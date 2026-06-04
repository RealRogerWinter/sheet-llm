import { detect as chordDetect, get as chordGet } from '@tonaljs/chord'
import { get as noteGet } from '@tonaljs/note'
import type { Accidental, Key, Pitch, Step } from './types'

export class ChordBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChordBuildError'
  }
}

/**
 * V1 chord palette: common triads + 7th chords. `tonalSymbol` is the
 * suffix tonal recognises in a chord name (e.g. "Cmaj7", "Dm7", "Bbm7b5").
 */
export const CHORD_QUALITIES = [
  { id: 'maj',  label: 'Major',      tonalSymbol: 'M' },
  { id: 'min',  label: 'Minor',      tonalSymbol: 'm' },
  { id: 'dim',  label: 'Diminished', tonalSymbol: 'dim' },
  { id: 'aug',  label: 'Augmented',  tonalSymbol: 'aug' },
  { id: 'sus2', label: 'Sus 2',      tonalSymbol: 'sus2' },
  { id: 'sus4', label: 'Sus 4',      tonalSymbol: 'sus4' },
  { id: 'maj7', label: 'Maj 7',      tonalSymbol: 'maj7' },
  { id: 'm7',   label: 'Min 7',      tonalSymbol: 'm7' },
  { id: '7',    label: 'Dom 7',      tonalSymbol: '7' },
  { id: 'dim7', label: 'Dim 7',      tonalSymbol: 'dim7' },
  { id: 'm7b5', label: 'Half-dim 7', tonalSymbol: 'm7b5' },
] as const

export type ChordQuality = typeof CHORD_QUALITIES[number]
export type ChordQualityId = ChordQuality['id']

// --- key signature alterations table ------------------------------------

const KEY_SHARPS_ORDER: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
const KEY_FLATS_ORDER: Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F']

const KEY_SIGN: Record<Key, number> = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
  F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
  Am: 0, Em: 1, Bm: 2, 'F#m': 3, 'C#m': 4, 'G#m': 5, 'D#m': 6, 'A#m': 7,
  Dm: -1, Gm: -2, Cm: -3, Fm: -4, Bbm: -5, Ebm: -6, Abm: -7,
}

/** Alteration (in semitones) implied by the key signature for a step. */
export function keyAlt(key: Key, step: Step): number {
  if (step === 'rest') return 0
  const n = KEY_SIGN[key]
  if (n > 0) return KEY_SHARPS_ORDER.slice(0, n).includes(step) ? 1 : 0
  if (n < 0) return KEY_FLATS_ORDER.slice(0, -n).includes(step) ? -1 : 0
  return 0
}

// --- step / accidental helpers ------------------------------------------

const STEP_SEMITONES: Record<Exclude<Step, 'rest'>, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
}

function altFromAccidental(a: Accidental | undefined, fallback: number): number {
  switch (a) {
    case 'sharp':    return 1
    case 'flat':     return -1
    case 'dblsharp': return 2
    case 'dblflat':  return -2
    case 'natural':  return 0
    case 'none':
    case undefined:  return fallback
  }
}

function altToAccidental(alt: number): Accidental {
  switch (alt) {
    case  0: return 'natural'
    case  1: return 'sharp'
    case -1: return 'flat'
    case  2: return 'dblsharp'
    case -2: return 'dblflat'
    default: throw new ChordBuildError(`Unsupported alteration ${alt}`)
  }
}

function altToTonalSymbol(alt: number): string {
  switch (alt) {
    case  0: return ''
    case  1: return '#'
    case -1: return 'b'
    case  2: return '##'
    case -2: return 'bb'
    default: throw new ChordBuildError(`Unsupported alteration ${alt}`)
  }
}

/** MIDI number for an (step, alt, octave) tuple in Scientific Pitch
 *  Notation (C4 = 60). */
function midiOf(step: Exclude<Step, 'rest'>, alt: number, octave: number): number {
  return (octave + 1) * 12 + STEP_SEMITONES[step] + alt
}

/** Returns the `accidental` field to set on a chord-tone Pitch so it
 *  sounds with the requested alteration under the given key signature,
 *  or undefined when the key signature already provides it (no override
 *  needed — keeps output clean). */
function accidentalForChordTone(step: Step, alt: number, key: Key): Accidental | undefined {
  if (step === 'rest') return undefined
  if (keyAlt(key, step) === alt) return undefined
  return altToAccidental(alt)
}

// --- public API ---------------------------------------------------------

/** Convert a Pitch to a tonal note name. When `accidental` is unset, the
 *  key signature determines the sounding alteration. */
export function pitchToTonalName(p: Pitch, key: Key): string {
  if (p.step === 'rest') throw new ChordBuildError('Cannot convert a rest to a tonal name')
  const alt = altFromAccidental(p.accidental, keyAlt(key, p.step))
  return `${p.step}${altToTonalSymbol(alt)}${p.octave}`
}

