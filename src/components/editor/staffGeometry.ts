import type { Clef, Step } from '@/lib/music/types'

/**
 * Vertical pitch ladder for treble clef, top-to-bottom. Used to map
 * a click Y on the staff to a (step, octave) pair. Mirrors what abcjs
 * renders for K:C / treble: top line = F5, bottom line = E4, with
 * three additional ledger-line positions above and below.
 */
const TREBLE_LADDER: Array<{ step: Step; octave: number }> = [
  { step: 'F', octave: 5 }, { step: 'E', octave: 5 }, { step: 'D', octave: 5 },
  { step: 'C', octave: 5 }, { step: 'B', octave: 4 }, { step: 'A', octave: 4 },
  { step: 'G', octave: 4 }, { step: 'F', octave: 4 }, { step: 'E', octave: 4 },
  { step: 'D', octave: 4 }, { step: 'C', octave: 4 }, { step: 'B', octave: 3 },
  { step: 'A', octave: 3 }, { step: 'G', octave: 3 },
]

/**
 * Vertical pitch ladder for bass clef, top-to-bottom. Top line = A3,
 * middle line = D3, bottom line = G2 (the bass-clef convention). Cuts
 * off at D2 since the schema's octave minimum is 2; clicks below D2
 * snap to D2 via the index clamp in pitchFromY.
 */
const BASS_LADDER: Array<{ step: Step; octave: number }> = [
  { step: 'A', octave: 3 }, { step: 'G', octave: 3 }, { step: 'F', octave: 3 },
  { step: 'E', octave: 3 }, { step: 'D', octave: 3 }, { step: 'C', octave: 3 },
  { step: 'B', octave: 2 }, { step: 'A', octave: 2 }, { step: 'G', octave: 2 },
  { step: 'F', octave: 2 }, { step: 'E', octave: 2 }, { step: 'D', octave: 2 },
]

function ladderFor(clef: Clef): Array<{ step: Step; octave: number }> {
  return clef === 'bass' ? BASS_LADDER : TREBLE_LADDER
}

/** Read the five staff-line Y-coordinates from a specific `.abcjs-staff`
 *  group, ascending (top-first). Operates on an explicit staff element
 *  so callers in multi-staff scenes don't accidentally read the wrong
 *  system's geometry — use {@link resolveStaffFromY} to pick the right
 *  element first. Returns undefined when the staff has fewer than five
 *  line paths (e.g. mid-engrave). */
export function getStaffYPositionsFor(staffEl: Element): number[] | undefined {
  const lines = staffEl.querySelectorAll('path')
  const ys: number[] = []
  for (const path of lines) {
    const d = path.getAttribute('d') ?? ''
    const m = d.match(/M\s*[\d.-]+\s+([\d.-]+)/)
    if (m) ys.push(parseFloat(m[1]))
  }
  ys.sort((a, b) => a - b)
  return ys.length >= 5 ? ys.slice(0, 5) : undefined
}

/** Convenience wrapper: read the first `.abcjs-staff` group's lines.
 *  Suitable for single-staff scenarios and tests; multi-staff callers
 *  should resolve the specific staff via {@link resolveStaffFromY} and
 *  call {@link getStaffYPositionsFor}. */
export function getStaffYPositions(svg: SVGSVGElement): number[] | undefined {
  const staff = svg.querySelector('.abcjs-staff')
  if (!staff) return undefined
  return getStaffYPositionsFor(staff)
}

/** Clef-aware pitch nearest a given client Y, or undefined if the
 *  staff geometry isn't available (e.g. before the first render).
 *
 *  `staffEl` selects which staff's line-paths to read. When omitted,
 *  the first `.abcjs-staff` in the SVG is used — correct only for
 *  single-staff, single-system renders. Callers handling multi-staff
 *  scores MUST resolve the clicked staff via {@link resolveStaffFromY}
 *  and pass its `staffEl` here, otherwise grand-staff bass-clef clicks
 *  fall back to the treble staff's line geometry. */
export function pitchFromY(
  svg: SVGSVGElement,
  clickClientY: number,
  clef: Clef = 'treble',
  staffEl?: Element,
): { step: Step; octave: number } | undefined {
  const staffYs = staffEl
    ? getStaffYPositionsFor(staffEl)
    : getStaffYPositions(svg)
  if (!staffYs) return undefined
  const rect = svg.getBoundingClientRect()
  const viewBox = svg.viewBox.baseVal
  const svgY = ((clickClientY - rect.top) / rect.height) * viewBox.height
  const topLineY = staffYs[0]
  const stepHeight = (staffYs[4] - staffYs[0]) / 8
  const stepsBelowTop = Math.round((svgY - topLineY) / stepHeight)
  const ladder = ladderFor(clef)
  const idx = Math.max(0, Math.min(ladder.length - 1, stepsBelowTop))
  return ladder[idx]
}

const STEP_SEMITONES: Record<Exclude<Step, 'rest'>, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
}

/** Diatonic ladder index (used for closest-pitch matching by Y).
 *  C0 = 0, D0 = 1, ..., B0 = 6, C1 = 7, ... — ignores accidentals. */
export function diatonicLadder(step: Exclude<Step, 'rest'>, octave: number): number {
  return octave * 7 + (['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const).indexOf(step)
}

/** Approximate MIDI for a (step, octave) pair, ignoring accidentals.
 *  Used for pitch-distance comparisons where the rendered notehead
 *  position determines the match (accidentals don't change Y). */
export function midiFromStep(step: Exclude<Step, 'rest'>, octave: number): number {
  return (octave + 1) * 12 + STEP_SEMITONES[step]
}
