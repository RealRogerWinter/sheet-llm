import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import TempoSpanPopover, {
  type TempoSpanEndOption,
  type TempoSpanPopoverPatch,
} from '@/components/editor/TempoSpanPopover'
import type { Span } from '@/lib/music/types'
import type { TempoSpanKind } from '@/lib/music/spans'

afterEach(() => cleanup())

const endOptions: TempoSpanEndOption[] = [
  { eventId: 'evtestid02', label: 'm1 b2 — D4 (quarter)' },
  { eventId: 'evtestid03', label: 'm1 b3 — E4 (quarter)' },
  { eventId: 'evtestid04', label: 'm1 b4 — F4 (quarter)' },
]

function makeTempoSpan(
  over: Partial<Span> & { kind: TempoSpanKind },
): Span & { kind: TempoSpanKind } {
  return {
    id: 'tempoaaaa1',
    startEventId: 'evtestid01',
    endEventId: 'evtestid04',
    staffIdx: 0,
    voiceIdx: 0,
    ...over,
  } as Span & { kind: TempoSpanKind }
}

describe('TempoSpanPopover — render', () => {
  it('renders form fields when open', () => {
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Tempo span kind' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'End event' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Terminal BPM' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Terminal tempo text' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Placement' })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <TempoSpanPopover
        open={false}
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('omits "On this voice" section when no existing tempo spans', () => {
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('list', { name: 'Existing tempo spans' })).toBeNull()
  })

  it('lists existing tempo spans with summaries + remove buttons', () => {
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[
          makeTempoSpan({ id: 'tempoaaaa1', kind: 'accel' }),
          makeTempoSpan({ id: 'tempobbbb2', kind: 'rit', endTempoBpm: 60 }),
        ]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('list', { name: 'Existing tempo spans' })).toBeDefined()
    // Each existing entry surfaces a × button.
    const removeButtons = screen.getAllByRole('button', { name: /Remove tempo span/i })
    expect(removeButtons).toHaveLength(2)
  })

  it('summary includes terminal BPM when set', () => {
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[
          makeTempoSpan({ id: 'temposum01', kind: 'rit', endTempoBpm: 144 }),
        ]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    // The summary string contains "rit → ♩=144". Match the full
    // summary substring rather than bare "rit" (which also appears
    // in the header "(accelerando / ritardando)" and the kind option).
    expect(screen.getByText(/rit → ♩=144/)).toBeDefined()
  })

  it('summary includes terminal text when set', () => {
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[
          makeTempoSpan({ id: 'temposum02', kind: 'rit', endTempoText: 'a tempo' }),
        ]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByText(/a tempo/)).toBeDefined()
  })

  it('kind dropdown defaults to accel', () => {
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const kindSelect = screen.getByRole('combobox', {
      name: 'Tempo span kind',
    }) as HTMLSelectElement
    expect(kindSelect.value).toBe('accel')
  })
})

