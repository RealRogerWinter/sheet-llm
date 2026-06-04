import type { Event, Key, Pitch, Score, Step } from './types'
import { getVoiceMeasures } from './scoreAccessors'

/**
 * Cadence-at-final-barline detector (M3.5-PR-3).
 *
 * Heuristic: look at the last two pitched events of the requested
 * voice; classify each by the pitch-class of its lowest pitch against
 * the active key's degrees:
 *   - I (or i in minor)        → 0    semitones above tonic
 *   - V (or v in minor)        → 7    semitones above tonic
 *   - IV (or iv in minor)      → 5    semitones above tonic
 *   - vi (or VI)               → 9    semitones above tonic
 *
 * Detected cadence kinds:
 *   authentic : V → I   (perfect cadence; the "splice past the
 *               ending" warning case)
 *   plagal    : IV → I
 *   half      : ? → V   (anything that lands on V at the end)
 *   deceptive : V → vi  (or V → VI in minor)
 *
 * Heuristic only — false positives/negatives are acceptable.
 * Callers WARN, never block. A fermata on the final event is an
 * additional "this is the end" signal but not required.
 *
 * Returns `{ detected: false }` when:
 *   - the voice has < 2 events
 *   - either of the last two events is a rest
 *   - the key isn't one of the standard major/minor keys
 *   - the chord roots don't match a recognised V-I / IV-I / X-V / V-vi pattern
 */
export type CadenceKind = 'authentic' | 'plagal' | 'half' | 'deceptive'

export interface CadenceResult {
  detected: boolean
  kind?: CadenceKind
  /** True when the final event carries a fermata (any duration) — an
   *  extra signal that this is "the end". */
  finalFermata?: boolean
}

const STEP_SEMITONE: Record<Exclude<Step, 'rest'>, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
}

const ACCIDENTAL_DELTA: Record<string, number> = {
  natural: 0,
  sharp: 1,
  flat: -1,
  dblsharp: 2,
  dblflat: -2,
  none: 0,
}

/** Pitch-class of the tonic for every supported key. Major/minor keys
 *  share their tonic PC — Am and C both root at PC 0 / PC 9
 *  respectively; the helper returns the actual key-root semitone
 *  ignoring quality, which is all the cadence heuristic needs. */
const KEY_TONIC_PC: Record<Key, number> = {
  C: 0,
  G: 7,
  D: 2,
  A: 9,
  E: 4,
  B: 11,
  'F#': 6,
  'C#': 1,
  F: 5,
  Bb: 10,
  Eb: 3,
  Ab: 8,
  Db: 1,
  Gb: 6,
  Cb: 11,
  Am: 9,
  Em: 4,
  Bm: 11,
  'F#m': 6,
  'C#m': 1,
  'G#m': 8,
  'D#m': 3,
  'A#m': 10,
  Dm: 2,
  Gm: 7,
  Cm: 0,
  Fm: 5,
  Bbm: 10,
  Ebm: 3,
  Abm: 8,
}

function pitchPc(p: Pitch): number | null {
  if (p.step === 'rest') return null
  const base = STEP_SEMITONE[p.step]
  const delta = p.accidental ? (ACCIDENTAL_DELTA[p.accidental] ?? 0) : 0
  return ((base + delta) % 12 + 12) % 12
}

/** Lowest non-rest pitch of an event, as a pitch-class (0..11), or
 *  null when the event is a rest. */
function lowestPc(e: Event): number | null {
  let lowestMidi = Number.POSITIVE_INFINITY
  let lowestPitch: Pitch | null = null
  for (const p of e.pitches) {
    if (p.step === 'rest') continue
    const semi = STEP_SEMITONE[p.step] + (p.accidental ? (ACCIDENTAL_DELTA[p.accidental] ?? 0) : 0)
    const midi = (p.octave + 1) * 12 + semi
    if (midi < lowestMidi) {
      lowestMidi = midi
      lowestPitch = p
    }
  }
  if (!lowestPitch) return null
  return pitchPc(lowestPitch)
}

