import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLongPress } from '@/components/editor/useLongPress'

// createLongPress reads only pointerType / isPrimary / clientX / clientY, so a
// plain object cast to PointerEvent is a faithful stand-in.
function pe(init: Partial<PointerEvent>): PointerEvent {
  return { pointerType: 'touch', isPrimary: true, clientX: 0, clientY: 0, ...init } as PointerEvent
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createLongPress', () => {
  it('fires after the hold duration for a primary touch pointer', () => {
    const onLongPress = vi.fn()
    const lp = createLongPress({ durationMs: 500, onLongPress })
    lp.onPointerDown(pe({ clientX: 10, clientY: 10 }))
    expect(onLongPress).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('cancels when the pointer moves past tolerance before firing', () => {
    const onLongPress = vi.fn()
    const lp = createLongPress({ durationMs: 500, moveTolerancePx: 10, onLongPress })
    lp.onPointerDown(pe({ clientX: 0, clientY: 0 }))
    lp.onPointerMove(pe({ clientX: 0, clientY: 30 })) // 30px > 10px tolerance
    vi.advanceTimersByTime(500)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('does not cancel for sub-tolerance jitter', () => {
    const onLongPress = vi.fn()
    const lp = createLongPress({ durationMs: 500, moveTolerancePx: 10, onLongPress })
    lp.onPointerDown(pe({ clientX: 0, clientY: 0 }))
    lp.onPointerMove(pe({ clientX: 3, clientY: 3 })) // ~4.2px < 10px
    vi.advanceTimersByTime(500)
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('cancels on pointerup before the hold completes', () => {
    const onLongPress = vi.fn()
    const lp = createLongPress({ durationMs: 500, onLongPress })
    lp.onPointerDown(pe({}))
    lp.onPointerUp(pe({}))
    vi.advanceTimersByTime(500)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('cancels on pointercancel', () => {
    const onLongPress = vi.fn()
    const lp = createLongPress({ durationMs: 500, onLongPress })
    lp.onPointerDown(pe({}))
    lp.onPointerCancel(pe({}))
    vi.advanceTimersByTime(500)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('ignores mouse pointers (desktop keeps native right-click)', () => {
    const onLongPress = vi.fn()
    const lp = createLongPress({ durationMs: 500, onLongPress })
    lp.onPointerDown(pe({ pointerType: 'mouse' }))
    vi.advanceTimersByTime(500)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('ignores non-primary pointers (a second finger)', () => {
    const onLongPress = vi.fn()
    const lp = createLongPress({ durationMs: 500, onLongPress })
    lp.onPointerDown(pe({ isPrimary: false }))
    vi.advanceTimersByTime(500)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('passes the originating pointerdown event to onLongPress', () => {
    const onLongPress = vi.fn()
    const lp = createLongPress({ durationMs: 500, onLongPress })
    const down = pe({ clientX: 42, clientY: 7 })
    lp.onPointerDown(down)
    vi.advanceTimersByTime(500)
    expect(onLongPress).toHaveBeenCalledWith(down)
  })
})
