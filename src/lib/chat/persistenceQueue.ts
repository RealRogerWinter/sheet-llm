/**
 * Module-scoped FIFO queue for client-side edit persistence.
 *
 * Replaces the per-edit fire-and-forget pattern in useEditPersistence
 * with a proper queue: coalesces by `coalesceKey`, batches via the
 * existing `/api/sessions/:id/versions/batch` endpoint, retries on
 * transient failure with backoff, falls through to `navigator.send
 * Beacon` on tab close so edits made in the last few seconds before
 * an unload still land server-side.
 *
 * Wired in by `useEditPersistence` (which installs the unload/visibility
 * listeners and translates editedScore changes into enqueue calls) and
 * by `useSubmitPrompt` (which calls `flushSync` before sending the next
 * LLM turn so the server-side transcript reflects the latest persisted
 * edit).
 *
 * No React in here — pure module state. Tests can reset via
 * `__resetForTesting`.
 */

import type { Score } from '@/lib/music/types'

type JobSource = 'edit' | 'llm_checkpoint'

interface QueueJob {
  chatId: string
  score: Score
  source: JobSource
  coalesceKey: string | undefined
  idempotencyKey: string
}

interface QueueAdapter {
  /** Returns the client's belief of the current head_version_id for the
   *  session. Queue uses it as `baseParentVersionId` on POST. */
  getHead: () => string | undefined
  /** Called after a successful POST with the new head id from the
   *  response so subsequent enqueues chain correctly. */
  setHead: (id: string) => void
}

const IDLE_FLUSH_MS = 2000
const MAX_ATTEMPTS = 4
// Backoff in ms by attempt number (1-indexed). 4 attempts total ≈ 7s
// max wait; tunable if we ever see real-world flakiness justifying more.
const BACKOFF_MS = [1000, 2000, 4000]

let adapter: QueueAdapter = {
  getHead: () => undefined,
  setHead: () => {},
}
const queue: QueueJob[] = []
let flushing = false
let idleTimer: ReturnType<typeof setTimeout> | null = null
const subscribers = new Set<() => void>()

function notifySubscribers(): void {
  for (const cb of subscribers) cb()
}

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdleFlush(): void {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    idleTimer = null
    void flushOne()
  }, IDLE_FLUSH_MS)
}

/**
 * Add a job to the queue. If the previous job has the same chatId AND
 * coalesceKey, replace it in place — covers "user dragged a note 30
 * times in 200ms" without 30 POSTs to dedup.
 */
export function enqueue(input: {
  chatId: string
  score: Score
  source: JobSource
  coalesceKey?: string
}): void {
  const idempotencyKey = mintIdempotencyKey(input.chatId)
  const last = queue.length > 0 ? queue[queue.length - 1] : undefined
  if (
    last &&
    last.chatId === input.chatId &&
    input.coalesceKey !== undefined &&
    last.coalesceKey === input.coalesceKey
  ) {
    last.score = input.score
    // Keep the OLD idempotency key — same logical edit, same dedup token.
  } else {
    queue.push({
      chatId: input.chatId,
      score: input.score,
      source: input.source,
      coalesceKey: input.coalesceKey,
      idempotencyKey,
    })
  }
  notifySubscribers()
  scheduleIdleFlush()
}

function mintIdempotencyKey(chatId: string): string {
  return `${chatId}:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2, 10)}`
}

/**
 * POST the next batch (all jobs sharing the head chatId at the front of
 * the queue). Single in-flight at a time — re-enqueued items after a
 * 5xx wait for the next call.
 */
