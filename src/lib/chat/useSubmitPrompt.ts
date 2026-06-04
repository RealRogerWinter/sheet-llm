'use client'

import { useCallback } from 'react'
import { useChatStore, type StreamProgress } from '@/lib/chat/state'
import { useDebugStore, buildDebugOverrides } from '@/lib/debug/debugStore'
import { summarizeScore } from '@/lib/shared/scoreSummary'
import type { Score } from '@/lib/music/types'
import type {
  ChatCta,
  ChatDebugPayload,
  ChatRequest,
  ChatResponse,
  TargetRegion,
  TranscriptTurn,
} from '@/lib/shared/types'

interface SubmitResult {
  ok: boolean
}

/**
 * Shared chat submission used by `PromptBar` (page footer) and
 * `ChatHistoryPanel`'s `PanelPromptInput` (panel footer). Centralises:
 *  - body construction (chatId + edited-score gating + debug overrides)
 *  - optimistic transcript appends (user turn before fetch, assistant
 *    turn after success — so the panel paints without waiting on a
 *    follow-up GET)
 *  - 410 handling (`chat_full` vs `chat_not_found` differ in whether
 *    they reset the local chatId)
 *  - debug-panel payload capture on success
 *
 * Returns `{ submit, pending, error }`. `submit(text)` is the only
 * action callers need; the rest is plumbing they read from the store.
 */
