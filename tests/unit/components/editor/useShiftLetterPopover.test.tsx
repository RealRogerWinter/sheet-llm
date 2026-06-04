import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { useShiftLetterPopover } from '@/components/editor/useShiftLetterPopover'

afterEach(() => cleanup())

function Harness({
  letter,
  open,
  enabled,
}: {
  letter: string
  open: () => void
  enabled?: boolean
}) {
  useShiftLetterPopover(letter, open, { enabled })
  return null
}

describe('useShiftLetterPopover', () => {
  it('calls the opener when Shift+letter is pressed', () => {
    const open = vi.fn()
    render(<Harness letter="D" open={open} />)
    fireEvent.keyDown(document, { key: 'D', shiftKey: true })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not fire on the letter alone (Shift required)', () => {
    const open = vi.fn()
    render(<Harness letter="D" open={open} />)
    fireEvent.keyDown(document, { key: 'd' })
    expect(open).not.toHaveBeenCalled()
  })

  it('does not fire when Ctrl is also held (Ctrl+Shift+D is a browser combo)', () => {
    const open = vi.fn()
    render(<Harness letter="D" open={open} />)
    fireEvent.keyDown(document, { key: 'D', shiftKey: true, ctrlKey: true })
    expect(open).not.toHaveBeenCalled()
  })

  it('does not fire when Meta is also held (Cmd+Shift+D is a system combo)', () => {
    const open = vi.fn()
    render(<Harness letter="D" open={open} />)
    fireEvent.keyDown(document, { key: 'D', shiftKey: true, metaKey: true })
    expect(open).not.toHaveBeenCalled()
  })

  it('does not fire when Alt is also held', () => {
    const open = vi.fn()
    render(<Harness letter="D" open={open} />)
    fireEvent.keyDown(document, { key: 'D', shiftKey: true, altKey: true })
    expect(open).not.toHaveBeenCalled()
  })

  it('does not fire while the user is typing in an input', () => {
    const open = vi.fn()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    render(<Harness letter="D" open={open} />)
    fireEvent.keyDown(input, { key: 'D', shiftKey: true })
    expect(open).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it('does not fire while the user is typing in a textarea', () => {
    const open = vi.fn()
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    render(<Harness letter="D" open={open} />)
    fireEvent.keyDown(ta, { key: 'D', shiftKey: true })
    expect(open).not.toHaveBeenCalled()
    document.body.removeChild(ta)
  })

  it('does not fire while the user is typing in a contenteditable', () => {
    const open = vi.fn()
    const div = document.createElement('div')
    // jsdom does not compute `isContentEditable` from the
    // contentEditable attribute — stub the property directly so the
    // guard logic exercises the contenteditable code path.
    Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true })
    document.body.appendChild(div)
    render(<Harness letter="D" open={open} />)
    fireEvent.keyDown(div, { key: 'D', shiftKey: true })
    expect(open).not.toHaveBeenCalled()
    document.body.removeChild(div)
  })

  it('does not fire when enabled is false (no listener attached)', () => {
    const open = vi.fn()
    render(<Harness letter="D" open={open} enabled={false} />)
    fireEvent.keyDown(document, { key: 'D', shiftKey: true })
    expect(open).not.toHaveBeenCalled()
  })

  it('matches strict equality on the letter (Shift+P does not fire a Shift+D listener)', () => {
    const open = vi.fn()
    render(<Harness letter="D" open={open} />)
    fireEvent.keyDown(document, { key: 'P', shiftKey: true })
    expect(open).not.toHaveBeenCalled()
  })

  it('removes its listener on unmount so subsequent presses are no-ops', () => {
    const open = vi.fn()
    const { unmount } = render(<Harness letter="D" open={open} />)
    unmount()
    fireEvent.keyDown(document, { key: 'D', shiftKey: true })
    expect(open).not.toHaveBeenCalled()
  })

  it('two instances coexist (Shift+D and Shift+P both fire their own openers)', () => {
    const openD = vi.fn()
    const openP = vi.fn()
    function Combined() {
      useShiftLetterPopover('D', openD)
      useShiftLetterPopover('P', openP)
      return null
    }
    render(<Combined />)
    fireEvent.keyDown(document, { key: 'D', shiftKey: true })
    fireEvent.keyDown(document, { key: 'P', shiftKey: true })
    expect(openD).toHaveBeenCalledTimes(1)
    expect(openP).toHaveBeenCalledTimes(1)
  })

  it('captures the LATEST opener — a re-rendered inline closure still fires the up-to-date function', () => {
    // Regression for the inline-arrow re-render case: if the hook
    // re-attached its document listener every time the opener prop
    // changed, fast re-renders during a single keypress could miss
    // the latest opener. The implementation uses a ref to track the
    // latest opener inside a stable handler.
    const firstOpener = vi.fn()
    const secondOpener = vi.fn()
    const { rerender } = render(<Harness letter="D" open={firstOpener} />)
    rerender(<Harness letter="D" open={secondOpener} />)
    fireEvent.keyDown(document, { key: 'D', shiftKey: true })
    expect(firstOpener).not.toHaveBeenCalled()
    expect(secondOpener).toHaveBeenCalledTimes(1)
  })

  it('calls preventDefault on the matched event', () => {
    const open = vi.fn()
    render(<Harness letter="D" open={open} />)
    const e = new KeyboardEvent('keydown', {
      key: 'D',
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    })
    document.dispatchEvent(e)
    expect(open).toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
  })

  it('does not call preventDefault when the combo is rejected', () => {
    const open = vi.fn()
    render(<Harness letter="D" open={open} />)
    const e = new KeyboardEvent('keydown', {
      key: 'D', // shift NOT held — combo rejected
      cancelable: true,
      bubbles: true,
    })
    document.dispatchEvent(e)
    expect(open).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('beats a bubble-phase target listener (capture-phase + stopPropagation prevents chord-stack double-fire)', () => {
    // Regression for the Shift+D double-fire bug:
    // useEditorKeyboard attaches a keydown listener on the score
    // div (bubble phase). Without capture-phase listening on the
    // hook side, Shift+D would fire the target chord-stack first
    // (stacking a D pitch) and THEN open the dynamics popover.
    //
    // This test models the scenario: a target listener on a focused
    // child + the hook's document listener. The hook must win and
    // the target listener must never fire.
    const open = vi.fn()
    const targetListener = vi.fn()
    const target = document.createElement('button')
    document.body.appendChild(target)
    target.focus()
    target.addEventListener('keydown', targetListener) // bubble phase
    render(<Harness letter="D" open={open} />)

    const e = new KeyboardEvent('keydown', {
      key: 'D',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    target.dispatchEvent(e)

    expect(open).toHaveBeenCalledTimes(1)
    expect(targetListener).not.toHaveBeenCalled()
    document.body.removeChild(target)
  })
})
