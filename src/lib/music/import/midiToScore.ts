import { Midi } from '@tonejs/midi'
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
import { meterInEighths } from '../meter'
import { normalize } from './normalize'
import type { ImportOptions, ImportResult, ImportWarning } from './types'

const DRUM_CHANNEL = 9 // 0-indexed; MIDI channel 10

/**
 * Convert a MIDI note number to (step, octave, accidental). Chooses
 * the spelling implied by the key signature when possible (sharps in
 * sharp keys, flats in flat keys).
 *
 * Maps the chromatic 0-11 (C, C#, D, D#, E, F, F#, G, G#, A, A#, B)
 * onto (step, accidental). When the key uses flats we re-spell black
 * keys as flats.
 */
const SHARP_SPELLING: Array<{ step: Step; accidental?: Accidental }> = [
  { step: 'C' },
  { step: 'C', accidental: 'sharp' },
  { step: 'D' },
  { step: 'D', accidental: 'sharp' },
  { step: 'E' },
  { step: 'F' },
  { step: 'F', accidental: 'sharp' },
  { step: 'G' },
  { step: 'G', accidental: 'sharp' },
  { step: 'A' },
  { step: 'A', accidental: 'sharp' },
  { step: 'B' },
]

const FLAT_SPELLING: Array<{ step: Step; accidental?: Accidental }> = [
  { step: 'C' },
  { step: 'D', accidental: 'flat' },
  { step: 'D' },
  { step: 'E', accidental: 'flat' },
  { step: 'E' },
  { step: 'F' },
  { step: 'G', accidental: 'flat' },
  { step: 'G' },
  { step: 'A', accidental: 'flat' },
  { step: 'A' },
  { step: 'B', accidental: 'flat' },
  { step: 'B' },
]

const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm'])

function midiToPitch(midi: number, key: Key): Pitch {
  const chromatic = ((midi % 12) + 12) % 12
  const octave = Math.floor(midi / 12) - 1 // MIDI 60 = C4
  const table = FLAT_KEYS.has(key) ? FLAT_SPELLING : SHARP_SPELLING
  const { step, accidental } = table[chromatic]
  // Clamp to the schema's octave range [0,9] (MIDI can reach octave -1).
  const clamped = Math.max(0, Math.min(9, octave))
  const out: Pitch = { step, octave: clamped }
  if (accidental) out.accidental = accidental
  return out
}

function keyFromMidi(label: string | undefined, scale: 'major' | 'minor' | undefined): Key {
  if (!label) return 'C'
  // @tonejs/midi exposes the tonic as a plain letter (e.g. "G", "Bb",
  // "F#"). Compose with the schema's minor 'm' suffix.
  const suffix = scale === 'minor' ? 'm' : ''
  const parsed = KeySchema.safeParse(`${label}${suffix}`)
  return parsed.success ? parsed.data : 'C'
}

function meterFromMidi(ts: [number, number] | undefined): Meter {
  if (!ts) return '4/4'
  const [num, den] = ts
  const label = `${num}/${den}`
  const parsed = MeterSchema.safeParse(label)
  return parsed.success ? parsed.data : '4/4'
}

/**
 * Greedy decomposition of a duration measured in eighths into the
 * largest available Duration enum values. Used for both notes and
 * rests. When the remainder doesn't fit any allowed duration we drop
 * the leftover — the caller emits a warning if anything was lost.
 */
const DURATION_EIGHTHS: Array<{ name: Duration; eighths: number }> = [
  { name: 'whole', eighths: 8 },
  { name: 'dotted-half', eighths: 6 },
  { name: 'half', eighths: 4 },
  { name: 'dotted-quarter', eighths: 3 },
  { name: 'quarter', eighths: 2 },
  { name: 'dotted-eighth', eighths: 1.5 },
  { name: 'eighth', eighths: 1 },
  { name: 'sixteenth', eighths: 0.5 },
  { name: '32nd', eighths: 0.25 },
]

