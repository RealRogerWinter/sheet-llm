import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FingeringPopover from '@/components/editor/FingeringPopover'

afterEach(() => cleanup())

describe('FingeringPopover', () => {
  it('renders with an input pre-filled by initialText', () => {
    render(
      <FingeringPopover
        open
        anchorX={400}
        anchorY={100}
        initialText="3"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Fingering text' }) as HTMLInputElement
    expect(input.value).toBe('3')
  })

  it('parses a bare digit as piano and submits on Apply', () => {
    const onSubmit = vi.fn()
    render(
      <FingeringPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Fingering text' }), {
      target: { value: '3' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSubmit).toHaveBeenCalledWith({ system: 'piano', value: '3' })
  })

  it('parses guitar-rh letter "p"', () => {
    const onSubmit = vi.fn()
    render(
      <FingeringPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'p' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSubmit).toHaveBeenCalledWith({ system: 'guitar-rh', value: 'p' })
  })

  it('parses a string fingering "2.III"', () => {
    const onSubmit = vi.fn()
    render(
      <FingeringPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '2.III' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSubmit).toHaveBeenCalledWith({
      system: 'string',
      finger: 2,
      stringRoman: 'III',
    })
  })

  it('parses an organ heel shorthand "1h"', () => {
    const onSubmit = vi.fn()
    render(
      <FingeringPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '1h' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSubmit).toHaveBeenCalledWith({ system: 'organ', value: '1', foot: 'heel' })
  })

  it('parses an explicit guitar-lh prefix', () => {
    const onSubmit = vi.fn()
    render(
      <FingeringPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'lh:2(6)/V' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSubmit).toHaveBeenCalledWith({
      system: 'guitar-lh',
      value: 2,
      stringNum: 6,
      fret: 'V',
    })
  })

  it('flags unparseable input with an error preview and disables Apply', () => {
    render(
      <FingeringPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'gibberish' } })
    expect(screen.getByText(/Couldn't parse/)).toBeDefined()
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('Enter submits, Escape closes', () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    render(
      <FingeringPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '4' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({ system: 'piano', value: '4' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('renders a Clear button when onClear is provided', () => {
    const onClear = vi.fn()
    const onClose = vi.fn()
    render(
      <FingeringPopover
        open
        anchorX={400}
        anchorY={100}
        initialText="3"
        onClear={onClear}
        onClose={onClose}
        onSubmit={vi.fn()}
      />,
    )
    const clear = screen.getByRole('button', { name: 'Clear' })
    fireEvent.click(clear)
    expect(onClear).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('hides the Clear button when onClear is not provided', () => {
    render(
      <FingeringPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })

  it('does not render when open=false', () => {
    render(
      <FingeringPopover
        open={false}
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog', { name: 'Fingering' })).toBeNull()
  })

  it('shows the canonical preview when the input parses', () => {
    render(
      <FingeringPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '1.IV' } })
    const preview = document.querySelector('[aria-live="polite"]') as HTMLElement
    expect(preview.textContent).toBe('→ 1.IV')
  })
})
