import { z } from 'zod'
import { isValidMeter } from './meter'

export const StepSchema = z.enum(['C', 'D', 'E', 'F', 'G', 'A', 'B', 'rest'])

export const AccidentalSchema = z.enum([
  'natural',
  'sharp',
  'flat',
  'dblsharp',
  'dblflat',
  'none',
])

export const DurationSchema = z.enum([
  'whole',
  'half',
  'quarter',
  'eighth',
  'sixteenth',
  '32nd',
  'dotted-half',
  'dotted-quarter',
  'dotted-eighth',
])

export const KeySchema = z.enum([
  'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#',
  'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb',
  'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m',
  'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm',
])

export const MeterSchema = z.string().refine(isValidMeter, {
  message: 'Meter must be "C", "C|", or "n/d" where n is 1-32 and d is one of 1, 2, 4, 8, 16, 32',
})

export const TupletSchema = z.union([
  z.literal(3),
  z.literal(5),
  z.literal(6),
  z.literal(7),
])

/**
 * Articulation glyphs that attach to a notehead. 'portato' is the
 * compound staccato-and-tenuto glyph (single character, NOT the
 * stack of two separate articulations). Helpers in articulations.ts
 * auto-coerce staccato+tenuto into portato and reject marcato+accent
 * (engraving convention).
 */
export const ArticulationSchema = z.enum([
  'staccato',
  'accent',
  'tenuto',
  'marcato',
  'portato',
  'none',
])

/**
 * Ornament vocabulary including the Baroque essentials the music
 * red team flagged as missing:
 *
 * Trill family:
 * - 'trill' — modern trill (tr~~~)
 * - 'pralltriller' — upper mordent with line through it (different
 *   glyph than 'upper-mordent'; rapid two-note alternation)
 * Mordent family:
 * - 'mordent' — generic lower mordent (legacy)
 * - 'upper-mordent' — main note + upper auxiliary + main note
 * - 'lower-mordent' — main note + lower auxiliary + main note
 * - 'schneller' — inverted-mordent variant (older terminology;
 *   sometimes used for the Pralltriller with a different stroke)
 * Turn family:
 * - 'turn' — standard turn (upper-main-lower-main)
 * - 'inverted-turn' — lower-main-upper-main
 * - 'delayed-turn' — turn placed BETWEEN notes (different rhythmic
 *   interpretation; common in Mozart sonatas)
 * Other:
 * - 'slide' — Schleifer; small line / two grace notes into a pitch
 * - 'arpeggio-up' — wavy line, low-to-high (default arpeggio)
 * - 'arpeggio-down' — wavy line + downward arrowhead
 * - 'non-arpeggio' — vertical bracket on the chord's left side
 *   ("play exactly together, do NOT roll")
 * - 'grace' — legacy grace-note placeholder (kept for back-compat;
 *   M7 added structured `Event.graceNotes: GraceNote[]` which takes
 *   precedence at render time when present + non-empty)
 * - 'none'
 */
export const OrnamentSchema = z.enum([
  'trill',
  'pralltriller',
  'mordent',
  'upper-mordent',
  'lower-mordent',
  'schneller',
  'turn',
  'inverted-turn',
  'delayed-turn',
  'slide',
  'arpeggio-up',
  'arpeggio-down',
  'non-arpeggio',
  'grace',
  'none',
])

/**
 * Accidental modifier for trill upper auxiliary notes (Bach style).
 * 'tr♯' indicates the trill alternates with the SHARPENED upper
 * neighbor; 'tr♭' with the flattened. 'natural' overrides a
 * key-signature implied accidental on the upper note.
 *
 * Stored separately from OrnamentSchema so it can attach to any
 * trill-family ornament (trill, pralltriller, etc.).
 */
export const TrillUpperPitchSchema = z.enum(['natural', 'sharp', 'flat', 'dblsharp', 'dblflat'])

/**
 * Duration values usable on a grace note. Limited to the short notes
 * that traditionally appear as grace gestures — half-note grace etc.
 * is not a thing. Dotted variants are also excluded; acciaccatura and
 * appoggiatura are notated on pure subdivisions.
 *
 * - 'eighth'     — most common; one flag on the stem
 * - 'sixteenth'  — two flags; faster ornamental flicks
 * - '32nd'       — three flags; rapid grace runs (e.g. trill prefixes)
 */
export const GraceDurationSchema = z.enum(['eighth', 'sixteenth', '32nd'])

/**
 * Single-glyph dynamic markings. Compound dynamics like "sub. p" or
 * "p espressivo" use the structured form (DynamicMarkingSchema)
 * which adds prefix/suffix to the base value.
 */
export const DynamicSchema = z.enum([
  'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff',
  'n',     // niente (silence as a dynamic; Berio, Sciarrino, late Nono)
  'fp', 'fz', 'sfz', 'sffz', 'sfp', 'sfpp', 'rfz', 'rfp', 'fzp',
  'none',
])

/**
 * Modifier prefix for dynamics. `sub.` = suddenly (subito), `poco`
 * = a little, `meno` / `più` = less / more. These attach to a base
 * dynamic to form compounds like "sub. p" or "poco f".
 */
export const DynamicPrefixSchema = z.enum(['sub.', 'poco', 'meno', 'più'])

/**
 * Structured compound dynamic for marks like "sub. p espressivo".
 * The base is one of the DynamicSchema values; prefix is an optional
 * modifier ("sub.", "poco", etc.); suffix is an italicized word
 * after the dynamic ("espressivo", "marcato", "cantabile", "dolce").
 *
 * Phase 1 keeps `Event.dynamic` (the legacy enum) and adds
 * `Event.dynamic_structured` for compounds. Helpers in dynamics.ts
 * unify the read path.
 */
export const DynamicMarkingSchema = z.object({
  base: DynamicSchema,
  prefix: DynamicPrefixSchema.optional(),
  suffix: z.string().max(40).optional(),
})

/**
 * Fermata duration glyph. Modern engraving (Gould, Read) distinguishes
 * at least 5 forms — the standard semicircle, a longer "Henze" square,
 * a shorter triangular, plus filled-triangle (very short) and
 * double-square (very long) for contemporary scores. Modern abcjs
 * renders them via the !fermata! decoration; longer/shorter variants
 * may need styling tweaks at render time.
 *
 * On Event: fermata above the note.
 * On Measure (barlineFermata): fermata above the closing barline —
 * the "general pause" fermata universal in symphonic literature.
 */
export const FermataSchema = z.enum([
  'very-short',
  'short',
  'standard',
  'long',
  'very-long',
])