function decomposeDuration(eighths: number): { pieces: Duration[]; remainder: number } {
  const pieces: Duration[] = []
  let remaining = eighths
  for (const d of DURATION_EIGHTHS) {
    while (remaining + 1e-6 >= d.eighths) {
      pieces.push(d.name)
      remaining -= d.eighths
    }
  }
  return { pieces, remainder: Math.max(0, remaining) }
}

interface GroupedNote {
  startTick: number
  durationTicks: number
  midis: number[]
}

/**
 * Snap a tick value to the nearest grid step. The grid is one 16th
 * note (= ppq / 4) by default.
 */
function snap(tick: number, grid: number): number {
  return Math.round(tick / grid) * grid
}

/**
 * Walk a MIDI track's notes, snap to the 16th grid, group same-onset
 * notes into chords (max 6 pitches), and produce intervals sorted by
 * start tick. Notes that snap to a duration of 0 are dropped.
 */
function groupNotes(
  notes: Array<{ ticks: number; durationTicks: number; midi: number; channel?: number }>,
  grid: number,
  warnings: ImportWarning[],
): GroupedNote[] {
  // Filter drum channel.
  const filtered = notes.filter((n) => n.channel !== DRUM_CHANNEL)
  if (filtered.length < notes.length) {
    warnings.push({
      severity: 'info',
      code: 'voice_picked',
      message: `Dropped ${notes.length - filtered.length} drum-channel notes.`,
    })
  }

  // Snap & filter zero-length.
  const snapped = filtered
    .map((n) => {
      const start = snap(n.ticks, grid)
      const end = snap(n.ticks + n.durationTicks, grid)
      return { startTick: start, durationTicks: Math.max(grid, end - start), midi: n.midi }
    })
    .sort((a, b) => a.startTick - b.startTick || a.midi - b.midi)

  const groups: GroupedNote[] = []
  for (const n of snapped) {
    const last = groups[groups.length - 1]
    if (last && last.startTick === n.startTick) {
      if (last.midis.length < 6) last.midis.push(n.midi)
      // Use the SHORTEST duration in the chord (most musical fit for
      // simultaneous onsets with different release times).
      last.durationTicks = Math.min(last.durationTicks, n.durationTicks)
    } else {
      groups.push({ startTick: n.startTick, durationTicks: n.durationTicks, midis: [n.midi] })
    }
  }
  return groups
}

/**
 * Walk a flat list of intervals (notes + computed rests), split each
 * one that crosses a barline (chaining ties), then bucket each piece
 * into its containing measure. Returns the assembled Measure[].
 */
function intervalsToMeasures(
  intervals: Array<{ startTick: number; durationTicks: number; pitches: Pitch[]; rest: boolean }>,
  measureTicks: number,
  ticksPerEighth: number,
  warnings: ImportWarning[],
): Measure[] {
  type Piece = { measureIdx: number; startTick: number; eighths: number; pitches: Pitch[]; rest: boolean; tieOut: boolean }
  const pieces: Piece[] = []

  for (const ivl of intervals) {
    let cursor = ivl.startTick
    let remainingTicks = ivl.durationTicks
    while (remainingTicks > 0) {
      const mIdx = Math.floor(cursor / measureTicks)
      const measureEnd = (mIdx + 1) * measureTicks
      const chunkTicks = Math.min(remainingTicks, measureEnd - cursor)
      const eighths = chunkTicks / ticksPerEighth
      const tieOut = chunkTicks < remainingTicks && !ivl.rest
      pieces.push({
        measureIdx: mIdx,
        startTick: cursor,
        eighths,
        pitches: ivl.pitches,
        rest: ivl.rest,
        tieOut,
      })
      cursor += chunkTicks
      remainingTicks -= chunkTicks
    }
  }

  const measureMap = new Map<number, Event[]>()
  let droppedTime = 0
  for (const p of pieces) {
    const { pieces: durs, remainder } = decomposeDuration(p.eighths)
    if (remainder > 1e-6) droppedTime += remainder
    if (durs.length === 0) continue
    for (let i = 0; i < durs.length; i++) {
      const isLast = i === durs.length - 1
      const event: Event = {
        pitches: p.pitches,
        duration: durs[i],
      }
      // Chain decomposed pieces with ties, and propagate the outer
      // cross-barline tie onto the very last piece.
      if (!p.rest && (!isLast || p.tieOut)) event.tied_to_next = true
      const arr = measureMap.get(p.measureIdx) ?? []
      arr.push(event)
      measureMap.set(p.measureIdx, arr)
    }
  }

  if (droppedTime > 0) {
    warnings.push({
      severity: 'info',
      code: 'duration_rounded',
      message: `${droppedTime.toFixed(2)} eighth-note(s) of rhythm couldn't be expressed in supported durations and were dropped.`,
    })
  }

  // Sort by ascending measureIdx and pad any gaps with empty measures
  // (shouldn't normally happen for a contiguous piece, but defensive).
  if (measureMap.size === 0) return []
  const maxIdx = Math.max(...measureMap.keys())
  const measures: Measure[] = []
  for (let i = 0; i <= maxIdx; i++) {
    const events = measureMap.get(i)
    if (events && events.length > 0) {
      measures.push({ events })
    } else {
      // Synthesize a whole-rest measure.
      measures.push({ events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] })
    }
  }
  return measures
}

