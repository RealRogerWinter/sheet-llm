import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import Popover from '@/components/editor/Popover'

afterEach(() => cleanup())

describe('Popover (shared shell)', () => {
  it('renders the child inside a dialog when open', () => {
    render(
      <Popover open anchorX={400} anchorY={100} ariaLabel="Test" onClose={vi.fn()}>
        <div>hello</div>
      </Popover>,
    )
    expect(screen.getByRole('dialog', { name: 'Test' })).toBeDefined()
    expect(screen.getByText('hello')).toBeDefined()
  })

  it('renders nothing when open=false', () => {
    render(
      <Popover open={false} anchorX={400} anchorY={100} ariaLabel="Test" onClose={vi.fn()}>
        <div>hidden</div>
      </Popover>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('hidden')).toBeNull()
  })

  it('Escape closes the popover (and stops propagation so the surrounding selection survives)', () => {
    const onClose = vi.fn()
    render(
      <Popover open anchorX={400} anchorY={100} ariaLabel="Test" onClose={onClose}>
        <div>x</div>
      </Popover>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose when closed (no listener attached)', () => {
    const onClose = vi.fn()
    render(
      <Popover open={false} anchorX={400} anchorY={100} ariaLabel="Test" onClose={onClose}>
        <div>x</div>
      </Popover>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('positions below the anchor when there is room', () => {
    // jsdom default innerHeight is 768; estimatedHeight 200 → 100 + 200 < 760.
    render(
      <Popover open anchorX={400} anchorY={100} ariaLabel="Test" onClose={vi.fn()}>
        <div>x</div>
      </Popover>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Test' })
    const style = dialog.getAttribute('style') ?? ''
    // Below = anchorY + 8 = 108
    expect(style).toContain('top: 108px')
  })

  it('flips above the anchor when below would clip the viewport', () => {
    // Place the anchor near the bottom — below would overflow.
    const innerH = window.innerHeight
    render(
      <Popover
        open
        anchorX={400}
        anchorY={innerH - 50}
        estimatedHeight={200}
        ariaLabel="Test"
        onClose={vi.fn()}
      >
        <div>x</div>
      </Popover>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Test' })
    const style = dialog.getAttribute('style') ?? ''
    // Above = max(8, anchorY - estimatedHeight - 8) = max(8, innerH - 50 - 208)
    const expectedTop = Math.max(8, innerH - 50 - 200 - 8)
    expect(style).toContain(`top: ${expectedTop}px`)
  })

  it('clamps horizontally so the popover does not run off the right edge', () => {
    const innerW = window.innerWidth
    render(
      <Popover
        open
        anchorX={innerW + 1000}
        anchorY={100}
        estimatedWidth={320}
        ariaLabel="Test"
        onClose={vi.fn()}
      >
        <div>x</div>
      </Popover>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Test' })
    const style = dialog.getAttribute('style') ?? ''
    // Right-clamp: left = innerWidth - 320 - 8
    expect(style).toContain(`left: ${innerW - 320 - 8}px`)
  })

  it('clamps horizontally so the popover does not run off the left edge', () => {
    render(
      <Popover
        open
        anchorX={-1000}
        anchorY={100}
        estimatedWidth={320}
        ariaLabel="Test"
        onClose={vi.fn()}
      >
        <div>x</div>
      </Popover>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Test' })
    const style = dialog.getAttribute('style') ?? ''
    // Left-clamp: left = 8
    expect(style).toContain('left: 8px')
  })

  it('stops mouseDown so a click inside does not bubble to React parent handlers', () => {
    // Guards against the ScorePanel's click-to-dismiss-selection
    // handler firing when the user clicks inside an open popover.
    const parentMouseDown = vi.fn()
    render(
      <div onMouseDown={parentMouseDown}>
        <Popover open anchorX={400} anchorY={100} ariaLabel="Test" onClose={vi.fn()}>
          <div>x</div>
        </Popover>
      </div>,
    )
    fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Test' }))
    expect(parentMouseDown).not.toHaveBeenCalled()
  })

  it('merges className onto the popover root alongside the shared skeleton class', () => {
    render(
      <Popover
        open
        anchorX={400}
        anchorY={100}
        ariaLabel="Test"
        onClose={vi.fn()}
        className="caller-class"
      >
        <div>x</div>
      </Popover>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Test' })
    expect(dialog.className).toContain('caller-class')
    // Skeleton class is a CSS-module hash; just assert there's at
    // least one other class present so we know merge happened.
    expect(dialog.className.split(' ').length).toBeGreaterThanOrEqual(2)
  })

  it('merges style overrides on top of computed left/top', () => {
    render(
      <Popover
        open
        anchorX={400}
        anchorY={100}
        ariaLabel="Test"
        onClose={vi.fn()}
        style={{ width: 480, opacity: 0.9 }}
      >
        <div>x</div>
      </Popover>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Test' })
    const style = dialog.getAttribute('style') ?? ''
    expect(style).toContain('width: 480px')
    expect(style).toContain('opacity: 0.9')
    expect(style).toContain('top:')
    expect(style).toContain('left:')
  })

  it('cleans up its Escape listener on unmount so subsequent Escape does not fire', () => {
    const onClose = vi.fn()
    const { unmount } = render(
      <Popover open anchorX={400} anchorY={100} ariaLabel="Test" onClose={onClose}>
        <div>x</div>
      </Popover>,
    )
    unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
