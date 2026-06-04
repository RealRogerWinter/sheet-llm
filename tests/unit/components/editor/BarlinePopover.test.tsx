import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import BarlinePopover, { type BarlinePopoverPatch } from '@/components/editor/BarlinePopover'

afterEach(() => cleanup())

describe('BarlinePopover — render', () => {
  it('renders form selectors + flag checkboxes', () => {
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Start barline kind' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'End barline kind' })).toBeDefined()
    expect(screen.getByRole('checkbox', { name: /Pickup measure/i })).toBeDefined()
    expect(screen.getByRole('checkbox', { name: /Final partial/i })).toBeDefined()
  })

  it('header includes the measure number (1-indexed display)', () => {
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={4}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByText(/measure 5/i)).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <BarlinePopover
        open={false}
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('startBarline selector shows current value', () => {
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={'repeat-start'}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const start = screen.getByRole('combobox', { name: 'Start barline kind' }) as HTMLSelectElement
    expect(start.value).toBe('repeat-start')
  })

  it('endBarline selector shows current value', () => {
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={'final'}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const end = screen.getByRole('combobox', { name: 'End barline kind' }) as HTMLSelectElement
    expect(end.value).toBe('final')
  })

  it('isPickup checkbox shows checked when prop is true', () => {
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={true}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const checkbox = screen.getByRole('checkbox', { name: /Pickup measure/i }) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
  })

  it('exposes all 8 barline kinds + default in the dropdown', () => {
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const start = screen.getByRole('combobox', { name: 'Start barline kind' })
    // 9 options: default + 8 kinds.
    expect(start.querySelectorAll('option')).toHaveLength(9)
  })
})

describe('BarlinePopover — Apply button behavior', () => {
  it('Apply button is disabled when selector matches current value (no-op suppression)', () => {
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    // Default empty selector + undefined prop → Apply disabled.
    const applyBtns = screen.getAllByRole('button', { name: 'Apply' }) as HTMLButtonElement[]
    expect(applyBtns).toHaveLength(2)
    for (const btn of applyBtns) {
      expect(btn.disabled).toBe(true)
    }
  })

  it('Apply enabled when user picks a new value', () => {
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Start barline kind' }), {
      target: { value: 'repeat-start' },
    })
    const applyBtns = screen.getAllByRole('button', { name: 'Apply' }) as HTMLButtonElement[]
    expect(applyBtns[0].disabled).toBe(false)
    expect(applyBtns[1].disabled).toBe(true) // end still matches
  })
})

describe('BarlinePopover — patch emission', () => {
  it('start Apply emits {kind:start, barline:...}', () => {
    const onPatch = vi.fn<(p: BarlinePopoverPatch) => void>()
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Start barline kind' }), {
      target: { value: 'repeat-start' },
    })
    const applyBtns = screen.getAllByRole('button', { name: 'Apply' })
    fireEvent.click(applyBtns[0])
    expect(onPatch).toHaveBeenCalledWith({ kind: 'start', barline: 'repeat-start' })
  })

  it('clearing to default emits {kind:start, barline:null}', () => {
    const onPatch = vi.fn<(p: BarlinePopoverPatch) => void>()
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={'repeat-start'}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Start barline kind' }), {
      target: { value: '' },
    })
    const applyBtns = screen.getAllByRole('button', { name: 'Apply' })
    fireEvent.click(applyBtns[0])
    expect(onPatch).toHaveBeenCalledWith({ kind: 'start', barline: null })
  })

  it('end Apply emits {kind:end, barline:...}', () => {
    const onPatch = vi.fn<(p: BarlinePopoverPatch) => void>()
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'End barline kind' }), {
      target: { value: 'final' },
    })
    const applyBtns = screen.getAllByRole('button', { name: 'Apply' })
    fireEvent.click(applyBtns[1])
    expect(onPatch).toHaveBeenCalledWith({ kind: 'end', barline: 'final' })
  })

  it('isPickup checkbox emits {kind:pickup, isPickup:true} on check', () => {
    const onPatch = vi.fn<(p: BarlinePopoverPatch) => void>()
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /Pickup measure/i }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'pickup', isPickup: true })
  })

  it('isPickup checkbox emits {kind:pickup, isPickup:false} on uncheck', () => {
    const onPatch = vi.fn<(p: BarlinePopoverPatch) => void>()
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={true}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /Pickup measure/i }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'pickup', isPickup: false })
  })

  it('isFinalPartial checkbox emits {kind:finalPartial, isFinalPartial:true}', () => {
    const onPatch = vi.fn<(p: BarlinePopoverPatch) => void>()
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /Final partial/i }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'finalPartial', isFinalPartial: true })
  })

  it('re-seeds selectors on close→re-open from updated props (M5-PR-3 pattern regression pin)', () => {
    // The wasOpen ref pattern (BarlinePopover.tsx:82-94) re-seeds
    // pendingStart / pendingEnd from props only on the false→true
    // transition. A future refactor that drops the gate would
    // re-seed on every render (cascading-render loop) — this test
    // pins the correct behavior.
    const { rerender } = render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    // Pre-state: default empty.
    let start = screen.getByRole('combobox', { name: 'Start barline kind' }) as HTMLSelectElement
    expect(start.value).toBe('')

    // Close → re-open with NEW prop value. Selector should reflect
    // the new prop after the close→open transition.
    act(() => {
      rerender(
        <BarlinePopover
          open={false}
          anchorX={400}
          anchorY={100}
          measureIdx={0}
          startBarline={'final'}
          endBarline={undefined}
          isPickup={false}
          isFinalPartial={false}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
    })
    act(() => {
      rerender(
        <BarlinePopover
          open
          anchorX={400}
          anchorY={100}
          measureIdx={0}
          startBarline={'final'}
          endBarline={undefined}
          isPickup={false}
          isFinalPartial={false}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
    })
    start = screen.getByRole('combobox', { name: 'Start barline kind' }) as HTMLSelectElement
    expect(start.value).toBe('final')
  })

  it('Close button calls onClose without emitting a patch', () => {
    const onClose = vi.fn()
    const onPatch = vi.fn()
    render(
      <BarlinePopover
        open
        anchorX={400}
        anchorY={100}
        measureIdx={0}
        startBarline={undefined}
        endBarline={undefined}
        isPickup={false}
        isFinalPartial={false}
        onClose={onClose}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
    expect(onPatch).not.toHaveBeenCalled()
  })
})