export function useSubmitPrompt() {
  const chatId = useChatStore((s) => s.chatId)
  const editedScore = useChatStore((s) => s.editedScore)
  const scoreJson = useChatStore((s) => s.scoreJson)
  const historyPointer = useChatStore((s) => s.historyPointer)
  const pending = useChatStore((s) => s.pending)
  const error = useChatStore((s) => s.error)
  const turns = useChatStore((s) => s.turns)
  const setChatId = useChatStore((s) => s.setChatId)
  const beginRequest = useChatStore((s) => s.beginRequest)
  const resolveRequest = useChatStore((s) => s.resolveRequest)
  const endRequestNoScore = useChatStore((s) => s.endRequestNoScore)
  const failRequest = useChatStore((s) => s.failRequest)
  const appendTurns = useChatStore((s) => s.appendTurns)
  const streamScoreSection = useChatStore((s) => s.streamScoreSection)
  const appendStreamingAssistantTurn = useChatStore((s) => s.appendStreamingAssistantTurn)
  const appendStreamingDelta = useChatStore((s) => s.appendStreamingDelta)
  const finalizeStreamingTurn = useChatStore((s) => s.finalizeStreamingTurn)
  const failStreamingTurn = useChatStore((s) => s.failStreamingTurn)
  const appendErrorTurn = useChatStore((s) => s.appendErrorTurn)
  const appendCtaTurn = useChatStore((s) => s.appendCtaTurn)
  const openQuotaCta = useChatStore((s) => s.openQuotaCta)
  const debugOrchestrator = useDebugStore((s) => s.orchestratorOverride)
  const debugModelOverride = useDebugStore((s) => s.modelOverride)
  const debugApiKeyOverride = useDebugStore((s) => s.apiKeyOverride)
  const debugGenerationTier = useDebugStore((s) => s.generationTierOverride)
  const setLastDebug = useDebugStore((s) => s.setLastDebug)

  const submit = useCallback(
    async (
      rawMessage: string,
      opts?: { targetRegion?: TargetRegion },
    ): Promise<SubmitResult> => {
      const message = rawMessage.trim()
      if (!message || pending) return { ok: false }

      const hasEdits = scoreJson !== undefined && historyPointer > 0

      // Find the most recent assistant SCORE turn so a refinement can
      // anchor to its toolUseId — same shape the server's
      // buildUserTurnForRefinement uses. Converse (text-only) assistant
      // turns are skipped: their synthetic toolUseId wouldn't resolve to
      // a render_score tool_use on the server.
      let lastAssistantToolUseId: string | undefined
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i]
        if (t.role === 'assistant' && t.kind === 'render_score') {
          lastAssistantToolUseId = t.toolUseId
          break
        }
      }

      const optimisticUserTurn: TranscriptTurn = lastAssistantToolUseId
        ? {
            role: 'user',
            kind: 'refinement',
            text: message,
            hadEdit: hasEdits,
            toolUseId: lastAssistantToolUseId,
            ts: Date.now(),
          }
        : { role: 'user', kind: 'text', text: message, ts: Date.now() }
      appendTurns([optimisticUserTurn])
      beginRequest(message)

      try {
        const debug = buildDebugOverrides(
          debugOrchestrator,
          debugModelOverride,
          debugApiKeyOverride,
          debugGenerationTier,
        )
        const body: ChatRequest = {
          chatId,
          message,
          ...(hasEdits && editedScore ? { editedScore } : {}),
          ...(opts?.targetRegion ? { targetRegion: opts.targetRegion } : {}),
          ...(debug ? { debug } : {}),
        }
        // Drain any pending edit-persistence queue items so the
        // server-side transcript reflects the latest edit BEFORE the
        // LLM POST runs (otherwise refinement would race against in-
        // flight version writes and either skip the user's edit or
        // 409 on parent-CAS).
        const { flushSync } = await import('@/lib/chat/persistenceQueue')
        await flushSync(2000)
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (res.status === 410) {
          const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
          if (data.code === 'chat_full') {
            const msg = data.error ?? 'Conversation full. Click New Score to continue.'
            appendErrorTurn(msg)
            failRequest(msg)
            return { ok: false }
          }
          // Session expired: the editor resets (abc cleared → panel hides),
          // so a persistent transcript turn would be invisible — the toast
          // is the right surface here.
          failRequest('Session expired. Try sending again to start fresh.', { resetChatId: true })
          return { ok: false }
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string
            chatId?: string
            cta?: ChatCta
          }
          // Adopt server-returned chatId so a retry hits the same session
          // and the orphan user row from the early server-side persist
          // (see /api/chat route.ts comment on `appendMessages([userTurn])`)
          // collapses into the next attempt via prepareMessagesForLLM.
          if (data.chatId) setChatId(data.chatId)
          if (data.cta) {
            // Quota / login gate: render the structured CTA — a persistent
            // in-transcript card plus a one-shot modal — instead of a plain
            // error toast (avoids card+modal+toast triple-messaging).
            appendCtaTurn(data.cta)
            openQuotaCta(data.cta)
            endRequestNoScore()
            return { ok: false }
          }
          const msg = data.error ?? `Request failed: ${res.status}`
          appendErrorTurn(msg)
          failRequest(msg)
          return { ok: false }
        }

        const contentType = res.headers.get('content-type') ?? ''

        // Streaming branch — converse (text) OR sectional score generation
        // (M25-PR-4). Both are text/event-stream; the X-Stream-Kind header
        // selects the consumer.
        if (contentType.startsWith('text/event-stream')) {
          if (res.headers.get('x-stream-kind') === 'score') {
            await consumeScoreStream(res, {
              setChatId,
              setLastDebug,
              streamScoreSection,
              resolveRequest,
              setCurrentHeadVersionId: useChatStore.getState().setCurrentHeadVersionId,
              appendTurns,
              appendErrorTurn,
              endRequestNoScore,
              failRequest,
            })
            return { ok: true }
          }
          await consumeConverseStream(res, {
            setChatId,
            setLastDebug,
            appendStreamingAssistantTurn,
            appendStreamingDelta,
            finalizeStreamingTurn,
            failStreamingTurn,
            appendErrorTurn,
            endRequestNoScore,
            failRequest,
          })
          return { ok: true }
        }

        // JSON branch — score handlers / refusal-passthrough / legacy.
        const data = (await res.json()) as ChatResponse
        setChatId(data.chatId)

        // M3.5-PR-4 — replacement-as-confirmation gate. When the server
        // flagged this turn as requiring confirmation, we DO NOT swap the
        // editor to the candidate score; instead we stash it on the store
        // and let ReplacementConfirmModal render the diff + capture the
        // user's choice. On accept the modal will fetch + apply; on
        // reject the score stays put.
        if (data.requiresConfirmation && data.replacement && data.scoreJson) {
          const store = useChatStore.getState()
          // Pending flag down so the prompt bar is interactable for the
          // user to read + decide.
          endRequestNoScore()
          store.setPendingConfirmation({
            chatId: data.chatId,
            candidateVersionId: data.replacement.candidateVersionId,
            candidateScore: data.scoreJson,
            beforeScore: store.editedScore ?? store.scoreJson ?? data.scoreJson,
            retainedIdentityRatio: data.replacement.retainedIdentityRatio,
            reasons: data.replacement.reasons,
            toolUseId: data.toolUseId ?? '',
            introText: data.introText ?? '',
            abc: data.abc,
            ...(data.headVersionId !== undefined ? { headVersionId: data.headVersionId } : {}),
          })
          setLastDebug(data.debug)
          return { ok: true }
        }

        // M24-PR-3a — AI ghost preview proposal. Parallel branch to the
        // replacement gate above: server flagged requiresConfirmation +
        // attached a `proposal` payload. We DO NOT swap the editor to
        // the candidate score; the proposal slot drives the inline
        // overlay (PR-3c) or docked diff panel (PR-4) rendering. The UI
        // component is responsible for the accept/reject network
        // roundtrip + state mutation.
        //
        // Mutually exclusive with the replacement branch above. **Order
        // matters**: replacement is checked first. If the server ever
        // populated both (shouldn't — the server-side hook in
        // maybeAttachGhostProposal returns early when result.replacement
        // is set), replacement wins.
        //
        // Clobber semantics: if a new chat request arrives while a
        // pendingProposal is already set, this branch overwrites the
        // prior slot with no guard. Same as the replacement branch —
        // submitting a new prompt implicitly abandons the prior
        // proposal. Manual-edit-cancels-proposal is wired separately in
        // PR-5 via a different path.
        if (data.requiresConfirmation && data.proposal && data.scoreJson) {
          const store = useChatStore.getState()
          endRequestNoScore()
          store.setPendingProposal({
            chatId: data.chatId,
            candidateVersionId: data.proposal.candidateVersionId,
            candidateScore: data.scoreJson,
            beforeScore: store.editedScore ?? store.scoreJson ?? data.scoreJson,
            abc: data.abc,
            affectedEventIds: data.proposal.affectedEventIds,
            introText: data.introText ?? '',
            toolUseId: data.toolUseId ?? '',
            ...(data.headVersionId !== undefined ? { headVersionId: data.headVersionId } : {}),
          })
          setLastDebug(data.debug)
          return { ok: true }
        }

        resolveRequest(data.abc, data.scoreJson, data.introText)
        // Server-side head pointer; useEditPersistence chains the next
        // edit POST against this. Undefined for converse-only turns
        // (no Score → no score_versions row produced).
        useChatStore.getState().setCurrentHeadVersionId(data.headVersionId)
        setLastDebug(data.debug)

        if (data.scoreJson && data.toolUseId) {
          appendTurns([
            {
              role: 'assistant',
              kind: 'render_score',
              introText: data.introText,
              scoreSummary: summarizeScore(data.scoreJson),
              toolUseId: data.toolUseId,
            },
          ])
        }
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Network error'
        appendErrorTurn(msg)
        failRequest(msg)
        return { ok: false }
      }
    },
    [
      pending,
      scoreJson,
      historyPointer,
      turns,
      chatId,
      editedScore,
      debugOrchestrator,
      debugModelOverride,
      debugApiKeyOverride,
      debugGenerationTier,
      setChatId,
      beginRequest,
      resolveRequest,
      endRequestNoScore,
      failRequest,
      appendTurns,
      streamScoreSection,
      appendStreamingAssistantTurn,
      appendStreamingDelta,
      finalizeStreamingTurn,
      failStreamingTurn,
      appendErrorTurn,
      appendCtaTurn,
      openQuotaCta,
      setLastDebug,
    ],
  )

  return { submit, pending, error }
}

