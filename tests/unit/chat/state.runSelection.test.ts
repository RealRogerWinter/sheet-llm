import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore, type RunSelection } from '@/lib/chat/state'

/**
 * Tests for the D2 intra-measure `runSelection` store slot, its setter
 * (`selectRun`), and the invariant that a plain `select()` clears it (a
 * fresh single selection ends the run).
 */

const RUN: RunSelection = {
  staffIdx: 0,
  voiceIdx: 0,
  measureIdx: 0,
  startEventIdx: 1,
  endEventIdx: 3,
}

beforeEach(() => {
  useChatStore.setState({ selection: undefined, runSelection: undefined })
})

describe('runSelection store slot (D2)', () => {
  it('selectRun sets the run', () => {
    useChatStore.getState().selectRun(RUN)
    expect(useChatStore.getState().runSelection).toEqual(RUN)
  })

  it('selectRun(undefined) clears the run', () => {
    useChatStore.getState().selectRun(RUN)
    useChatStore.getState().selectRun(undefined)
    expect(useChatStore.getState().runSelection).toBeUndefined()
  })

  it('a plain select() clears any active run', () => {
    useChatStore.getState().selectRun(RUN)
    useChatStore.getState().select({ measureIdx: 0, eventIdx: 0 })
    expect(useChatStore.getState().runSelection).toBeUndefined()
    expect(useChatStore.getState().selection).toEqual({ measureIdx: 0, eventIdx: 0 })
  })

  it('select(undefined) also clears the run', () => {
    useChatStore.getState().selectRun(RUN)
    useChatStore.getState().select(undefined)
    expect(useChatStore.getState().runSelection).toBeUndefined()
  })
})
