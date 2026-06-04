import { XMLParser } from 'fast-xml-parser'
import type {
  Accidental,
  Clef,
  Duration,
  Event,
  Key,
  Measure,
  Meter,
  Pitch,
  Score,
  Staff,
  Step,
  Voice,
} from '../types'
import { KeySchema, MeterSchema, ScoreSchema } from '../types'
import { normalize } from './normalize'
import type { ImportOptions, ImportResult, ImportWarning } from './types'

/**
 * MusicXML 4.0 score-partwise importer (export/import parity).
 *
 * This is the inverse of `scoreToMusicXml` (src/lib/music/export/musicxml.ts):
 * its job is to re-open the uncompressed `.musicxml` documents we export so
 * the round-trip subset survives (key / meter / clef / measure count / a
 * representative set of notes + rests + chords + accidentals + ties +
 * tuplets + a grand-staff second staff). It is deliberately a SUBSET parser:
 *
 *   - Reads `<score-partwise>` (the only root we emit). `<score-timewise>`
 *     and compressed `.mxl` (zip) are rejected upstream in detect.ts /
 *     route.ts.
 *   - First-measure (or any-measure) `<attributes>`: divisions, key
 *     (fifths + mode), time (beats/beat-type, common/cut), clef (G→treble,
 *     F→bass), and `<staves>` (2 → grand staff via `secondStaff`).
 *   - `<note>`: rest vs pitch; `<chord/>` stacks onto the previous event;
 *     `<duration>` (in divisions) → our Duration enum (preferring `<type>`
 *     + `<dot/>` when present, else nearest fraction, with a
 *     `duration_rounded` warning when inexact); `<accidental>`/`<alter>` →
 *     our accidental; `<tie type="start">` → per-pitch `tied_to_next`;
 *     `<time-modification>`/`<tuplet>` → our tuplet (3/5/6/7) best-effort.
 *   - `<voice>` + `<staff>` route notes to the primary voice, `extraVoices`,
 *     or `secondStaff` (+ its extraVoices). `<backup>`/`<forward>` are used
 *     only to keep each voice's timeline aligned (no emitted output).
 *   - Tempo from `<sound tempo=>` or `<metronome>` → `tempo_bpm` (clamped /
 *     dropped with `tempo_dropped`).
 *   - Metadata: `<work-title>` → title; `<creator type=...>` →
 *     composer / arranger / lyricist; `<rights>` → copyright.
 *
 * Anything the model can't represent (barlines beyond defaults, repeats,
 * voltas, dynamics, articulations, spans, harmony, lyrics) is dropped with
 * an `unsupported_element` info warning rather than failing — correctness on
 * the round-trip subset is prioritized over breadth. Malformed XML or a
 * non-MusicXML document yields a single blocking `parse_failed` warning.
 *
 * The result is run through `normalize()` + `ScoreSchema` exactly like
 * `jsonToScore` / `abcToScore`, enforcing the same caps (max 2 staves, max 4
 * voices/staff, tempo 30–240, chord max 6, octave [0,9], MAX_MEASURES).
 */

const STEPS: ReadonlyArray<Exclude<Step, 'rest'>> = ['C', 'D', 'E', 'F', 'G', 'A', 'B']

/** Subset of the parsed XML shapes we touch. fast-xml-parser yields either
 *  scalars (for text-only leaves) or objects with `#text` + `@_attr` keys,
 *  so every accessor below normalizes through `text()` / `num()` / `attr()`. */
type XmlNode = Record<string, unknown> | string | number | boolean | null | undefined

interface ParseState {
  warnings: ImportWarning[]
  /** Coalesce the high-volume "dropped X" notes into one warning per kind. */
  droppedKinds: Set<string>
}

// ── fast-xml-parser config ───────────────────────────────────────────

/**
 * Elements that must ALWAYS be arrays even when a single occurrence is
 * present, so the walker doesn't branch on "object vs array". MusicXML's
 * partwise tree repeats these.
 */
