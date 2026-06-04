import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import TrillLinePopover, {
  type TrillLineEndOption,
  type TrillLinePopoverPatch,
} from '@/components/editor/TrillLinePopover'
import type { Span } from '@/lib/music/types'

afterEach(() => cleanup())

const endOptions: TrillLineEndOption[] = [
  { eventId: 'evtestid02', label: 'm1 b2 — D4 (quarter)' },
  { eventId: 'evtestid03', label: 'm1 b3 — E4 (quarter)' },
]

function makeTrillLine(over: Partial<Span> = {}): Span & { kind: 'trill-line' } {
  return {
    id: 'trillaaaa1',
    kind: 'trill-line',
    startEventId: 'evtestid01',
    endEventId: 'evtestid03',
    staffIdx: 0,
    voiceIdx: 0,
    ...over,
  } as Span & { kind: 'trill-line' }
}

describe('TrillLinePopover — render', () => {
  it('renders form fields when open', () => {
    render(
      <TrillLinePopover
        open
        anchorX={400}
        anchorY={100}
        existingTrillLines={[]}
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
      <TrillLinePopover
        open={false}
        anchorX={400}
        anchorY={100}
        existingTrillLines={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists existing trill lines with × remove buttons', () => {
    render(
      <TrillLinePopover
        open
        anchorX={400}
        anchorY={100}
        existingTrillLines={[makeTrillLine(), makeTrillLine({ id: 'trillbbbb2' })]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('list', { name: 'Existing trill lines' })).toBeDefined()
    expect(screen.getAllByRole('button', { name: /Remove trill line/i })).toHaveLength(2)
  })

  it('shows the trill ornament pairing hint', () => {
    render(
      <TrillLinePopover
        open
        anchorX={400}
        anchorY={100}
        existingTrillLines={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByText(/extends a trill ornament/i)).toBeDefined()
  })
})

describe('TrillLinePopover — submit', () => {
  it('emits a minimal insert (just endEventId)', () => {
    const onPatch = vi.fn()
    render(
      <TrillLinePopover
        open
        anchorX={400}
        anchorY={100}
        existingTrillLines={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'End event' }), {
      target: { value: 'evtestid03' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      endEventId: 'evtestid03',
    } satisfies TrillLinePopoverPatch)
  })

  it('emits insert with explicit placement', () => {
    const onPatch = vi.fn()
    render(
      <TrillLinePopover
        open
        anchorX={400}
        anchorY={100}
        existingTrillLines={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Placement' }), {
      target: { value: 'above' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'End event' }), {
      target: { value: 'evtestid02' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      endEventId: 'evtestid02',
      placement: 'above',
    } satisfies TrillLinePopoverPatch)
  })

  it('disables Apply when no end event is available', () => {
    render(
      <TrillLinePopover
        open
        anchorX={400}
        anchorY={100}
        existingTrillLines={[]}
        availableEnds={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const apply = screen.getByRole('button', { name: /Apply/i })
    expect((apply as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('TrillLinePopover — remove', () => {
  it('emits remove with the span id when × clicked', () => {
    const onPatch = vi.fn()
    render(
      <TrillLinePopover
        open
        anchorX={400}
        anchorY={100}
        existingTrillLines={[makeTrillLine()]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Remove trill line/i }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'remove',
      id: 'trillaaaa1',
    } satisfies TrillLinePopoverPatch)
  })
})
