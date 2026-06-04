import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import SlurPopover, {
  type SlurEndOption,
} from '@/components/editor/SlurPopover'
import type { Span } from '@/lib/music/types'
import type { SlurKind } from '@/lib/music/spans'

afterEach(() => cleanup())

const endOptions: SlurEndOption[] = [
  { eventId: 'evtestid01', label: 'm1 b1 — C4 (quarter) (same note)' },
  { eventId: 'evtestid02', label: 'm1 b2 — D4 (quarter)' },
  { eventId: 'evtestid03', label: 'm1 b3 — E4 (quarter)' },
  { eventId: 'evtestid04', label: 'm1 b4 — F4 (quarter)' },
]

function makeSlur(over: Partial<Span> & { kind: SlurKind }): Span & { kind: SlurKind } {
  return {
    id: 'slurabcde1',
    startEventId: 'evtestid01',
    endEventId: 'evtestid04',
    staffIdx: 0,
    voiceIdx: 0,
    ...over,
  } as Span & { kind: SlurKind }
}

describe('SlurPopover — render', () => {
  it('renders form fields when open', () => {
    render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Slur kind' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'End event' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Placement' })).toBeDefined()
  })

  it('does NOT render terminal-dynamic fields (slur is not loudness)', () => {
    render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('combobox', { name: 'Start dynamic' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'End dynamic' })).toBeNull()
  })

  it('does not render when open=false', () => {
    render(
      <SlurPopover
        open={false}
        anchorX={400}
        anchorY={100}
        existingSlurs={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('omits "On this voice" section when no existing slurs', () => {
    render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('list', { name: 'Existing slurs' })).toBeNull()
  })

  it('lists existing slurs with summaries + remove buttons', () => {
    render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[
          makeSlur({ id: 'slurabcde1', kind: 'slur' }),
          makeSlur({ id: 'slurabcde2', kind: 'phrase-slur' }),
        ]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const list = screen.getByRole('list', { name: 'Existing slurs' })
    expect(list.textContent).toContain('slur')
    expect(list.textContent).toContain('phrase')
    expect(screen.getAllByRole('button', { name: /Remove slur/ })).toHaveLength(2)
  })

  it('includes positional info in summary when eventPositions is provided', () => {
    const positions = new Map<string, string>([
      ['evtestid01', 'm1 b1'],
      ['evtestid04', 'm1 b4'],
    ])
    render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[
          makeSlur({
            id: 'slurabcde1',
            kind: 'slur',
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
      screen.getByRole('list', { name: 'Existing slurs' }).textContent,
    ).toContain('m1 b1 → m1 b4')
  })

  it('kind dropdown shows both slur and phrase-slur options', () => {
    render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const select = screen.getByRole('combobox', { name: 'Slur kind' }) as HTMLSelectElement
    expect(select.options).toHaveLength(2)
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['slur', 'phrase-slur'])
  })
})

describe('SlurPopover — apply', () => {
  it('Apply is disabled when no end event is selected', () => {
    render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[]}
        availableEnds={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('Apply emits insert patch with kind + end event id (placement omitted)', () => {
    const onPatch = vi.fn()
    render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledTimes(1)
    const patch = onPatch.mock.calls[0][0]
    expect(patch.kind).toBe('insert')
    expect(patch.slurKind).toBe('slur')
    expect(patch.endEventId).toBe('evtestid01') // first availableEnds default
    expect(patch.placement).toBeUndefined()
  })

  it('Apply emits insert with phrase-slur + placement when set', () => {
    const onPatch = vi.fn()
    render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Slur kind' }), {
      target: { value: 'phrase-slur' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'End event' }), {
      target: { value: 'evtestid04' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Placement' }), {
      target: { value: 'above' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const patch = onPatch.mock.calls[0][0]
    expect(patch).toEqual({
      kind: 'insert',
      slurKind: 'phrase-slur',
      endEventId: 'evtestid04',
      placement: 'above',
    })
  })

  it('Remove button emits remove patch with the slur id', () => {
    const onPatch = vi.fn()
    render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[makeSlur({ id: 'slurXYZ123', kind: 'slur' })]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Remove slur/ }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'remove', id: 'slurXYZ123' })
  })

  it('Apply does NOT fire when end event is empty (e.g. user reset the dropdown)', () => {
    const onPatch = vi.fn()
    render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'End event' }), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('snaps endEventId back to first available when selection changes while popover is open (no stale state)', () => {
    const onPatch = vi.fn()
    const initialEnds: SlurEndOption[] = [
      { eventId: 'evtestid01', label: 'm1 b1' },
      { eventId: 'evtestid02', label: 'm1 b2' },
    ]
    const { rerender } = render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[]}
        availableEnds={initialEnds}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    // Default end = evtestid01 (first available).
    const select = screen.getByRole('combobox', { name: 'End event' }) as HTMLSelectElement
    expect(select.value).toBe('evtestid01')

    // Parent's selection changes — availableEnds rebuilds, evtestid01
    // is no longer in the dropdown. The popover should snap to the
    // first available end of the NEW set.
    const newEnds: SlurEndOption[] = [
      { eventId: 'evtestid99', label: 'm2 b1' },
      { eventId: 'evtestidaa', label: 'm2 b2' },
    ]
    rerender(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[]}
        availableEnds={newEnds}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    // After the effect runs, endEventId should be the first of newEnds.
    expect((screen.getByRole('combobox', { name: 'End event' }) as HTMLSelectElement).value).toBe(
      'evtestid99',
    )
    // Apply now emits a valid (in-set) endEventId, not the stale one.
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'insert', endEventId: 'evtestid99' }),
    )
  })

  it('Cancel button fires onClose', () => {
    const onClose = vi.fn()
    render(
      <SlurPopover
        open
        anchorX={400}
        anchorY={100}
        existingSlurs={[]}
        availableEnds={endOptions}
        onClose={onClose}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
