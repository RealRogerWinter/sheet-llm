import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import { isClipboardItem, runClipboardItem } from '@/components/editor/contextMenuClipboard'
import { copyMeasureRange } from '@/lib/chat/clipboard'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

// Stub the system-clipboard sidecar (D3): mirror is a no-op so copy/cut
// tests never touch a real Clipboard API; readSystemClipboardEntry is
// controllable for the foreign-paste fallback test.
vi.mock('@/components/editor/systemClipboard', () => ({
  mirrorToSystemClipboard: vi.fn().mockResolvedValue(undefined),
  readSystemClipboardEntry: vi.fn().mockResolvedValue(null),
}))
import { readSystemClipboardEntry } from '@/components/editor/systemClipboard'

const real = {
  setClipboard: useChatStore.getState().setClipboard,
  applyBalancedEdit: useChatStore.getState().applyBalancedEdit,
  applyEdit: useChatStore.getState().applyEdit,
  applyScore: useChatStore.getState().applyScore,
  requestMeasureDelete: useChatStore.getState().requestMeasureDelete,
  showStatusMessage: useChatStore.getState().showStatusMessage,
  selectRun: useChatStore.getState().selectRun,
}

const note = (step: string) => ({ pitches: [{ step, octave: 4 }], duration: 'quarter' })
const noteScore = (): Score =>
  ({ key: 'C', meter: '4/4', measures: [{ events: [note('C')] }] } as unknown as Score)
// Four quarters = a full 4/4 bar — enough for a multi-event run.
const fourNoteScore = (): Score =>
  ({ key: 'C', meter: '4/4', measures: [{ events: [note('C'), note('D'), note('E'), note('F')] }] } as unknown as Score)
const emptyBarScore = (): Score =>
  ({ key: 'C', meter: '4/4', measures: [{ events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] }] } as unknown as Score)

afterEach(() => {
  useChatStore.setState({ ...real, editedScore: undefined, clipboard: undefined, runSelection: undefined })
})

describe('runClipboardItem (M28-PR-3)', () => {
  it('isClipboardItem recognizes cut/copy/paste only', () => {
    expect(isClipboardItem('copy')).toBe(true)
    expect(isClipboardItem('cut')).toBe(true)
    expect(isClipboardItem('paste')).toBe(true)
    expect(isClipboardItem('play')).toBe(false)
  })

  it('Copy on a note writes an events clipboard entry', () => {
    const setClipboard = vi.fn()
    useChatStore.setState({ editedScore: noteScore(), setClipboard })
    runClipboardItem('copy', { kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } })
    expect(setClipboard).toHaveBeenCalledTimes(1)
    expect(setClipboard.mock.calls[0][0].kind).toBe('events')
  })

  it('Cut on a note copies then removes (one mutating commit)', () => {
    const setClipboard = vi.fn()
    const applyBalancedEdit = vi.fn()
    useChatStore.setState({ editedScore: noteScore(), setClipboard, applyBalancedEdit })
    runClipboardItem('cut', { kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } })
    expect(setClipboard).toHaveBeenCalled()
    expect(applyBalancedEdit).toHaveBeenCalledWith({ kind: 'removeBalanced', selection: { measureIdx: 0, eventIdx: 0 } })
  })

  it('Cut on a measure routes through requestMeasureDelete', () => {
    const setClipboard = vi.fn()
    const requestMeasureDelete = vi.fn()
    useChatStore.setState({ editedScore: noteScore(), setClipboard, requestMeasureDelete })
    runClipboardItem('cut', { kind: 'measure', measureIdx: 0, insertAfterIdx: 0, staffIdx: 0 })
    expect(requestMeasureDelete).toHaveBeenCalledWith({ fromStart: 0, fromEnd: 0 })
  })

  it('Paste of an events clipboard onto a note commits the pasted score', () => {
    const applyScore = vi.fn()
    const clipboard = {
      kind: 'events' as const,
      events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' }],
      sourceMeta: { meter: '4/4', staffIdx: 0, voiceIdx: 0, totalUnits: 8 },
    }
    useChatStore.setState({ editedScore: emptyBarScore(), clipboard: clipboard as never, applyScore })
    runClipboardItem('paste', { kind: 'note', selection: { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0 } })
    expect(applyScore).toHaveBeenCalledTimes(1)
  })

  it('Paste of a measures clipboard onto a measure dispatches insertMeasuresAfter', () => {
    const applyEdit = vi.fn()
    const clip = copyMeasureRange(noteScore(), { fromStart: 0, fromEnd: 0 })
    useChatStore.setState({ editedScore: noteScore(), clipboard: clip, applyEdit })
    runClipboardItem('paste', { kind: 'measure', measureIdx: 1, insertAfterIdx: 0, staffIdx: 0 })
    expect(applyEdit).toHaveBeenCalledTimes(1)
    expect(applyEdit.mock.calls[0][0].kind).toBe('insertMeasuresAfter')
  })
})

