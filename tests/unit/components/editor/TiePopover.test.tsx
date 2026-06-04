import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import TiePopover, { type TiePopoverPatch } from '@/components/editor/TiePopover'
import type { Pitch } from '@/lib/music/types'

afterEach(() => cleanup())

const C4: Pitch = { step: 'C', octave: 4 }
const E4: Pitch = { step: 'E', octave: 4 }
const G4: Pitch = { step: 'G', octave: 4 }
const REST4: Pitch = { step: 'rest', octave: 4 }

describe('TiePopover — render', () => {
  it('renders header with "single pitch" label for monophonic event', () => {
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[C4]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByText(/single pitch/i)).toBeDefined()
  })

  it('renders header with "chord" label for chord-stack event', () => {
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[C4, E4, G4]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    // The header text uniquely contains "Tie (chord — ...)". The body
    // also has a "Tie chord into next event" toggle label, so match
    // the exact header substring.
    expect(screen.getByText(/Tie \(chord — /i)).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <TiePopover
        open={false}
        anchorX={400}
        anchorY={100}
        pitches={[C4]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders one row per pitch for a chord event', () => {
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[C4, E4, G4]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByText('C4')).toBeDefined()
    expect(screen.getByText('E4')).toBeDefined()
    expect(screen.getByText('G4')).toBeDefined()
  })

  it('renders sharp/flat glyphs in pitch labels', () => {
    const Csharp: Pitch = { step: 'C', octave: 4, accidental: 'sharp' }
    const Dflat: Pitch = { step: 'D', octave: 5, accidental: 'flat' }
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[Csharp, Dflat]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByText('C♯4')).toBeDefined()
    expect(screen.getByText('D♭5')).toBeDefined()
  })

  it('event-wide checkbox reflects eventTiedToNext prop', () => {
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[C4]}
        eventTiedToNext={true}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const evCheckbox = screen.getByRole('checkbox', { name: /Tie event to next/i })
    expect((evCheckbox as HTMLInputElement).checked).toBe(true)
  })

  it('per-pitch tied state reflects isPitchTiedToNext semantics', () => {
    // C is per-pitch tied; E is event-wide (would be tied if event-wide
    // were on, but here it's off so E stays untied); G is explicitly
    // false (releases an event-wide tie — but event-wide is off so
    // unchanged).
    const Ctied: Pitch = { ...C4, tied_to_next: true }
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[Ctied, E4, G4]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const checkboxes = screen.getAllByRole('checkbox')
    // Layout: event-wide checkbox first, then per-pitch (3 pitches × 3
    // checkboxes = 9). C row is checkboxes[1..3] (tie, lv, enh).
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true) // C tie
    expect((checkboxes[4] as HTMLInputElement).checked).toBe(false) // E tie
    expect((checkboxes[7] as HTMLInputElement).checked).toBe(false) // G tie
  })
})

