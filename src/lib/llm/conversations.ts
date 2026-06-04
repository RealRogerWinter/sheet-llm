import { and, eq, isNull, asc, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  messages,
  scoreVersions,
  sessions,
  type NewMessage,
} from '@/lib/db/schema'
import { scoreHash } from '@/lib/orchestrator/scoreVersion'
import { ScoreSchema, type Score } from '@/lib/music/types'
import type { ChatMessage } from './wrapper'

/**
 * Optional metadata threaded through the transcript so consumers can
 * surface streaming-lifecycle state without parsing content_json. Absent
 * (or `_meta?.streamStatus === 'complete'`) for the normal happy-path
 * turn; present on rows the reaper or the SSE-error path marked.
 */
export type ConversationMessage = ChatMessage & {
  _meta?: {
    streamStatus?: 'partial' | 'errored'
    errorCode?: string | null
  }
}

export type Conversation = ConversationMessage[]

export type AppendOptions = {
  /**
   * Tags any newly-discovered Score (assistant tool_use blocks) with a
   * `source`. Defaults to `'llm'` for assistant turns; user turns never
   * produce score_versions.
   */
  scoreSource?: 'llm' | 'edit' | 'import' | 'fork-seed' | 'revert'
  /**
   * M3.5-PR-4 — when true, the inserted score_versions row is created
   * normally (so the candidate score is recoverable via its id) but the
   * session's `head_version_id` is NOT advanced. Used by the
   * replacement-as-confirmation gate path: the candidate score lives
   * in DB as an orphan until the user picks accept/reject; on accept,
   * `/api/chat/confirm-replacement` flips the head explicitly.
   */
  skipHeadVersionBump?: boolean
}

/**
 * Variant of {@link appendMessages} that returns the id of any
 * newly-created score_versions row. M3.5-PR-4 uses this to obtain the
 * candidateVersionId for the confirmation modal without re-querying.
 */
export type AppendMessagesResult = {
  newScoreVersionId: string | null
}

export type CreateOptions = {
  forkedFromSessionId?: string | null
  forkedFromVersionId?: string | null
  /**
   * Seed `head_version_id` immediately (used by fork to point at a parent
   * session's version without copying any rows).
   */
  initialHeadVersionId?: string | null
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Create a fresh session for `userId`. Returns the new session id.
 * The caller is expected to follow up with `appendMessages` for any
 * seed content.
 */
export async function createConversation(
  userId: string,
  opts: CreateOptions = {},
): Promise<string> {
  const db = getDb()
  const id = crypto.randomUUID()
  const ts = now()
  await db.insert(sessions).values({
    id,
    userId,
    createdAt: ts,
    updatedAt: ts,
    lastMessageAt: ts,
    forkedFromSessionId: opts.forkedFromSessionId ?? null,
    forkedFromVersionId: opts.forkedFromVersionId ?? null,
    headVersionId: opts.initialHeadVersionId ?? null,
  })
  return id
}

/**
 * Cheap existence check, scoped to `userId` so a request bearing
 * cookie A can never observe session B's existence by guessing its id.
 */
export async function hasConversation(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const db = getDb()
  const row = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        isNull(sessions.deletedAt),
      ),
    )
    .limit(1)
    .get()
  return row != null
}

/**
 * Hydrate the full ordered transcript for a session as a list of native
 * Anthropic `ChatMessage`s. Returns undefined when the session doesn't
 * exist for this user (404-equivalent — never leak existence cross-user).
 */
export async function getConversation(
  userId: string,
  sessionId: string,
): Promise<Conversation | undefined> {
  const db = getDb()
  const owns = await hasConversation(userId, sessionId)
  if (!owns) return undefined
  const rows = await db
    .select({
      contentJson: messages.contentJson,
      role: messages.role,
      streamStatus: messages.streamStatus,
      errorCode: messages.errorCode,
    })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.seq))
  const out: Conversation = []
  for (const row of rows) {
    const content = JSON.parse(row.contentJson)
    if (row.role !== 'user' && row.role !== 'assistant') continue
    const msg: ConversationMessage = { role: row.role, content } as ConversationMessage
    // Only attach _meta for non-complete rows. Keeps the happy-path
    // shape identical to the pre-stream-status world; callers that
    // never look at _meta (the LLM-call path in api/chat/route.ts)
    // are unaffected.
    if (row.streamStatus !== 'complete') {
      msg._meta = {
        streamStatus: row.streamStatus as 'partial' | 'errored',
        errorCode: row.errorCode ?? null,
      }
    }
    out.push(msg)
  }
  return out
}

