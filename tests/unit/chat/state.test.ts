import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

const VALID_SCORE: Score = {
  title: 'C major scale',
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

function freshStore() {
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
  })
}

describe('useChatStore — core', () => {
  beforeEach(freshStore)

  it('starts in an empty state', () => {
    const s = useChatStore.getState()
    expect(s.chatId).toBeUndefined()
    expect(s.abc).toBeUndefined()
    expect(s.pending).toBe(false)
    expect(s.history).toEqual([])
    expect(s.historyPointer).toBe(-1)
  })

  it('beginRequest sets pending + lastPrompt and clears error', () => {
    useChatStore.setState({ error: 'previous error' })
    useChatStore.getState().beginRequest('a C major scale')
    const s = useChatStore.getState()
    expect(s.pending).toBe(true)
    expect(s.lastPrompt).toBe('a C major scale')
    expect(s.error).toBeUndefined()
  })

  it('resolveRequest stores abc + scoreJson + initializes editor state', () => {
    useChatStore.getState().beginRequest('scale')
    useChatStore.getState().resolveRequest('X:1\nK:C', VALID_SCORE, 'Here you go:')
    const s = useChatStore.getState()
    expect(s.pending).toBe(false)
    expect(s.scoreJson).toEqual(VALID_SCORE)
    expect(s.editedScore).toEqual(VALID_SCORE)
    expect(s.editMap).toBeDefined()
    expect(s.history).toHaveLength(1)
    expect(s.history[0]).toEqual(VALID_SCORE)
    expect(s.historyPointer).toBe(0)
    expect(s.introText).toBe('Here you go:')
  })

  it('failRequest stores error and clears pending', () => {
    useChatStore.getState().beginRequest('thing')
    useChatStore.getState().failRequest('boom')
    const s = useChatStore.getState()
    expect(s.pending).toBe(false)
    expect(s.error).toBe('boom')
  })

  it('failRequest with resetChatId clears chat id + abc + editor state', () => {
    useChatStore.setState({ chatId: 'abc-id', abc: 'X:1\nK:C\nC|', editedScore: VALID_SCORE, history: [VALID_SCORE], historyPointer: 0 })
    useChatStore.getState().failRequest('expired', { resetChatId: true })
    const s = useChatStore.getState()
    expect(s.chatId).toBeUndefined()
    expect(s.abc).toBeUndefined()
    expect(s.editedScore).toBeUndefined()
    expect(s.history).toEqual([])
  })

  it('clearError clears just the error', () => {
    useChatStore.setState({ error: 'x', abc: 'X:1\nK:C\nC|' })
    useChatStore.getState().clearError()
    expect(useChatStore.getState().error).toBeUndefined()
    expect(useChatStore.getState().abc).toBe('X:1\nK:C\nC|')
  })

  it('reset clears everything and calls DELETE /api/chat when chatId is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    global.fetch = fetchMock as unknown as typeof fetch

    useChatStore.setState({
      chatId: 'test-id',
      abc: 'X:1',
      scoreJson: VALID_SCORE,
      editedScore: VALID_SCORE,
      history: [VALID_SCORE],
      historyPointer: 0,
    })

    await useChatStore.getState().reset()

    const s = useChatStore.getState()
    expect(s.chatId).toBeUndefined()
    expect(s.abc).toBeUndefined()
    expect(s.editedScore).toBeUndefined()
    expect(s.history).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith('/api/chat?chatId=test-id', { method: 'DELETE' })
  })

  it('reset without chatId still clears local state and does not call DELETE', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    useChatStore.setState({ abc: 'X:1', error: 'err' })
    await useChatStore.getState().reset()

    expect(useChatStore.getState().abc).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('useChatStore — editor', () => {
  beforeEach(() => {
    freshStore()
    useChatStore.getState().resolveRequest('X:1\nK:C', VALID_SCORE)
  })

  it('select sets selection', () => {
    useChatStore.getState().select({ measureIdx: 0, eventIdx: 1 })
    expect(useChatStore.getState().selection).toEqual({ measureIdx: 0, eventIdx: 1 })
  })

  it('applyEdit mutates editedScore and pushes a history snapshot', () => {
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    const s = useChatStore.getState()
    // First pitch was C; +1 step → D.
    expect(s.editedScore!.measures[0].events[0].pitches[0].step).toBe('D')
    expect(s.history).toHaveLength(2)
    expect(s.historyPointer).toBe(1)
  })

  it('undo moves back through history', () => {
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    useChatStore.getState().undo()
    const s = useChatStore.getState()
    expect(s.historyPointer).toBe(0)
    expect(s.editedScore!.measures[0].events[0].pitches[0].step).toBe('C')
  })

  it('redo moves forward through history', () => {
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    useChatStore.getState().undo()
    useChatStore.getState().redo()
    const s = useChatStore.getState()
    expect(s.historyPointer).toBe(1)
    expect(s.editedScore!.measures[0].events[0].pitches[0].step).toBe('D')
  })

  it('canUndo / canRedo report stack bounds', () => {
    expect(useChatStore.getState().canUndo()).toBe(false)
    expect(useChatStore.getState().canRedo()).toBe(false)

    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    expect(useChatStore.getState().canUndo()).toBe(true)
    expect(useChatStore.getState().canRedo()).toBe(false)

    useChatStore.getState().undo()
    expect(useChatStore.getState().canUndo()).toBe(false)
    expect(useChatStore.getState().canRedo()).toBe(true)
  })

  it('new edit after undo truncates the redo branch', () => {
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaStep: 1,
    })
    expect(useChatStore.getState().history).toHaveLength(3)

    useChatStore.getState().undo()
    expect(useChatStore.getState().historyPointer).toBe(1)

    useChatStore.getState().applyEdit({ kind: 'changeKey', key: 'G' })
    const s = useChatStore.getState()
    // Redo branch should be cleared; history length now 3 (initial + first edit + new edit).
    expect(s.history).toHaveLength(3)
    expect(s.historyPointer).toBe(2)
    expect(s.canRedo()).toBe(false)
  })

  it('coalesce key collapses repeated same-key edits within the window', () => {
    useChatStore.getState().applyEdit(
      { kind: 'changePitch', target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 }, deltaStep: 1 },
      'pitch-up:0:0',
    )
    useChatStore.getState().applyEdit(
      { kind: 'changePitch', target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 }, deltaStep: 1 },
      'pitch-up:0:0',
    )
    const s = useChatStore.getState()
    // Coalesced — still only 2 entries (initial + one combined edit), not 3.
    expect(s.history).toHaveLength(2)
    // Final state reflects both edits: C +2 = E.
    expect(s.editedScore!.measures[0].events[0].pitches[0].step).toBe('E')
  })

  it('applyEdit captures EditError as a user-visible error and does not advance history', () => {
    // changePitch on octave 9 with +octave would push it past the [0,9] ceiling.
    useChatStore.setState({
      editedScore: {
        ...VALID_SCORE,
        measures: [{ events: [{ pitches: [{ step: 'C', octave: 9 }], duration: 'whole' }] }],
      },
    })
    const initialHistoryLen = useChatStore.getState().history.length
    useChatStore.getState().applyEdit({
      kind: 'changePitch',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      deltaOctave: 1,
    })
    const s = useChatStore.getState()
    expect(s.error).toMatch(/octave.*out of/i)
    expect(s.history).toHaveLength(initialHistoryLen)
  })

  it('resetEditsToLLM restores the last LLM score and clears edit history', () => {
    useChatStore.getState().applyEdit({ kind: 'changeKey', key: 'G' })
    expect(useChatStore.getState().editedScore!.key).toBe('G')

    useChatStore.getState().resetEditsToLLM()
    const s = useChatStore.getState()
    expect(s.editedScore!.key).toBe('C')
    expect(s.history).toEqual([VALID_SCORE])
    expect(s.historyPointer).toBe(0)
  })
})