/**
 * Parse a MIDI binary blob into a Score. The pipeline:
 *
 *  1. Pick the track with the most notes (drum channel filtered out).
 *  2. Read tempo / time signature / key signature from the header.
 *  3. Snap every note onset and release to a 16th-note grid.
 *  4. Group notes by snapped onset into chord events (max 6 pitches).
 *  5. Fill the gaps between events with rests.
 *  6. Split intervals at barlines and chain ties.
 *  7. Decompose each interval's duration into our Duration enum.
 *  8. Run through normalize() for anacrusis padding + truncation.
 *
 * Tuplet detection is skipped in MVP (detecting 3/5/6/7-tuplets from
 * free time is a research problem). Mid-piece tempo / key / meter
 * changes are flattened with warnings.
 */
export function midiToScore(bytes: Uint8Array, options: ImportOptions = {}): ImportResult {
  let midi: Midi
  try {
    // Midi constructor is overloaded — passing an empty/short buffer
    // can throw; the empty-MIDI path below handles the no-notes case.
    midi = new Midi(bytes)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'MIDI parse failed'
    return {
      score: emptyScore(),
      format: 'midi',
      warnings: [{ severity: 'block', code: 'parse_failed', message: `MIDI parse error: ${msg}` }],
    }
  }

  const warnings: ImportWarning[] = []
  const ppq = midi.header.ppq
  const ticksPerEighth = ppq / 2 // 1 eighth = half a quarter

  if (midi.header.tempos.length > 1) {
    warnings.push({
      severity: 'info',
      code: 'tempo_dropped',
      message: `${midi.header.tempos.length} tempo changes found; kept only the first.`,
    })
  }
  if (midi.header.keySignatures.length > 1) {
    warnings.push({
      severity: 'info',
      code: 'mid_piece_key_change',
      message: `${midi.header.keySignatures.length} key changes found; flattened to the first.`,
    })
  }
  if (midi.header.timeSignatures.length > 1) {
    warnings.push({
      severity: 'info',
      code: 'mid_piece_meter_change',
      message: `${midi.header.timeSignatures.length} time-signature changes found; flattened to the first.`,
    })
  }

  const nonEmpty = midi.tracks.filter((t) => t.notes.length > 0)
  if (nonEmpty.length === 0) {
    return {
      score: emptyScore(),
      format: 'midi',
      warnings: [{ severity: 'block', code: 'parse_failed', message: 'MIDI file contains no notes.' }],
    }
  }

  const firstKey = midi.header.keySignatures[0]
  const scale: 'major' | 'minor' | undefined =
    firstKey?.scale === 'minor' ? 'minor' : firstKey?.scale === 'major' ? 'major' : undefined
  const key = keyFromMidi(firstKey?.key, scale)
  const firstTs = midi.header.timeSignatures[0]
  const tsTuple: [number, number] | undefined =
    firstTs?.timeSignature && firstTs.timeSignature.length >= 2
      ? [firstTs.timeSignature[0], firstTs.timeSignature[1]]
      : undefined
  const meter = meterFromMidi(tsTuple)
  const firstTempo = midi.header.tempos[0]
  const tempo = firstTempo ? Math.round(firstTempo.bpm) : 100
  const tempoInRange = tempo >= 30 && tempo <= 240
  const measureTicks = meterInEighths(meter) * ticksPerEighth

  type TrackPipe = {
    track: (typeof nonEmpty)[number]
    measures: Measure[]
    medianMidi: number
  }

  /** Convert one MIDI track's notes → Measure[]. Returns null when the
   *  pipeline yields no usable events (after drum/zero-length filtering). */
  const trackToMeasures = (track: (typeof nonEmpty)[number]): Measure[] | null => {
    const grouped = groupNotes(track.notes, ppq / 4, warnings)
    if (grouped.length === 0) return null
    const intervals: Array<{ startTick: number; durationTicks: number; pitches: Pitch[]; rest: boolean }> = []
    const firstStart = grouped[0].startTick
    let cursor = firstStart
    for (const g of grouped) {
      if (g.startTick > cursor) {
        intervals.push({
          startTick: cursor,
          durationTicks: g.startTick - cursor,
          pitches: [{ step: 'rest', octave: 4 }],
          rest: true,
        })
      }
      const pitches = g.midis.slice(0, 6).map((m) => midiToPitch(m, key))
      intervals.push({
        startTick: g.startTick,
        durationTicks: g.durationTicks,
        pitches,
        rest: false,
      })
      cursor = g.startTick + g.durationTicks
    }
    const shifted = intervals.map((i) => ({ ...i, startTick: i.startTick - firstStart }))
    const m = intervalsToMeasures(shifted, measureTicks, ticksPerEighth, warnings)
    return m.length > 0 ? m : null
  }

  // Build a pipeline result per track so the layout cascade can pick
  // tracks by median pitch.
  const pipes: TrackPipe[] = []
  for (const t of nonEmpty) {
    const m = trackToMeasures(t)
    if (m === null) continue
    const midis = t.notes.filter((n) => n.midi >= 0).map((n) => n.midi).sort((a, b) => a - b)
    const median =
      midis.length === 0 ? 60 : midis.length % 2 === 1
        ? midis[(midis.length - 1) / 2]
        : (midis[midis.length / 2 - 1] + midis[midis.length / 2]) / 2
    pipes.push({ track: t, measures: m, medianMidi: median })
  }

  if (pipes.length === 0) {
    return {
      score: emptyScore(),
      format: 'midi',
      warnings: [
        ...warnings,
        { severity: 'block', code: 'parse_failed', message: 'No usable notes after filtering.' },
      ],
    }
  }

  const layout = resolveLayoutFromPipes(pipes, options.layoutOverride, warnings)
  const partialScore: Score = buildScoreFromLayout(layout, {
    title: layout.title,
    key,
    meter,
    ...(tempoInRange ? { tempo_bpm: tempo } : {}),
  })

  const { score, warnings: normWarnings } = normalize(partialScore, options)
  const allWarnings = [...warnings, ...normWarnings]

  const schemaCheck = ScoreSchema.safeParse(score)
  if (!schemaCheck.success) {
    return {
      score,
      format: 'midi',
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

  return { score: schemaCheck.data, format: 'midi', warnings: allWarnings }
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

// ── multi-track layout cascade ─────────────────────────────────────────

const SPLIT_HAND_MIN_GAP_SEMITONES = 12
const SATB_PAIR_MAX_GAP_SEMITONES = 18

interface BuiltVoice {
  measures: Measure[]
  medianMidi: number
  sourceName?: string
}

interface ResolvedLayout {
  /** Primary staff voice 0 — always present. */
  primaryMeasures: Measure[]
  /** Voices 1..N on the primary staff. */
  primaryExtraVoices: Voice[]
  /** Optional second staff. */
  secondStaff?: Staff
  /** Title to attach to the score (typically the source track's name). */
  title?: string
}

interface TrackPipeShape {
  track: { name?: string; notes: Array<{ midi: number }> }
  measures: Measure[]
  medianMidi: number
}

/**
 * Pick a layout from the per-track pipeline results. Cascade:
 *
 *  1. layoutOverride='single' (explicit user choice) → busiest track,
 *     clef seeded by avg-pitch heuristic.
 *  2. layoutOverride='grand-staff' → pick top + bottom by median; treble
 *     primary, bass secondStaff. If only 1 track, generate a placeholder
 *     bass staff with whole-rest measures.
 *  3. layoutOverride='satb' → pick top 4 tracks (S A T B by median desc);
 *     pad with whole-rest voices if fewer than 4 are available.
 *  4. Auto (no override):
 *     a. SATB: exactly 4 non-empty tracks, strictly decreasing median, AND
 *        |median(top) - median(2nd)| < 18 AND |median(3rd) - median(4th)| < 18.
 *     b. Two-track piano: exactly 2 non-empty tracks, |median diff| > 12.
 *     c. Fallback: busiest single track + actionable warning.
 */
function resolveLayoutFromPipes(
  pipes: TrackPipeShape[],
  override: ImportOptions['layoutOverride'],
  warnings: ImportWarning[],
): ResolvedLayout {
  const sortedByCount = [...pipes].sort((a, b) => b.track.notes.length - a.track.notes.length)
  const sortedByMedian = [...pipes].sort((a, b) => b.medianMidi - a.medianMidi)

  if (override === 'single') {
    return singleLayout(sortedByCount[0])
  }
  if (override === 'grand-staff') {
    return grandStaffLayout(sortedByMedian)
  }
  if (override === 'satb') {
    return satbLayout(sortedByMedian)
  }

  // SATB auto-detect.
  if (pipes.length === 4) {
    const [s, a, t, b] = sortedByMedian
    const strictlyDecreasing =
      s.medianMidi > a.medianMidi && a.medianMidi > t.medianMidi && t.medianMidi > b.medianMidi
    const pairsClose =
      s.medianMidi - a.medianMidi <= SATB_PAIR_MAX_GAP_SEMITONES &&
      t.medianMidi - b.medianMidi <= SATB_PAIR_MAX_GAP_SEMITONES
    if (strictlyDecreasing && pairsClose) {
      warnings.push({
        severity: 'info',
        code: 'voice_picked',
        message: `Imported 4-track MIDI as SATB (S=${s.track.name ?? '?'}, A=${a.track.name ?? '?'}, T=${t.track.name ?? '?'}, B=${b.track.name ?? '?'}).`,
        meta: { layout: 'satb' },
      })
      return satbLayout(sortedByMedian)
    }
  }

  // Two-track piano auto-detect.
  if (pipes.length === 2) {
    const [top, bottom] = sortedByMedian
    if (top.medianMidi - bottom.medianMidi > SPLIT_HAND_MIN_GAP_SEMITONES) {
      warnings.push({
        severity: 'info',
        code: 'voice_picked',
        message: `Imported 2-track MIDI as grand-staff piano (top=${top.track.name ?? 'unnamed'}, bottom=${bottom.track.name ?? 'unnamed'}).`,
        meta: { layout: 'grand-staff' },
      })
      return grandStaffLayout(sortedByMedian)
    }
  }

  // Fallback: busiest single track.
  const chosen = sortedByCount[0]
  if (pipes.length > 1) {
    const dropped = pipes.length - 1
    warnings.push({
      severity: 'info',
      code: 'voice_picked',
      message: `MIDI has ${pipes.length} tracks but doesn't match piano or SATB layouts; imported '${chosen.track.name ?? 'unnamed'}' (${chosen.track.notes.length} notes). ${dropped} other track${dropped === 1 ? '' : 's'} dropped — use the Layout selector in the preview to import them as grand staff or SATB instead.`,
      meta: { layout: 'single', trackCount: pipes.length },
    })
  }
  return singleLayout(chosen)
}

function singleLayout(p: TrackPipeShape): ResolvedLayout {
  return {
    primaryMeasures: p.measures,
    primaryExtraVoices: [],
    title: p.track.name?.slice(0, 80),
  }
}

function grandStaffLayout(sortedByMedian: TrackPipeShape[]): ResolvedLayout {
  const top = sortedByMedian[0]
  const bottom = sortedByMedian[1]
  if (!bottom) {
    // Only 1 track: scaffold an empty bass staff so the user has
    // something to fill in. Length matches the primary's measure count.
    const restMeasures: Measure[] = top.measures.map(() => ({
      events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }],
    }))
    return {
      primaryMeasures: top.measures,
      primaryExtraVoices: [],
      secondStaff: { clef: 'bass', measures: restMeasures },
      title: top.track.name?.slice(0, 80),
    }
  }
  // Bar-align the two staves by clipping to the shorter measure list.
  const len = Math.min(top.measures.length, bottom.measures.length)
  return {
    primaryMeasures: top.measures.slice(0, len),
    primaryExtraVoices: [],
    secondStaff: {
      clef: 'bass',
      measures: bottom.measures.slice(0, len),
    },
    title: top.track.name?.slice(0, 80),
  }
}

function satbLayout(sortedByMedian: TrackPipeShape[]): ResolvedLayout {
  const [s, a, t, b] = sortedByMedian
  const len = Math.min(
    s?.measures.length ?? 0,
    a?.measures.length ?? 0,
    t?.measures.length ?? 0,
    b?.measures.length ?? 0,
  )
  // If fewer than 4 source tracks, fill the missing voices with
  // whole-rest scaffolding. We at minimum need a soprano (primary).
  const sopMeasures = s.measures.slice(0, len > 0 ? len : s.measures.length)
  const altoMeasures = a?.measures.slice(0, sopMeasures.length) ?? padRestMeasures(sopMeasures.length)
  const tenorMeasures = t?.measures.slice(0, sopMeasures.length) ?? padRestMeasures(sopMeasures.length)
  const bassMeasures = b?.measures.slice(0, sopMeasures.length) ?? padRestMeasures(sopMeasures.length)
  return {
    primaryMeasures: sopMeasures,
    primaryExtraVoices: [{ measures: altoMeasures }],
    secondStaff: {
      clef: 'bass',
      measures: tenorMeasures,
      extraVoices: [{ measures: bassMeasures }],
    },
    title: s.track.name?.slice(0, 80),
  }
}

function padRestMeasures(count: number): Measure[] {
  return Array.from({ length: count }, () => ({
    events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }],
  }))
}