async function flushOne(): Promise<void> {
  if (flushing || queue.length === 0) return
  flushing = true
  // Batch by chatId — only the first contiguous run; if the user
  // switched mid-flush, subsequent chatIds wait for the next call.
  const headChatId = queue[0].chatId
  const batch: QueueJob[] = []
  while (queue.length > 0 && queue[0].chatId === headChatId) {
    batch.push(queue.shift()!)
  }
  notifySubscribers()

  let baseParentVersionId: string | null = adapter.getHead() ?? null
  let attempt = 1
  let lastError: unknown = undefined

  while (attempt <= MAX_ATTEMPTS) {
    try {
      const res = await fetch(
        `/api/sessions/${headChatId}/versions/batch`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            baseParentVersionId,
            versions: batch.map((j) => ({
              idempotencyKey: j.idempotencyKey,
              score: j.score,
              source: j.source === 'llm_checkpoint' ? 'llm' : 'edit',
              ...(j.coalesceKey ? { coalesceKey: j.coalesceKey } : {}),
            })),
          }),
        },
      )

      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as {
          code?: string
          currentHead?: string | null
        }
        if (body.code === 'stale_parent' && body.currentHead !== undefined) {
          // Rewrite the chain's base, retry exactly once with the
          // server's view of head. If it's still wrong, surface.
          if (attempt === 1) {
            baseParentVersionId = body.currentHead ?? null
            attempt += 1
            continue
          }
        }
        // Other 409 (turn_in_progress, etc.) — re-enqueue and bail out.
        // useSubmitPrompt's flushSync will retry after the turn lands.
        for (let i = batch.length - 1; i >= 0; i--) queue.unshift(batch[i])
        notifySubscribers()
        break
      }

      if (!res.ok) {
        // 5xx → retryable. 4xx that isn't 409 → drop (client error,
        // not transient).
        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
          await sleep(BACKOFF_MS[attempt - 1] ?? 4000)
          attempt += 1
          continue
        }
        // Surface the response body so a 400 from a schema/byte-cap
        // failure is debuggable from the console without DevTools
        // Network inspection. Best-effort — text() may itself reject.
        const detail = await res.text().catch(() => '<unreadable>')
        lastError = new Error(`HTTP ${res.status}: ${detail}`)
        console.error('[persistenceQueue] non-retryable', res.status, detail)
        break
      }

      const body = (await res.json()) as { versionIds?: string[] }
      if (Array.isArray(body.versionIds) && body.versionIds.length > 0) {
        adapter.setHead(body.versionIds[body.versionIds.length - 1])
      }
      break // success
    } catch (e) {
      // Network / parse error — retryable.
      lastError = e
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS[attempt - 1] ?? 4000)
        attempt += 1
        continue
      }
      console.error('[persistenceQueue] gave up after retries', e)
      break
    }
  }

  flushing = false
  notifySubscribers()
  // If anything's still queued (cross-session batch or re-enqueue
  // after 409), schedule the next flush.
  if (queue.length > 0) scheduleIdleFlush()
  // Reference lastError to keep linters/devtools surfacing it during
  // debugging without throwing (this is a background loop).
  void lastError
}

/**
 * Synchronous flush — used by useSubmitPrompt before LLM POSTs so the
 * server-side transcript reflects the latest persisted edit. Returns
 * a promise that resolves when the in-flight + queue is drained or a
 * caller-provided timeout elapses.
 */
export async function flushSync(timeoutMs = 5000): Promise<void> {
  clearIdleTimer()
  const deadline = Date.now() + timeoutMs
  while (queue.length > 0 || flushing) {
    if (Date.now() > deadline) return
    if (!flushing) {
      await flushOne()
    } else {
      await sleep(50)
    }
  }
}

/**
 * Beacon-flush: fired from beforeunload / visibilitychange:hidden.
 * `navigator.sendBeacon` is synchronous from the browser's POV and
 * uses keepalive transport so the request survives the unload.
 * Falls back to `fetch({ keepalive: true })` when sendBeacon refuses
 * the payload (>64KB cap or unsupported in environment).
 *
 * Returns false if there's nothing to flush or the queue couldn't be
 * dispatched at all (browser blocked it).
 */
export function flushBeacon(): boolean {
  if (queue.length === 0) return false
  if (typeof navigator === 'undefined') return false
  const headChatId = queue[0].chatId
  const batch: QueueJob[] = []
  while (queue.length > 0 && queue[0].chatId === headChatId) {
    batch.push(queue.shift()!)
  }
  notifySubscribers()
  const url = `/api/sessions/${headChatId}/versions/batch`
  const payload = JSON.stringify({
    baseParentVersionId: adapter.getHead() ?? null,
    versions: batch.map((j) => ({
      idempotencyKey: j.idempotencyKey,
      score: j.score,
      source: j.source === 'llm_checkpoint' ? 'llm' : 'edit',
      ...(j.coalesceKey ? { coalesceKey: j.coalesceKey } : {}),
    })),
  })
  try {
    const blob = new Blob([payload], { type: 'application/json' })
    if (navigator.sendBeacon && navigator.sendBeacon(url, blob)) {
      return true
    }
  } catch {
    // sendBeacon refused (oversized blob, browser policy) — fall through
  }
  // Best-effort fallback. Won't help if the unload races us, but on
  // visibilitychange:hidden we have time.
  try {
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: payload,
      keepalive: true,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Wire the queue to the live ChatStore-backed head. Called once on app
 * boot (from useEditPersistence's mount effect).
 */
export function setAdapter(next: QueueAdapter): void {
  adapter = next
}

export function getPendingCount(): number {
  return queue.length + (flushing ? 1 : 0)
}

export function subscribeToPending(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/** Test-only: reset all module-level state. */
export function __resetForTesting(): void {
  queue.length = 0
  flushing = false
  clearIdleTimer()
  subscribers.clear()
  adapter = { getHead: () => undefined, setHead: () => {} }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
