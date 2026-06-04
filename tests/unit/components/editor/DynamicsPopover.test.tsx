import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import DynamicsPopover from '@/components/editor/DynamicsPopover'

afterEach(() => cleanup())

describe('DynamicsPopover', () => {
  it('renders with an input pre-filled by initialText', () => {
    render(
      <DynamicsPopover
        open
        anchorX={400}
        anchorY={100}
        initialText="mf"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Dynamic text' }) as HTMLInputElement
    expect(input.value).toBe('mf')
  })

  it('shows live canonical preview of the parsed input', () => {
    render(
      <DynamicsPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Dynamic text' })
    fireEvent.change(input, { target: { value: 'sub p' } })
    // parseDynamic accepts "sub" without trailing period and emits the
    // canonical "sub. p" form. Preview lives in the aria-live region;
    // use it as the scoped query target so the hint paragraph (which
    // also mentions "sub. p") doesn't collide.
    const preview = document.querySelector('[aria-live="polite"]') as HTMLElement
    expect(preview).toBeDefined()
    expect(preview.textContent).toMatch(/→ sub\. p/)
  })

  it('flags unparseable input with an error preview and disables Apply', () => {
    render(
      <DynamicsPopover
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

  it('submits a simple base-only marking', () => {
    const onSubmit = vi.fn()
    render(
      <DynamicsPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mf' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSubmit).toHaveBeenCalledWith({ base: 'mf' })
  })

  it('submits a compound marking with prefix + suffix', () => {
    const onSubmit = vi.fn()
    render(
      <DynamicsPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'sub. p espressivo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSubmit).toHaveBeenCalledWith({
      base: 'p',
      prefix: 'sub.',
      suffix: 'espressivo',
    })
  })

  it('Enter submits, Escape closes', () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    render(
      <DynamicsPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'ff' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({ base: 'ff' })

    // Escape on the document, not the input — the component listens at document-level.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('niente ("n") is accepted as a valid base', () => {
    const onSubmit = vi.fn()
    render(
      <DynamicsPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSubmit).toHaveBeenCalledWith({ base: 'n' })
  })

  it('does not render when open=false', () => {
    render(
      <DynamicsPopover
        open={false}
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog', { name: 'Dynamics' })).toBeNull()
  })
})
