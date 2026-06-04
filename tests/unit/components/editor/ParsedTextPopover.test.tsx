import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ParsedTextPopover from '@/components/editor/ParsedTextPopover'

afterEach(() => cleanup())

interface Meter {
  numerator: number
  denominator: number
}

/** Pretend "M/N" parser to exercise the contract end-to-end. */
function parseMeter(text: string): Meter | undefined {
  const m = text.trim().match(/^(\d+)\/(\d+)$/)
  if (!m) return undefined
  const numerator = Number(m[1])
  const denominator = Number(m[2])
  if (numerator <= 0 || denominator <= 0) return undefined
  return { numerator, denominator }
}

function formatMeter(meter: Meter): string {
  return `${meter.numerator}/${meter.denominator}`
}

const baseProps = {
  open: true,
  anchorX: 400,
  anchorY: 100,
  ariaLabel: 'Meter',
  title: 'Meter',
  hint: <>Try: 4/4, 3/4, 5/8, 7/8</>,
  placeholder: 'e.g. 5/8',
  inputAriaLabel: 'Meter text',
  parser: parseMeter,
  formatter: formatMeter,
}

describe('ParsedTextPopover', () => {
  it('renders with the input pre-filled by initialText', () => {
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        initialText="5/8"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Meter text' }) as HTMLInputElement
    expect(input.value).toBe('5/8')
  })

  it('shows the live canonical preview of the parsed input', () => {
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Meter text' }), {
      target: { value: '7/8' },
    })
    const preview = document.querySelector('[aria-live="polite"]') as HTMLElement
    expect(preview.textContent).toBe('→ 7/8')
  })

  it('flags unparseable input with an error preview and disables Apply', () => {
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Meter text' }), {
      target: { value: 'gibberish' },
    })
    expect(screen.getByText(/Couldn't parse "gibberish"/)).toBeDefined()
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('submits the parsed value on Apply click', () => {
    const onSubmit = vi.fn()
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Meter text' }), {
      target: { value: '6/8' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSubmit).toHaveBeenCalledWith({ numerator: 6, denominator: 8 })
  })

  it('submits on Enter and closes on Escape', () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Meter text' })
    fireEvent.change(input, { target: { value: '4/4' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({ numerator: 4, denominator: 4 })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('Cancel button fires onClose without onSubmit', () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not submit when the input is unparseable, even on Enter', () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Meter text' })
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('treats null and undefined parser return values as parse-failure (no false-truthy edge cases)', () => {
    function nullishParser(text: string): Meter | null | undefined {
      if (text === 'a') return null
      if (text === 'b') return undefined
      return parseMeter(text)
    }
    const onSubmit = vi.fn()
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        parser={nullishParser}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    const input = screen.getByRole('textbox', { name: 'Meter text' })

    fireEvent.change(input, { target: { value: 'a' } })
    expect(apply.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'b' } })
    expect(apply.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '4/4' } })
    expect(apply.disabled).toBe(false)
  })

  it('renders nothing when open=false', () => {
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        open={false}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog', { name: 'Meter' })).toBeNull()
  })

  it('exposes a custom submit label', () => {
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        submitLabel="Set"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Set' })).toBeDefined()
  })

  it('exposes the title and hint in the header', () => {
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByText('Meter')).toBeDefined()
    expect(screen.getByText(/Try: 4\/4, 3\/4, 5\/8, 7\/8/)).toBeDefined()
  })

  it('renders a Clear button when onClear is provided and fires both onClear and onClose', () => {
    const onClear = vi.fn()
    const onClose = vi.fn()
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        onClear={onClear}
        onClose={onClose}
        onSubmit={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('hides the Clear button when onClear is not provided', () => {
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })

  it('Clear button does NOT depend on parser state (works for empty + invalid input)', () => {
    const onClear = vi.fn()
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        onClear={onClear}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    // Even when Apply is disabled, Clear must still be live — clearing
    // is the action when the user wants to unset, not author a new value.
    fireEvent.change(screen.getByRole('textbox', { name: 'Meter text' }), {
      target: { value: 'nope' },
    })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    const clear = screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    expect(clear.disabled).toBe(false)
    fireEvent.click(clear)
    expect(onClear).toHaveBeenCalled()
  })

  it('honors a custom clearLabel', () => {
    render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        onClear={vi.fn()}
        clearLabel="Remove"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDefined()
  })

  it('preserves user-typed text when initialText changes while open (no mid-edit re-seed)', () => {
    // Regression: the parent re-renders with a new initialText after the
    // user clicked a different pitch chip mid-popover. The popover must
    // NOT discard the in-progress typing — only re-seed on the open
    // false→true transition.
    const { rerender } = render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        open
        initialText="3/4"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Meter text' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '7/8' } })
    expect(input.value).toBe('7/8')
    // Parent re-renders with a new seed mid-edit (e.g., chip-switch).
    rerender(
      <ParsedTextPopover<Meter>
        {...baseProps}
        open
        initialText="6/8"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    // The typing survives — initialText updates don't clobber edits.
    expect(input.value).toBe('7/8')
  })

  it('re-seeds the input when initialText changes between opens', () => {
    const { rerender } = render(
      <ParsedTextPopover<Meter>
        {...baseProps}
        open={false}
        initialText="3/4"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    // Open with seed 3/4
    rerender(
      <ParsedTextPopover<Meter>
        {...baseProps}
        open
        initialText="3/4"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    let input = screen.getByRole('textbox', { name: 'Meter text' }) as HTMLInputElement
    expect(input.value).toBe('3/4')

    // Close, then reopen with a different seed.
    rerender(
      <ParsedTextPopover<Meter>
        {...baseProps}
        open={false}
        initialText="3/4"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    rerender(
      <ParsedTextPopover<Meter>
        {...baseProps}
        open
        initialText="6/8"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    input = screen.getByRole('textbox', { name: 'Meter text' }) as HTMLInputElement
    expect(input.value).toBe('6/8')
  })
})
