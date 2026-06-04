import type {
  Accidental,
  Articulation,
  Clef,
  Duration,
  Event,
  Key,
  Measure,
  Meter,
  Ornament,
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
 * Map a fractional ABC duration (relative to a whole note) onto our
 * closed Duration enum. Returns undefined if the value doesn't land
 * on a representable duration — caller surfaces a warning and either
 * rounds or drops the event.
 */
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

function fractionToDuration(frac: number, tolerance = 1e-4): Duration | undefined {
  for (const d of DURATION_BY_FRACTION) {
    if (Math.abs(d.frac - frac) <= tolerance) return d.name
  }
  return undefined
}

const STEPS: ReadonlyArray<Step> = ['C', 'D', 'E', 'F', 'G', 'A', 'B']

/**
 * Convert abcjs' integer pitch (0 = middle C, +/- per staff step) to
 * our (step, octave). Octave 4 = the octave starting at middle C.
 */
function pitchNumberToStepOctave(n: number): { step: Step; octave: number } {
  const mod = ((n % 7) + 7) % 7
  const step = STEPS[mod]
  const octave = 4 + Math.floor(n / 7)
  return { step, octave }
}

function abcAccidentalToOurs(acc: string | undefined): Accidental | undefined {
  switch (acc) {
    case 'sharp':
      return 'sharp'
    case 'flat':
      return 'flat'
    case 'natural':
      return 'natural'
    case 'dblsharp':
    case 'doublesharp':
      return 'dblsharp'
    case 'dblflat':
    case 'doubleflat':
      return 'dblflat'
    default:
      return undefined
  }
}

/**
 * Translate abcjs' decoration strings to articulation / ornament /
 * (dynamic — handled separately). Anything we don't recognize is
 * dropped silently; warnings would be noisy.
 */
function decorationsToFields(
  decorations: string[] | undefined,
): { articulation?: Articulation; ornament?: Ornament; dynamic?: Event['dynamic'] } {
  if (!decorations || decorations.length === 0) return {}
  const out: ReturnType<typeof decorationsToFields> = {}
  for (const d of decorations) {
    switch (d) {
      case 'staccato':
        out.articulation = 'staccato'
        break
      case 'accent':
      case 'emphasis':
        out.articulation = 'accent'
        break
      case 'tenuto':
        out.articulation = 'tenuto'
        break
      case 'marcato':
        out.articulation = 'marcato'
        break
      case 'trill':
      case '!trill!':
        out.ornament = 'trill'
        break
      case 'mordent':
      case 'lowermordent':
      case 'uppermordent':
        out.ornament = 'mordent'
        break
      case 'turn':
        out.ornament = 'turn'
        break
      case 'pp':
      case 'p':
      case 'mp':
      case 'mf':
      case 'f':
      case 'ff':
        out.dynamic = d
        break
    }
  }
  return out
}

interface AbcjsPitch {
  pitch: number
  name?: string
  accidental?: string
  startTie?: unknown
  endTie?: boolean
}

interface AbcjsNoteElement {
  el_type: 'note'
  pitches?: AbcjsPitch[]
  rest?: { type: string }
  duration: number
  startTriplet?: number
  endTriplet?: boolean
  tripletMultiplier?: number
  decoration?: string[]
  chord?: Array<{ name: string }>
}

interface AbcjsBarElement {
  el_type: 'bar'
  type: string
}

type AbcjsVoiceElement = AbcjsNoteElement | AbcjsBarElement | { el_type: string }

interface AbcjsLine {
  staff?: Array<{
    voices?: AbcjsVoiceElement[][]
    clef?: { type?: string }
  }>
}

interface AbcjsTune {
  metaText?: { title?: string; tempo?: { bpm?: number } }
  lines?: AbcjsLine[]
  getMeter?: () => { type: string; value?: Array<{ num: string; den: string }> }
  getKeySignature?: () => { root?: string; acc?: string; mode?: string }
  warnings?: string[]
}

function isNote(el: AbcjsVoiceElement): el is AbcjsNoteElement {
  return el.el_type === 'note'
}

function isBar(el: AbcjsVoiceElement): el is AbcjsBarElement {
  return el.el_type === 'bar'
}

/**
 * Translate abcjs key signature → our Key enum, or return undefined
 * if it's a mode we don't support (Dorian, Mixolydian, etc.).
 */
function abcKeyToOurs(k: ReturnType<NonNullable<AbcjsTune['getKeySignature']>>): Key | undefined {
  if (!k.root) return 'C'
  const mode = (k.mode ?? '').toLowerCase()
  if (mode !== '' && mode !== 'm' && mode !== 'maj' && mode !== 'min') {
    // Modal — Dorian, Mixolydian, etc. Not in our enum.
    return undefined
  }
  const accidental = k.acc === '#' ? '#' : k.acc === 'b' ? 'b' : ''
  const minor = mode === 'm' || mode === 'min'
  const label = `${k.root}${accidental}${minor ? 'm' : ''}`
  const parsed = KeySchema.safeParse(label)
  return parsed.success ? parsed.data : undefined
}

function abcMeterToOurs(m: ReturnType<NonNullable<AbcjsTune['getMeter']>>): { meter?: Meter; label?: string } {
  let label: string | undefined
  if (m.type === 'common_time') label = 'C'
  else if (m.type === 'cut_time') label = 'C|'
  else if (m.type === 'specified' && m.value && m.value[0]) {
    label = `${m.value[0].num}/${m.value[0].den}`
  }
  if (!label) return {}
  const parsed = MeterSchema.safeParse(label)
  return parsed.success ? { meter: parsed.data, label } : { label }
}

interface ParsedTuneState {
  warnings: ImportWarning[]
  multiVoice: boolean
  multiStaff: boolean
  tiePending: boolean
  /**
   * abcjs marks only the FIRST event in a tuplet with `startTriplet`
   * and the LAST with `endTriplet`. Our schema requires `tuplet: N`
   * on every event in the group, so the voice walker carries the
   * current tuplet count across subsequent events.
   */
  openTuplet: 3 | 5 | 6 | 7 | undefined
}

/**
 * Convert one abcjs note element to one of our Events. Returns
 * undefined if the element's duration doesn't map cleanly onto our
 * Duration enum — caller emits a warning.
 */
function noteToEvent(
  el: AbcjsNoteElement,
  state: ParsedTuneState,
  measureIdx: number,
  eventIdx: number,
): Event | undefined {
  const isRest = el.rest !== undefined || !el.pitches || el.pitches.length === 0
  const pitches: Pitch[] = isRest
    ? [{ step: 'rest', octave: 4 }]
    : el.pitches!.map((p) => {
        const { step, octave } = pitchNumberToStepOctave(p.pitch)
        const out: Pitch = { step, octave }
        const acc = abcAccidentalToOurs(p.accidental)
        if (acc) out.accidental = acc
        return out
      })

  // Octave clamp — our schema is [0..9]. Snap and warn.
  for (let i = 0; i < pitches.length; i++) {
    if (pitches[i].step === 'rest') continue
    if (pitches[i].octave < 0) {
      state.warnings.push({
        severity: 'info',
        code: 'duration_rounded',
        message: `Note at measure ${measureIdx + 1} event ${eventIdx + 1} was below octave 0; clamped up.`,
      })
      pitches[i] = { ...pitches[i], octave: 0 }
    } else if (pitches[i].octave > 9) {
      state.warnings.push({
        severity: 'info',
        code: 'duration_rounded',
        message: `Note at measure ${measureIdx + 1} event ${eventIdx + 1} was above octave 9; clamped down.`,
      })
      pitches[i] = { ...pitches[i], octave: 9 }
    }
  }

  // Cap chord size at 6.
  if (pitches.length > 6) pitches.length = 6

  const duration = fractionToDuration(el.duration)
  if (!duration) {
    state.warnings.push({
      severity: 'info',
      code: 'duration_rounded',
      message: `Skipped a note at measure ${measureIdx + 1} event ${eventIdx + 1} with duration ${el.duration} (whole-note fractions); not representable in our enum.`,
    })
    return undefined
  }

  const decoFields = decorationsToFields(el.decoration)
  const event: Event = { pitches, duration }
  // Tuplet bookkeeping: open on startTriplet, propagate to subsequent
  // events via state.openTuplet, close on endTriplet.
  if (el.startTriplet) state.openTuplet = el.startTriplet as 3 | 5 | 6 | 7
  if (state.openTuplet) event.tuplet = state.openTuplet
  if (el.endTriplet) state.openTuplet = undefined
  if (decoFields.articulation) event.articulation = decoFields.articulation
  if (decoFields.ornament) event.ornament = decoFields.ornament
  if (decoFields.dynamic) event.dynamic = decoFields.dynamic

  // Ties: abcjs sets startTie on individual pitches. We mark
  // tied_to_next on the event if ANY pitch has a tie out.
  const hasStartTie = !isRest && el.pitches!.some((p) => p.startTie !== undefined)
  if (hasStartTie) event.tied_to_next = true

  return event
}

/**
 * Walk one voice's flat element list, splitting on bar elements into
 * measures and converting note elements to our Event shape. Tuplet
 * groups inside the same measure are carried through verbatim
 * (abcjs already groups them with startTriplet / endTriplet markers).
 *
 * Empty measures (e.g. two consecutive barlines) are dropped silently
 * — abcjs sometimes emits them at the very start of a piece.
 */
function voiceToMeasures(voice: AbcjsVoiceElement[], state: ParsedTuneState): Measure[] {
  const measures: Measure[] = []
  let current: Event[] = []

  const flushMeasure = () => {
    if (current.length > 0) measures.push({ events: current })
    current = []
  }

  for (const el of voice) {
    if (isBar(el)) {
      flushMeasure()
      continue
    }
    if (!isNote(el)) continue
    const ev = noteToEvent(el, state, measures.length, current.length)
    if (ev) current.push(ev)
  }
  flushMeasure()
  return measures
}

// ── multi-voice / multi-staff helpers ──────────────────────────────────

/** Normalize an abcjs clef.type string to our Clef enum (or undefined if
 *  unknown / unsupported). Treats transposing octaves as their base clef. */
function staffClefToOurs(ct: string | undefined): Clef | undefined {
  if (!ct) return undefined
  if (ct.startsWith('bass')) return 'bass'
  if (ct.startsWith('treble')) return 'treble'
  // alto / tenor / etc. — not yet in our enum.
  return undefined
}

interface WalkedVoice {
  staffIdx: number
  voiceIdx: number
  clef: Clef
  events: AbcjsVoiceElement[]
}

interface WalkedVoices {
  voices: WalkedVoice[]
  staffCount: number
  maxVoicesPerStaff: number
}

/**
 * Walk every line × staff × voice in the parsed tune and concatenate
 * elements for each (staffIdx, voiceIdx) pair. abcjs splits a logical
 * voice across multiple line systems; we re-stitch them here.
 *
 * Order of the returned `voices` array is (staffIdx asc, voiceIdx asc)
 * so callers can index into it for the "primary staff first" mapping.
 */
function walkVoices(lines: AbcjsLine[]): WalkedVoices {
  // Map<staffIdx, Map<voiceIdx, { events, clef }>>
  const byStaff = new Map<number, Map<number, { events: AbcjsVoiceElement[]; clef: Clef }>>()
  let staffCount = 0
  let maxVoicesPerStaff = 0
  for (const line of lines) {
    for (const [staffIdx, staff] of (line.staff ?? []).entries()) {
      staffCount = Math.max(staffCount, staffIdx + 1)
      const clef = staffClefToOurs(staff.clef?.type) ?? 'treble'
      let staffMap = byStaff.get(staffIdx)
      if (!staffMap) {
        staffMap = new Map()
        byStaff.set(staffIdx, staffMap)
      }
      for (const [voiceIdx, v] of (staff.voices ?? []).entries()) {
        maxVoicesPerStaff = Math.max(maxVoicesPerStaff, voiceIdx + 1)
        const existing = staffMap.get(voiceIdx)
        if (existing) {
          existing.events = existing.events.concat(v)
        } else {
          staffMap.set(voiceIdx, { events: v.slice(), clef })
        }
      }
    }
  }

  const voices: WalkedVoice[] = []
  const staffIdxs = [...byStaff.keys()].sort((a, b) => a - b)
  for (const s of staffIdxs) {
    const staffMap = byStaff.get(s)!
    const voiceIdxs = [...staffMap.keys()].sort((a, b) => a - b)
    for (const v of voiceIdxs) {
      const entry = staffMap.get(v)!
      voices.push({ staffIdx: s, voiceIdx: v, clef: entry.clef, events: entry.events })
    }
  }
  return { voices, staffCount, maxVoicesPerStaff }
}

/**
 * Approximate MIDI for a (step, octave) pair, ignoring accidentals.
 * Mirrors src/components/editor/staffGeometry.ts midiFromStep but
 * lives here to avoid a cross-module import. Used by the grand-staff
 * heuristic below.
 */
function midiOf(step: Exclude<Step, 'rest'>, octave: number): number {
  const offsets: Record<Exclude<Step, 'rest'>, number> = {
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
  }
  return (octave + 1) * 12 + offsets[step]
}

/** Median MIDI of all non-rest pitches in a voice's measures, or
 *  undefined when the voice has no pitched notes (all rests). */
function medianVoiceMidi(measures: Measure[]): number | undefined {
  const midis: number[] = []
  for (const m of measures) {
    for (const ev of m.events) {
      for (const p of ev.pitches) {
        if (p.step === 'rest') continue
        midis.push(midiOf(p.step as Exclude<Step, 'rest'>, p.octave))
      }
    }
  }
  if (midis.length === 0) return undefined
  midis.sort((a, b) => a - b)
  const mid = Math.floor(midis.length / 2)
  return midis.length % 2 === 0 ? (midis[mid - 1] + midis[mid]) / 2 : midis[mid]
}

interface BuiltVoiceLite {
  staffIdx: number
  voiceIdx: number
  clef: Clef
  measures: Measure[]
  medianMidi: number | undefined
}

const PROMOTE_MIDI_GAP_SEMITONES = 18
const MIDDLE_C_MIDI = 60

/**
 * Conservative heuristic for ABC files that come back as one staff
 * with multiple voices but really meant grand staff (`%%score (1 2)`
 * with octave-separated lines). Promotes the lowest qualifying voice
 * to a synthetic staff 1 with bass clef. Skipped when the parse
 * already gives us a second staff — we honor abcjs's structural
 * verdict in that case.
 *
 * Thresholds intentionally narrow:
 * - median MIDI gap from voice 0 > 18 semitones (1.5 octaves), AND
 * - the candidate's median sits below middle C (60).
 * Bach two-part inventions (gap ≈ 12 st, both above middle C in places)
 * stay as same-staff polyphony; clear piano grand-staff layouts (RH
 * around C5, LH around C3) promote.
 */
function promoteLowVoicesToSecondStaff(built: BuiltVoiceLite[]): BuiltVoiceLite[] {
  const hasSecondStaff = built.some((v) => v.staffIdx === 1)
  if (hasSecondStaff) return built
  const onStaff0 = built.filter((v) => v.staffIdx === 0)
  if (onStaff0.length < 2) return built
  const v0 = onStaff0[0]
  if (v0.medianMidi === undefined) return built
  const candidates = onStaff0.slice(1)
  const promoted: BuiltVoiceLite[] = []
  const remaining: BuiltVoiceLite[] = [v0]
  for (const c of candidates) {
    if (
      c.medianMidi !== undefined &&
      c.medianMidi < MIDDLE_C_MIDI &&
      v0.medianMidi - c.medianMidi > PROMOTE_MIDI_GAP_SEMITONES
    ) {
      promoted.push({ ...c, staffIdx: 1, voiceIdx: promoted.length, clef: 'bass' })
    } else {
      remaining.push(c)
    }
  }
  if (promoted.length === 0) return built
  // Re-index the remaining staff-0 voices so voice 0 stays voice 0.
  const reindexedStaff0 = remaining.map((v, i) => ({ ...v, voiceIdx: i }))
  return [...reindexedStaff0, ...promoted]
}

function parseTunes(abc: string): AbcjsTune[] {
  // Lazy-load abcjs so client-only pages don't pay for it until
  // they actually parse. Server import paths preload it via the
  // import endpoint, so the cost is hidden behind the user click.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('abcjs') as { default?: unknown; parseOnly?: unknown }
  const abcjs =
    (mod as { default?: { parseOnly: (s: string) => AbcjsTune[] } }).default ??
    (mod as unknown as { parseOnly: (s: string) => AbcjsTune[] })
  return abcjs.parseOnly(abc)
}

/**
 * Parse an ABC string into a Score. Walks the first staff's first
 * voice (recording a `multi_voice` / `multi_staff` warning when there
 * are siblings) and runs the result through normalize() for anacrusis
 * padding + truncation.
 */
export function abcToScore(abc: string, options: ImportOptions = {}): ImportResult {
  let tunes: AbcjsTune[]
  try {
    tunes = parseTunes(abc)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'abcjs parse failed'
    return {
      score: emptyScore(),
      format: 'abc',
      warnings: [{ severity: 'block', code: 'parse_failed', message: `ABC parse error: ${msg}` }],
    }
  }

  if (!tunes || tunes.length === 0) {
    return {
      score: emptyScore(),
      format: 'abc',
      warnings: [{ severity: 'block', code: 'parse_failed', message: 'No tune found in ABC source.' }],
    }
  }

  const tune = tunes[0]
  const state: ParsedTuneState = {
    warnings: [],
    multiVoice: false,
    multiStaff: false,
    tiePending: false,
    openTuplet: undefined,
  }

  // Key + meter — both can disqualify if outside our enums.
  const keyParsed = tune.getKeySignature?.()
  const key = keyParsed ? abcKeyToOurs(keyParsed) : 'C'
  if (!key) {
    return {
      score: emptyScore(),
      format: 'abc',
      warnings: [
        {
          severity: 'block',
          code: 'unsupported_mode',
          message: `Key signature '${keyParsed?.root}${keyParsed?.acc ?? ''}${keyParsed?.mode ?? ''}' is not supported (modes other than major/minor aren't in the schema).`,
        },
      ],
    }
  }

  const meterParsed = tune.getMeter?.()
  const meterResult = meterParsed ? abcMeterToOurs(meterParsed) : { meter: '4/4' as Meter, label: '4/4' }
  if (!meterResult.meter) {
    return {
      score: emptyScore(),
      format: 'abc',
      warnings: [
        {
          severity: 'block',
          code: 'unsupported_meter',
          message: meterResult.label
            ? `Meter '${meterResult.label}' is unsupported: numerator must be 1-32 and denominator must be one of 1, 2, 4, 8, 16, 32.`
            : `Meter could not be parsed from the ABC source.`,
        },
      ],
    }
  }
  const meter = meterResult.meter

  // Walk every line × staff × voice into a structured map keyed by
  // (staffIdx, voiceIdx). abcjs typically splits a logical voice
  // across multiple lines (one per system); concatenate them.
  const walked = walkVoices(tune.lines ?? [])

  if (walked.staffCount > 2) {
    state.warnings.push({
      severity: 'info',
      code: 'multi_staff',
      message: `${walked.staffCount} staves found; only the first 2 are imported. The rest are dropped.`,
      meta: { staffCount: walked.staffCount, cap: 2 },
    })
  }
  if (walked.maxVoicesPerStaff > 4) {
    state.warnings.push({
      severity: 'info',
      code: 'multi_voice',
      message: `Up to ${walked.maxVoicesPerStaff} voices found on one staff; only the first 4 voices per staff are imported.`,
      meta: { voiceCount: walked.maxVoicesPerStaff, cap: 4 },
    })
  }

  // Convert each (staff, voice) element list into a Measure[] and
  // capture its median MIDI (for the grand-staff heuristic).
  type BuiltVoice = { staffIdx: number; voiceIdx: number; clef: Clef; measures: Measure[]; medianMidi: number | undefined }
  const built: BuiltVoice[] = []
  for (const v of walked.voices) {
    const measures = voiceToMeasures(v.events, state)
    built.push({
      staffIdx: v.staffIdx,
      voiceIdx: v.voiceIdx,
      clef: v.clef,
      measures,
      medianMidi: medianVoiceMidi(measures),
    })
  }

  // Heuristic: when abcjs reports a single staff with multiple voices
  // (e.g. `%%score (1 2)` collapsed by older ABC dialects) BUT pitch
  // ranges suggest grand staff, promote the lower voice(s) to a
  // secondStaff with bass clef. Conservative thresholds: median diff
  // > 18 semitones AND the candidate's median is below middle C (60).
  const promotedVoices = promoteLowVoicesToSecondStaff(built)

  // Build the Score: staff 0 → primary, staff 1 → secondStaff.
  // Voice 0 of each staff → measures; voices 1..3 → extraVoices.
  const primaryStaffVoices = promotedVoices.filter((v) => v.staffIdx === 0).slice(0, 4)
  const secondStaffVoices = promotedVoices.filter((v) => v.staffIdx === 1).slice(0, 4)
  if (primaryStaffVoices.length === 0) {
    return {
      score: emptyScore(),
      format: 'abc',
      warnings: [
        ...state.warnings,
        { severity: 'block', code: 'parse_failed', message: 'No measures parsed from ABC.' },
      ],
    }
  }

  // Primary measures = staff 0, voice 0.
  const primaryVoice0 = primaryStaffVoices[0]
  if (primaryVoice0.measures.length === 0) {
    return {
      score: emptyScore(),
      format: 'abc',
      warnings: [
        ...state.warnings,
        { severity: 'block', code: 'parse_failed', message: 'No measures parsed from ABC.' },
      ],
    }
  }

  const primaryExtraVoices: Voice[] = primaryStaffVoices.slice(1).map((v) => ({ measures: v.measures }))
  const secondStaff: Staff | undefined = secondStaffVoices.length
    ? {
        clef: secondStaffVoices[0].clef,
        measures: secondStaffVoices[0].measures,
        ...(secondStaffVoices.length > 1
          ? { extraVoices: secondStaffVoices.slice(1).map((v) => ({ measures: v.measures })) }
          : {}),
      }
    : undefined

  const importedVoiceTotal =
    primaryStaffVoices.length + (secondStaff ? secondStaffVoices.length : 0)
  if (importedVoiceTotal > 1 || secondStaff) {
    state.warnings.push({
      severity: 'info',
      code: 'voice_picked',
      message: `Imported ${importedVoiceTotal} voice${importedVoiceTotal === 1 ? '' : 's'} on ${secondStaff ? 2 : 1} stave${secondStaff ? 's' : ''}.`,
      meta: {
        staffCount: secondStaff ? 2 : 1,
        primaryVoices: primaryStaffVoices.length,
        secondaryVoices: secondStaffVoices.length,
      },
    })
  }

  const primaryClef = primaryVoice0.clef

  const tempo = tune.metaText?.tempo?.bpm
  const tempoInRange =
    typeof tempo === 'number' && Number.isInteger(tempo) && tempo >= 30 && tempo <= 240
  if (tempo !== undefined && !tempoInRange) {
    state.warnings.push({
      severity: 'info',
      code: 'tempo_dropped',
      message: `Tempo ${tempo} bpm was outside the supported range (30–240) and was dropped.`,
    })
  }

  const partialScore: Score = {
    ...(tune.metaText?.title ? { title: tune.metaText.title.slice(0, 80) } : {}),
    key,
    meter,
    ...(tempoInRange ? { tempo_bpm: tempo } : {}),
    ...(primaryClef && primaryClef !== 'treble' ? { clef: primaryClef } : {}),
    measures: primaryVoice0.measures,
    ...(primaryExtraVoices.length ? { extraVoices: primaryExtraVoices } : {}),
    ...(secondStaff ? { secondStaff } : {}),
  }

  const { score, warnings: normWarnings } = normalize(partialScore, options)
  const allWarnings = [...state.warnings, ...normWarnings]

  // Final schema check — catches any drift between the abcjs adapter
  // and our schema (e.g. a malformed pitch). Demote to a block
  // warning so the caller can surface it through the same channel.
  const schemaCheck = ScoreSchema.safeParse(score)
  if (!schemaCheck.success) {
    return {
      score,
      format: 'abc',
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

  return { score: schemaCheck.data, format: 'abc', warnings: allWarnings }
}

function emptyScore(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }],
      },
    ],
  }
}
