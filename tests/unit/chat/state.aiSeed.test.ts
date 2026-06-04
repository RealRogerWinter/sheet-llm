import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '@/lib/chat/state'

describe('aiSeed bus (M29-PR-1)', () => {
  beforeEach(() => {
    useChatStore.setState({ aiSeed: undefined })
  })

  it('starts undefined', () => {
    expect(useChatStore.getState().aiSeed).toBeUndefined()
  })

  it('seedAiInput sets the text and bumps the nonce on every call (incl. identical text)', () => {
    useChatStore.getState().seedAiInput('In measure 3, ')
    const a = useChatStore.getState().aiSeed
    expect(a?.text).toBe('In measure 3, ')
    expect(a?.nonce).toBe(1)

    useChatStore.getState().seedAiInput('In measure 3, ')
    expect(useChatStore.getState().aiSeed?.nonce).toBe(2)
  })

  it('carries an optional targetRegion (D5) and omits it when absent', () => {
    useChatStore.getState().seedAiInput('In measure 3, ', { startMeasureIdx: 2, endMeasureIdx: 2 })
    expect(useChatStore.getState().aiSeed?.targetRegion).toEqual({ startMeasureIdx: 2, endMeasureIdx: 2 })

    useChatStore.getState().seedAiInput('plain prompt')
    expect(useChatStore.getState().aiSeed?.targetRegion).toBeUndefined()
  })
})