/**
 * Insert an assistant message immediately at SSE-open with
 * `stream_status='partial'` and an empty body. Returns the new
 * messageId so the SSE handler can finalize it later.
 *
 * Runs in the same transaction as the seq resolution so a parallel
 * `appendMessages` writer can't race and claim the same seq —
 * messages_session_seq's UNIQUE constraint would catch it but the
 * resulting opaque 500 is worse than serializing here.
 *
 * `precedingMessages` (typically the just-built user turn) is inserted
 * BEFORE the partial assistant row, in the same transaction. The chat
 * route uses this to defer user-turn persistence until the stream
 * actually opens, so a request that errors before this point leaves
 * no orphan user row whose tool_result would dangle without a
 * matching preceding assistant tool_use.
 *
 * Bumps sessions.last_message_at + updated_at so the sidebar's
 * "most recently active" sort reflects the new turn immediately,
 * not only after the stream finishes.
 */
export async function appendStreamingAssistant(
  userId: string,
  sessionId: string,
  precedingMessages: ChatMessage[] = [],
  opts: AppendOptions = {},
): Promise<{ messageId: string; seq: number }> {
  const db = getDb()
  const owns = await hasConversation(userId, sessionId)
  if (!owns) throw new Error(`[conversations] Unknown session for user: ${sessionId}`)
  const ts = now()
  const messageId = crypto.randomUUID()
  let seq = 0
  db.transaction((tx) => {
    const nextSeqRow = tx
      .select({ max: sql<number | null>`COALESCE(MAX(${messages.seq}), -1)` })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .get()
    const startSeq = (nextSeqRow?.max ?? -1) + 1
    const inserted = insertMessagesInTx(
      tx,
      sessionId,
      precedingMessages,
      startSeq,
      opts,
      ts,
    )
    seq = inserted.nextSeq
    tx.insert(messages)
      .values({
        id: messageId,
        sessionId,
        seq,
        role: 'assistant',
        contentJson: '[]',
        toolUseId: null,
        scoreVersionId: null,
        isSynthetic: 0,
        streamStatus: 'partial',
        errorCode: null,
        createdAt: ts,
      })
      .run()
    const update: Record<string, unknown> = { updatedAt: ts, lastMessageAt: ts }
    if (inserted.newHeadVersionId !== null) update.headVersionId = inserted.newHeadVersionId
    if (inserted.newAutoTitle !== null) update.title = inserted.newAutoTitle
    tx.update(sessions).set(update).where(eq(sessions.id, sessionId)).run()
  })
  return { messageId, seq }
}

export type StreamFinalizeOutcome =
  | { status: 'complete'; text: string }
  | { status: 'errored'; text: string; errorCode: string }

/**
 * Finalize a streaming-message row created by `appendStreamingAssistant`.
 * Uses a conditional UPDATE (`WHERE stream_status='partial'`) so the
 * reaper-finalize race is decidable: whoever flipped the row out of
 * `partial` first wins. `{updated: false}` means the reaper or another
 * finalize beat us — caller logs and moves on, does NOT throw.
 *
 * Idempotent — calling finalize twice with the same outcome is safe
 * (second call returns `{updated: false}`).
 */
export async function finalizeStreamingMessage(
  messageId: string,
  outcome: StreamFinalizeOutcome,
): Promise<{ updated: boolean }> {
  const db = getDb()
  const contentJson = JSON.stringify([{ type: 'text', text: outcome.text }])
  const result = await db
    .update(messages)
    .set({
      contentJson,
      streamStatus: outcome.status,
      errorCode: outcome.status === 'errored' ? outcome.errorCode : null,
    })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.streamStatus, 'partial'),
      ),
    )
    .returning({ id: messages.id })
  return { updated: result.length > 0 }
}

