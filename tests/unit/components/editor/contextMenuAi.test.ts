import { describe, it, expect, afterEach, vi } from 'vitest'
import { isAiItem, runAiItem } from '@/components/editor/contextMenuAi'
import { useChatStore } from '@/lib/chat/state'

const realSeed = useChatStore.getState().seedAiInput
afterEach(() => {
  useChatStore.setState({ seedAiInput: realSeed })
})

describe('runAiItem (M29-PR-2)', () => {
  it('isAiItem recognizes ai:* ids only', () => {
    expect(isAiItem('ai:edit')).toBe(true)
    expect(isAiItem('copy')).toBe(false)
  })

  it('Edit-with-AI on a note seeds a 1-based prompt + the 0-based region (D5)', () => {
    const seedAiInput = vi.fn()
    useChatStore.setState({ seedAiInput })
    runAiItem('ai:edit', { kind: 'note', selection: { measureIdx: 4, eventIdx: 0 } })
    expect(seedAiInput).toHaveBeenCalledWith('In measure 5, ', { startMeasureIdx: 4, endMeasureIdx: 4 })
  })

  it('Regenerate on a measure seeds a rewrite prompt + region', () => {
    const seedAiInput = vi.fn()
    useChatStore.setState({ seedAiInput })
    runAiItem('ai:regenerate', { kind: 'measure', measureIdx: 2, insertAfterIdx: 0, staffIdx: 0 })
    expect(seedAiInput).toHaveBeenCalledWith('Rewrite measure 3 entirely: ', { startMeasureIdx: 2, endMeasureIdx: 2 })
  })

  it('Regenerate-range seeds an inclusive 1-based range prompt + the range region', () => {
    const seedAiInput = vi.fn()
    useChatStore.setState({ seedAiInput })
    runAiItem('ai:regenerate-range', { kind: 'range', range: { fromStart: 1, fromEnd: 3 } })
    expect(seedAiInput).toHaveBeenCalledWith('Rewrite measures 2–4: ', { startMeasureIdx: 1, endMeasureIdx: 3 })
  })

  it('Explain on a measure seeds an explain prompt + region', () => {
    const seedAiInput = vi.fn()
    useChatStore.setState({ seedAiInput })
    runAiItem('ai:explain', { kind: 'measure', measureIdx: 0, insertAfterIdx: 0, staffIdx: 0 })
    expect(seedAiInput).toHaveBeenCalledWith('Explain measure 1', { startMeasureIdx: 0, endMeasureIdx: 0 })
  })
})