describe('TempoSpanPopover — Apply button', () => {
  it('Apply is enabled when end is selected and no BPM (no terminal label)', () => {
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(false)
  })

  it('Apply is disabled when no end events available', () => {
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('Apply is disabled when BPM is out of range (250 > 240)', () => {
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const bpmInput = screen.getByRole('textbox', { name: 'Terminal BPM' })
    fireEvent.change(bpmInput, { target: { value: '250' } })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('Apply is disabled when BPM is non-numeric', () => {
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const bpmInput = screen.getByRole('textbox', { name: 'Terminal BPM' })
    fireEvent.change(bpmInput, { target: { value: 'fast' } })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('BPM input shows aria-invalid for out-of-range value', () => {
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const bpmInput = screen.getByRole('textbox', { name: 'Terminal BPM' })
    fireEvent.change(bpmInput, { target: { value: '500' } })
    expect(bpmInput.getAttribute('aria-invalid')).toBe('true')
  })

  it('BPM input is valid when empty (optional field)', () => {
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const bpmInput = screen.getByRole('textbox', { name: 'Terminal BPM' })
    expect(bpmInput.getAttribute('aria-invalid')).toBe('false')
  })
})

describe('TempoSpanPopover — patch emission', () => {
  it('basic Apply emits insert with kind:accel and end event', () => {
    const onPatch = vi.fn<(p: TempoSpanPopoverPatch) => void>()
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      tempoKind: 'accel',
      endEventId: 'evtestid02',
    })
  })

  it('Apply with endTempoBpm produces the bpm in the patch', () => {
    const onPatch = vi.fn<(p: TempoSpanPopoverPatch) => void>()
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Tempo span kind' }), {
      target: { value: 'rit' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Terminal BPM' }), {
      target: { value: '60' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      tempoKind: 'rit',
      endEventId: 'evtestid02',
      endTempoBpm: 60,
    })
  })

  it('Apply with endTempoText produces the text in the patch', () => {
    const onPatch = vi.fn<(p: TempoSpanPopoverPatch) => void>()
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Terminal tempo text' }), {
      target: { value: 'a tempo' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      tempoKind: 'accel',
      endEventId: 'evtestid02',
      endTempoText: 'a tempo',
    })
  })

  it('Apply combines bpm + text + placement when all are set', () => {
    const onPatch = vi.fn<(p: TempoSpanPopoverPatch) => void>()
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Tempo span kind' }), {
      target: { value: 'rit' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Terminal BPM' }), {
      target: { value: '120' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Terminal tempo text' }), {
      target: { value: 'a tempo' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Placement' }), {
      target: { value: 'above' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      tempoKind: 'rit',
      endEventId: 'evtestid02',
      placement: 'above',
      endTempoBpm: 120,
      endTempoText: 'a tempo',
    })
  })

  it('Apply trims whitespace-only text fields', () => {
    const onPatch = vi.fn<(p: TempoSpanPopoverPatch) => void>()
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Terminal tempo text' }), {
      target: { value: '   ' }, // whitespace only
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      tempoKind: 'accel',
      endEventId: 'evtestid02',
    })
    // No endTempoText property emitted
    const call = onPatch.mock.calls[0][0]
    expect('endTempoText' in call ? call.endTempoText : undefined).toBeUndefined()
  })

  it('Cancel calls onClose without emitting a patch', () => {
    const onClose = vi.fn()
    const onPatch = vi.fn()
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={onClose}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('re-seeds on close→re-open (BPM + text cleared, regression pin for M5-PR-3-class bug)', () => {
    // The wasOpen ref pattern (TempoSpanPopover.tsx:91-102) resets
    // BPM / text / placement on EVERY closed→open transition. This
    // test exercises that path explicitly so a future refactor that
    // accidentally re-renders on every open=true (instead of
    // false→true transitions) is caught.
    const { rerender } = render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    // Fill in BPM + text.
    fireEvent.change(screen.getByRole('textbox', { name: 'Terminal BPM' }), {
      target: { value: '60' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Terminal tempo text' }), {
      target: { value: 'a tempo' },
    })
    // Verify pre-state.
    expect((screen.getByRole('textbox', { name: 'Terminal BPM' }) as HTMLInputElement).value).toBe('60')
    expect((screen.getByRole('textbox', { name: 'Terminal tempo text' }) as HTMLInputElement).value).toBe('a tempo')

    // Close, then re-open via rerender — exercises the wasOpen
    // false→true transition.
    act(() => {
      rerender(
        <TempoSpanPopover
          open={false}
          anchorX={400}
          anchorY={100}
          existingTempoSpans={[]}
          availableEnds={endOptions}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
    })
    act(() => {
      rerender(
        <TempoSpanPopover
          open
          anchorX={400}
          anchorY={100}
          existingTempoSpans={[]}
          availableEnds={endOptions}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
    })
    // Both fields cleared.
    expect((screen.getByRole('textbox', { name: 'Terminal BPM' }) as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('textbox', { name: 'Terminal tempo text' }) as HTMLInputElement).value).toBe('')
  })

  it('Remove button emits {kind:"remove", id}', () => {
    const onPatch = vi.fn<(p: TempoSpanPopoverPatch) => void>()
    render(
      <TempoSpanPopover
        open
        anchorX={400}
        anchorY={100}
        existingTempoSpans={[makeTempoSpan({ id: 'tempoaaaa1', kind: 'accel' })]}
        availableEnds={endOptions}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Remove tempo span/i }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'remove', id: 'tempoaaaa1' })
  })
})