/**
 * Append messages to a session's transcript in a single transaction.
 * For each assistant message containing a `tool_use` block whose `input`
 * parses as a Score, also:
 *   1. INSERT a `score_versions` row (linked back to the message),
 *   2. UPDATE `sessions.head_version_id` to that new version,
 *   3. UPDATE `sessions.updated_at` / `last_message_at`.
 *
 * Throws if the session isn't owned by `userId` (defense in depth — the
 * route layer should have rejected long before this).
 */
export async function appendMessages(
  userId: string,
  sessionId: string,
  msgs: ChatMessage[],
  opts: AppendOptions = {},
): Promise<AppendMessagesResult> {
  if (msgs.length === 0) return { newScoreVersionId: null }
  const db = getDb()
  const owns = await hasConversation(userId, sessionId)
  if (!owns) throw new Error(`[conversations] Unknown session for user: ${sessionId}`)

  // better-sqlite3 transactions are synchronous and run all reads/writes
  // atomically — perfect for the "insert messages + maybe score_version
  // + bump head" pattern below.
  const ts = now()
  let resultVersionId: string | null = null
  db.transaction((tx) => {
    const nextSeqRow = tx
      .select({ max: sql<number | null>`COALESCE(MAX(${messages.seq}), -1)` })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .get()
    const startSeq = (nextSeqRow?.max ?? -1) + 1
    const { newHeadVersionId, newAutoTitle } = insertMessagesInTx(
      tx,
      sessionId,
      msgs,
      startSeq,
      opts,
      ts,
    )
    resultVersionId = newHeadVersionId

    // Bump session timestamps + head pointer + auto-title in one update.
    const update: Record<string, unknown> = {
      updatedAt: ts,
      lastMessageAt: ts,
    }
    // M3.5-PR-4: when `skipHeadVersionBump` is set, the candidate score
    // row is still inserted (so confirm-replacement can advance the head
    // by id later) but the session's head pointer stays at the prior
    // head until the user explicitly confirms.
    if (newHeadVersionId !== null && !opts.skipHeadVersionBump) {
      update.headVersionId = newHeadVersionId
    }
    if (newAutoTitle !== null) update.title = newAutoTitle
    tx.update(sessions).set(update).where(eq(sessions.id, sessionId)).run()
  })
  return { newScoreVersionId: resultVersionId }
}

type TxArg = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

/**
 * Insert `msgs` into the messages table starting at `startSeq`, within
 * the caller's transaction. Handles score_versions creation for any
 * assistant tool_use turn and surfaces an auto-title candidate from
 * the first eligible non-synthetic user text message.
 *
 * Caller is responsible for opening the transaction, resolving startSeq
 * via MAX(seq)+1, and applying the returned newHeadVersionId /
 * newAutoTitle / nextSeq to the sessions row + any subsequent inserts.
 */
function insertMessagesInTx(
  tx: TxArg,
  sessionId: string,
  msgs: ChatMessage[],
  startSeq: number,
  opts: AppendOptions,
  ts: number,
): {
  nextSeq: number
  newHeadVersionId: string | null
  newAutoTitle: string | null
} {
  let seq = startSeq
  let newHeadVersionId: string | null = null
  let newAutoTitle: string | null = null

  const currentTitleRow = tx
    .select({ title: sessions.title })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get()
  const titleIsNull = currentTitleRow?.title == null

  for (const msg of msgs) {
    const messageId = crypto.randomUUID()
    const toolUseId = extractToolUseId(msg)
    const isSynthetic = toolUseId != null && toolUseId.startsWith('toolu_orch_')

    // Insert the message FIRST with score_version_id=null so the circular
    // FK (score_versions.message_id → messages.id) has a target. We'll
    // backfill score_version_id below once the version row exists.
    const row: NewMessage = {
      id: messageId,
      sessionId,
      seq,
      role: msg.role,
      contentJson: JSON.stringify(msg.content),
      toolUseId: toolUseId ?? null,
      scoreVersionId: null,
      isSynthetic: isSynthetic ? 1 : 0,
      createdAt: ts,
    }
    tx.insert(messages).values(row).run()

    const insertedScoreVersionId = tryInsertScoreVersionForAssistant(
      tx,
      sessionId,
      messageId,
      msg,
      opts.scoreSource ?? 'llm',
      newHeadVersionId, // chain to whatever we just created in this loop, or null on first iter
      ts,
    )
    if (insertedScoreVersionId) {
      newHeadVersionId = insertedScoreVersionId
      tx.update(messages)
        .set({ scoreVersionId: insertedScoreVersionId })
        .where(eq(messages.id, messageId))
        .run()
    }

    if (
      titleIsNull &&
      newAutoTitle === null &&
      msg.role === 'user' &&
      !isSynthetic
    ) {
      const candidate = firstUserText(msg)
      if (candidate) newAutoTitle = candidate
    }

    seq += 1
  }

  return { nextSeq: seq, newHeadVersionId, newAutoTitle }
}

