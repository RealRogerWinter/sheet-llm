import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, renderHook, act } from '@testing-library/react'
import TransportBar from '@/components/transport/TransportBar'
import { TransportContext } from '@/components/transport/TransportContext'
import { isNaturalEnd, useTransport, type TransportState } from '@/components/transport/useTransport'

const REPEAT_KEY = 'sheet-llm.transportRepeat'

// TransportBar measures itself via ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function makeTransport(overrides: Partial<TransportState> = {}): TransportState {
  return {
    isReady: true,
    isPlaying: false,
    isRebinding: false,
    isSupported: true,
    ended: false,
    totalMs: 10000,
    totalMeasures: 8,
    qpm: 120,
    volume: 0.85,
    muted: false,
    repeat: false,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    restart: vi.fn(),
    seekPercent: vi.fn(),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    toggleRepeat: vi.fn(),
    registerProgressFill: vi.fn(),
    registerScrubberRoot: vi.fn(),
    ...overrides,
  }
}

function renderBar(t: TransportState) {
  return render(
    <TransportContext.Provider value={t}>
      <TransportBar />
    </TransportContext.Provider>,
  )
}

describe('isNaturalEnd', () => {
  it('is true once elapsed reaches duration (within slack)', () => {
    expect(isNaturalEnd(10, 10)).toBe(true)
    expect(isNaturalEnd(9.96, 10)).toBe(true) // 50ms slack
    expect(isNaturalEnd(12, 10)).toBe(true)
  })

  it('is false partway through (a manual stop/seek)', () => {
    expect(isNaturalEnd(4, 10)).toBe(false)
    expect(isNaturalEnd(0, 10)).toBe(false)
  })

  it('never fires when duration is unknown (Infinity)', () => {
    expect(isNaturalEnd(9999, Infinity)).toBe(false)
  })
})

describe('<TransportBar /> repeat toggle', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('has a stable accessible name and reflects off-state via aria-pressed', () => {
    // The name stays "Repeat"; state is carried by aria-pressed (the
    // WAI-ARIA toggle-button pattern), not by a changing label.
    renderBar(makeTransport({ repeat: false }))
    const btn = screen.getByRole('button', { name: 'Repeat' })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  it('reflects the on state via aria-pressed with the same name', () => {
    renderBar(makeTransport({ repeat: true }))
    const btn = screen.getByRole('button', { name: 'Repeat' })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking the button calls toggleRepeat', () => {
    const t = makeTransport({ repeat: false })
    renderBar(t)
    fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
    expect(t.toggleRepeat).toHaveBeenCalledTimes(1)
  })

  it('stays enabled even when the engine is not ready (it is a persisted preference)', () => {
    renderBar(makeTransport({ isReady: false, repeat: false }))
    expect(screen.getByRole('button', { name: 'Repeat' })).toBeEnabled()
  })
})

// Hook-level behavior. Passing `undefined` as the visualObj short-circuits
// the rebuild effect before it dynamically imports abcjs / touches Web
// Audio, so the persistence + hydration paths run in isolation under jsdom.
describe('useTransport repeat persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('defaults repeat to false with no stored preference', () => {
    const { result } = renderHook(() => useTransport(undefined))
    expect(result.current.repeat).toBe(false)
  })

  it('toggleRepeat flips state and writes the preference to localStorage', () => {
    const { result } = renderHook(() => useTransport(undefined))

    act(() => result.current.toggleRepeat())
    expect(result.current.repeat).toBe(true)
    expect(window.localStorage.getItem(REPEAT_KEY)).toBe('1')

    act(() => result.current.toggleRepeat())
    expect(result.current.repeat).toBe(false)
    expect(window.localStorage.getItem(REPEAT_KEY)).toBe('0')
  })

  it('hydrates repeat=true from a stored "1" on mount', () => {
    window.localStorage.setItem(REPEAT_KEY, '1')
    const { result } = renderHook(() => useTransport(undefined))
    expect(result.current.repeat).toBe(true)
  })

  it('ignores a stored value other than "1"', () => {
    window.localStorage.setItem(REPEAT_KEY, 'yes')
    const { result } = renderHook(() => useTransport(undefined))
    expect(result.current.repeat).toBe(false)
  })

  it('survives a throwing localStorage (private mode / quota) — in-memory state still flips', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const { result } = renderHook(() => useTransport(undefined))
    expect(() => act(() => result.current.toggleRepeat())).not.toThrow()
    expect(result.current.repeat).toBe(true)
  })
})
