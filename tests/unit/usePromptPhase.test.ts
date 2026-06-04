import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePromptPhase } from '@/lib/chat/usePromptPhase'
import { useChatStore } from '@/lib/chat/state'

function resetStore() {
  useChatStore.setState({
    pending: false,
    revealStartedAt: null,
    revealEpoch: 0,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetStore()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePromptPhase', () => {
  it('idle when nothing is happening', () => {
    const { result } = renderHook(() => usePromptPhase())
    expect(result.current).toBe('idle')
  })

  it('composing while pending is true', () => {
    useChatStore.setState({ pending: true })
    const { result } = renderHook(() => usePromptPhase())
    expect(result.current).toBe('composing')
  })

  it('arriving when pending is cleared but a reveal is in flight', () => {
    useChatStore.setState({ pending: false, revealStartedAt: Date.now() })
    const { result } = renderHook(() => usePromptPhase())
    expect(result.current).toBe('arriving')
  })

  it('transitions composing → arriving → done → idle across a full request cycle', () => {
    useChatStore.setState({ pending: true })
    const { result, rerender } = renderHook(() => usePromptPhase())
    expect(result.current).toBe('composing')

    // Response arrived; reveal kicks off.
    act(() => {
      useChatStore.setState({ pending: false, revealStartedAt: Date.now() })
    })
    rerender()
    expect(result.current).toBe('arriving')

    // Reveal completes — revealEpoch bumps, donePulse latches true.
    act(() => {
      useChatStore.getState().markRevealComplete()
    })
    rerender()
    expect(result.current).toBe('done')

    // After the 80ms hold the phase falls back to idle.
    act(() => {
      vi.advanceTimersByTime(120)
    })
    rerender()
    expect(result.current).toBe('idle')
  })

  it('a new request preempts the done hold and goes straight to composing', () => {
    useChatStore.setState({ pending: true })
    const { result, rerender } = renderHook(() => usePromptPhase())

    act(() => {
      useChatStore.setState({ pending: false, revealStartedAt: Date.now() })
    })
    act(() => {
      useChatStore.getState().markRevealComplete()
    })
    rerender()
    expect(result.current).toBe('done')

    act(() => {
      useChatStore.setState({ pending: true })
    })
    rerender()
    expect(result.current).toBe('composing')
  })

  it('pending takes precedence over revealStartedAt (overlap is impossible in practice but defensive)', () => {
    useChatStore.setState({ pending: true, revealStartedAt: Date.now() })
    const { result } = renderHook(() => usePromptPhase())
    expect(result.current).toBe('composing')
  })
})
