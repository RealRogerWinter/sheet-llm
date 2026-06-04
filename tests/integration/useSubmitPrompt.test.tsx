import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSubmitPrompt } from '@/lib/chat/useSubmitPrompt'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'
import type { ChatResponse } from '@/lib/shared/types'

const VALID_SCORE: Score = {
  title: 'C scale',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
    ] },
  ],
}

function resetStores() {
  useChatStore.setState({
    chatId: undefined,
    abc: undefined,
    scoreJson: undefined,
    editedScore: undefined,
    editMap: undefined,
    selection: undefined,
    lastPrompt: undefined,
    introText: undefined,
    pending: false,
    error: undefined,
    history: [],
    historyPointer: -1,
    lastCoalesceKey: undefined,
    lastCoalesceAt: 0,
    turns: [],
    transcriptLoading: false,
    transcriptError: undefined,
    transcriptRetryNonce: 0,
    panelOpen: false,
    cheatSheetOpen: false,
    pendingConfirmation: undefined,
    pendingProposal: undefined,
  })
}

function mockFetchResponse(status: number, json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Build a converse (text) SSE Response body from a list of frames. */
function mockSseResponse(frames: Array<{ event: string; data: unknown }>): Response {
  const body = frames
    .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** Build a sectional score SSE Response (selected via X-Stream-Kind: score). */
function mockScoreSseResponse(frames: Array<{ event: string; data: unknown }>): Response {
  const body = frames
    .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-stream-kind': 'score' },
  })
}