/**
 * Extract the first text block from a user message and reduce it to a
 * sidebar-friendly title (≤50 chars, trimmed, no truncation marker — the
 * UI adds an ellipsis only when needed).
 * Returns null when there's no usable text (tool_result-only turn, empty
 * text, etc.).
 */
function firstUserText(msg: ChatMessage): string | null {
  if (msg.role !== 'user') return null
  for (const block of msg.content) {
    if (block.type === 'text') {
      const trimmed = block.text.trim()
      if (trimmed.length === 0) continue
      return trimmed.length > 50 ? trimmed.slice(0, 50) : trimmed
    }
  }
  return null
}

function extractToolUseId(msg: ChatMessage): string | null {
  if (msg.role !== 'assistant') return null
  for (const block of msg.content) {
    if (block.type === 'tool_use') return block.id
  }
  return null
}

/**
 * If `msg` is an assistant turn with a render_score `tool_use` block whose
 * input parses as a Score, INSERT a score_versions row and return its id.
 * Returns null otherwise (text-only converse turns, user turns, malformed
 * tool_use blocks).
 *
 * Runs inside the caller's transaction.
 */
function tryInsertScoreVersionForAssistant(
  tx: TxArg,
  sessionId: string,
  messageId: string,
  msg: ChatMessage,
  source: 'llm' | 'edit' | 'import' | 'fork-seed' | 'revert',
  parentVersionId: string | null,
  ts: number,
): string | null {
  if (msg.role !== 'assistant') return null
  let scoreInput: unknown = undefined
  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      scoreInput = block.input
      break
    }
  }
  if (scoreInput === undefined) return null
  const parsed = ScoreSchema.safeParse(scoreInput)
  if (!parsed.success) return null

  const score: Score = parsed.data
  const versionId = crypto.randomUUID()
  const hash = scoreHash(score)
  // The append loop computes parentVersionId by chaining within the batch;
  // the FIRST assistant in the batch should chain to the session's current
  // head, NOT null. Resolve here when caller passed null on the first iter.
  let resolvedParent = parentVersionId
  if (resolvedParent === null) {
    const headRow = tx
      .select({ head: sessions.headVersionId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get()
    resolvedParent = headRow?.head ?? null
  }
  tx.insert(scoreVersions)
    .values({
      id: versionId,
      sessionId,
      parentVersionId: resolvedParent,
      scoreJson: JSON.stringify(score),
      scoreHash: hash,
      source,
      messageId,
      createdAt: ts,
    })
    .run()
  return versionId
}

/**
 * Soft-delete a session. Returns true if a row was actually marked deleted,
 * false if the session didn't exist for this user or was already deleted.
 */
export async function deleteConversation(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const db = getDb()
  const result = await db
    .update(sessions)
    .set({ deletedAt: now() })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        isNull(sessions.deletedAt),
      ),
    )
    .returning({ id: sessions.id })
  return result.length > 0
}

/**
 * Test-only: truncate every conversation-related table. Production code
 * MUST NOT call this — it ignores user scoping and ownership entirely.
 * Sessions + messages + score_versions all clear; users table is left
 * intact so a per-test fixture user persists.
 */
export async function clearAllConversationsForTesting(): Promise<void> {
  const db = getDb()
  // FK cascade order: score_versions → messages → sessions.
  db.delete(scoreVersions).run()
  db.delete(messages).run()
  db.delete(sessions).run()
}