/** Degree relative to tonic (0 = I, 7 = V, etc.) — modulo 12. */
function degree(pc: number, tonicPc: number): number {
  return (((pc - tonicPc) % 12) + 12) % 12
}

/**
 * Detect a cadence at the final barline of the given (staff, voice).
 * Defaults to (0, 0) — the primary line. Returns `{ detected: true,
 * kind: ... }` when the last two events match a recognised pattern.
 */
export function detectCadenceAtFinalBarline(
  score: Score,
  staffIdx = 0,
  voiceIdx = 0,
): CadenceResult {
  const measures = getVoiceMeasures(score, staffIdx, voiceIdx)
  if (measures.length === 0) return { detected: false }
  const lastMeasure = measures[measures.length - 1]

  // We want the last two PITCHED events. They might both live in the
  // final measure (V-I in the last bar) or split across the penultimate
  // and final bars (V on the upbeat of m.n-1, I on the downbeat of
  // m.n). Walk events RIGHT-to-LEFT across the last few measures.
  // PR-7 tuning: extended the window to 16 (was 8) so a phrase like
  // F → G → C → C (IV V I I — a PAC with the tonic repeated) is still
  // detected: we skip trailing tonic-repeats below.
  const flat: Event[] = []
  for (let mi = measures.length - 1; mi >= 0 && flat.length < 16; mi--) {
    const m = measures[mi]
    for (let ei = m.events.length - 1; ei >= 0; ei--) {
      flat.push(m.events[ei])
    }
  }
  if (flat.length < 2) return { detected: false }

  const tonicPc = KEY_TONIC_PC[score.key]
  if (tonicPc === undefined) return { detected: false }

  const lastEvent = flat[0]
  const lastPcRaw = lowestPc(lastEvent)
  if (lastPcRaw === null) return { detected: false }
  const lastDegRaw = degree(lastPcRaw, tonicPc)

  // PR-7 tuning: if the final event is the tonic, skip backwards over
  // any further tonic-repeats so a phrase like IV V I I (PAC with a
  // repeated tonic) still detects as V→I. The harmonic cadence is the
  // motion INTO the tonic, not from the tonic to itself. We keep the
  // "last event" as the tonic landing for fermata/result purposes.
  let prevIdx = 1
  if (lastDegRaw === 0) {
    while (prevIdx < flat.length) {
      const pc = lowestPc(flat[prevIdx])
      if (pc === null) break
      if (degree(pc, tonicPc) !== 0) break
      prevIdx++
    }
  }
  if (prevIdx >= flat.length) return { detected: false }
  const prev = flat[prevIdx]
  const last = lastEvent
  const prevPc = lowestPc(prev)
  if (prevPc === null) return { detected: false }

  const lastDeg = lastDegRaw
  const prevDeg = degree(prevPc, tonicPc)

  const finalFermata = last.fermata !== undefined || lastMeasure.barlineFermata !== undefined

  // V → I (or v → i) : authentic
  if (prevDeg === 7 && lastDeg === 0) {
    return { detected: true, kind: 'authentic', finalFermata }
  }
  // IV → I : plagal
  if (prevDeg === 5 && lastDeg === 0) {
    return { detected: true, kind: 'plagal', finalFermata }
  }
  // V → vi : deceptive (both major and minor flavors)
  if (prevDeg === 7 && lastDeg === 9) {
    return { detected: true, kind: 'deceptive', finalFermata }
  }
  // ? → V : half cadence (any approach to V at the end). Only flag
  // when the last event clearly lands on V and the preceding event is
  // something other than V itself (otherwise it's a static dominant
  // pedal, not a half cadence per se).
  if (lastDeg === 7 && prevDeg !== 7) {
    return { detected: true, kind: 'half', finalFermata }
  }
  return { detected: false }
}
