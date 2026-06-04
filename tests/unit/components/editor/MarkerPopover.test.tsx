import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import MarkerPopover from '@/components/editor/MarkerPopover'
import type { Marker } from '@/lib/music/types'

afterEach(() => cleanup())

function makeMarker(over: Partial<Marker> = {}): Marker {
  return {
    id: 'marker0001',
    measureIdx: 0,
    tempo_bpm: 120,
    ...over,
  }
}

describe('MarkerPopover — render', () => {
  it('renders form fields when open', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('spinbutton', { name: 'Tempo bpm' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Tempo text' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Meter' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Key' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Metric modulation from-note' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Metric modulation to-note' })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <MarkerPopover
        open={false}
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('omits "On this measure" section when no existing markers', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('list', { name: 'Existing markers' })).toBeNull()
  })

  it('lists existing markers with summaries + remove buttons', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[
          makeMarker({ id: 'marker0001', tempo_bpm: 120, tempo_text: 'Allegro' }),
          makeMarker({ id: 'marker0002', meter: '3/4' }),
        ]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const list = screen.getByRole('list', { name: 'Existing markers' })
    expect(list.textContent).toContain('Allegro')
    expect(list.textContent).toContain('120 bpm')
    expect(list.textContent).toContain('3/4')
    expect(screen.getAllByRole('button', { name: /Remove marker/ })).toHaveLength(2)
  })
})

describe('MarkerPopover — apply', () => {
  it('Apply is disabled when no field is set', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('Apply enables when tempo_bpm is typed', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tempo bpm' }), {
      target: { value: '120' },
    })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(false)
  })

  it('emits an insert patch with only the filled fields', () => {
    const onPatch = vi.fn()
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tempo bpm' }), {
      target: { value: '140' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Tempo text' }), {
      target: { value: 'Allegro' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      tempo_bpm: 140,
      tempo_text: 'Allegro',
    })
  })

  it('emits meter when the meter input is valid', () => {
    const onPatch = vi.fn()
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Meter' }), {
      target: { value: '6/8' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'insert', meter: '6/8' })
  })

  it('rejects invalid meter (Apply stays disabled when meter is the only field)', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Meter' }), {
      target: { value: 'not-a-meter' },
    })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('emits key when selected from the dropdown', () => {
    const onPatch = vi.fn()
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Key' }), {
      target: { value: 'G' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'insert', key: 'G' })
  })

  it('emits metricModulation when BOTH from and to are picked', () => {
    const onPatch = vi.fn()
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Metric modulation from-note' }), {
      target: { value: 'quarter' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Metric modulation to-note' }), {
      target: { value: 'dotted-quarter' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      metricModulation: { fromNote: 'quarter', toNote: 'dotted-quarter' },
    })
  })

  it('does NOT emit metricModulation when only one of from/to is picked', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    // Only set "from" — modulation needs BOTH; should leave Apply
    // disabled (no other field).
    fireEvent.change(screen.getByRole('combobox', { name: 'Metric modulation from-note' }), {
      target: { value: 'quarter' },
    })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('rejects tempo_bpm out of range (30..240) — Apply stays disabled', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tempo bpm' }), {
      target: { value: '500' },
    })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('Enter inside tempo_bpm submits when valid', () => {
    const onPatch = vi.fn()
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    const bpm = screen.getByRole('spinbutton', { name: 'Tempo bpm' }) as HTMLInputElement
    fireEvent.change(bpm, { target: { value: '100' } })
    fireEvent.keyDown(bpm, { key: 'Enter' })
    expect(onPatch).toHaveBeenCalledWith({ kind: 'insert', tempo_bpm: 100 })
  })

  it('clears tempo inputs after Apply (key + meter stay sticky)', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Key' }), {
      target: { value: 'G' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Meter' }), {
      target: { value: '6/8' },
    })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tempo bpm' }), {
      target: { value: '120' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect((screen.getByRole('spinbutton', { name: 'Tempo bpm' }) as HTMLInputElement).value).toBe('')
    // Both stay sticky — locks the "rapid markers across bars" use case.
    expect((screen.getByRole('combobox', { name: 'Key' }) as HTMLSelectElement).value).toBe('G')
    expect((screen.getByRole('textbox', { name: 'Meter' }) as HTMLInputElement).value).toBe('6/8')
  })

  it('CLEARS metric-modulation after Apply (asymmetry vs key/meter — mm rarely repeats)', () => {
    // Code-review fix (M9-PR-4): mm stickiness would silently re-emit
    // the same modulation on the next marker. Leaving it sticky was
    // the most deceptive sub-case since users rarely intend to drop
    // the SAME mm twice in a row. Tempo + mm both clear; key + meter
    // stay because those genuinely benefit from rapid bar-to-bar
    // reuse.
    const onPatch = vi.fn()
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Metric modulation from-note' }), {
      target: { value: 'quarter' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Metric modulation to-note' }), {
      target: { value: 'dotted-quarter' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    // mmFrom + mmTo should be back to the empty option.
    expect(
      (screen.getByRole('combobox', { name: 'Metric modulation from-note' }) as HTMLSelectElement).value,
    ).toBe('')
    expect(
      (screen.getByRole('combobox', { name: 'Metric modulation to-note' }) as HTMLSelectElement).value,
    ).toBe('')
  })

  it('mm half-state (only one of from/to) marks both selects aria-invalid + shows hint', () => {
    // Code-review fix (M9-PR-4): without the hint + aria-invalid, a
    // user picking only mmFrom and adding tempo_bpm could Apply and
    // never realize the mm half-state was silently dropped.
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const from = screen.getByRole('combobox', {
      name: 'Metric modulation from-note',
    }) as HTMLSelectElement
    const to = screen.getByRole('combobox', {
      name: 'Metric modulation to-note',
    }) as HTMLSelectElement
    fireEvent.change(from, { target: { value: 'quarter' } })
    // From is set, To isn't — To should be flagged invalid.
    expect(to.getAttribute('aria-invalid')).toBe('true')
    expect(from.getAttribute('aria-invalid')).toBe('false')
    // Hint visible in the popover dialog.
    const dialog = screen.getByRole('dialog', { name: 'Marker' })
    expect(dialog.textContent).toMatch(/needs BOTH/i)
  })
})