const coveringRun = { staffIdx: 0, voiceIdx: 0, measureIdx: 0, startEventIdx: 1, endEventIdx: 2 }
const sel = (eventIdx: number) => ({ staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx })

describe('runClipboardItem — run-aware Copy/Cut (D2)', () => {
  it('Copy on a note INSIDE the active run copies the whole run, not the single note', () => {
    const setClipboard = vi.fn()
    useChatStore.setState({ editedScore: fourNoteScore(), setClipboard, runSelection: coveringRun })
    runClipboardItem('copy', { kind: 'note', selection: sel(1) })
    expect(setClipboard).toHaveBeenCalledTimes(1)
    const entry = setClipboard.mock.calls[0][0]
    expect(entry.kind).toBe('events')
    expect(entry.events).toHaveLength(2) // D + E (the run)
  })

  it('Copy on a note OUTSIDE the active run copies just that single note', () => {
    const setClipboard = vi.fn()
    useChatStore.setState({ editedScore: fourNoteScore(), setClipboard, runSelection: coveringRun })
    runClipboardItem('copy', { kind: 'note', selection: sel(0) }) // not in [1,2]
    expect(setClipboard.mock.calls[0][0].events).toHaveLength(1)
  })

  it('Cut on a note inside the active run commits a score edit (run→rests) and clears the run', () => {
    const setClipboard = vi.fn()
    const applyScore = vi.fn()
    const applyBalancedEdit = vi.fn()
    const selectRun = vi.fn()
    useChatStore.setState({
      editedScore: fourNoteScore(),
      setClipboard,
      applyScore,
      applyBalancedEdit,
      selectRun,
      runSelection: coveringRun,
    })
    runClipboardItem('cut', { kind: 'note', selection: sel(1) })
    expect(applyScore).toHaveBeenCalledTimes(1)
    expect(applyBalancedEdit).not.toHaveBeenCalled() // NOT the single-event path
    expect(selectRun).toHaveBeenCalledWith(undefined)
  })

  it('Cut on a note outside the active run falls back to the single-event removeBalanced', () => {
    const setClipboard = vi.fn()
    const applyScore = vi.fn()
    const applyBalancedEdit = vi.fn()
    useChatStore.setState({
      editedScore: fourNoteScore(),
      setClipboard,
      applyScore,
      applyBalancedEdit,
      runSelection: coveringRun,
    })
    runClipboardItem('cut', { kind: 'note', selection: sel(0) })
    expect(applyBalancedEdit).toHaveBeenCalledWith({ kind: 'removeBalanced', selection: sel(0) })
    expect(applyScore).not.toHaveBeenCalled()
  })
})

describe('runClipboardItem — foreign system-clipboard paste (D3)', () => {
  afterEach(() => {
    ;(readSystemClipboardEntry as Mock).mockResolvedValue(null)
  })

  it('falls back to the system clipboard when the in-memory slot is empty, adopting the entry', async () => {
    const applyScore = vi.fn()
    const setClipboard = vi.fn()
    const foreign = {
      kind: 'events' as const,
      events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' }],
      sourceMeta: { meter: '4/4', staffIdx: 0, voiceIdx: 0, totalUnits: 8 },
    }
    ;(readSystemClipboardEntry as Mock).mockResolvedValue(foreign)
    useChatStore.setState({ editedScore: emptyBarScore(), clipboard: undefined, applyScore, setClipboard })
    await runClipboardItem('paste', { kind: 'note', selection: { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0 } })
    expect(setClipboard).toHaveBeenCalledWith(foreign) // adopted into the in-memory slot
    expect(applyScore).toHaveBeenCalledTimes(1)
  })

  it('does nothing when both the in-memory slot and the system clipboard are empty', async () => {
    const applyScore = vi.fn()
    ;(readSystemClipboardEntry as Mock).mockResolvedValue(null)
    useChatStore.setState({ editedScore: emptyBarScore(), clipboard: undefined, applyScore })
    await runClipboardItem('paste', { kind: 'note', selection: { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0 } })
    expect(applyScore).not.toHaveBeenCalled()
  })

  it('prefers the in-memory slot — does NOT read the system clipboard when a clip is present', async () => {
    const applyScore = vi.fn()
    const clipboard = {
      kind: 'events' as const,
      events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' }],
      sourceMeta: { meter: '4/4', staffIdx: 0, voiceIdx: 0, totalUnits: 8 },
    }
    ;(readSystemClipboardEntry as Mock).mockClear()
    useChatStore.setState({ editedScore: emptyBarScore(), clipboard: clipboard as never, applyScore })
    await runClipboardItem('paste', { kind: 'note', selection: { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0 } })
    expect(applyScore).toHaveBeenCalledTimes(1)
    expect(readSystemClipboardEntry as Mock).not.toHaveBeenCalled()
  })
})