describe('TiePopover — patch emission', () => {
  it('event-wide checkbox toggle emits kind:"event" patch', () => {
    const onPatch = vi.fn<(p: TiePopoverPatch) => void>()
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[C4]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    const evCheckbox = screen.getByRole('checkbox', { name: /Tie event to next/i })
    fireEvent.click(evCheckbox)
    expect(onPatch).toHaveBeenCalledWith({ kind: 'event', tied_to_next: true })
  })

  it('per-pitch tie checkbox emits kind:"pitch-tie" with the correct pitchIdx', () => {
    const onPatch = vi.fn<(p: TiePopoverPatch) => void>()
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[C4, E4, G4]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    // Find the middle pitch's tie checkbox by aria-label
    const eTie = screen.getByRole('checkbox', { name: /Tie pitch 2/i })
    fireEvent.click(eTie)
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'pitch-tie',
      pitchIdx: 1,
      tied_to_next: true,
    })
  })

  it('lv checkbox emits kind:"lv" with the correct pitchIdx', () => {
    const onPatch = vi.fn<(p: TiePopoverPatch) => void>()
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[C4]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    const lv = screen.getByRole('checkbox', { name: /Laissez vibrer pitch 1/i })
    fireEvent.click(lv)
    expect(onPatch).toHaveBeenCalledWith({ kind: 'lv', pitchIdx: 0, lv: true })
  })

  it('enharmonic checkbox emits kind:"enharmonic"', () => {
    const onPatch = vi.fn<(p: TiePopoverPatch) => void>()
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[C4]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    const enh = screen.getByRole('checkbox', { name: /Enharmonic respell pitch 1/i })
    fireEvent.click(enh)
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'enharmonic',
      pitchIdx: 0,
      enharmonicTie: true,
    })
  })

  it('unchecking a per-pitch tie emits kind:"pitch-tie" with false', () => {
    const onPatch = vi.fn<(p: TiePopoverPatch) => void>()
    const Ctied: Pitch = { ...C4, tied_to_next: true }
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[Ctied]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    const tie = screen.getByRole('checkbox', { name: /Tie pitch 1/i })
    fireEvent.click(tie)
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'pitch-tie',
      pitchIdx: 0,
      tied_to_next: false,
    })
  })
})

describe('TiePopover — rest semantics', () => {
  it('rest pitches have all 3 checkboxes disabled', () => {
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[REST4]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const tie = screen.getByRole('checkbox', { name: /Tie pitch 1 \(rest\)/i })
    const lv = screen.getByRole('checkbox', { name: /Laissez vibrer pitch 1 \(rest\)/i })
    const enh = screen.getByRole('checkbox', { name: /Enharmonic respell pitch 1 \(rest\)/i })
    expect((tie as HTMLInputElement).disabled).toBe(true)
    expect((lv as HTMLInputElement).disabled).toBe(true)
    expect((enh as HTMLInputElement).disabled).toBe(true)
  })

  it('event-wide checkbox disabled when all pitches are rests', () => {
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[REST4]}
        eventTiedToNext={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const ev = screen.getByRole('checkbox', { name: /Tie event to next/i })
    expect((ev as HTMLInputElement).disabled).toBe(true)
  })
})

describe('TiePopover — Close button', () => {
  it('Close calls onClose', () => {
    const onClose = vi.fn()
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[C4]}
        eventTiedToNext={false}
        onClose={onClose}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('TiePopover — derived tied state', () => {
  it('per-pitch tie state honors event-wide fallback (isPitchTiedToNext semantics)', () => {
    // Event-wide is true; per-pitch flags absent → all pitches show
    // tied=true (matches the renderer's behavior).
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[C4, E4, G4]}
        eventTiedToNext={true}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const allTieCheckboxes = screen
      .getAllByRole('checkbox')
      .filter((cb) => cb.getAttribute('aria-label')?.startsWith('Tie pitch'))
    expect(allTieCheckboxes).toHaveLength(3)
    for (const cb of allTieCheckboxes) {
      expect((cb as HTMLInputElement).checked).toBe(true)
    }
  })

  it('per-pitch tied:false WINS over event-wide tied:true', () => {
    // Event-wide true with E explicitly false → E should show
    // tied=false while C and G are tied=true.
    const Efalse: Pitch = { ...E4, tied_to_next: false }
    render(
      <TiePopover
        open
        anchorX={400}
        anchorY={100}
        pitches={[C4, Efalse, G4]}
        eventTiedToNext={true}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const cTie = screen.getByRole('checkbox', { name: /Tie pitch 1 \(C4\)/i })
    const eTie = screen.getByRole('checkbox', { name: /Tie pitch 2 \(E4\)/i })
    const gTie = screen.getByRole('checkbox', { name: /Tie pitch 3 \(G4\)/i })
    expect((cTie as HTMLInputElement).checked).toBe(true)
    expect((eTie as HTMLInputElement).checked).toBe(false)
    expect((gTie as HTMLInputElement).checked).toBe(true)
  })
})
