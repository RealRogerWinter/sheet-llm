import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef } from 'react'
import { useScoreReveal } from '@/lib/abc/useScoreReveal'
import { useChatStore } from '@/lib/chat/state'
import { useDebugStore } from '@/lib/debug/debugStore'

interface MockAnimation {
  cancel: ReturnType<typeof vi.fn>
  finished: Promise<void>
  _resolve: () => void
  keyframes: Keyframe[] | PropertyIndexedKeyframes | null
  options: KeyframeAnimationOptions | number | undefined
}

let mockAnimations: MockAnimation[] = []
let animateSpy: ReturnType<typeof vi.fn>

function installAnimateStub() {
  mockAnimations = []
  animateSpy = vi.fn(function (
    this: HTMLElement,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ) {
    let resolve!: () => void
    const finished = new Promise<void>((r) => { resolve = r })
    const anim: MockAnimation = {
      cancel: vi.fn(),
      finished,
      _resolve: resolve,
      keyframes,
      options,
    }
    mockAnimations.push(anim)
    return anim as unknown as Animation
  })
  ;(Element.prototype as unknown as { animate: typeof animateSpy }).animate = animateSpy
}

function uninstallAnimateStub() {
  delete (Element.prototype as { animate?: unknown }).animate
}

function makeContainer(targetCount: number, kinds?: Array<'note' | 'bar' | 'rest'>) {
  const container = document.createElement('div')
  for (let i = 0; i < targetCount; i++) {
    const kind = kinds?.[i] ?? 'note'
    const el = document.createElement('div')
    el.classList.add(`abcjs-${kind}`)
    el.style.opacity = '0'
    container.appendChild(el)
  }
  document.body.appendChild(container)
  return container
}

function resetStores() {
  useChatStore.setState({
    revealEpoch: 0,
    revealStartedAt: null,
    reduceMotion: false,
  })
  useDebugStore.setState({ revealAnimationEnabled: true })
}

beforeEach(() => {
  installAnimateStub()
  resetStores()
})

afterEach(() => {
  uninstallAnimateStub()
  document.body.innerHTML = ''
})

describe('useScoreReveal', () => {
  it('does nothing on the initial mount (trigger 0)', () => {
    const container = makeContainer(3)
    renderHook(() => {
      const ref = useRef(container)
      useScoreReveal(ref, { trigger: 0 })
    })
    expect(animateSpy).not.toHaveBeenCalled()
  })

  it('calls animate() once per target with monotonically increasing delays', () => {
    const container = makeContainer(4, ['note', 'note', 'note', 'note'])
    renderHook(() => {
      const ref = useRef(container)
      useScoreReveal(ref, { trigger: 1 })
    })

    expect(animateSpy).toHaveBeenCalledTimes(4)
    const delays = mockAnimations.map((a) => (a.options as KeyframeAnimationOptions).delay ?? 0)
    expect(delays).toEqual([0, 60, 120, 180])
  })

  it('compresses stagger so total reveal stays under the 3.2s budget for long scores', () => {
    // 200 targets at the base 60ms stagger would push way past 3.2s
    // (200 × 60 + 300 = 12.3s). The compressed stagger should keep
    // (n-1) * stagger + duration ≤ 3200ms.
    const container = makeContainer(200)
    renderHook(() => {
      const ref = useRef(container)
      useScoreReveal(ref, { trigger: 1 })
    })

    const last = mockAnimations[mockAnimations.length - 1]
    const lastDelay = (last.options as KeyframeAnimationOptions).delay as number
    const lastDuration = (last.options as KeyframeAnimationOptions).duration as number
    expect(lastDelay + lastDuration).toBeLessThanOrEqual(3200)
  })

  it('barlines get a 30ms head-start over the matching note delay', () => {
    const container = makeContainer(2, ['bar', 'note'])
    renderHook(() => {
      const ref = useRef(container)
      useScoreReveal(ref, { trigger: 1 })
    })

    const barDelay = (mockAnimations[0].options as KeyframeAnimationOptions).delay
    const barDuration = (mockAnimations[0].options as KeyframeAnimationOptions).duration
    expect(barDelay).toBe(0) // Math.max(0, 0 - 30)
    expect(barDuration).toBe(200)
  })

  it('marks reveal started immediately and complete after all animations finish', async () => {
    const container = makeContainer(2)
    renderHook(() => {
      const ref = useRef(container)
      useScoreReveal(ref, { trigger: 1 })
    })

    expect(useChatStore.getState().revealStartedAt).not.toBeNull()

    await act(async () => {
      mockAnimations.forEach((a) => a._resolve())
      // Flush microtasks for the Promise.all chain.
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useChatStore.getState().revealStartedAt).toBeNull()
    expect(useChatStore.getState().revealEpoch).toBe(1)
    const targets = container.querySelectorAll('.abcjs-note')
    targets.forEach((el) => {
      expect((el as HTMLElement).style.opacity).toBe('')
    })
  })

  it('cleanup cancels all in-flight animations and clears inline styles on re-trigger', () => {
    const container = makeContainer(3)
    const { rerender } = renderHook(
      ({ trigger }: { trigger: number }) => {
        const ref = useRef(container)
        useScoreReveal(ref, { trigger })
      },
      { initialProps: { trigger: 1 } },
    )

    const firstBatch = [...mockAnimations]
    expect(firstBatch).toHaveLength(3)

    rerender({ trigger: 2 })

    // First batch's cancel must have fired.
    firstBatch.forEach((a) => expect(a.cancel).toHaveBeenCalled())
    // Second batch was started.
    expect(mockAnimations.length).toBe(6)
  })

  it('honors reduceMotion: single 220ms ease-out crossfade, no stagger', () => {
    useChatStore.setState({ reduceMotion: true })
    const container = makeContainer(5)
    renderHook(() => {
      const ref = useRef(container)
      useScoreReveal(ref, { trigger: 1 })
    })

    expect(animateSpy).toHaveBeenCalledTimes(5)
    mockAnimations.forEach((a) => {
      const opts = a.options as KeyframeAnimationOptions
      expect(opts.duration).toBe(220)
      expect(opts.easing).toBe('ease-out')
      // No delay → all start together.
      expect(opts.delay ?? 0).toBe(0)
    })
  })

  it('skips animation and clears opacity:0 when revealAnimationEnabled is false', () => {
    useDebugStore.setState({ revealAnimationEnabled: false })
    const container = makeContainer(3)
    container.querySelectorAll('.abcjs-note').forEach((el) => {
      expect((el as HTMLElement).style.opacity).toBe('0')
    })

    renderHook(() => {
      const ref = useRef(container)
      useScoreReveal(ref, { trigger: 1 })
    })

    expect(animateSpy).not.toHaveBeenCalled()
    container.querySelectorAll('.abcjs-note').forEach((el) => {
      expect((el as HTMLElement).style.opacity).toBe('')
    })
  })

  it('does nothing (and does not bump epoch) when there are no targets', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    renderHook(() => {
      const ref = useRef(container)
      useScoreReveal(ref, { trigger: 1 })
    })
    expect(animateSpy).not.toHaveBeenCalled()
    expect(useChatStore.getState().revealStartedAt).toBeNull()
  })
})