describe('MarkerPopover — clef change (M19-PR-1)', () => {
  it('single-staff default: shows only one clef picker labeled "New clef"', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Clef change staff 1' })).toBeDefined()
    expect(screen.queryByRole('combobox', { name: 'Clef change staff 2' })).toBeNull()
  })

  it('two-staff: shows BOTH per-staff clef pickers', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        staffCount={2}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Clef change staff 1' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Clef change staff 2' })).toBeDefined()
  })

  it('Apply enables when a clef is picked', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 1' }), {
      target: { value: 'bass' },
    })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(false)
  })

  it('emits clefs[{staffIdx:0, clef:"bass"}] on single-staff Apply', () => {
    const onPatch = vi.fn()
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 1' }), {
      target: { value: 'bass' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      clefs: [{ staffIdx: 0, clef: 'bass' }],
    })
  })

  it('two-staff: emits clefs for ONLY the staves with a non-empty pick', () => {
    const onPatch = vi.fn()
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        staffCount={2}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    // Only flip staff 2 from treble → bass; staff 1 stays untouched.
    fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 2' }), {
      target: { value: 'bass' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      clefs: [{ staffIdx: 1, clef: 'bass' }],
    })
  })

  it('two-staff: emits BOTH clef entries when both staves are set', () => {
    const onPatch = vi.fn()
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        staffCount={2}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 1' }), {
      target: { value: 'treble' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 2' }), {
      target: { value: 'bass' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      clefs: [
        { staffIdx: 0, clef: 'treble' },
        { staffIdx: 1, clef: 'bass' },
      ],
    })
  })

  it('emits clefs alongside other fields when several are set together', () => {
    const onPatch = vi.fn()
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Key' }), {
      target: { value: 'G' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 1' }), {
      target: { value: 'bass' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      key: 'G',
      clefs: [{ staffIdx: 0, clef: 'bass' }],
    })
  })

  it('CLEARS clef pickers after Apply (asymmetry vs key/meter — clef rarely repeats bar-to-bar)', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        staffCount={2}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 1' }), {
      target: { value: 'bass' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 2' }), {
      target: { value: 'treble' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(
      (screen.getByRole('combobox', { name: 'Clef change staff 1' }) as HTMLSelectElement).value,
    ).toBe('')
    expect(
      (screen.getByRole('combobox', { name: 'Clef change staff 2' }) as HTMLSelectElement).value,
    ).toBe('')
  })

  it('existing-marker summary prints "clef → X" for single-clef markers', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[
          makeMarker({
            id: 'marker0099',
            tempo_bpm: undefined,
            clefs: [{ staffIdx: 0, clef: 'bass' }],
          }),
        ]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('list', { name: 'Existing markers' }).textContent,
    ).toContain('clef → bass')
  })

  it('existing-marker summary prints "staff N → X" for multi-clef markers', () => {
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[
          makeMarker({
            id: 'marker0100',
            tempo_bpm: undefined,
            clefs: [
              { staffIdx: 0, clef: 'treble' },
              { staffIdx: 1, clef: 'bass' },
            ],
          }),
        ]}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const txt = screen.getByRole('list', { name: 'Existing markers' }).textContent ?? ''
    expect(txt).toContain('staff 1 → treble')
    expect(txt).toContain('staff 2 → bass')
  })

  it('single-staff: staff-2 pick is IGNORED even if state was somehow set', () => {
    // Guard against a future refactor that leaks the staff-2 state
    // into the patch when staffCount=1. The form section is hidden
    // for staffCount=1, but computePatch must also gate.
    const onPatch = vi.fn()
    const { rerender } = render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        staffCount={2}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    // Set staff 2 while two-staff is in effect.
    fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 2' }), {
      target: { value: 'bass' },
    })
    // Then shrink to single-staff (e.g. user removed secondStaff via
    // some other action). The staff-2 row vanishes; staff-2 state
    // must not bleed into the patch.
    rerender(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        staffCount={1}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    // Now set staff 1 + Apply — patch should only include staff 1.
    fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 1' }), {
      target: { value: 'treble' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'insert',
      clefs: [{ staffIdx: 0, clef: 'treble' }],
    })
  })
})

describe('MarkerPopover — remove', () => {
  it('clicking × emits a remove patch with that id', () => {
    const onPatch = vi.fn()
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[
          makeMarker({ id: 'marker0001', tempo_bpm: 120, tempo_text: 'Allegro' }),
        ]}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Remove marker/ }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'remove', id: 'marker0001' })
  })
})

describe('MarkerPopover — Cancel', () => {
  it('Cancel closes without emitting a patch', () => {
    const onClose = vi.fn()
    const onPatch = vi.fn()
    render(
      <MarkerPopover
        open
        anchorX={400}
        anchorY={100}
        existingMarkers={[]}
        onClose={onClose}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(onPatch).not.toHaveBeenCalled()
  })
})