const FORCE_ARRAY = new Set([
  'part',
  'measure',
  'note',
  'clef',
  'beat-unit',
  'creator',
  'rights',
  'staff-details',
  'direction',
  'direction-type',
  'sound',
  'attributes',
])

function makeParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Keep numeric-looking text as strings so e.g. a `<step>` of "E" and a
    // `<duration>` of "8" go through the same accessor without surprise
    // coercions; we parse numbers explicitly where needed.
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: (name) => FORCE_ARRAY.has(name),
  })
}

// ── normalized accessors ─────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Text content of a node. Handles scalar leaves and `{#text}` objects. */
function text(node: XmlNode): string | undefined {
  if (node === undefined || node === null) return undefined
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (isObj(node)) {
    const t = node['#text']
    if (t === undefined || t === null) return undefined
    return String(t)
  }
  return undefined
}

function num(node: XmlNode): number | undefined {
  const t = text(node)
  if (t === undefined) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** Attribute value off an element node (returns undefined for scalars). */
function attr(node: XmlNode, name: string): string | undefined {
  if (!isObj(node)) return undefined
  const v = node[`@_${name}`]
  if (v === undefined || v === null) return undefined
  return String(v)
}

/** Child element (single). Returns undefined when absent. When the parser
 *  produced an array (forced or repeated), returns the first entry. */
function child(node: XmlNode, name: string): XmlNode {
  if (!isObj(node)) return undefined
  const v = node[name]
  if (Array.isArray(v)) return v[0] as XmlNode
  return v as XmlNode
}

/** Child elements as an array, regardless of single vs repeated. */
function children(node: XmlNode, name: string): XmlNode[] {
  if (!isObj(node)) return []
  const v = node[name]
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? (v as XmlNode[]) : [v as XmlNode]
}

function has(node: XmlNode, name: string): boolean {
  return isObj(node) && node[name] !== undefined
}

// ── enum mapping ─────────────────────────────────────────────────────

/**
 * MusicXML `<key>` (fifths + mode) → our Key enum. Mirrors the exporter's
 * KEY_FIFTHS table exactly so the round-trip is lossless for the 30 keys we
 * support. Returns undefined for combinations outside the enum (e.g. a
 * modal mode, or fifths beyond ±7) so the caller can warn + fall back.
 */
function fifthsToKey(fifths: number, mode: 'major' | 'minor'): Key | undefined {
  const MAJOR: Record<number, Key> = {
    [-7]: 'Cb', [-6]: 'Gb', [-5]: 'Db', [-4]: 'Ab', [-3]: 'Eb', [-2]: 'Bb',
    [-1]: 'F', 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#',
  }
  const MINOR: Record<number, Key> = {
    [-7]: 'Abm', [-6]: 'Ebm', [-5]: 'Bbm', [-4]: 'Fm', [-3]: 'Cm', [-2]: 'Gm',
    [-1]: 'Dm', 0: 'Am', 1: 'Em', 2: 'Bm', 3: 'F#m', 4: 'C#m', 5: 'G#m',
    6: 'D#m', 7: 'A#m',
  }
  const label = (mode === 'minor' ? MINOR : MAJOR)[fifths]
  if (!label) return undefined
  const parsed = KeySchema.safeParse(label)
  return parsed.success ? parsed.data : undefined
}

/** MusicXML `<time>` → our Meter. Honors symbol="common"/"cut" first, then
 *  beats/beat-type. Returns undefined when the result isn't a valid Meter. */
function timeToMeter(timeNode: XmlNode): Meter | undefined {
  const symbol = attr(timeNode, 'symbol')
  if (symbol === 'common') return '4/4' as Meter
  if (symbol === 'cut') return 'C|' as Meter
  const beats = num(child(timeNode, 'beats'))
  const beatType = num(child(timeNode, 'beat-type'))
  if (beats === undefined || beatType === undefined) return undefined
  const label = `${beats}/${beatType}`
  const parsed = MeterSchema.safeParse(label)
  return parsed.success ? (parsed.data as Meter) : undefined
}

/** MusicXML `<clef>` sign → our Clef. G→treble, F→bass; anything else
 *  (C clefs, percussion, TAB) is unsupported and returns undefined. */
function signToClef(sign: string | undefined): Clef | undefined {
  if (!sign) return undefined
  if (sign === 'G') return 'treble'
  if (sign === 'F') return 'bass'
  return undefined
}

/** MusicXML `<alter>` / `<accidental>` → our Accidental. */
function accidentalOf(noteNode: XmlNode): Accidental | undefined {
  const accText = text(child(noteNode, 'accidental'))
  if (accText) {
    switch (accText) {
      case 'sharp':
        return 'sharp'
      case 'flat':
        return 'flat'
      case 'natural':
        return 'natural'
      case 'double-sharp':
      case 'sharp-sharp':
        return 'dblsharp'
      case 'flat-flat':
      case 'double-flat':
        return 'dblflat'
      default:
        break
    }
  }
  // Fall back to <alter> when no explicit <accidental> glyph was emitted.
  const alter = num(child(child(noteNode, 'pitch'), 'alter'))
  if (alter === 1) return 'sharp'
  if (alter === -1) return 'flat'
  if (alter === 2) return 'dblsharp'
  if (alter === -2) return 'dblflat'
  return undefined
}

// ── duration mapping ─────────────────────────────────────────────────

const DIVISIONS_PER_WHOLE_FACTOR = 4 // <divisions> = per-quarter; whole = 4×

/** Our Duration enum keyed by fraction-of-whole (matches the exporter +
 *  abcToScore's DURATION_BY_FRACTION table). */
const DURATION_BY_FRACTION: ReadonlyArray<{ frac: number; name: Duration }> = [
  { frac: 1, name: 'whole' },
  { frac: 0.75, name: 'dotted-half' },
  { frac: 0.5, name: 'half' },
  { frac: 0.375, name: 'dotted-quarter' },
  { frac: 0.25, name: 'quarter' },
  { frac: 0.1875, name: 'dotted-eighth' },
  { frac: 0.125, name: 'eighth' },
  { frac: 0.0625, name: 'sixteenth' },
  { frac: 0.03125, name: '32nd' },
]

/** Map a MusicXML `<type>` token (+ dot count) to our Duration, when the
 *  exporter's note-type vocabulary is present. Returns undefined for types
 *  outside our enum (64th, breve, etc.) so the caller falls back to the
 *  divisions-fraction path. */
function typeAndDotsToDuration(typeTok: string | undefined, dots: number): Duration | undefined {
  if (!typeTok) return undefined
  const base: Record<string, Duration> = {
    whole: 'whole',
    half: 'half',
    quarter: 'quarter',
    eighth: 'eighth',
    '16th': 'sixteenth',
    '32nd': '32nd',
  }
  const b = base[typeTok]
  if (!b) return undefined
  if (dots === 0) return b
  if (dots === 1) {
    if (b === 'half') return 'dotted-half'
    if (b === 'quarter') return 'dotted-quarter'
    if (b === 'eighth') return 'dotted-eighth'
  }
  // 2+ dots, or a dotted form we don't model (dotted-whole/sixteenth) →
  // let the fraction path round it.
  return undefined
}

function fractionToDuration(frac: number, tolerance = 1e-3): Duration | undefined {
  for (const d of DURATION_BY_FRACTION) {
    if (Math.abs(d.frac - frac) <= tolerance) return d.name
  }
  return undefined
}

/** Nearest representable Duration to an arbitrary fraction-of-whole. */
function nearestDuration(frac: number): Duration {
  let best = DURATION_BY_FRACTION[DURATION_BY_FRACTION.length - 1]
  let bestDelta = Infinity
  for (const d of DURATION_BY_FRACTION) {
    const delta = Math.abs(d.frac - frac)
    if (delta < bestDelta) {
      bestDelta = delta
      best = d
    }
  }
  return best.name
}

// ── tuplet mapping ───────────────────────────────────────────────────

/** Map a `<time-modification>` actual-notes count to our Tuplet enum.
 *  Only 3/5/6/7 are representable; others are dropped (best-effort). */
function actualToTuplet(actual: number | undefined): 3 | 5 | 6 | 7 | undefined {
  if (actual === 3 || actual === 5 || actual === 6 || actual === 7) return actual
  return undefined
}

// ── per-voice accumulation ───────────────────────────────────────────

/**
 * A single (staff, voice) stream of events, accumulated measure by measure
 * across the whole part. staffNum/voiceNum are the raw MusicXML numbers;
 * the final staff/voice routing maps them onto our Score structure.
 */
interface VoiceStream {
  staffNum: number
  voiceNum: number
  /** measures[i] = the events parsed for this voice in <measure> i. */
  measures: Event[][]
}

/** Key for the per-(staff,voice) stream map. */
function streamKey(staffNum: number, voiceNum: number): string {
  return `${staffNum}:${voiceNum}`
}

interface PartContext {
  divisions: number
  /** Number of staves declared via <staves> (1 unless a grand staff). */
  staves: number
}

/**
 * Walk one `<measure>` element, appending each voice's events into the
 * shared stream map. `<backup>`/`<forward>` are intentionally ignored for
 * output — voice routing is driven by `<voice>` + `<staff>`, and each
 * voice's per-measure event list is independent, so the time cursor never
 * needs to be tracked here.
 */
function walkMeasure(
  measureNode: XmlNode,
  measureIdx: number,
  ctx: PartContext,
  streams: Map<string, VoiceStream>,
  state: ParseState,
): void {
  // <attributes> can appear at the start of any measure; fold divisions /
  // staves updates so later measures parse correctly. (Mid-piece key / meter
  // / clef changes are dropped — Score-level Markers would be needed and the
  // exporter only round-trips them via the markers[] path, which we don't
  // reconstruct here.)
  for (const attrsNode of children(measureNode, 'attributes')) {
    const div = num(child(attrsNode, 'divisions'))
    if (div !== undefined && div > 0) ctx.divisions = div
    const staves = num(child(attrsNode, 'staves'))
    if (staves !== undefined && staves > 0) ctx.staves = staves
    if (measureIdx > 0 && (has(attrsNode, 'key') || has(attrsNode, 'time') || has(attrsNode, 'clef'))) {
      noteDropped(state, 'mid-piece key/meter/clef change')
    }
  }

  let prevStreamKey: string | undefined
  for (const noteNode of children(measureNode, 'note')) {
    // Grace notes have no <duration> and don't occupy timeline space; the
    // model attaches them to a principal Event via graceNotes[]. Re-deriving
    // that attachment from the flat MusicXML stream is involved; drop them.
    if (has(noteNode, 'grace')) {
      noteDropped(state, 'grace note')
      continue
    }

    const staffNum = num(child(noteNode, 'staff')) ?? 1
    const voiceNum = num(child(noteNode, 'voice')) ?? 1
    const key = streamKey(staffNum, voiceNum)
    let stream = streams.get(key)
    if (!stream) {
      stream = { staffNum, voiceNum, measures: [] }
      streams.set(key, stream)
    }
    // Ensure this stream has an event list for every measure up to now.
    while (stream.measures.length <= measureIdx) stream.measures.push([])
    const bucket = stream.measures[measureIdx]

    const isChord = has(noteNode, 'chord')
    const pitch = parseNotePitch(noteNode, measureIdx, state)
    const duration = parseNoteDuration(noteNode, ctx.divisions, state, measureIdx)
    const tieStart = noteHasTieStart(noteNode)
    const tuplet = actualToTuplet(num(child(child(noteNode, 'time-modification'), 'actual-notes')))

    if (isChord && prevStreamKey === key && bucket.length > 0) {
      // Stack onto the previous event of THIS voice (chord member).
      const anchor = bucket[bucket.length - 1]
      if (pitch && anchor.pitches[0]?.step !== 'rest') {
        if (anchor.pitches.length < 6) {
          if (tieStart) pitch.tied_to_next = true
          anchor.pitches.push(pitch)
        }
        // else: chord already at the 6-pitch cap — drop extra silently
        // (matches the chord-size cap other importers enforce).
      }
      prevStreamKey = key
      continue
    }

    // New event.
    const event: Event = {
      pitches: pitch ? [pitch] : [{ step: 'rest', octave: 4 }],
      duration,
    }
    if (tuplet !== undefined) event.tuplet = tuplet
    if (pitch && tieStart) {
      pitch.tied_to_next = true
      event.tied_to_next = true
    }
    bucket.push(event)
    prevStreamKey = key
  }
}

/** Parse a `<note>`'s pitch (or undefined for a `<rest/>`). Clamps octave to
 *  [0,9] with a warning, mirroring abcToScore. */
function parseNotePitch(
  noteNode: XmlNode,
  measureIdx: number,
  state: ParseState,
): Pitch | undefined {
  if (has(noteNode, 'rest')) return undefined
  const pitchNode = child(noteNode, 'pitch')
  const stepText = text(child(pitchNode, 'step'))
  const step = (STEPS as readonly string[]).includes(stepText ?? '')
    ? (stepText as Exclude<Step, 'rest'>)
    : 'C'
  let octave = num(child(pitchNode, 'octave')) ?? 4
  if (octave < 0) {
    state.warnings.push({
      severity: 'info',
      code: 'duration_rounded',
      message: `Note in measure ${measureIdx + 1} was below octave 0; clamped up.`,
    })
    octave = 0
  } else if (octave > 9) {
    state.warnings.push({
      severity: 'info',
      code: 'duration_rounded',
      message: `Note in measure ${measureIdx + 1} was above octave 9; clamped down.`,
    })
    octave = 9
  }
  const out: Pitch = { step, octave }
  const acc = accidentalOf(noteNode)
  if (acc) out.accidental = acc
  return out
}

/** Resolve a `<note>`'s Duration: prefer `<type>` + `<dot/>`, else round the
 *  `<duration>`/divisions fraction, warning on inexact rounding. */
function parseNoteDuration(
  noteNode: XmlNode,
  divisions: number,
  state: ParseState,
  measureIdx: number,
): Duration {
  const typeTok = text(child(noteNode, 'type'))
  const dots = children(noteNode, 'dot').length
  const byType = typeAndDotsToDuration(typeTok, dots)
  if (byType) return byType

  // Fall back to <duration> in divisions → fraction-of-whole.
  const durDivisions = num(child(noteNode, 'duration'))
  if (durDivisions !== undefined && divisions > 0) {
    const frac = durDivisions / (divisions * DIVISIONS_PER_WHOLE_FACTOR)
    const exact = fractionToDuration(frac)
    if (exact) return exact
    const rounded = nearestDuration(frac)
    state.warnings.push({
      severity: 'info',
      code: 'duration_rounded',
      message: `A note in measure ${measureIdx + 1} had duration ${frac.toFixed(4)} of a whole note; rounded to '${rounded}'.`,
    })
    return rounded
  }
  // No type and no duration (shouldn't happen for our exporter's output):
  // default to quarter so the measure still parses, and warn.
  state.warnings.push({
    severity: 'info',
    code: 'duration_rounded',
    message: `A note in measure ${measureIdx + 1} had no recognizable duration; defaulted to a quarter note.`,
  })
  return 'quarter'
}

/** True when the note carries `<tie type="start">` (drives tied_to_next). */
function noteHasTieStart(noteNode: XmlNode): boolean {
  for (const tie of children(noteNode, 'tie')) {
    if (attr(tie, 'type') === 'start') return true
  }
  return false
}

function noteDropped(state: ParseState, kind: string): void {
  if (state.droppedKinds.has(kind)) return
  state.droppedKinds.add(kind)
  state.warnings.push({
    severity: 'info',
    code: 'unsupported_element',
    message: `Dropped unsupported MusicXML element(s): ${kind}. The note content was kept where possible.`,
    meta: { kind },
  })
}

// ── attributes / metadata extraction ─────────────────────────────────

/** Extract key / meter / per-staff clef + staff count from the FIRST
 *  measure's `<attributes>`. */
function readFirstAttributes(
  firstMeasure: XmlNode,
  state: ParseState,
): { key: Key; meter: Meter; clefByStaff: Map<number, Clef>; staves: number } {
  let key: Key = 'C'
  let meter: Meter = '4/4' as Meter
  const clefByStaff = new Map<number, Clef>()
  let staves = 1

  for (const attrsNode of children(firstMeasure, 'attributes')) {
    const staffCount = num(child(attrsNode, 'staves'))
    if (staffCount !== undefined && staffCount > 0) staves = staffCount

    const keyNode = child(attrsNode, 'key')
    if (keyNode !== undefined) {
      const fifths = num(child(keyNode, 'fifths'))
      const modeText = text(child(keyNode, 'mode'))
      const mode: 'major' | 'minor' = modeText === 'minor' ? 'minor' : 'major'
      if (fifths !== undefined) {
        const k = fifthsToKey(fifths, mode)
        if (k) key = k
        else {
          state.warnings.push({
            severity: 'info',
            code: 'unsupported_key',
            message: `Key (fifths=${fifths}, ${mode}) is outside the supported set; defaulted to C major.`,
          })
        }
      }
    }

    const timeNode = child(attrsNode, 'time')
    if (timeNode !== undefined) {
      const m = timeToMeter(timeNode)
      if (m) meter = m
      else {
        state.warnings.push({
          severity: 'info',
          code: 'unsupported_meter',
          message: `Time signature could not be mapped; defaulted to 4/4.`,
        })
      }
    }

    for (const clefNode of children(attrsNode, 'clef')) {
      // <clef number=N> binds to staff N (1-based). Single-staff scores
      // omit the attribute → staff 1.
      const staffNo = Number(attr(clefNode, 'number') ?? '1') || 1
      const clef = signToClef(text(child(clefNode, 'sign')))
      if (clef) clefByStaff.set(staffNo, clef)
      else if (text(child(clefNode, 'sign'))) {
        state.warnings.push({
          severity: 'info',
          code: 'unsupported_element',
          message: `Clef sign '${text(child(clefNode, 'sign'))}' is unsupported; defaulted to treble.`,
        })
      }
    }
  }
  return { key, meter, clefByStaff, staves }
}

/** Read `tempo_bpm` from the document: first <sound tempo=>, else a
 *  <metronome> per-minute on a quarter beat-unit. Clamps/drops out of range. */
function readTempo(part: XmlNode, state: ParseState): number | undefined {
  let bpm: number | undefined
  for (const measureNode of children(part, 'measure')) {
    for (const dir of children(measureNode, 'direction')) {
      for (const sound of children(dir, 'sound')) {
        const t = num(child(sound, 'tempo')) ?? (attr(sound, 'tempo') !== undefined ? Number(attr(sound, 'tempo')) : undefined)
        if (t !== undefined && Number.isFinite(t)) {
          bpm = Math.round(t)
          break
        }
      }
      if (bpm !== undefined) break
      // <metronome> fallback (beat-unit quarter + per-minute).
      for (const dt of children(dir, 'direction-type')) {
        const metro = child(dt, 'metronome')
        const perMinute = num(child(metro, 'per-minute'))
        if (perMinute !== undefined) {
          bpm = Math.round(perMinute)
          break
        }
      }
      if (bpm !== undefined) break
    }
    // <sound tempo> can also appear directly under <measure>.
    if (bpm === undefined) {
      for (const sound of children(measureNode, 'sound')) {
        const t = num(child(sound, 'tempo'))
        if (t !== undefined) {
          bpm = Math.round(t)
          break
        }
      }
    }
    if (bpm !== undefined) break
  }
  if (bpm === undefined) return undefined
  if (bpm < 30 || bpm > 240) {
    state.warnings.push({
      severity: 'info',
      code: 'tempo_dropped',
      message: `Tempo ${bpm} bpm was outside the supported range (30–240) and was dropped.`,
    })
    return undefined
  }
  return bpm
}

interface Metadata {
  title?: string
  composer?: string
  arranger?: string
  lyricist?: string
  copyright?: string
}

function readMetadata(root: XmlNode): Metadata {
  const out: Metadata = {}
  const title = text(child(child(root, 'work'), 'work-title'))
  if (title) out.title = title.slice(0, 80)
  const ident = child(root, 'identification')
  for (const creator of children(ident, 'creator')) {
    const type = attr(creator, 'type')
    const value = text(creator)
    if (!value) continue
    if (type === 'composer' && !out.composer) out.composer = value.slice(0, 120)
    else if (type === 'arranger' && !out.arranger) out.arranger = value.slice(0, 120)
    else if (type === 'lyricist' && !out.lyricist) out.lyricist = value.slice(0, 120)
  }
  const rights = text(child(ident, 'rights'))
  if (rights) out.copyright = rights.slice(0, 200)
  return out
}

// ── staff/voice routing → Score ──────────────────────────────────────

/**
 * Fold the per-(staff,voice) streams into a Score: staff 1 → primary +
 * extraVoices, staff 2 → secondStaff + its extraVoices. Caps: max 2 staves,
 * max 4 voices per staff. Empty event lists (a measure where the voice had no
 * notes) become a single whole rest so the measure isn't empty (the schema
 * requires ≥1 event per measure).
 */
function streamsToScore(
  streams: Map<string, VoiceStream>,
  measureCount: number,
  key: Key,
  meter: Meter,
  clefByStaff: Map<number, Clef>,
  tempo: number | undefined,
  meta: Metadata,
  state: ParseState,
): Score | undefined {
  const all = [...streams.values()]
  if (all.length === 0) return undefined

  const staffNums = [...new Set(all.map((s) => s.staffNum))].sort((a, b) => a - b)
  if (staffNums.length > 2) {
    state.warnings.push({
      severity: 'info',
      code: 'multi_staff',
      message: `${staffNums.length} staves found; only the first 2 are imported.`,
      meta: { staffCount: staffNums.length, cap: 2 },
    })
  }
  const usableStaves = staffNums.slice(0, 2)

  const voicesForStaff = (staffNum: number): VoiceStream[] => {
    const list = all
      .filter((s) => s.staffNum === staffNum)
      .sort((a, b) => a.voiceNum - b.voiceNum)
    if (list.length > 4) {
      state.warnings.push({
        severity: 'info',
        code: 'multi_voice',
        message: `Staff ${staffNum} has ${list.length} voices; only the first 4 are imported.`,
        meta: { voiceCount: list.length, cap: 4 },
      })
    }
    return list.slice(0, 4)
  }

  const toMeasures = (stream: VoiceStream): Measure[] => {
    const measures: Measure[] = []
    for (let i = 0; i < measureCount; i++) {
      const events = stream.measures[i] ?? []
      if (events.length === 0) {
        measures.push({ events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] })
      } else {
        measures.push({ events })
      }
    }
    return measures
  }

  const primaryStaffNum = usableStaves[0]
  const primaryVoices = voicesForStaff(primaryStaffNum)
  if (primaryVoices.length === 0) return undefined

  const primaryMeasures = toMeasures(primaryVoices[0])
  const primaryExtra: Voice[] = primaryVoices.slice(1).map((v) => ({ measures: toMeasures(v) }))
  const primaryClef = clefByStaff.get(primaryStaffNum) ?? 'treble'

  let secondStaff: Staff | undefined
  if (usableStaves.length > 1) {
    const secondStaffNum = usableStaves[1]
    const secondVoices = voicesForStaff(secondStaffNum)
    if (secondVoices.length > 0) {
      const secondClef = clefByStaff.get(secondStaffNum) ?? 'bass'
      secondStaff = {
        clef: secondClef,
        measures: toMeasures(secondVoices[0]),
        ...(secondVoices.length > 1
          ? { extraVoices: secondVoices.slice(1).map((v) => ({ measures: toMeasures(v) })) }
          : {}),
      }
    }
  }

  const score: Score = {
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.composer ? { composer: meta.composer } : {}),
    ...(meta.arranger ? { arranger: meta.arranger } : {}),
    ...(meta.lyricist ? { lyricist: meta.lyricist } : {}),
    ...(meta.copyright ? { copyright: meta.copyright } : {}),
    key,
    meter,
    ...(tempo !== undefined ? { tempo_bpm: tempo } : {}),
    ...(primaryClef !== 'treble' ? { clef: primaryClef } : {}),
    measures: primaryMeasures,
    ...(primaryExtra.length ? { extraVoices: primaryExtra } : {}),
    ...(secondStaff ? { secondStaff } : {}),
  }
  return score
}