interface ConverseStreamHandlers {
  setChatId: (id: string | undefined) => void
  setLastDebug: (d: ChatDebugPayload | undefined) => void
  appendStreamingAssistantTurn: (toolUseId: string) => number
  appendStreamingDelta: (index: number, delta: string) => void
  finalizeStreamingTurn: (index: number, finalText?: string) => void
  failStreamingTurn: (index: number, message: string) => void
  appendErrorTurn: (message: string) => void
  endRequestNoScore: () => void
  failRequest: (error: string) => void
}

/**
 * Parse the response body as an SSE stream and dispatch events to the
 * store. EventSource doesn't work for POST, so we use fetch + a manual
 * frame parser. Each frame is `event: <name>\ndata: <json>\n\n`; lines
 * starting with `:` are comments (keepalives).
 */
async function consumeConverseStream(
  res: Response,
  h: ConverseStreamHandlers,
): Promise<void> {
  if (!res.body) {
    h.failRequest('Streaming response had no body')
    h.endRequestNoScore()
    return
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let turnIndex: number | undefined
  let sawError = false
  let sawDone = false
  // See consumeScoreStream: bind the stream to its originating session so
  // navigating away mid-stream stops it writing into the new session.
  let streamChatId: string | undefined
  const isStale = () =>
    streamChatId !== undefined && useChatStore.getState().chatId !== streamChatId

  function handleEvent(event: string, dataJson: string): void {
    let data: Record<string, unknown> = {}
    try {
      data = dataJson ? (JSON.parse(dataJson) as Record<string, unknown>) : {}
    } catch {
      return
    }
    if (event === 'header') {
      const chatId = data.chatId as string | undefined
      const toolUseId = (data.toolUseId as string | undefined) ?? 'toolu_orch_text_unknown'
      if (chatId) {
        streamChatId = chatId
        h.setChatId(chatId)
      }
      if (data.debug !== undefined) {
        h.setLastDebug(data.debug as ChatDebugPayload | undefined)
      }
      turnIndex = h.appendStreamingAssistantTurn(toolUseId)
    } else if (event === 'text-delta' && typeof data.delta === 'string') {
      if (isStale()) return
      if (turnIndex !== undefined) h.appendStreamingDelta(turnIndex, data.delta)
    } else if (event === 'done') {
      sawDone = true
      if (isStale()) return
      const finalText = typeof data.finalText === 'string' ? data.finalText : undefined
      if (turnIndex !== undefined) h.finalizeStreamingTurn(turnIndex, finalText)
      h.endRequestNoScore()
    } else if (event === 'error') {
      sawError = true
      if (isStale()) return
      const message =
        typeof data.error === 'string' ? data.error : 'Conversational response failed'
      // Turn the in-flight placeholder into a visible error bubble in the
      // transcript (keeps any partial text already streamed); if the header
      // never arrived there's no placeholder, so append a standalone error
      // turn instead. Either way the error stays in the chat history. Then
      // surface the global toast / clear `pending` via failRequest.
      if (turnIndex !== undefined) h.failStreamingTurn(turnIndex, message)
      else h.appendErrorTurn(message)
      h.failRequest(message)
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (value) buf += dec.decode(value, { stream: true })
      // Flush complete SSE frames (terminated by blank line).
      let sep = buf.indexOf('\n\n')
      while (sep !== -1) {
        const frame = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        let event = 'message'
        const dataLines: string[] = []
        for (const line of frame.split('\n')) {
          if (!line || line.startsWith(':')) continue
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
        if (event !== 'message' || dataLines.length > 0) {
          handleEvent(event, dataLines.join('\n'))
        }
        sep = buf.indexOf('\n\n')
      }
      // Navigated away mid-stream: stop consuming + release the flags.
      if (isStale()) {
        useChatStore.getState().cancelStreamingForSwitch()
        await reader.cancel().catch(() => {})
        break
      }
      if (done) break
    }
  } catch (e) {
    // A throw mid-read is a failure to generate — mark it as one so the
    // `finally` block (gated on `!sawError`) doesn't re-fire a duplicate.
    if (!isStale()) {
      sawError = true
      const message = e instanceof Error ? e.message : 'Stream interrupted'
      if (turnIndex !== undefined) h.failStreamingTurn(turnIndex, message)
      else h.appendErrorTurn(message)
      h.failRequest(message)
    }
  } finally {
    // Stream closed without an explicit done OR error frame (server crash,
    // transport drop): surface it as an interrupted generation rather than
    // a silent empty bubble, and clear `pending` so the UI unlocks. When
    // stale, cancelStreamingForSwitch already released the flags.
    if (!sawDone && !sawError && !isStale()) {
      const message = 'The response was interrupted before it finished.'
      if (turnIndex !== undefined) h.failStreamingTurn(turnIndex, message)
      else h.appendErrorTurn(message)
      h.failRequest(message)
    }
  }
}

interface ScoreStreamHandlers {
  setChatId: (id: string | undefined) => void
  setLastDebug: (d: ChatDebugPayload | undefined) => void
  streamScoreSection: (abc: string, scoreJson: Score, progress: StreamProgress) => void
  resolveRequest: (abc: string, scoreJson?: Score, introText?: string) => void
  setCurrentHeadVersionId: (id: string | undefined) => void
  appendTurns: (turns: TranscriptTurn[]) => void
  appendErrorTurn: (message: string) => void
  endRequestNoScore: () => void
  failRequest: (error: string) => void
}

/**
 * Parse the SSE body of an M25 sectional score generation. Frames:
 *   header  -> { chatId, model, debug }
 *   section -> { sectionIndex, totalSections, label, abc, scoreJson }  (renders progressively)
 *   done    -> { abc, scoreJson, toolUseId, introText, headVersionId, warnings }
 *   error   -> { code, error }
 * Mirrors consumeConverseStream's frame parser; differs only in the
 * per-event handling (progressive score render + final commit).
 */
async function consumeScoreStream(res: Response, h: ScoreStreamHandlers): Promise<void> {
  if (!res.body) {
    h.failRequest('Streaming response had no body')
    h.endRequestNoScore()
    return
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let sawDone = false
  let sawError = false
  // The session this stream belongs to (assigned in the header frame). If
  // the user navigates to a different session mid-stream, the stream is
  // stale: it must stop writing (so it can't clobber the now-current
  // session) and release the request flags via cancelStreamingForSwitch.
  let streamChatId: string | undefined
  const isStale = () =>
    streamChatId !== undefined && useChatStore.getState().chatId !== streamChatId

  function handleEvent(event: string, dataJson: string): void {
    let data: Record<string, unknown> = {}
    try {
      data = dataJson ? (JSON.parse(dataJson) as Record<string, unknown>) : {}
    } catch {
      return
    }
    if (event === 'header') {
      if (typeof data.chatId === 'string') {
        streamChatId = data.chatId
        h.setChatId(data.chatId)
      }
      if (data.debug !== undefined) h.setLastDebug(data.debug as ChatDebugPayload | undefined)
    } else if (event === 'section') {
      if (isStale()) return
      if (typeof data.abc === 'string' && data.scoreJson) {
        h.streamScoreSection(data.abc, data.scoreJson as Score, {
          sectionIndex: typeof data.sectionIndex === 'number' ? data.sectionIndex : 0,
          totalSections: typeof data.totalSections === 'number' ? data.totalSections : 0,
          label: typeof data.label === 'string' ? data.label : '',
        })
      }
    } else if (event === 'done') {
      sawDone = true
      // User switched sessions before the stream finished — don't overwrite
      // the session they're now looking at with this one's final score.
      if (isStale()) return
      const abc = typeof data.abc === 'string' ? data.abc : ''
      h.resolveRequest(abc, data.scoreJson as Score | undefined, data.introText as string | undefined)
      h.setCurrentHeadVersionId(data.headVersionId as string | undefined)
      if (data.scoreJson && typeof data.toolUseId === 'string') {
        h.appendTurns([
          {
            role: 'assistant',
            kind: 'render_score',
            introText: data.introText as string | undefined,
            scoreSummary: summarizeScore(data.scoreJson as Score),
            toolUseId: data.toolUseId,
          },
        ])
      }
    } else if (event === 'error') {
      sawError = true
      if (isStale()) return
      // No placeholder turn exists on the score path (the assistant turn is
      // appended only on `done`), so append a standalone error turn to keep
      // the failure permanently in the transcript.
      const message = typeof data.error === 'string' ? data.error : 'Generation failed'
      h.appendErrorTurn(message)
      h.failRequest(message)
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (value) buf += dec.decode(value, { stream: true })
      let sep = buf.indexOf('\n\n')
      while (sep !== -1) {
        const frame = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        let event = 'message'
        const dataLines: string[] = []
        for (const line of frame.split('\n')) {
          if (!line || line.startsWith(':')) continue
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
        if (event !== 'message' || dataLines.length > 0) {
          handleEvent(event, dataLines.join('\n'))
        }
        sep = buf.indexOf('\n\n')
      }
      // Navigated away mid-stream: stop consuming + release the flags so the
      // composing overlay doesn't sit on the newly-loaded session.
      if (isStale()) {
        useChatStore.getState().cancelStreamingForSwitch()
        await reader.cancel().catch(() => {})
        break
      }
      if (done) break
    }
  } catch (e) {
    // Mark sawError so the `finally` (gated on `!sawError`) can't double-fire.
    if (!isStale()) {
      sawError = true
      const message = e instanceof Error ? e.message : 'Stream interrupted'
      h.appendErrorTurn(message)
      h.failRequest(message)
    }
  } finally {
    // Stream closed without a terminal frame (crash/drop): surface it as a
    // failed generation that stays in the transcript (an errored turn) +
    // the global toast, rather than silently unlocking with no explanation.
    // When stale, cancelStreamingForSwitch already released the flags.
    if (!sawDone && !sawError && !isStale()) {
      const message = 'Generation was interrupted before any music was produced.'
      h.appendErrorTurn(message)
      h.failRequest(message)
    }
  }
}
