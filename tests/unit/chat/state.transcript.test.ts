import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '@/lib/chat/state'
import type { TranscriptTurn } from '@/lib/shared/types'

function freshStore() {
  useChatStore.setState({
    turns: [],
    transcriptLoading: false,
    transcriptError: undefined,
    transcriptRetryNonce: 0,
    panelOpen: false,
    cheatSheetOpen: false,
  })
}

const USER_TURN: TranscriptTurn = { role: 'user', kind: 'text', text: 'a C major scale' }
const ASSISTANT_TURN: TranscriptTurn = {
  role: 'assistant',
  kind: 'render_score',
  introText: 'Here you go.',
  scoreSummary: { title: 'Mocked', key: 'C', meter: '4/4', measureCount: 1 },
  toolUseId: 'toolu_1',
  scoreHash: 'hash-1',
}

describe('useChatStore — transcript', () => {
  beforeEach(freshStore)

  it('starts with empty turns and the panel closed', () => {
    const s = useChatStore.getState()
    expect(s.turns).toEqual([])
    expect(s.panelOpen).toBe(false)
  })

  it('setTurns replaces wholesale', () => {
    useChatStore.getState().setTurns([USER_TURN, ASSISTANT_TURN])
    expect(useChatStore.getState().turns).toHaveLength(2)
    useChatStore.getState().setTurns([])
    expect(useChatStore.getState().turns).toEqual([])
  })

  it('appendTurns preserves order across calls', () => {
    useChatStore.getState().appendTurns([USER_TURN])
    useChatStore.getState().appendTurns([ASSISTANT_TURN])
    const turns = useChatStore.getState().turns
    expect(turns).toHaveLength(2)
    expect(turns[0]).toEqual(USER_TURN)
    expect(turns[1]).toEqual(ASSISTANT_TURN)
  })

  it('clearTurns empties and clears transcriptError', () => {
    useChatStore.setState({ turns: [USER_TURN], transcriptError: 'boom' })
    useChatStore.getState().clearTurns()
    const s = useChatStore.getState()
    expect(s.turns).toEqual([])
    expect(s.transcriptError).toBeUndefined()
  })

  it('retryTranscriptSync bumps nonce and clears transcriptError', () => {
    useChatStore.setState({ transcriptError: 'network down', transcriptRetryNonce: 3 })
    useChatStore.getState().retryTranscriptSync()
    const s = useChatStore.getState()
    expect(s.transcriptRetryNonce).toBe(4)
    expect(s.transcriptError).toBeUndefined()
  })
})

describe('useChatStore — panel toggle cross-exclusion', () => {
  beforeEach(freshStore)

  it('togglePanel opens the panel and closes cheat sheet', () => {
    useChatStore.setState({ cheatSheetOpen: true })
    useChatStore.getState().togglePanel()
    const s = useChatStore.getState()
    expect(s.panelOpen).toBe(true)
    expect(s.cheatSheetOpen).toBe(false)
  })

  it('togglePanel closes the panel without re-opening the cheat sheet', () => {
    useChatStore.setState({ panelOpen: true })
    useChatStore.getState().togglePanel()
    const s = useChatStore.getState()
    expect(s.panelOpen).toBe(false)
    expect(s.cheatSheetOpen).toBe(false)
  })

  it('toggleCheatSheet opens cheat sheet and closes the panel', () => {
    useChatStore.setState({ panelOpen: true })
    useChatStore.getState().toggleCheatSheet()
    const s = useChatStore.getState()
    expect(s.cheatSheetOpen).toBe(true)
    expect(s.panelOpen).toBe(false)
  })

  it('toggleCheatSheet closing does not reopen the panel', () => {
    useChatStore.setState({ cheatSheetOpen: true })
    useChatStore.getState().toggleCheatSheet()
    const s = useChatStore.getState()
    expect(s.cheatSheetOpen).toBe(false)
    expect(s.panelOpen).toBe(false)
  })

  it('setPanelOpen(true) closes the cheat sheet', () => {
    useChatStore.setState({ cheatSheetOpen: true })
    useChatStore.getState().setPanelOpen(true)
    expect(useChatStore.getState().cheatSheetOpen).toBe(false)
    expect(useChatStore.getState().panelOpen).toBe(true)
  })
})

describe('useChatStore — reset() clears transcript state', () => {
  beforeEach(freshStore)

  it('clears turns and transcript flags', async () => {
    useChatStore.setState({
      turns: [USER_TURN, ASSISTANT_TURN],
      transcriptError: 'old',
      transcriptLoading: true,
    })
    await useChatStore.getState().reset()
    const s = useChatStore.getState()
    expect(s.turns).toEqual([])
    expect(s.transcriptError).toBeUndefined()
    expect(s.transcriptLoading).toBe(false)
  })
})
