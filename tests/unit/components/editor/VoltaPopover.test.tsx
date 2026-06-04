import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import VoltaPopover, { type VoltaPopoverPatch } from '@/components/editor/VoltaPopover'
import type { Volta } from '@/lib/music/types'

afterEach(() => cleanup())

const baseProps = {
  open: true as const,
  anchorX: 400,
  anchorY: 100,
  measureIdx: 2,
  existingVoltas: [] as ReadonlyArray<Volta>,
  measureCount: 8,
  onClose: vi.fn(),
  onPatch: vi.fn(),
}

describe('VoltaPopover — render', () => {
  it('renders form fields when open', () => {
    render(<VoltaPopover {...baseProps} />)
    expect(screen.getByRole('textbox', { name: /Start measure/i })).toBeDefined()
    expect(screen.getByRole('textbox', { name: /End measure/i })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Endings list' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'End hook' })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(<VoltaPopover {...baseProps} open={false} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('header includes the measure number (1-indexed)', () => {
    render(<VoltaPopover {...baseProps} measureIdx={4} />)
    expect(screen.getByText(/measure 5/i)).toBeDefined()
  })

  it('defaults start + end to the anchor measure (1-indexed)', () => {
    render(<VoltaPopover {...baseProps} measureIdx={3} />)
    const start = screen.getByRole('textbox', { name: /Start measure/i }) as HTMLInputElement
    const end = screen.getByRole('textbox', { name: /End measure/i }) as HTMLInputElement
    expect(start.value).toBe('4')
    expect(end.value).toBe('4')
  })

  it('defaults endings to "1"', () => {
    render(<VoltaPopover {...baseProps} />)
    const e = screen.getByRole('textbox', { name: 'Endings list' }) as HTMLInputElement
    expect(e.value).toBe('1')
  })

  it('renders the renderer-gotcha hint about non-thin endBarline', () => {
    render(<VoltaPopover {...baseProps} />)
    expect(screen.getByText(/non-thin endBarline/i)).toBeDefined()
  })

  it('lists existing voltas covering the anchor measure', () => {
    const existing: Volta[] = [
      {
        id: 'voltaa1234',
        startMeasureIdx: 1,
        endMeasureIdx: 3,
        endings: [1],
      },
      {
        id: 'voltab5678',
        startMeasureIdx: 5,
        endMeasureIdx: 5,
        endings: [2],
      },
    ]
    render(<VoltaPopover {...baseProps} measureIdx={2} existingVoltas={existing} />)
    // Only the first volta (covering m=2) appears in the list.
    expect(screen.getByText(/\[1\] m2–4/)).toBeDefined()
    expect(screen.queryByText(/\[2\] m6/)).toBeNull()
  })
})

describe('VoltaPopover — Apply validation', () => {
  it('Apply enabled by default (anchor measure, endings=1)', () => {
    render(<VoltaPopover {...baseProps} />)
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(false)
  })

  it('Apply disabled when start > end', () => {
    render(<VoltaPopover {...baseProps} />)
    fireEvent.change(screen.getByRole('textbox', { name: /Start measure/i }), {
      target: { value: '5' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /End measure/i }), {
      target: { value: '3' },
    })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('Apply disabled when start out of range (0 or > measureCount)', () => {
    render(<VoltaPopover {...baseProps} measureCount={5} />)
    fireEvent.change(screen.getByRole('textbox', { name: /Start measure/i }), {
      target: { value: '0' },
    })
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: /Start measure/i }), {
      target: { value: '10' },
    })
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Apply disabled when endings empty', () => {
    render(<VoltaPopover {...baseProps} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Endings list' }), {
      target: { value: '' },
    })
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Apply disabled when endings contain duplicates', () => {
    render(<VoltaPopover {...baseProps} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Endings list' }), {
      target: { value: '1,1,2' },
    })
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Apply disabled when an ending is out of 1..9', () => {
    render(<VoltaPopover {...baseProps} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Endings list' }), {
      target: { value: '1,10' },
    })
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Apply enabled with comma-separated endings (with whitespace)', () => {
    render(<VoltaPopover {...baseProps} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Endings list' }), {
      target: { value: '1, 2, 3' },
    })
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('VoltaPopover — patch emission', () => {
  it('Apply with defaults emits insert with anchor measure', () => {
    const onPatch = vi.fn<(p: VoltaPopoverPatch) => void>()
    render(<VoltaPopover {...baseProps} measureIdx={2} onPatch={onPatch} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      startMeasureIdx: 2,
      endMeasureIdx: 2,
      endings: [1],
    })
  })

  it('Apply with multi-bar range emits insert with correct range', () => {
    const onPatch = vi.fn<(p: VoltaPopoverPatch) => void>()
    render(<VoltaPopover {...baseProps} onPatch={onPatch} />)
    fireEvent.change(screen.getByRole('textbox', { name: /Start measure/i }), {
      target: { value: '2' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /End measure/i }), {
      target: { value: '5' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Endings list' }), {
      target: { value: '1,2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      startMeasureIdx: 1,
      endMeasureIdx: 4,
      endings: [1, 2],
    })
  })

  it('Apply with endHook emits the flag in the patch', () => {
    const onPatch = vi.fn<(p: VoltaPopoverPatch) => void>()
    render(<VoltaPopover {...baseProps} onPatch={onPatch} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'End hook' }), {
      target: { value: 'open' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      startMeasureIdx: 2,
      endMeasureIdx: 2,
      endings: [1],
      endHook: 'open',
    })
  })

  it('Remove button emits {kind:remove, id}', () => {
    const onPatch = vi.fn<(p: VoltaPopoverPatch) => void>()
    const existing: Volta[] = [
      {
        id: 'voltarem01',
        startMeasureIdx: 2,
        endMeasureIdx: 2,
        endings: [1],
      },
    ]
    render(<VoltaPopover {...baseProps} existingVoltas={existing} onPatch={onPatch} />)
    fireEvent.click(screen.getByRole('button', { name: /Remove volta/i }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'remove', id: 'voltarem01' })
  })

  it('Close button calls onClose without emitting a patch', () => {
    const onClose = vi.fn()
    const onPatch = vi.fn()
    render(<VoltaPopover {...baseProps} onClose={onClose} onPatch={onPatch} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('re-seeds selectors on close→re-open from updated measureIdx (M5-PR-3 regression pin)', () => {
    // wasOpen pattern: re-seed pendingStart/pendingEnd from props
    // only on the false→true transition. A future refactor that
    // re-seeds on every open=true render would defeat the
    // sticky-range workflow.
    const { rerender } = render(<VoltaPopover {...baseProps} measureIdx={2} />)
    let start = screen.getByRole('textbox', { name: /Start measure/i }) as HTMLInputElement
    expect(start.value).toBe('3')

    // Mid-open prop change: pending values should NOT change.
    act(() => {
      rerender(<VoltaPopover {...baseProps} open measureIdx={5} />)
    })
    start = screen.getByRole('textbox', { name: /Start measure/i }) as HTMLInputElement
    expect(start.value).toBe('3') // still the original

    // Close + reopen with new measureIdx → re-seed kicks in.
    act(() => {
      rerender(<VoltaPopover {...baseProps} open={false} measureIdx={5} />)
    })
    act(() => {
      rerender(<VoltaPopover {...baseProps} open measureIdx={5} />)
    })
    start = screen.getByRole('textbox', { name: /Start measure/i }) as HTMLInputElement
    expect(start.value).toBe('6')
  })

  it('Apply clears the endings field (sticky range for next entry)', () => {
    const onPatch = vi.fn<(p: VoltaPopoverPatch) => void>()
    render(<VoltaPopover {...baseProps} onPatch={onPatch} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Endings list' }), {
      target: { value: '1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const e = screen.getByRole('textbox', { name: 'Endings list' }) as HTMLInputElement
    expect(e.value).toBe('')
  })
})