const PitchObjectSchema = z.object({
  step: StepSchema,
  // Scientific-pitch octave; middle C = C4. Range [0,9] spans piano A0
  // (octave 0) and bass clef / contrabass (octave 0-1) up through piccolo
  // (octave 8) with headroom — wide enough for any real instrument. The
  // abc octave-mark mapping lives in pitchToAbc (scoreToAbcWithMap.ts).
  octave: z.number().int().min(0).max(9),
  accidental: AccidentalSchema.optional(),
  /**
   * Per-pitch tie to the corresponding pitch in the next event.
   * In a chord `[C-E-G][CEG]` only C is tied: the first event's
   * `pitches[0].tied_to_next = true`, while E and G stay false.
   *
   * Optional during Phase 1 rollout. Helpers in `pitchTies.ts`
   * (`isPitchTiedToNext`) consult both this field and the legacy
   * event-wide `Event.tied_to_next` flag. PR-12 migration normalizes
   * event-wide ties into per-pitch ties and removes the legacy field.
   */
  tied_to_next: z.boolean().optional(),
  /**
   * Laissez vibrer — open-ended tie with no termination target.
   * Common on harp, vibraphone, piano with damper conventions.
   * The pitch rings until natural decay; no next-event pitch is
   * required to satisfy validation.
   */
  lv: z.boolean().optional(),
  /**
   * Enharmonic-tie escape hatch (C# → Db, etc.). Tied pitches
   * normally require step+octave match in the next event. Setting
   * this flag relaxes the match requirement for the Second Viennese
   * School / pivot-modulation case where the tied note is
   * deliberately respelled across the barline.
   */
  enharmonicTie: z.boolean().optional(),
})

/**
 * Defensive normalization for the LLM's #1 pitch mistake.
 *
 * `step` MUST be a bare letter (C..B) or 'rest', with accidentals in the
 * separate `accidental` field — the system prompt says so explicitly. But
 * in flat/sharp-heavy keys the model still sometimes emits a COMBINED note
 * name ("Bb", "F#", "Ebb", "Fx") as the step. Because `render_score` is
 * validated against `ScoreSchema` at the provider layer, a single such
 * pitch throws `ProviderSchemaError` and — with no retry on that class in
 * `callWithScoreRetry` — kills the WHOLE generation (in Bbm = 5 flats,
 * essentially every note trips it). The render tool's `strict` grammar
 * used to prevent this but had to be dropped (Anthropic: "compiled grammar
 * too large"), leaving only a prompt-level mitigation that demonstrably
 * still fails.
 *
 * So we rescue it at the schema boundary: split the combined form back
 * into step + accidental. Idempotent — a canonical step (and any existing
 * `accidental`) passes through untouched; an unrecognizable step ("H") is
 * left for `StepSchema` to reject so genuine garbage still surfaces.
 */
const CANONICAL_STEPS: ReadonlySet<string> = new Set(StepSchema.options)
const COMBINED_STEP_RE = /^([A-Ga-g])(##|x|bb|#|b|♯|♭|♮|n)?$/
const ACCIDENTAL_FROM_SUFFIX: Record<string, z.infer<typeof AccidentalSchema>> = {
  '#': 'sharp',
  '♯': 'sharp',
  b: 'flat',
  '♭': 'flat',
  '##': 'dblsharp',
  x: 'dblsharp',
  bb: 'dblflat',
  n: 'natural',
  '♮': 'natural',
}

export function normalizePitchInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const p = raw as Record<string, unknown>
  if (typeof p.step !== 'string') return raw
  const step = p.step.trim()
  // Already canonical — leave the object (and any existing accidental) as-is.
  if (CANONICAL_STEPS.has(step)) return raw
  const m = COMBINED_STEP_RE.exec(step)
  if (!m) return raw // unrecognized — let StepSchema reject it
  const letter = m[1].toUpperCase()
  const suffix = m[2]
  const accidental = suffix ? ACCIDENTAL_FROM_SUFFIX[suffix] : undefined
  // The combined note name is the clearest expression of intent, so a
  // derived accidental wins over any (likely-stale) accidental field.
  return accidental !== undefined
    ? { ...p, step: letter, accidental }
    : { ...p, step: letter }
}

export const PitchSchema = z.preprocess(normalizePitchInput, PitchObjectSchema)

/**
 * Stable per-event identifier. Optional in the schema during Phase 1
 * rollout — backfilled by `ensureEventIds()` for legacy scores and
 * generated via `createEventId()` for fresh events. Tightened to
 * required once the migration completes (Phase 1 PR-12).
 *
 * Length 8-16 chars; nanoid-produced IDs are 10 chars and 'm'-prefixed
 * derived IDs (migration) are 10 chars.
 */
export const EventIdSchema = z.string().min(8).max(16)

/**
 * Discriminator between rest and pitched events. Optional during the
 * Phase 1 rollout — when absent, callers infer rest-ness from
 * `pitches[0].step === 'rest'` (the legacy hack). Helpers in
 * `eventKind.ts` (`isRest`, `isPitched`, `createRest`, `createNote`)
 * cover both representations so new code can be explicit without
 * forcing a flag-day migration of every callsite.
 *
 * Once PR-12 migration backfills `kind` on every stored event the
 * field tightens to required and the `step: 'rest'` hack is removed.
 */
export const EventKindSchema = z.enum(['note', 'rest'])

// ─────────────────────────────────────────────────────────────────────
// Fingerings — tagged union per instrument family
// ─────────────────────────────────────────────────────────────────────

/**
 * Piano fingering: 0-5 (0 = thumb crossing under, 1 = thumb, 5 =
 * pinky). `substitution` carries notations like "3-2" (slide from
 * finger 3 to 2) or "1>2" (cross under). Free-form string so the
 * conventions are accurate without an exhaustive enum.
 */
export const PianoFingeringSchema = z.object({
  system: z.literal('piano'),
  value: z.enum(['0', '1', '2', '3', '4', '5']),
  substitution: z.string().max(20).optional(),
})

/**
 * String fingering: 0-4 (0 = open string). `stringRoman` indicates
 * which string is used (I, II, III, IV — orthogonal axis from the
 * finger number).
 */
export const StringFingeringSchema = z.object({
  system: z.literal('string'),
  finger: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  stringRoman: z.enum(['I', 'II', 'III', 'IV']).optional(),
})

/**
 * Guitar LH (left hand) fingering: 1-4. `stringNum` indicates string
 * (1-6, where 1 is high E in classical numbering); `fret` is a Roman
 * numeral position indicator (e.g. "V" for fifth position).
 */
export const GuitarLHFingeringSchema = z.object({
  system: z.literal('guitar-lh'),
  value: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  stringNum: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]).optional(),
  fret: z.string().regex(/^[IVX]+$/).max(5).optional(),
})

