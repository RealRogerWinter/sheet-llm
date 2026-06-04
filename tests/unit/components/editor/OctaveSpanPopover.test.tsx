import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import OctaveSpanPopover, {
  type OctaveSpanEndOption,
  type OctaveSpanPopoverPatch,
} from '@/components/editor/OctaveSpanPopover'
import type { Span } from '@/lib/music/types'
import type { OctaveSpanKind } from '@/lib/music/spans'

afterEach(() => cleanup())

const endOptions: OctaveSpanEndOption[] = [
  { eventId: 'evtestid02', label: 'm1 b2 — D4 (quarter)' },
  { eventId: 'evtestid03', label: 'm1 b3 — E4 (quarter)' },
  { eventId: 'evtestid04', label: 'm1 b4 — F4 (quarter)' },
]

function makeOctaveSpan(
  over: Partial<Span> & { kind: OctaveSpanKind },
): Span & { kind: OctaveSpanKind } {
  return {
    id: 'octaaaaaa1',
    startEventId: 'evtestid01',
    endEventId: 'evtestid04',
    staffIdx: 0,
    voiceIdx: 0,
    ...over,
  } as Span & { kind: OctaveSpanKind }
}

describe('OctaveSpanPopover — render', () => {
  it('renders form fields when open', () => {
    render(
      <OctaveSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingOctaveSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Octave span kind' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'End event' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Placement' })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <OctaveSpanPopover
        open={false}
        anchorX={400}
        anchorY={100}
        existingOctaveSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists existing octave spans with summaries + remove buttons', () => {
    render(
      <OctaveSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingOctaveSpans={[
          makeOctaveSpan({ id: 'octaaaaaa1', kind: '8va' }),
          makeOctaveSpan({ id: 'octbbbbbb2', kind: '8vb' }),
          makeOctaveSpan({ id: 'oct15ma001', kind: '15ma' }),
        ]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('list', { name: 'Existing octave spans' })).toBeDefined()
    const removeButtons = screen.getAllByRole('button', { name: /Remove octave span/i })
    expect(removeButtons).toHaveLength(3)
  })
})

describe('OctaveSpanPopover — kind picker', () => {
  it('exposes all 4 kinds in the picker', () => {
    render(
      <OctaveSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingOctaveSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const select = screen.getByRole('combobox', { name: 'Octave span kind' }) as HTMLSelectElement
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value)
    expect(values).toEqual(['8va', '8vb', '15ma', '15mb'])
  })

  it('defaults to 8va on open', () => {
    render(
      <OctaveSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingOctaveSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const select = screen.getByRole('combobox', { name: 'Octave span kind' }) as HTMLSelectElement
    expect(select.value).toBe('8va')
  })
})

describe('OctaveSpanPopover — submit', () => {
  it('emits insert with octaveKind and endEventId', () => {
    const onPatch = vi.fn()
    render(
      <OctaveSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingOctaveSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    const kindSelect = screen.getByRole('combobox', { name: 'Octave span kind' })
    fireEvent.change(kindSelect, { target: { value: '8vb' } })
    const endSelect = screen.getByRole('combobox', { name: 'End event' })
    fireEvent.change(endSelect, { target: { value: 'evtestid03' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      octaveKind: '8vb',
      endEventId: 'evtestid03',
    } satisfies OctaveSpanPopoverPatch)
  })

  it('emits insert with explicit placement override', () => {
    const onPatch = vi.fn()
    render(
      <OctaveSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingOctaveSpans={[]}
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
      octaveKind: '8va',
      endEventId: 'evtestid02',
      placement: 'below',
    } satisfies OctaveSpanPopoverPatch)
  })

  it('disables Apply when no end event is available', () => {
    render(
      <OctaveSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingOctaveSpans={[]}
        availableEnds={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const apply = screen.getByRole('button', { name: /Apply/i })
    expect((apply as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('OctaveSpanPopover — remove', () => {
  it('emits remove with the span id when × clicked', () => {
    const onPatch = vi.fn()
    render(
      <OctaveSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingOctaveSpans={[makeOctaveSpan({ id: 'octaaaaaa1', kind: '8va' })]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Remove octave span/i }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'remove',
      id: 'octaaaaaa1',
    } satisfies OctaveSpanPopoverPatch)
  })
})

describe('OctaveSpanPopover — re-seed on reopen', () => {
  it('resets the form when transitioning closed → open', async () => {
    const { rerender } = render(
      <OctaveSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingOctaveSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const kindSelect = screen.getByRole('combobox', { name: 'Octave span kind' }) as HTMLSelectElement
    fireEvent.change(kindSelect, { target: { value: '15ma' } })
    expect(kindSelect.value).toBe('15ma')
    await act(async () => {
      rerender(
        <OctaveSpanPopover
          open={false}
          anchorX={400}
          anchorY={100}
          existingOctaveSpans={[]}
          availableEnds={endOptions}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
    })
    await act(async () => {
      rerender(
        <OctaveSpanPopover
          open
          anchorX={400}
          anchorY={100}
          existingOctaveSpans={[]}
          availableEnds={endOptions}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
    })
    const reseededSelect = screen.getByRole('combobox', { name: 'Octave span kind' }) as HTMLSelectElement
    expect(reseededSelect.value).toBe('8va')
  })
})