// ── entry point ──────────────────────────────────────────────────────

export function musicxmlToScore(xml: string, options: ImportOptions = {}): ImportResult {
  const state: ParseState = { warnings: [], droppedKinds: new Set() }

  let root: XmlNode
  try {
    const parsed = makeParser().parse(xml) as Record<string, unknown>
    if (parsed['score-timewise'] !== undefined) {
      return blocked('MusicXML score-timewise is not supported; export/save as score-partwise.')
    }
    root = parsed['score-partwise'] as XmlNode
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'XML parse failed'
    return blocked(`MusicXML parse error: ${msg}`)
  }

  if (!isObj(root)) {
    return blocked('Not a MusicXML score-partwise document.')
  }

  const parts = children(root, 'part')
  if (parts.length === 0) {
    return blocked('MusicXML document has no <part>.')
  }
  if (parts.length > 1) {
    state.warnings.push({
      severity: 'info',
      code: 'multi_staff',
      message: `${parts.length} parts found; only the first part is imported.`,
      meta: { partCount: parts.length },
    })
  }
  const part = parts[0]
  const measureNodes = children(part, 'measure')
  if (measureNodes.length === 0) {
    return blocked('MusicXML <part> has no <measure>.')
  }

  const { key, meter, clefByStaff, staves } = readFirstAttributes(measureNodes[0], state)
  const tempo = readTempo(part, state)
  const meta = readMetadata(root)

  const ctx: PartContext = { divisions: 1, staves }
  const streams = new Map<string, VoiceStream>()
  measureNodes.forEach((measureNode, idx) => {
    walkMeasure(measureNode, idx, ctx, streams, state)
  })

  const partial = streamsToScore(
    streams,
    measureNodes.length,
    key,
    meter,
    clefByStaff,
    tempo,
    meta,
    state,
  )
  if (!partial) {
    return blocked('No notes could be parsed from the MusicXML document.')
  }

  const { score, warnings: normWarnings } = normalize(partial, options)
  const allWarnings = [...state.warnings, ...normWarnings]

  const schemaCheck = ScoreSchema.safeParse(score)
  if (!schemaCheck.success) {
    return {
      score,
      format: 'musicxml',
      warnings: [
        ...allWarnings,
        {
          severity: 'block',
          code: 'schema_invalid',
          message: `After parse: ${schemaCheck.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        },
      ],
    }
  }

  return { score: schemaCheck.data, format: 'musicxml', warnings: allWarnings }
}

/** Build a blocking-warning ImportResult with the canonical empty score
 *  (never surfaced — the route returns a 422 the moment a block is present). */
function blocked(message: string): ImportResult {
  return {
    score: emptyScore(),
    format: 'musicxml',
    warnings: [{ severity: 'block', code: 'parse_failed', message }],
  }
}

function emptyScore(): Score {
  return {
    key: 'C',
    meter: '4/4' as Meter,
    measures: [
      {
        events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }],
      },
    ],
  }
}