/**
 * Guitar RH (right hand) fingering: Spanish letter system. p =
 * pulgar (thumb), i = índice, m = medio, a = anular, c = chiquito.
 */
export const GuitarRHFingeringSchema = z.object({
  system: z.literal('guitar-rh'),
  value: z.enum(['p', 'i', 'm', 'a', 'c']),
})

/**
 * Organ fingering: 0-5 plus optional pedal indicators (heel ∪, toe ∧)
 * and thumb-direction indicators ( and ).
 */
export const OrganFingeringSchema = z.object({
  system: z.literal('organ'),
  value: z.enum(['0', '1', '2', '3', '4', '5']),
  foot: z.enum(['heel', 'toe']).optional(),
  thumbDirection: z.enum(['(', ')']).optional(),
})

export const FingeringSchema = z.union([
  PianoFingeringSchema,
  StringFingeringSchema,
  GuitarLHFingeringSchema,
  GuitarRHFingeringSchema,
  OrganFingeringSchema,
])

// ─────────────────────────────────────────────────────────────────────
// Chord symbol — structured representation of jazz/lead-sheet harmony
// ─────────────────────────────────────────────────────────────────────

/** Note name with optional accidental: C, C#, Bb, F#, etc. */
export const NoteNameSchema = z
  .string()
  .regex(/^[A-G](#|b)?$/, 'Expected note name like C, C#, Bb')

export const ChordQualitySchema = z.enum([
  'major',
  'minor',
  'diminished',
  'augmented',
  'sus2',
  'sus4',
])

export const ChordSeventhSchema = z.enum([
  'none',
  'maj7',
  'dom7',
  'min7',
  'dim7',
  'halfdim7',
])

export const ChordModalSchema = z.enum([
  'Ionian',
  'Dorian',
  'Phrygian',
  'Lydian',
  'Mixolydian',
  'Aeolian',
  'Locrian',
])

export type ChordSymbol = {
  root: string
  quality: 'major' | 'minor' | 'diminished' | 'augmented' | 'sus2' | 'sus4'
  seventh: 'none' | 'maj7' | 'dom7' | 'min7' | 'dim7' | 'halfdim7'
  extensions?: Array<9 | 11 | 13>
  alterations?: string[]
  add?: Array<2 | 4 | 6 | 9 | 11 | 13>
  omit?: Array<3 | 5 | 7>
  bass?: { type: 'note'; value: string } | { type: 'chord'; value: ChordSymbol }
  modal?: 'Ionian' | 'Dorian' | 'Phrygian' | 'Lydian' | 'Mixolydian' | 'Aeolian' | 'Locrian'
  display?: string
}

export const ChordSymbolSchema: z.ZodType<ChordSymbol> = z.lazy(() =>
  z.object({
    root: NoteNameSchema,
    quality: ChordQualitySchema,
    seventh: ChordSeventhSchema,
    extensions: z.array(z.union([z.literal(9), z.literal(11), z.literal(13)])).max(3).optional(),
    alterations: z.array(z.string().regex(/^(b|#)?\d{1,2}$|^alt$/)).max(6).optional(),
    add: z
      .array(
        z.union([
          z.literal(2),
          z.literal(4),
          z.literal(6),
          z.literal(9),
          z.literal(11),
          z.literal(13),
        ]),
      )
      .max(4)
      .optional(),
    omit: z.array(z.union([z.literal(3), z.literal(5), z.literal(7)])).max(3).optional(),
    bass: z
      .union([
        z.object({ type: z.literal('note'), value: NoteNameSchema }),
        z.object({ type: z.literal('chord'), value: ChordSymbolSchema }),
      ])
      .optional(),
    modal: ChordModalSchema.optional(),
    display: z.string().max(40).optional(),
  }),
)

/**
 * One syllable of lyric text attached to an event for one verse.
 * Multiple verses on the same event are encoded as multiple
 * LyricSyllable entries in the event's `lyrics` array, each with
 * its own `verse` number.
 *
 * `hyphen: true` — this syllable is part of a multi-syllable word;
 * the next event in the same verse continues the word (engraver
 * renders a hyphen between them).
 * `extender: true` — this syllable extends across following notes
 * as a melisma (engraver renders an underscore line). Subsequent
 * events in the same verse should have no syllable until the
 * melisma ends.
 *
 * Per-voice lyrics work by virtue of each voice having its own
 * Event array — voice 0 (Soprano) and voice 1 (Alto) at the same
 * musical beat are separate Event objects that can carry different
 * syllables (SATB divisi text).
 */
/**
 * verse 1..50 covers conventional hymnals (5-7 verses), 22-verse
 * acrostic psalms in Anglican settings, and longer traditional
 * pieces (Sephardic piyyutim, Sanskrit hymns). syllable min(1) so
 * an empty-string entry can't impersonate a melisma — convention
 * is to OMIT the array entry for events that should be silent in
 * that verse.
 */
export const LyricSyllableSchema = z.object({
  verse: z.number().int().min(1).max(50),
  syllable: z.string().min(1).max(40),
  hyphen: z.boolean().optional(),
  extender: z.boolean().optional(),
})

/**
 * One grace MOMENT attached to a principal Event. A grace CHORD
 * (multiple noteheads played together at one moment) is a single
 * `GraceNote` with multiple Pitch entries; a beamed grace RUN (a
 * sequence of grace moments) is multiple `GraceNote` entries in
 * `Event.graceNotes`.
 *
 * Grace pitches cannot be rests (a rest as a grace is incoherent —
 * there's no glyph for it). The refine() enforces this since
 * PitchSchema otherwise accepts `step: 'rest'`.
 *
 * `slashed: true` is the acciaccatura (crushed, no time taken from
 * the principal); omitted/false is the appoggiatura (takes time
 * from the principal — traditionally half of a binary or two-thirds
 * of a dotted principal; the renderer doesn't enforce this — it's
 * a notation, not a playback, distinction).
 *
 * Phase 1 covers BEFORE-grace only. After-grace (rare, mostly trill
 * terminations and Chopin Nocturne nachschlag) is deferred — ABC's
 * `c{c}` after-grace dialect is non-standard and abcjs handling is
 * inconsistent.
 */
export const GraceNoteSchema = z.object({
  pitches: z
    .array(PitchSchema)
    .min(1)
    .max(6)
    .refine((pp) => pp.every((p) => p.step !== 'rest'), {
      message: 'Grace note pitches cannot be rests',
    }),
  duration: GraceDurationSchema,
  slashed: z.boolean().optional(),
})

export const EventSchema = z.object({
  id: EventIdSchema.optional(),
  kind: EventKindSchema.optional(),
  pitches: z.array(PitchSchema).min(1).max(6),
  duration: DurationSchema,
  tuplet: TupletSchema.optional(),
  /**
   * Legacy single-articulation field. New code adds to `articulations`
   * (plural) which supports stacking. Helpers in articulations.ts
   * unify both — `getArticulations(event)` returns a single array.
   */
  articulation: ArticulationSchema.optional(),
  /**
   * Articulation stack — multiple glyphs attach to a notehead, e.g.
   * staccato+accent. Stacking order is enforced at render time
   * (staccato innermost → marcato outermost). marcato+accent is
   * rejected (engraving convention). staccato+tenuto auto-coerces
   * to the compound portato glyph.
   */
  articulations: z.array(ArticulationSchema).max(4).optional(),
  /** First-class fermata field; supports 5-form duration distinction. */
  fermata: FermataSchema.optional(),
  /** Breath mark (' above staff between this note and the next). */
  breathMark: z.boolean().optional(),
  /** Caesura (// "railroad tracks" between this note and the next). */
  caesura: z.boolean().optional(),
  /**
   * Single-note tremolo: slashes through the stem indicating rapid
   * repetition. 1 = eighth-tremolo, 2 = sixteenth, 3 = 32nd,
   * 4 = 64th (Liszt / Rachmaninov), 5 = rare contemporary.
   * `measured: false` for unmeasured/bowed tremolo (Beethoven 5
   * strings); `true` or omitted for measured (Schubert).
   */
  tremolo: z
    .object({
      slashes: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      measured: z.boolean().optional(),
    })
    .optional(),
  /**
   * String bowing direction: up-bow (V) or down-bow (∏). Per-note;
   * STATE-changing techniques like pizz./arco live on
   * Score.techniqueStates (see PR-8).
   */
  bowing: z.enum(['up', 'down']).optional(),
  /**
   * Jazz inflection — single-note pitch-bend annotation. Distinct
   * from articulations (which affect length) and ornaments (which
   * are decorative). Renders as small graphical glyphs above/below
   * the note: fall (line down), doit (line up), scoop (curve up
   * into note), plop (curve down into note), ghost (note in
   * parentheses).
   */
  jazzInflection: z.enum(['fall', 'doit', 'scoop', 'plop', 'ghost']).optional(),
  ornament: OrnamentSchema.optional(),
  /**
   * For trill-family ornaments, indicates the accidental of the
   * upper auxiliary note ('tr♯' Bach-style). Renders as a small
   * accidental glyph above the ornament symbol.
   */
  trillUpperPitch: TrillUpperPitchSchema.optional(),
  /**
   * Structured grace notes attached BEFORE this principal Event. A
   * sequence of grace MOMENTS; each moment is a single GraceNote
   * (one notehead) or a grace CHORD (multiple noteheads at one
   * moment). Replaces the legacy `ornament: 'grace'` placeholder —
   * when this array is present + non-empty, the renderer emits the
   * structured glyphs and the legacy fallback is suppressed. When
   * absent or empty, `ornament: 'grace'` continues to render its
   * default single grace note for back-compat.
   *
   * After-grace (nachschlag) is deferred to a future PR — abcjs
   * dialect for after-grace is non-standard.
   */
  graceNotes: z.array(GraceNoteSchema).max(8).optional(),
  /** Legacy single-value dynamic. Compounds use dynamic_structured. */
  dynamic: DynamicSchema.optional(),
  /**
   * Structured compound dynamic for "sub. p espressivo", "poco f", etc.
   * When present, takes precedence over `dynamic` at render time.
   */
  dynamic_structured: DynamicMarkingSchema.optional(),
  tied_to_next: z.boolean().optional(),
  /**
   * Lyric syllables attached to this event. Each verse has its own
   * entry in the array; lookup is by `verse` number, not by index.
   * See `lyrics.ts` helpers for the per-verse API.
   *
   * Verses are unique within an event — the refine() below enforces
   * this so getSyllable() can return a single deterministic match.
   */
  lyrics: z
    .array(LyricSyllableSchema)
    .max(50)
    .refine(
      (arr) => new Set(arr.map((s) => s.verse)).size === arr.length,
      { message: 'Each verse number may appear at most once in an event’s lyrics array' },
    )
    .optional(),
  /**
   * Chord symbol for jazz / lead-sheet rendering. Structured so
   * transposition can mechanically remap the root/bass; `display`
   * caches the canonical text form.
   */
  chordSymbol: ChordSymbolSchema.optional(),
  /**
   * Fingerings — one per pitch in a chord (or none). Tagged-union
   * per instrument family: piano (0-5 + substitutions), string
   * (0-4 + Roman numeral string indicator), guitar LH/RH (the LH
   * uses 1-4 + string + position; the RH uses Spanish letters
   * p/i/m/a/c), organ (0-5 + heel/toe + thumb direction).
   *
   * Indexing: entry `fingerings[i]` corresponds to `pitches[i]`.
   * Interior `null` slots represent "no fingering at this pitch"
   * so the user can fingering pitch 2 of a 3-note chord without
   * fingering pitches 0 and 1 (helpers in `fingerings.ts` trim
   * trailing nulls automatically). Array length 0..6; trailing
   * pitches without an entry remain unfingered.
   */
  fingerings: z.array(FingeringSchema.nullable()).max(6).optional(),
})

/** Barline glyphs at the start or end of a measure. */
export const BarlineSchema = z.enum([
  'thin',
  'double',
  'final',
  'repeat-start',
  'repeat-end',
  'repeat-both',
  'invisible',
  'dashed',
])

/**
 * Single source of truth for the 8 barline kinds (M16-PR-3 review
 * fix). Mirrors the HAIRPIN_KINDS / SLUR_KINDS / TEMPO_SPAN_KINDS
 * pattern in spans.ts — consumers (render_score schema, editIntra
 * Measure op-bag schema, editor UI selectors) import this const so
 * adding a 9th kind to BarlineSchema is caught by sync-pin tests
 * instead of silently skipping the new kind in some surfaces.
 */
export const BARLINE_KINDS = BarlineSchema.options

export const MeasureSchema = z.object({
  events: z.array(EventSchema).min(1).max(32),
  /**
   * Fermata placed on the CLOSING barline of this measure — the
   * "general pause" fermata (G.P.) universal in symphonic literature
   * (Beethoven 5 mvt 1 m.21, Mahler everywhere). Distinct from
   * Event.fermata which sits on a note.
   */
  barlineFermata: FermataSchema.optional(),
  /**
   * Barline glyph at the LEFT edge of this measure. Defaults to
   * 'thin'. `repeat-start` opens a `|: ... :|` repeat block.
   */
  startBarline: BarlineSchema.optional(),
  /**
   * Barline glyph at the RIGHT edge of this measure. Defaults to
   * 'thin'. `repeat-end` closes a `|: ... :|` repeat. `final`
   * draws the closing thin+thick. `double` separates major sections.
   */
  endBarline: BarlineSchema.optional(),
  /**
   * True for the anacrusis (pickup) measure — typically only the
   * first measure of a piece, where total duration is less than the
   * meter's full capacity. NOTE: PR-5 only schemas the flag;
   * validateMeasureDuration in PR-13 will honor it to permit short
   * measures. Setting isPickup today has no behavioral effect.
   */
  isPickup: z.boolean().optional(),
  /**
   * True for a closing partial measure that balances an anacrusis,
   * common in hymn-tune practice. Same status as isPickup — PR-13
   * will honor; currently inert.
   */
  isFinalPartial: z.boolean().optional(),
  /**
   * Engraver hint to break to a new system AFTER this measure.
   */
  systemBreakAfter: z.boolean().optional(),
  /**
   * Engraver hint to break to a new page AFTER this measure.
   */
  pageBreakAfter: z.boolean().optional(),
})

export const ClefSchema = z.enum(['treble', 'bass'])

export const VoiceSchema = z.object({
  measures: z.array(MeasureSchema).min(1).max(10000),
})

export const StaffSchema = z.object({
  clef: ClefSchema,
  measures: z.array(MeasureSchema).min(1).max(10000),
  /**
   * Optional extra voices on this staff (SATB-style polyphony). The
   * primary voice lives in `measures` above (voice index 0); entries
   * here are voices 1, 2, 3. Each voice must have the same number of
   * measures as the primary so the staves stay bar-aligned per voice.
   * Cap: 3 extra voices (so SATB fits as two staves with two voices
   * each).
   */
  extraVoices: z.array(VoiceSchema).max(3).optional(),
})

// ─────────────────────────────────────────────────────────────────────
// Spans (slurs, hairpins, octave lines, glissandi)
// Endpoints reference stable Event IDs. PR-1 added IDs as optional;
// once IDs are required (PR-12), spans are fully load-bearing.
// ─────────────────────────────────────────────────────────────────────

export const SpanIdSchema = z.string().min(8).max(16)

export const SpanKindSchema = z.enum([
  'slur',           // phrase or legato slur
  'phrase-slur',    // explicit phrase slur (longer, broader curve)
  'hairpin-cresc',  // < crescendo wedge
  'hairpin-dim',    // > diminuendo wedge
  '8va',            // octave-up line above the staff
  '8vb',            // octave-down line below the staff
  '15ma',           // two-octave-up
  '15mb',           // two-octave-down
  'glissando',
  'trill-line',     // wavy line extending a trill ornament
  'tremolo-between', // between-note z-tremolo
  'pedal',          // piano pedal: Ped. ____ * (or notched line)
  'accel',          // accelerando line: "accel." text + dashed extension (M14)
  'rit',            // ritardando line: "rit." text + dashed extension (M14)
])

export const SpanSchema = z.object({
  /**
   * Optional during M11-PR-1 rollout — the LLM may emit spans[] without
   * ids and the orchestrator's `ensureSpanIds` (spans.ts) backfills
   * before save. Direct-construction sites (edit-op insertSpan, editor
   * UI) always mint via createSpanId. Same pattern as M3-PR-1
   * TechniqueChange.id, M8-PR-1 Annotation.id, M9-PR-1 Marker.id.
   */
  id: SpanIdSchema.optional(),
  kind: SpanKindSchema,
  startEventId: EventIdSchema,
  endEventId: EventIdSchema,
  /**
   * staff/voice the span belongs to. Cross-voice and cross-staff
   * spans are rejected in Phase 1; cross-staff slurs are a Phase 2
   * deferral.
   */
  staffIdx: z.number().int().min(0).max(1),
  voiceIdx: z.number().int().min(0).max(3),
  /**
   * Optional terminal dynamics for hairpins, enabling shorthand like
   * `p<f` (cresc from p to f). When set, the renderer attaches the
   * dynamic glyph at the corresponding end of the hairpin.
   */
  startDynamic: DynamicSchema.optional(),
  endDynamic: DynamicSchema.optional(),
  /**
   * Vertical placement hint. `default` lets the engraver decide.
   */
  placement: z.enum(['above', 'below', 'default']).optional(),
  /**
   * Glissando style; only meaningful when kind='glissando'.
   */
  glissStyle: z.enum(['straight', 'wavy']).optional(),
  /**
   * Whether the glissando carries the 'gliss.' text label.
   */
  glissText: z.boolean().optional(),
  /**
   * Terminal tempo (BPM) for accel/rit spans (M14). When set, the
   * renderer paints "accel. → ♩=144" / "rit. → ♩=60" at the end
   * event so the player sees the target pulse. Only meaningful for
   * kind='accel' or kind='rit'; ignored on other span kinds.
   *
   * Distinct from a sibling tempo Marker at the end — the span's
   * terminal tempo is the VISUAL target label; a Marker with
   * tempo_bpm carries the actual playback transition. Users often
   * want both: the span carries the visual continuity, the marker
   * carries the discrete numeric pulse.
   */
  endTempoBpm: z.number().int().min(30).max(240).optional(),
  /**
   * Terminal tempo TEXT for accel/rit spans (M14). When set, the
   * renderer paints the text at the end event ("a tempo", "meno
   * mosso", etc.). Distinct from endTempoBpm — text and BPM may
   * coexist ("a tempo (♩=120)") or appear independently.
   */
  endTempoText: z.string().max(40).optional(),
})

// ─────────────────────────────────────────────────────────────────────
// Markers (mid-piece changes: key, meter, clef, tempo)
// Per-measure overrides. `activeKeyAt(score, measureIdx)` etc. honor
// the score-level default plus the most recent marker at or before
// the given index.
// ─────────────────────────────────────────────────────────────────────

export const ClefChangeSchema = z.object({
  staffIdx: z.number().int().min(0).max(1),
  clef: ClefSchema,
})

/**
 * Shared id schema for Marker / JumpMarker / SegnoMarker / CodaMarker.
 * Moved above MarkerSchema (M9-PR-1) so the mid-piece tempo/key/meter
 * markers can reference it without a forward declaration; the
 * JumpMarker family below uses the same schema.
 */
export const MarkerIdSchema = z.string().min(8).max(16)

/**
 * Note value usable in a metric-modulation notation. Excludes 'whole'
 * (too long to be a sensible modulation pivot) and the longer dotted
 * variants. Matches the standard 20th-century engraving convention
 * (Carter Quartets, Reich Tehillim, Adams Shaker Loops).
 */
export const MetricModulationNoteSchema = z.enum([
  'half',
  'dotted-half',
  'quarter',
  'dotted-quarter',
  'eighth',
  'dotted-eighth',
  'sixteenth',
])

/**
 * Metric modulation notation: "fromNote (in OLD tempo) = toNote (in
 * NEW tempo)". Renders as "♩ = ♩." at the measure boundary, signaling
 * tempo equivalence in subdivision terms across a meter or pulse
 * change. The actual new playback tempo is whatever the sibling
 * `tempo_bpm` on the same Marker carries — metric modulation is the
 * visual label, not the playback semantic.
 */
export const MetricModulationSchema = z.object({
  fromNote: MetricModulationNoteSchema,
  toNote: MetricModulationNoteSchema,
})

export const MarkerSchema = z
  .object({
    /**
     * Optional id during M9-PR-1 rollout — the LLM may emit markers[]
     * without ids and the orchestrator's `ensureMarkerIds` backfills
     * before save. Direct-construction sites (edit-op insertMarker,
     * editor UI) always mint via createMarkerId. Same pattern as
     * M3-PR-1 TechniqueChange.id and M8-PR-1 Annotation.id.
     */
    id: MarkerIdSchema.optional(),
    measureIdx: z.number().int().min(0),
    key: KeySchema.optional(),
    meter: MeterSchema.optional(),
    tempo_bpm: z.number().int().min(30).max(240).optional(),
    /** Tempo word (e.g. 'Allegro'); usually paired with tempo_bpm. */
    tempo_text: z.string().max(40).optional(),
    /** Per-staff clef changes at this measure boundary. */
    clefs: z.array(ClefChangeSchema).max(2).optional(),
    /**
     * Optional metric-modulation notation ("♩ = ♩.") rendered at
     * this marker. Visual label only — the new tempo lives in the
     * sibling `tempo_bpm` (or stays implicit when omitted).
     */
    metricModulation: MetricModulationSchema.optional(),
  })
  .refine(
    (m) =>
      m.key !== undefined ||
      m.meter !== undefined ||
      m.tempo_bpm !== undefined ||
      m.tempo_text !== undefined ||
      (m.clefs !== undefined && m.clefs.length > 0) ||
      m.metricModulation !== undefined,
    {
      message:
        'Marker must change at least one of key, meter, tempo_bpm, tempo_text, clefs, metricModulation',
    },
  )

// ─────────────────────────────────────────────────────────────────────
// Voltas (1st / 2nd / Nth endings)
// ─────────────────────────────────────────────────────────────────────

export const VoltaIdSchema = z.string().min(8).max(16)

export const VoltaSchema = z.object({
  id: VoltaIdSchema,
  startMeasureIdx: z.number().int().min(0),
  endMeasureIdx: z.number().int().min(0),
  /**
   * The endings this volta represents. `[1]` = 1st time only.
   * `[1, 2]` = first AND second pass. `[1, 2, 3]` = takes first
   * three passes. Use multiple Voltas for separate brackets
   * stacked over the same passage.
   */
  endings: z.array(z.number().int().min(1).max(9)).min(1).max(9),
  /**
   * Whether the right end of the bracket has a closing hook.
   * Open-ended voltas flow into the next without a hook.
   */
  endHook: z.enum(['closed', 'open']).optional(),
  /** Optional text label (e.g., "First time", "D.C."). */
  text: z.string().max(40).optional(),
})

// ─────────────────────────────────────────────────────────────────────
// Jump markers (D.C., D.S., al Coda, Coda, Segno, Fine)
// Linked by ID so multi-coda pieces (Brahms Hungarian Dances, Sousa
// marches) can express "this D.S. → that Segno → that Coda".
// MarkerIdSchema is declared above (M9-PR-1 hoist) and shared with
// the tempo/key/meter Marker schema.
// ─────────────────────────────────────────────────────────────────────

export const JumpKindSchema = z.enum([
  'D.C.',
  'D.S.',
  'D.C. al Coda',
  'D.S. al Coda',
  'D.C. al Fine',
  'D.S. al Fine',
  'To Coda',
  'Fine',
])

export const JumpMarkerSchema = z.object({
  id: MarkerIdSchema,
  measureIdx: z.number().int().min(0),
  side: z.enum(['start', 'end']),
  kind: JumpKindSchema,
  /**
   * For *.al-Coda kinds: id of the To-Coda marker that the jump
   * lands on. Validated to reference an existing markers entry.
   */
  toCodaRef: MarkerIdSchema.optional(),
  /**
   * For *.al-Coda and Coda kinds: id of the Coda marker the
   * playback jumps to after hitting To Coda.
   */
  codaRef: MarkerIdSchema.optional(),
  /**
   * For D.S.* kinds: id of the Segno marker to return to.
   */
  segnoRef: MarkerIdSchema.optional(),
})

export const SegnoMarkerSchema = z.object({
  id: MarkerIdSchema,
  measureIdx: z.number().int().min(0),
  side: z.enum(['start', 'end']),
})

export const CodaMarkerSchema = z.object({
  id: MarkerIdSchema,
  measureIdx: z.number().int().min(0),
  side: z.enum(['start', 'end']),
})

// ─────────────────────────────────────────────────────────────────────
// Performance technique state (pizz., arco, col legno, sul ponticello,
// etc.). These are state-changing directions that persist on a voice
// until cancelled — fundamentally different from per-note articulations.
// A `pizz.` at m.5 means voice plays pizzicato from m.5 forward until
// an `arco` marker (or another technique change) cancels it.
// ─────────────────────────────────────────────────────────────────────

export const TechniqueIdSchema = z.string().min(8).max(16)

export const TechniqueKindSchema = z.enum([
  'pizz',              // pizzicato
  'arco',              // back to bowing (cancels pizz)
  'col-legno-battuto', // struck with the wood
  'col-legno-tratto',  // drawn with the wood
  'sul-ponticello',    // on the bridge
  'sul-tasto',         // on the fingerboard
  'flautando',         // flute-like (close to fingerboard)
  'ord',               // ordinario — return to normal
  'snap-pizz',         // Bartók pizzicato (snap)
  'LH-pizz',           // left-hand pizzicato (+ symbol)
  'tremolo',           // unmeasured tremolo state
  'mute-on',           // con sord. (with mute)
  'mute-off',          // senza sord. (without mute)
])

export const TechniqueChangeSchema = z.object({
  /**
   * Stable reference id. Optional on the wire so LLM-authored
   * render_score calls don't have to mint one — `ensureTechniqueIds`
   * backfills before any edit-op handler that needs a stable target.
   * Editor-created changes always carry an id from `createTechniqueChange`.
   */
  id: TechniqueIdSchema.optional(),
  measureIdx: z.number().int().min(0),
  /** Omit to apply at the start of the measure. */
  eventIdx: z.number().int().min(0).optional(),
  staffIdx: z.number().int().min(0).max(1),
  voiceIdx: z.number().int().min(0).max(3),
  kind: TechniqueKindSchema,
})

// ─────────────────────────────────────────────────────────────────────
// Free-floating annotations (rehearsal marks, expression text,
// tempo text, free annotations like 'dolce').
// ─────────────────────────────────────────────────────────────────────

export const AnnotationIdSchema = z.string().min(8).max(16)

export const AnnotationStyleSchema = z.enum([
  'plain',
  'italic',
  'bold',
  'rehearsal-mark',
  'tempo-text',
  'expression',
])

export const AnnotationSchema = z.object({
  /**
   * Optional during rollout — the LLM may emit annotations[] without
   * ids and the orchestrator's `ensureAnnotationIds` (annotations.ts)
   * backfills before save. Mirrors the M3-PR-1 TechniqueChange.id
   * pattern. Direct-construction call sites (edit-op insertAnnotation,
   * editor UI) always mint via createAnnotationId.
   */
  id: AnnotationIdSchema.optional(),
  target: z.object({
    measureIdx: z.number().int().min(0),
    /** Omit to anchor at the measure level. */
    eventIdx: z.number().int().min(0).optional(),
    /** Visual placement relative to the target. */
    position: z.enum(['above', 'below', 'left', 'right']),
  }),
  text: z.string().max(120),
  style: AnnotationStyleSchema,
  /**
   * Optional span endpoint for line-extending annotations like
   * "rit. ____" or "accel. ____". When set, the annotation renders
   * with a dashed line extending to this event/measure.
   */
  spanEnd: z
    .object({
      measureIdx: z.number().int().min(0),
      eventIdx: z.number().int().min(0).optional(),
    })
    .optional(),
})

// ─────────────────────────────────────────────────────────────────────
// EngravingDefaults — per-score rendering preferences. Modeled after
// SMuFL / Dorico's engraving_defaults but trimmed to fields that
// abcjs can plausibly honor or that we plan to apply via render-time
// styling. PR-13 will gate the renderer on these.
// ─────────────────────────────────────────────────────────────────────

export const EngravingDefaultsSchema = z.object({
  // Dynamics positioning — vocal vs instrumental conflict resolution.
  // 'hidden' suppresses dynamic glyphs (useful for instrumental part
  // extraction or editor overlays where dynamics live on a separate
  // layer); maps to abcjs's `%%dynamic hidden`.
  dynamicsPosition: z
    .enum(['above', 'below', 'auto-by-staff', 'hidden'])
    .default('auto-by-staff'),

  // Dynamics typography
  dynamicsStyle: z.enum(['italic-bold', 'italic-only', 'bold-only']).optional(),

  // Tempo text typography + placement
  tempoTextFont: z.enum(['italic-bold', 'bold-roman', 'italic-roman', 'plain-roman']).optional(),
  tempoTextPlacement: z.enum(['above', 'inline']).optional(),

  // Rehearsal mark frame style
  rehearsalMarkStyle: z.enum(['rectangle', 'circle', 'plain']).optional(),

  // Editorial accidentals — round / square brackets, or none.
  editorialAccidentalBrackets: z.enum(['round', 'square', 'none']).optional(),

  // Cautionary accidentals — show always, only across barline (default),
  // or never (compact modern style).
  cautionaryAccidentalPolicy: z.enum(['always', 'across-barline-only', 'never']).optional(),

  // Beam slope — American convention favors steeper slopes; European
  // (Henle / Bärenreiter) prefers flatter.
  beamSlopeRule: z.enum(['american-steep', 'european-flat']).optional(),

  // Stem length default in staff-spaces (the abcjs unit; ~3.5 is the
  // engraver standard).
  stemLengthDefault: z.number().min(2).max(6).optional(),

  // Slur curve parameters
  slurThickness: z.number().min(0.5).max(3).optional(),
  slurCurvature: z.number().min(0.1).max(2).optional(),

  // Tie curve parameters
  tieThickness: z.number().min(0.5).max(3).optional(),
  tieCurvature: z.number().min(0.1).max(2).optional(),

  // Tuplet bracket display
  tupletBracketStyle: z.enum(['bracket', 'slur', 'none']).optional(),
  tupletNumberStyle: z.enum(['plain', 'italic', 'serif']).optional(),

  // First-system indent vs subsequent-system indent (in staff-spaces).
  firstSystemIndent: z.number().min(0).max(20).optional(),
  subsequentSystemIndent: z.number().min(0).max(20).optional(),

  // Multi-rest H-bar style for multi-measure rests
  multiRestHBarStyle: z.enum(['thick', 'thin', 'churchwarden']).optional(),

  // Language for tempo terms (preference, not enforcement)
  tempoTermsLanguage: z.enum(['italian', 'german', 'english', 'french']).optional(),

  // Chord-symbol font: jazz-style (superscript extensions) vs plain.
  chordSymbolStyle: z.enum(['jazz', 'plain', 'roman-numeral']).optional(),

  // Lyric font size relative to staff (percentage)
  lyricFontScale: z.number().min(50).max(200).optional(),

  // Whether to show courtesy time-signature at end of prior system on
  // mid-piece meter changes.
  courtesyTimeSignatures: z.boolean().optional(),

  // Whether to show courtesy key-signature at end of prior system on
  // mid-piece key changes.
  courtesyKeySignatures: z.boolean().optional(),

  // Whether to show cancel naturals on key changes that have FEWER
  // accidentals than the prior key (F major → C major: natural on B).
  cancelNaturalsOnKeyChange: z.boolean().optional(),

  // Beam-group breaking — let meter drive default beaming.
  beamingPolicy: z.enum(['by-beat', 'by-half-bar', 'by-bar', 'manual']).optional(),

  // System breaks — page-mode or scroll-mode.
  pageLayoutMode: z.enum(['page', 'scroll']).optional(),

  // Maximum measures per system (when not overridden by manual
  // systemBreakAfter).
  maxMeasuresPerSystem: z.number().int().min(1).max(32).optional(),

  // Whether grace notes are displayed in 'cue' size (smaller).
  graceNoteCueSize: z.boolean().optional(),
})

export const ScoreSchema = z.object({
  title: z.string().max(80).optional(),
  key: KeySchema,
  meter: MeterSchema,
  tempo_bpm: z.number().int().min(30).max(240).optional(),
  clef: ClefSchema.optional(),
  measures: z.array(MeasureSchema).min(1).max(10000),
  /**
   * Optional extra voices on the primary staff (SATB top-system).
   * Each voice's measures.length must equal `measures.length`.
   */
  extraVoices: z.array(VoiceSchema).max(3).optional(),
  /**
   * Optional second staff (grand-staff / piano left hand). When
   * present, its measures must match the primary staff's measures
   * length so the two staves stay bar-aligned. Validated in
   * validateScore.
   */
  secondStaff: StaffSchema.optional(),
  /** Score-level metadata. */
  composer: z.string().max(120).optional(),
  arranger: z.string().max(120).optional(),
  lyricist: z.string().max(120).optional(),
  copyright: z.string().max(200).optional(),
  /**
   * Phase 1 schema extensions. All optional; PR-13 adds the
   * cross-reference invariants (span endpoints exist, jump refs
   * exist, volta consecutivity, marker monotonicity, etc.).
   */
  spans: z.array(SpanSchema).optional(),
  markers: z.array(MarkerSchema).optional(),
  voltas: z.array(VoltaSchema).optional(),
  jumpMarkers: z.array(JumpMarkerSchema).optional(),
  segnoMarkers: z.array(SegnoMarkerSchema).optional(),
  codaMarkers: z.array(CodaMarkerSchema).optional(),
  // Cap matches the LLM-side maxItems hint in renderScoreTool.ts so
  // the wire schema and the persisted Zod schema agree on the bound
  // (any path that bypasses the tool — generateSimple raw JSON,
  // direct DB insert — still gets the cap).
  annotations: z.array(AnnotationSchema).max(100).optional(),
  /**
   * Performance-technique state changes. pizz./arco/col legno/etc.
   * persist on a voice from their position forward until cancelled.
   * Helpers in techniques.ts compute the active technique at any
   * (staffIdx, voiceIdx, measureIdx, eventIdx).
   */
  techniqueStates: z.array(TechniqueChangeSchema).optional(),
  /**
   * Per-score rendering preferences. Resolves the vocal-vs-instrumental
   * dynamics-position conflict (auto-by-staff), tempo text font/placement,
   * rehearsal-mark frame style, beam slope (American steep vs European
   * flat), slur/tie thickness + curvature, tuplet bracket display,
   * cautionary accidentals policy, language for tempo terms, and more.
   * PR-13 gates the renderer on these defaults; today the schema
   * accepts them additively and renderers ignore unrecognized fields.
   */
  engravingDefaults: EngravingDefaultsSchema.optional(),
})

/**
 * Canonical "blank canvas" seed. One measure with a single whole rest
 * in C major, 4/4, treble. The `clef` field is intentionally omitted —
 * the renderer defaults to treble, matching `changeClef`'s convention
 * of dropping the field when value === 'treble' (see
 * `editOperations.ts` changeClef branch).
 *
 * Used by /api/import?format=blank to seed a fresh editable session
 * without invoking the LLM.
 */
export const BLANK_SCORE: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        {
          kind: 'rest',
          pitches: [{ step: 'rest', octave: 4 }],
          duration: 'whole',
        },
      ],
    },
  ],
}

export type Step = z.infer<typeof StepSchema>
export type Accidental = z.infer<typeof AccidentalSchema>
export type Duration = z.infer<typeof DurationSchema>
export type Key = z.infer<typeof KeySchema>
export type Meter = z.infer<typeof MeterSchema>
export type Clef = z.infer<typeof ClefSchema>
export type Articulation = z.infer<typeof ArticulationSchema>
export type Ornament = z.infer<typeof OrnamentSchema>
export type TrillUpperPitch = z.infer<typeof TrillUpperPitchSchema>
export type Dynamic = z.infer<typeof DynamicSchema>
export type DynamicPrefix = z.infer<typeof DynamicPrefixSchema>
export type DynamicMarking = z.infer<typeof DynamicMarkingSchema>
export type Fermata = z.infer<typeof FermataSchema>
export type Pitch = z.infer<typeof PitchSchema>
export type EventKind = z.infer<typeof EventKindSchema>
export type LyricSyllable = z.infer<typeof LyricSyllableSchema>
export type GraceDuration = z.infer<typeof GraceDurationSchema>
export type GraceNote = z.infer<typeof GraceNoteSchema>
export type ChordQuality = z.infer<typeof ChordQualitySchema>
export type ChordSeventh = z.infer<typeof ChordSeventhSchema>
export type ChordModal = z.infer<typeof ChordModalSchema>
export type PianoFingering = z.infer<typeof PianoFingeringSchema>
export type StringFingering = z.infer<typeof StringFingeringSchema>
export type GuitarLHFingering = z.infer<typeof GuitarLHFingeringSchema>
export type GuitarRHFingering = z.infer<typeof GuitarRHFingeringSchema>
export type OrganFingering = z.infer<typeof OrganFingeringSchema>
export type Fingering = z.infer<typeof FingeringSchema>
export type Event = z.infer<typeof EventSchema>
export type Barline = z.infer<typeof BarlineSchema>
export type Measure = z.infer<typeof MeasureSchema>
export type Voice = z.infer<typeof VoiceSchema>
export type Staff = z.infer<typeof StaffSchema>
export type SpanKind = z.infer<typeof SpanKindSchema>
export type Span = z.infer<typeof SpanSchema>
export type ClefChange = z.infer<typeof ClefChangeSchema>
export type Marker = z.infer<typeof MarkerSchema>
export type MetricModulation = z.infer<typeof MetricModulationSchema>
export type MetricModulationNote = z.infer<typeof MetricModulationNoteSchema>
export type Volta = z.infer<typeof VoltaSchema>
export type JumpKind = z.infer<typeof JumpKindSchema>
export type JumpMarker = z.infer<typeof JumpMarkerSchema>
export type SegnoMarker = z.infer<typeof SegnoMarkerSchema>
export type CodaMarker = z.infer<typeof CodaMarkerSchema>
export type AnnotationStyle = z.infer<typeof AnnotationStyleSchema>
export type Annotation = z.infer<typeof AnnotationSchema>
export type TechniqueKind = z.infer<typeof TechniqueKindSchema>
export type TechniqueChange = z.infer<typeof TechniqueChangeSchema>
export type EngravingDefaults = z.infer<typeof EngravingDefaultsSchema>
export type Score = z.infer<typeof ScoreSchema>