describe('useSubmitPrompt', () => {
  beforeEach(() => {
    resetStores()
  })

  it('appends a user.text turn then an assistant.render_score turn on success', async () => {
    const response: ChatResponse = {
      chatId: 'chat-1',
      abc: 'X:1\nK:C\nC2D2E2F2|',
      introText: 'Here you go.',
      scoreJson: VALID_SCORE,
      toolUseId: 'toolu_resp_1',
    }
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(200, response))
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('a C major scale')
    })

    const turns = useChatStore.getState().turns
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ role: 'user', kind: 'text', text: 'a C major scale' })
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      kind: 'render_score',
      introText: 'Here you go.',
      toolUseId: 'toolu_resp_1',
    })

    expect(useChatStore.getState().chatId).toBe('chat-1')
    expect(useChatStore.getState().abc).toBe(response.abc)
  })

  it('appends a refinement turn when an assistant turn already exists', async () => {
    useChatStore.setState({
      chatId: 'chat-1',
      turns: [
        { role: 'user', kind: 'text', text: 'first' },
        {
          role: 'assistant',
          kind: 'render_score',
          introText: 'one',
          scoreSummary: { title: 'A', key: 'C', meter: '4/4', measureCount: 1 },
          toolUseId: 'toolu_prev',
        },
      ],
    })

    const response: ChatResponse = {
      chatId: 'chat-1',
      abc: 'X:1\nK:G\nG4|',
      introText: 'two',
      scoreJson: { ...VALID_SCORE, key: 'G', title: 'G' },
      toolUseId: 'toolu_resp_2',
    }
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(200, response))
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('now in G')
    })

    const turns = useChatStore.getState().turns
    expect(turns).toHaveLength(4)
    expect(turns[2]).toMatchObject({
      role: 'user',
      kind: 'refinement',
      text: 'now in G',
      hadEdit: false,
      toolUseId: 'toolu_prev',
    })
    expect(turns[3]).toMatchObject({
      role: 'assistant',
      kind: 'render_score',
      toolUseId: 'toolu_resp_2',
    })
  })

  it('on 410 chat_full: keeps the user turn, appends a persistent error turn, does not reset chatId', async () => {
    useChatStore.setState({ chatId: 'chat-1' })
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(410, { code: 'chat_full', error: 'Conversation full.' }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('overflowing')
    })

    const s = useChatStore.getState()
    // The error is now a permanent transcript turn, not just the transient
    // chip — so it survives the next submit.
    expect(s.turns).toHaveLength(2)
    expect(s.turns[0]).toMatchObject({ role: 'user', text: 'overflowing' })
    expect(s.turns[1]).toMatchObject({
      role: 'assistant',
      kind: 'text',
      errored: true,
      errorText: 'Conversation full.',
    })
    expect(s.error).toBe('Conversation full.')
    expect(s.chatId).toBe('chat-1') // not reset
  })

  it('on 410 chat_not_found: keeps the user turn, sets error, resets chatId', async () => {
    useChatStore.setState({ chatId: 'chat-1' })
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(410, { code: 'chat_not_found', error: 'Session expired.' }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('lost session')
    })

    const s = useChatStore.getState()
    expect(s.turns).toHaveLength(1)
    expect(s.chatId).toBeUndefined()
    expect(s.error).toMatch(/Session expired/i)
  })

  it('on network error: keeps the user turn and appends a persistent error turn', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('hi')
    })

    const s = useChatStore.getState()
    expect(s.turns).toHaveLength(2)
    expect(s.turns[1]).toMatchObject({
      role: 'assistant',
      kind: 'text',
      errored: true,
      errorText: 'offline',
    })
    expect(s.error).toBe('offline')
  })

  it('keeps the error turn in the transcript across a later successful submit', async () => {
    // The whole point of persisting errors as turns: a retry must not erase
    // the record of the failure that preceded it.
    global.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('first try')
    })
    expect(useChatStore.getState().turns).toHaveLength(2) // user + error

    const response: ChatResponse = {
      chatId: 'chat-1',
      abc: 'X:1\nK:C\nC2D2E2F2|',
      scoreJson: VALID_SCORE,
      toolUseId: 'toolu_ok',
    }
    global.fetch = vi
      .fn()
      .mockResolvedValue(mockFetchResponse(200, response)) as unknown as typeof fetch
    await act(async () => {
      await result.current.submit('second try')
    })

    const turns = useChatStore.getState().turns
    // user, error (persisted), user, assistant-score — the error stays put.
    expect(turns).toHaveLength(4)
    expect(turns[1]).toMatchObject({ role: 'assistant', errored: true, errorText: 'offline' })
    expect(turns[3]).toMatchObject({
      role: 'assistant',
      kind: 'render_score',
      toolUseId: 'toolu_ok',
    })
    // The transient global error was cleared by the successful submit, but the
    // transcript record remains.
    expect(useChatStore.getState().error).toBeUndefined()
  })

  it('on a score-stream error frame: appends a persistent error turn', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockScoreSseResponse([
        { event: 'header', data: { chatId: 'chat-1' } },
        { event: 'error', data: { error: 'Score model exploded' } },
      ]),
    ) as unknown as typeof fetch

    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('a symphony')
    })

    const s = useChatStore.getState()
    const last = s.turns[s.turns.length - 1]
    expect(last).toMatchObject({
      role: 'assistant',
      kind: 'text',
      errored: true,
      errorText: 'Score model exploded',
    })
    expect(s.error).toBe('Score model exploded')
    expect(s.pending).toBe(false)
  })

  it('on a converse-stream error frame: marks the assistant turn errored and surfaces the message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockSseResponse([
        { event: 'header', data: { chatId: 'chat-1', toolUseId: 'toolu_txt' } },
        { event: 'text-delta', data: { delta: 'Here is the start' } },
        { event: 'error', data: { error: 'Upstream model exploded' } },
      ]),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('say something')
    })

    const s = useChatStore.getState()
    const last = s.turns[s.turns.length - 1]
    // The placeholder assistant turn became a visible error bubble that
    // keeps the partial text that streamed in before the failure.
    expect(last).toMatchObject({
      role: 'assistant',
      kind: 'text',
      text: 'Here is the start',
      errored: true,
      errorText: 'Upstream model exploded',
      streaming: false,
    })
    // The failure also clears `pending` and lands in the global error slot.
    expect(s.pending).toBe(false)
    expect(s.error).toBe('Upstream model exploded')
  })

  it('on a converse stream that drops with no terminal frame: surfaces an interruption', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockSseResponse([
        { event: 'header', data: { chatId: 'chat-1', toolUseId: 'toolu_txt2' } },
        { event: 'text-delta', data: { delta: 'partial' } },
        // No `done` / `error` frame — the stream just ends.
      ]),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('say something')
    })

    const s = useChatStore.getState()
    const last = s.turns[s.turns.length - 1]
    expect(last).toMatchObject({ role: 'assistant', errored: true, streaming: false })
    expect(s.pending).toBe(false)
    expect(s.error).toMatch(/interrupted/i)
  })

  it('ignores blank submissions', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('   ')
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useChatStore.getState().turns).toHaveLength(0)
  })
})

