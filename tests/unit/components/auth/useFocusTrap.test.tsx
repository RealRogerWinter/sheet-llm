import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { useFocusTrap } from '@/components/auth/useFocusTrap'

afterEach(cleanup)

function Harness({ active, onClose }: { active: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, active, onClose)
  return (
    <div>
      <button data-testid="outside">outside</button>
      <div ref={ref}>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </div>
    </div>
  )
}

function tab(el: Element, shiftKey = false) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }))
}

describe('useFocusTrap', () => {
  it('moves focus to the first focusable on activate', () => {
    const { getByTestId } = render(<Harness active onClose={() => {}} />)
    expect(document.activeElement).toBe(getByTestId('first'))
  })

  it('does nothing while inactive', () => {
    const { getByTestId } = render(<Harness active={false} onClose={() => {}} />)
    expect(document.activeElement).not.toBe(getByTestId('first'))
  })

  it('Escape calls onClose', () => {
    const onClose = vi.fn()
    const { getByTestId } = render(<Harness active onClose={onClose} />)
    getByTestId('first').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Tab on the last element wraps to the first; Shift+Tab on the first wraps to the last', () => {
    const { getByTestId } = render(<Harness active onClose={() => {}} />)
    const first = getByTestId('first')
    const last = getByTestId('last')
    last.focus()
    tab(last)
    expect(document.activeElement).toBe(first)
    tab(first, true)
    expect(document.activeElement).toBe(last)
  })
})
