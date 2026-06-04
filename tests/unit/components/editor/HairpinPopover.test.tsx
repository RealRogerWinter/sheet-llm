import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import HairpinPopover, {
  type HairpinEndOption,
} from '@/components/editor/HairpinPopover'
import type { Span } from '@/lib/music/types'
import type { HairpinKind } from '@/lib/music/spans'

afterEach(() => cleanup())

const endOptions: HairpinEndOption[] = [
  { eventId: 'evtestid01', label: 'm1 b1 — C4 (quarter) (same note)' },
  { eventId: 'evtestid02', label: 'm1 b2 — D4 (quarter)' },
  { eventId: 'evtestid03', label: 'm1 b3 — E4 (quarter)' },
  { eventId: 'evtestid04', label: 'm1 b4 — F4 (quarter)' },
]

function makeHairpin(over: Partial<Span> & { kind: HairpinKind }): Span & { kind: HairpinKind } {
  return {
    id: 'hairpin001',
    startEventId: 'evtestid01',
    endEventId: 'evtestid04',
    staffIdx: 0,
    voiceIdx: 0,
    ...over,
  } as Span & { kind: HairpinKind }
}

describe('HairpinPopover — render', () => {
  it('renders form fields when open', () => {
    render(
      <HairpinPopover
        open
        anchorX={400}
        anchorY={100}
        existingHairpins={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Hairpin kind' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'End event' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Start dynamic' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'End dynamic' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Placement' })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <HairpinPopover
        open={false}
        anchorX={400}
        anchorY={100}
        existingHairpins={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('omits "On this voice" section when no existing hairpins', () => {
    render(
      <HairpinPopover
        open
        anchorX={400}
        anchorY={100}
        existingHairpins={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('list', { name: 'Existing hairpins' })).toBeNull()
  })

  it('lists existing hairpins with summaries + remove buttons', () => {
    render(
      <HairpinPopover
        open
        anchorX={400}
        anchorY={100}
        existingHairpins={[
          makeHairpin({ id: 'hairpin001', kind: 'hairpin-cresc' }),
          makeHairpin({
            id: 'hairpin002',
            kind: 'hairpin-dim',
            startDynamic: 'f',
            endDynamic: 'p',
          }),
        ]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const list = screen.getByRole('list', { name: 'Existing hairpins' })
    expect(list.textContent).toContain('cresc')
    expect(list.textContent).toContain('dim f>p')
    expect(screen.getAllByRole('button', { name: /Remove hairpin/ })).toHaveLength(2)
  })

  it('includes positional info in summary when eventPositions is provided', () => {
    const positions = new Map<string, string>([
      ['evtestid01', 'm1 b1'],
      ['evtestid04', 'm1 b4'],
    ])
    render(
      <HairpinPopover
        open
        anchorX={400}
        anchorY={100}
        existingHairpins={[
          makeHairpin({
            id: 'hairpin001',
            kind: 'hairpin-cresc',
            startEventId: 'evtestid01',
            endEventId: 'evtestid04',
          }),
        ]}
        availableEnds={endOptions}
        eventPositions={positions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('list', { name: 'Existing hairpins' }).textContent,
    ).toContain('m1 b1 → m1 b4')
  })

  it('end-event dropdown shows the available labels', () => {
    render(
      <HairpinPopover
        open
        anchorX={400}
        anchorY={100}
        existingHairpins={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const select = screen.getByRole('combobox', { name: 'End event' }) as HTMLSelectElement
    // Includes the "(select an end event)" placeholder + 4 real options.
    expect(select.options).toHaveLength(5)
    expect(select.options[1].text).toContain('m1 b1')
    expect(select.options[4].text).toContain('m1 b4')
  })
})

describe('HairpinPopover — apply', () => {
  it('Apply is disabled when no end event is selected', () => {
    render(
      <HairpinPopover
        open
        anchorX={400}
        anchorY={100}
        existingHairpins={[]}
        availableEnds={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('Apply emits insert patch with kind + end event id (other fields omitted)', () => {
    const onPatch = vi.fn()
    render(
      <HairpinPopover
        open
        anchorX={400}
        anchorY={100}
        existingHairpins={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledTimes(1)
    const patch = onPatch.mock.calls[0][0]
    expect(patch.kind).toBe('insert')
    expect(patch.hairpinKind).toBe('hairpin-cresc')
    // Default end = first availableEnds entry (the same-note option in this fixture).
    expect(patch.endEventId).toBe('evtestid01')
    expect(patch.startDynamic).toBeUndefined()
    expect(patch.endDynamic).toBeUndefined()
    expect(patch.placement).toBeUndefined()
  })

  it('Apply emits insert patch with kind=dim + terminal dynamics + placement when set', () => {
    const onPatch = vi.fn()
    render(
      <HairpinPopover
        open
        anchorX={400}
        anchorY={100}
        existingHairpins={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Hairpin kind' }), {
      target: { value: 'hairpin-dim' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'End event' }), {
      target: { value: 'evtestid03' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Start dynamic' }), {
      target: { value: 'f' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'End dynamic' }), {
      target: { value: 'p' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Placement' }), {
      target: { value: 'below' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const patch = onPatch.mock.calls[0][0]
    expect(patch).toEqual({
      kind: 'insert',
      hairpinKind: 'hairpin-dim',
      endEventId: 'evtestid03',
      startDynamic: 'f',
      endDynamic: 'p',
      placement: 'below',
    })
  })

  it('Remove button emits remove patch with the hairpin id', () => {
    const onPatch = vi.fn()
    render(
      <HairpinPopover
        open
        anchorX={400}
        anchorY={100}
        existingHairpins={[
          makeHairpin({ id: 'hairpinABC1', kind: 'hairpin-cresc' }),
        ]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Remove hairpin/ }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'remove', id: 'hairpinABC1' })
  })

  it('Apply does NOT fire when end event is empty + dropdown shows placeholder', () => {
    const onPatch = vi.fn()
    render(
      <HairpinPopover
        open
        anchorX={400}
        anchorY={100}
        existingHairpins={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    // Reset end event to empty.
    fireEvent.change(screen.getByRole('combobox', { name: 'End event' }), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('Cancel button fires onClose', () => {
    const onClose = vi.fn()
    render(
      <HairpinPopover
        open
        anchorX={400}
        anchorY={100}
        existingHairpins={[]}
        availableEnds={endOptions}
        onClose={onClose}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