describe('useSubmitPrompt — ghost preview proposal branch (M24-PR-3a)', () => {
  beforeEach(() => {
    resetStores()
  })

  it('detects requiresConfirmation + proposal and stashes pendingProposal (no score swap)', async () => {
    // Seat a baseline edited-score so beforeScore is set on the slot.
    useChatStore.setState({
      chatId: 'chat-1',
      abc: 'X:1\nK:C\nC2D2E2F2|',
      scoreJson: VALID_SCORE,
      editedScore: VALID_SCORE,
    })

    const CANDIDATE: Score = {
      ...VALID_SCORE,
      measures: [
        {
          events: [
            { id: 'a0', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
            { id: 'a1', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
            { id: 'a2', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
            { id: 'a3', pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
          ],
        },
      ],
    }
    const response: ChatResponse = {
      chatId: 'chat-1',
      abc: 'X:1\nK:C\nC2E2E2F2|',
      introText: 'Raised the second note.',
      scoreJson: CANDIDATE,
      toolUseId: 'toolu_prop_1',
      headVersionId: 'head-1',
      requiresConfirmation: true,
      proposal: {
        affectedEventIds: ['a1'],
        candidateVersionId: 'cand-1',
      },
    }
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(200, response))
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('raise the second note')
    })

    const s = useChatStore.getState()
    expect(s.pendingProposal).toBeDefined()
    expect(s.pendingProposal?.chatId).toBe('chat-1')
    expect(s.pendingProposal?.candidateVersionId).toBe('cand-1')
    expect(s.pendingProposal?.candidateScore).toEqual(CANDIDATE)
    expect(s.pendingProposal?.beforeScore).toEqual(VALID_SCORE)
    expect(s.pendingProposal?.affectedEventIds).toEqual(['a1'])
    expect(s.pendingProposal?.abc).toBe('X:1\nK:C\nC2E2E2F2|')
    expect(s.pendingProposal?.introText).toBe('Raised the second note.')
    expect(s.pendingProposal?.toolUseId).toBe('toolu_prop_1')
    expect(s.pendingProposal?.headVersionId).toBe('head-1')
    expect(s.pendingProposal?.presentation).toBe('inline')

    // CRITICAL: the editor's score did NOT swap to the candidate. The
    // pre-proposal score (VALID_SCORE) stays put until the user accepts.
    expect(s.scoreJson).toEqual(VALID_SCORE)
    expect(s.editedScore).toEqual(VALID_SCORE)
    expect(s.abc).toBe('X:1\nK:C\nC2D2E2F2|')

    // Pending flag down so the prompt bar is interactable.
    expect(s.pending).toBe(false)

    // No assistant turn appended — that's the caller's job after the
    // accept network roundtrip succeeds (PR-3c).
    expect(s.turns.filter((t) => t.role === 'assistant')).toHaveLength(0)
  })

  it('replacement branch wins over proposal (mutual exclusion on the client too)', async () => {
    // Defense-in-depth: if the server ever populated BOTH replacement
    // and proposal (a bug), the replacement branch wins because it's
    // checked first. This matches the server-side mutual-exclusion
    // invariant in maybeAttachGhostProposal (proposal hook defers when
    // replacement already set).
    useChatStore.setState({ scoreJson: VALID_SCORE, editedScore: VALID_SCORE })
    const response: ChatResponse = {
      chatId: 'chat-1',
      abc: 'X:1\nK:Am\nA4|',
      scoreJson: { ...VALID_SCORE, key: 'Am' },
      toolUseId: 'toolu_both',
      requiresConfirmation: true,
      replacement: {
        retainedIdentityRatio: 0,
        reasons: ['everything changed'],
        candidateVersionId: 'cand-replace',
      },
      proposal: {
        affectedEventIds: ['a0'],
        candidateVersionId: 'cand-proposal',
      },
    }
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(200, response))
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('make it minor')
    })

    const s = useChatStore.getState()
    expect(s.pendingConfirmation).toBeDefined()
    expect(s.pendingConfirmation?.candidateVersionId).toBe('cand-replace')
    expect(s.pendingProposal).toBeUndefined()
  })

  it('plain success (no proposal, no replacement) still swaps the score', async () => {
    // Regression guard: introducing the new branch must not break the
    // happy path.
    const response: ChatResponse = {
      chatId: 'chat-1',
      abc: 'X:1\nK:C\nC2D2E2F2|',
      scoreJson: VALID_SCORE,
      toolUseId: 'toolu_plain',
    }
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse(200, response))
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submit('a scale')
    })

    const s = useChatStore.getState()
    expect(s.pendingProposal).toBeUndefined()
    expect(s.scoreJson).toEqual(VALID_SCORE)
    expect(s.editedScore).toEqual(VALID_SCORE)
  })
})