/** Convert a tonal note name (with octave, e.g. "Eb4") into a Pitch. */
export function tonalNoteToPitch(name: string, key: Key): Pitch | undefined {
  const info = noteGet(name)
  if (info.empty || info.oct === undefined) return undefined
  const step = info.letter as Step
  const alt = info.alt as number
  const accidental = accidentalForChordTone(step, alt, key)
  const pitch: Pitch = { step, octave: info.oct }
  if (accidental !== undefined) pitch.accidental = accidental
  return pitch
}

/** Build the pitch list for a chord rooted on `root` with quality
 *  `qualityId`, spelled under `key`. Pitches are returned ascending
 *  (each chord tone's MIDI > the previous tone's MIDI). */
export function buildChord(root: Pitch, qualityId: ChordQualityId, key: Key): Pitch[] {
  if (root.step === 'rest') throw new ChordBuildError('Cannot build a chord on a rest')
  const quality = CHORD_QUALITIES.find((q) => q.id === qualityId)
  if (!quality) throw new ChordBuildError(`Unknown chord quality: ${qualityId}`)

  const rootAlt = altFromAccidental(root.accidental, keyAlt(key, root.step))
  const rootName = `${root.step}${altToTonalSymbol(rootAlt)}`
  const symbol = rootName + quality.tonalSymbol

  const chord = chordGet(symbol)
  if (chord.empty || chord.notes.length === 0) {
    throw new ChordBuildError(`Could not build chord "${symbol}"`)
  }

  const pitches: Pitch[] = []
  let prevMidi = -Infinity
  let currentOctave = root.octave

  for (let i = 0; i < chord.notes.length; i++) {
    const info = noteGet(chord.notes[i])
    if (info.empty) {
      throw new ChordBuildError(`Could not parse chord note "${chord.notes[i]}"`)
    }
    const step = info.letter as Exclude<Step, 'rest'>
    const alt = info.alt as number
    let oct = i === 0 ? root.octave : currentOctave
    let midi = midiOf(step, alt, oct)
    while (i > 0 && midi <= prevMidi) {
      oct += 1
      midi = midiOf(step, alt, oct)
    }
    if (oct < 2 || oct > 6) {
      throw new ChordBuildError(
        `Chord "${symbol}" rooted on ${root.step}${root.octave} extends out of supported range (octave ${oct})`,
      )
    }
    const accidental = accidentalForChordTone(step, alt, key)
    const pitch: Pitch = { step, octave: oct }
    if (accidental !== undefined) pitch.accidental = accidental
    pitches.push(pitch)
    currentOctave = oct
    prevMidi = midi
  }

  return pitches
}

/** Return pitches sorted from lowest MIDI to highest. Stable for equal MIDI.
 *  Rests (if any) sort to the front. When `key` is supplied, pitches with
 *  no explicit accidental are scored under the key signature. */
export function sortPitchesAscending(pitches: Pitch[], key?: Key): Pitch[] {
  const withMidi = pitches.map((p, i) => {
    if (p.step === 'rest') return { p, i, midi: -Infinity }
    const alt = altFromAccidental(p.accidental, key !== undefined ? keyAlt(key, p.step) : 0)
    return { p, i, midi: midiOf(p.step, alt, p.octave) }
  })
  withMidi.sort((a, b) => a.midi - b.midi || a.i - b.i)
  return withMidi.map((w) => w.p)
}

const STEP_ORDER: Exclude<Step, 'rest'>[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B']

/** Return the pitch a diatonic `intervalSteps`-th above the given pitch.
 *  Examples: intervalSteps=3 walks two letter-steps up (C→E, D→F, F→A).
 *  Accidental is left implicit so the key signature governs the
 *  chord-tone alteration at render time. Throws when the result
 *  extends past octave 6. */
export function diatonicAbove(pitch: Pitch, intervalSteps: number): Pitch {
  if (pitch.step === 'rest') {
    throw new ChordBuildError('Cannot compute a diatonic interval above a rest')
  }
  if (intervalSteps < 1) {
    throw new ChordBuildError(`Interval ${intervalSteps} must be >= 1`)
  }
  let idx = STEP_ORDER.indexOf(pitch.step)
  let oct = pitch.octave
  idx += intervalSteps - 1
  while (idx >= STEP_ORDER.length) {
    idx -= STEP_ORDER.length
    oct += 1
  }
  if (oct < 2 || oct > 6) {
    throw new ChordBuildError(
      `Diatonic ${intervalSteps}-above ${pitch.step}${pitch.octave} extends out of range (octave ${oct})`,
    )
  }
  // No accidental field — key signature governs the chord-tone alteration.
  return { step: STEP_ORDER[idx], octave: oct }
}

/** Best-effort chord name for a stack of pitches (e.g. "Cmaj7", "Em").
 *  Returns null if tonal cannot identify any chord. Needs ≥2 non-rest pitches. */
export function chordNameFromPitches(pitches: Pitch[], key: Key): string | null {
  if (pitches.length < 2) return null
  if (pitches.some((p) => p.step === 'rest')) return null
  const names = pitches.map((p) => pitchToTonalName(p, key))
  const detected = chordDetect(names)
  return detected.length > 0 ? detected[0] : null
}
