import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import TremoloBetweenPopover, {
  type TremoloBetweenEndOption,
  type TremoloBetweenPopoverPatch,
} from '@/components/editor/TremoloBetweenPopover'
import type { Span } from '@/lib/music/types'

afterEach(() => cleanup())

const endOptions: TremoloBetweenEndOption[] = [
  { eventId: 'evtestid02', label: 'm1 b2 — D4 (quarter)' },
]

function makeTremolo(over: Partial<Span> = {}): Span & { kind: 'tremolo-between' } {
  return {
    id: 'tremaaaaa1',
    kind: 'tremolo-between',
    startEventId: 'evtestid01',
    endEventId: 'evtestid02',
    staffIdx: 0,
    voiceIdx: 0,
    ...over,
  } as Span & { kind: 'tremolo-between' }
}

describe('TremoloBetweenPopover — render', () => {
  it('renders form fields when open', () => {
    render(
      <TremoloBetweenPopover
        open
        anchorX={400}
        anchorY={100}
        existingTremolos={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'End event' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Placement' })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <TremoloBetweenPopover
        open={false}
        anchorX={400}
        anchorY={100}
        existingTremolos={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists existing between-note tremolos with × remove buttons', () => {
    render(
      <TremoloBetweenPopover
        open
        anchorX={400}
        anchorY={100}
        existingTremolos={[makeTremolo(), makeTremolo({ id: 'trembbbbb2' })]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('list', { name: 'Existing between-note tremolos' }),
    ).toBeDefined()
    expect(
      screen.getAllByRole('button', { name: /Remove between-note tremolo/i }),
    ).toHaveLength(2)
  })

  it('shows the single-note-vs-between disambiguation hint', () => {
    render(
      <TremoloBetweenPopover
        open
        anchorX={400}
        anchorY={100}
        existingTremolos={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByText(/Distinct from a single-note tremolo/i)).toBeDefined()
  })
})

describe('TremoloBetweenPopover — submit', () => {
  it('emits a minimal insert (just endEventId)', () => {
    const onPatch = vi.fn()
    render(
      <TremoloBetweenPopover
        open
        anchorX={400}
        anchorY={100}
        existingTremolos={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'End event' }), {
      target: { value: 'evtestid02' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      endEventId: 'evtestid02',
    } satisfies TremoloBetweenPopoverPatch)
  })

  it('emits insert with explicit placement', () => {
    const onPatch = vi.fn()
    render(
      <TremoloBetweenPopover
        open
        anchorX={400}
        anchorY={100}
        existingTremolos={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Placement' }), {
      target: { value: 'below' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'End event' }), {
      target: { value: 'evtestid02' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      endEventId: 'evtestid02',
      placement: 'below',
    } satisfies TremoloBetweenPopoverPatch)
  })

  it('disables Apply when no end event is available', () => {
    render(
      <TremoloBetweenPopover
        open
        anchorX={400}
        anchorY={100}
        existingTremolos={[]}
        availableEnds={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const apply = screen.getByRole('button', { name: /Apply/i })
    expect((apply as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('TremoloBetweenPopover — remove', () => {
  it('emits remove with the span id when × clicked', () => {
    const onPatch = vi.fn()
    render(
      <TremoloBetweenPopover
        open
        anchorX={400}
        anchorY={100}
        existingTremolos={[makeTremolo()]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Remove between-note tremolo/i }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'remove',
      id: 'tremaaaaa1',
    } satisfies TremoloBetweenPopoverPatch)
  })
})