function buildScoreFromLayout(
  layout: ResolvedLayout,
  base: { title?: string; key: Key; meter: Meter; tempo_bpm?: number },
): Score {
  // Score-level clef: when there's no secondStaff, infer clef from the
  // primary staff's median register. Only set clef when it would be
  // "bass" — treble is the implicit default.
  let clef: Clef | undefined
  if (!layout.secondStaff) {
    const allMidis = layout.primaryMeasures
      .flatMap((m) => m.events.flatMap((e) => e.pitches))
      .filter((p) => p.step !== 'rest')
      .map((p) => midiOf(p.step as Exclude<Step, 'rest'>, p.octave))
    if (allMidis.length > 0) {
      allMidis.sort((a, b) => a - b)
      const median = allMidis.length % 2 === 1
        ? allMidis[(allMidis.length - 1) / 2]
        : (allMidis[allMidis.length / 2 - 1] + allMidis[allMidis.length / 2]) / 2
      if (median < 60) clef = 'bass'
    }
  }
  return {
    ...(base.title ? { title: base.title } : layout.title ? { title: layout.title } : {}),
    key: base.key,
    meter: base.meter,
    ...(base.tempo_bpm !== undefined ? { tempo_bpm: base.tempo_bpm } : {}),
    ...(clef ? { clef } : {}),
    measures: layout.primaryMeasures,
    ...(layout.primaryExtraVoices.length ? { extraVoices: layout.primaryExtraVoices } : {}),
    ...(layout.secondStaff ? { secondStaff: layout.secondStaff } : {}),
  }
}

function midiOf(step: Exclude<Step, 'rest'>, octave: number): number {
  const offsets: Record<Exclude<Step, 'rest'>, number> = {
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
  }
  return (octave + 1) * 12 + offsets[step]
}
