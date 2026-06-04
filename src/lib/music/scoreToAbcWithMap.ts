import type {
  Accidental,
  Annotation,
  Articulation,
  Dynamic,
  Event,
  Fingering,
  GraceNote,
  JumpKind,
  Marker,
  Measure,
  MetricModulationNote,
  Ornament,
  Pitch,
  Score,
  Span,
  TechniqueKind,
} from './types'
import { ValidationError } from './errors'
import { getArticulations } from './articulations'
import { formatChordSymbol } from './chordSymbols'
import { getDynamicBase } from './dynamics'
import {
  getStaffClef,
  getStaffCount,
  getVoiceCount,
  getVoiceMeasures,
} from './scoreAccessors'
import {
  isGlissando,
  isHairpin,
  isOctaveSpan,
  isSlur,
  isTempoSpan,
  isTremoloBetween,
  isTrillLine,
} from './spans'
import { isPitchTiedToNext } from './pitchTies'
import { getMaxVerse, getSyllable } from './lyrics'

export type NoteRange = {
  staffIdx: number
  voiceIdx: number
  measureIdx: number
  eventIdx: number
  pitchIdx: number
  startChar: number
  endChar: number
}

export type EventRange = {
  staffIdx: number
  voiceIdx: number
  measureIdx: number
  eventIdx: number
  startChar: number
  endChar: number
  pitchRanges: NoteRange[]
}

export type SourceMap = {
  events: EventRange[]
  /** key = `${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}` */
  byEvent: Map<string, EventRange>
}

const DURATION_ABC: Record<Event['duration'], string> = {
  whole: '8',
  'dotted-half': '6',
  half: '4',
  'dotted-quarter': '3',
  quarter: '2',
  'dotted-eighth': '3/2',
  eighth: '',
  sixteenth: '/2',
  '32nd': '/4',
}

const ACCIDENTAL_PREFIX: Record<Accidental, string> = {
  natural: '=',
  sharp: '^',
  flat: '_',
  dblsharp: '^^',
  dblflat: '__',
  none: '',
}

function pitchToAbc(pitch: Pitch): string {
  if (pitch.step === 'rest') return 'z'
  const accidental = ACCIDENTAL_PREFIX[pitch.accidental ?? 'none']
  if (pitch.octave < 0 || pitch.octave > 9) {
    throw new ValidationError(`Octave ${pitch.octave} out of supported range (0..9)`, 'schema_error')
  }
  // abc octave marks anchored at uppercase `C` = octave 4, lowercase
  // `c` = octave 5. Each trailing comma drops an octave (C, = 3, C,, = 2,
  // C,,, = 1, C,,,, = 0) and each apostrophe raises one (c' = 6, c'' = 7,
  // … c'''' = 9), so the whole [0,9] schema range is representable.
  const note =
    pitch.octave <= 4
      ? `${pitch.step}${','.repeat(4 - pitch.octave)}`
      : `${pitch.step.toLowerCase()}${"'".repeat(pitch.octave - 5)}`
  return accidental + note
}

function articulationToAbc(art?: Articulation): string {
  switch (art) {
    case 'staccato': return '.'
    case 'accent': return '!accent!'
    case 'tenuto': return '!tenuto!'
    case 'marcato': return '!marcato!'
    // portato is the compound staccato-and-tenuto glyph; abcjs renders
    // the pair as the combined notation when both decorations attach
    // to the same notehead.
    case 'portato': return '.!tenuto!'
    default: return ''
  }
}

/**
 * Render every articulation attached to an event. Honors the
 * unification in articulations.ts: the array form (`event.articulations`)
 * takes precedence over the legacy singular field, and the array order
 * has already been normalized by withArticulation. Emitting in order
 * stacks the glyphs innermost (staccato) to outermost (marcato).
 */
function articulationsToAbc(event: Event): string {
  return getArticulations(event).map(articulationToAbc).join('')
}

function ornamentToAbc(orn?: Ornament): string {
  // Mapping to the abcjs `legalAccents` list (see
  // node_modules/abcjs/dist/abcjs-basic.js — `abc_parse_settings.js`).
  // Ornaments without a direct abcjs equivalent map to the nearest
  // visually-similar glyph:
  //   - schneller → pralltriller (same single-tooth glyph, naming varies)
  //   - delayed-turn → turn (delay-positioning is a render-time concern
  //     deferred to a later PR)
  //   - arpeggio-down / non-arpeggio → arpeggio (abcjs does not encode
  //     arrow direction or "do-not-roll" bracket; tracked for follow-up)
  switch (orn) {
    case 'trill': return 'T'
    case 'pralltriller': return '!pralltriller!'
    case 'mordent': return 'M'
    case 'upper-mordent': return '!uppermordent!'
    case 'lower-mordent': return '!lowermordent!'
    case 'schneller': return '!pralltriller!'
    case 'turn': return '!turn!'
    case 'inverted-turn': return '!invertedturn!'
    case 'delayed-turn': return '!turn!'
    case 'slide': return '!slide!'
    case 'arpeggio-up': return '!arpeggio!'
    case 'arpeggio-down': return '!arpeggio!'
    case 'non-arpeggio': return ''
    case 'grace': return '{c}'
    default: return ''
  }
}

/**
 * Render one grace MOMENT as the inner text of an abcjs grace block.
 * Single pitch → bare ABC note (e.g. "c"); multiple pitches → chord
 * brackets (e.g. "[ace]"). Duration divisor: eighth is the ABC
 * default (no suffix); sixteenth = "/" (alias for /2); 32nd = "/4".
 */
function graceMomentToAbc(g: GraceNote): string {
  const pitchesText = g.pitches.map(pitchToAbc).join('')
  const wrapped = g.pitches.length > 1 ? `[${pitchesText}]` : pitchesText
  let divisor = ''
  if (g.duration === 'sixteenth') divisor = '/'
  else if (g.duration === '32nd') divisor = '/4'
  return wrapped + divisor
}

/**
 * Render the structured graceNotes array as an abcjs grace prefix.
 *
 * abcjs grace syntax:
 *   {c}        — default eighth grace before main
 *   {abc}      — beamed grace run (each note is one moment)
 *   {[ace]}    — grace chord (one moment, multiple noteheads)
 *   {/c}       — slashed (acciaccatura)
 *
 * Limitations:
 *   - The slashed marker in ABC sits IMMEDIATELY after the opening
 *     `{` and applies as `.acciaccatura: true` to the LEADING grace
 *     only (verified against abcjs/src/parse/abc_parse_music.js
 *     letter_to_grace — subsequent `/` characters inside the block
 *     are consumed as duration divisors for the prior note, not as
 *     leading-slash markers for the next). When the leading grace
 *     is slashed, the leading `/` is emitted. For mixed slashed/
 *     unslashed runs the trailing graces' slashed flag is silently
 *     dropped from the visual output — a true per-grace slashed
 *     within one beamed group is not representable in ABC.
 *   - After-grace (nachschlag) is not supported; schema only allows
 *     before-graces in Phase 1.
 */
function graceNotesToAbc(graceNotes?: GraceNote[]): string {
  if (!graceNotes || graceNotes.length === 0) return ''
  // Only the LEADING grace's slashed flag projects through ABC. The
  // schema admits per-grace slashed; in the beamed-mixed case the
  // back end loses fidelity. Editors that want full fidelity must
  // emit space-separated graces (which breaks the beam) — a trade-
  // off we accept for the common (uniform) case.
  const leadingSlashed = graceNotes[0]?.slashed === true
  const inner = graceNotes.map(graceMomentToAbc).join('')
  return `{${leadingSlashed ? '/' : ''}${inner}}`
}

function dynamicToAbc(dyn?: Dynamic): string {
  if (!dyn || dyn === 'none') return ''
  return `!${dyn}!`
}

/**
 * Map a BarlineSchema kind to its abcjs token (M16-PR-2). Verified
 * against node_modules/abcjs/src/parse/abc_tokenizer.js:160-237
 * (getBarLine):
 *   thin           → `|`     (default; pre-M16 emitted this
 *                              unconditionally)
 *   double         → `||`    (bar_thin_thin)
 *   final          → `|]`    (bar_thin_thick)
 *   repeat-start   → `|:`    (bar_left_repeat)
 *   repeat-end     → `:|`    (bar_right_repeat)
 *   repeat-both    → `::`    (bar_dbl_repeat — the canonical
 *                              2-char form. Tokenizer line 178
 *                              matches `::` as a single token.
 *                              The seemingly-natural 3-char `:|:`
 *                              would be wrongly parsed as bar_
 *                              right_repeat + orphan `:` because
 *                              the `:|` branch at line 198 returns
 *                              after 2 chars on any non-]/|
 *                              following char.)
 *   invisible      → `[|]`   (bar_invisible)
 *   dashed         → `|`     (abcjs has no dashed barline token;
 *                              data round-trips through save/load
 *                              but renders as thin. Documented
 *                              limitation; would need an SVG post-
 *                              processing pass to draw dashed.)
 *
 * Caller is responsible for emitting `|` for an UNDEFINED barline
 * (the pre-M16 default behavior) — this helper assumes the input
 * is a defined Barline kind, not "no barline".
 */
function barlineToAbc(kind: Score['measures'][number]['endBarline']): string {
  switch (kind) {
    case 'thin': return '|'
    case 'double': return '||'
    case 'final': return '|]'
    case 'repeat-start': return '|:'
    case 'repeat-end': return ':|'
    case 'repeat-both': return '::'
    case 'invisible': return '[|]'
    case 'dashed': return '|'  // abcjs has no dashed-barline token
    case undefined: return '|'
    default: {
      // Exhaustiveness check — TS errors if a new BarlineSchema
      // value lands without a renderer case.
      const _exhaustive: never = kind
      void _exhaustive
      return '|'
    }
  }
}

/**
 * Build a per-measure volta-opener map (M17-PR-2). Keyed by
 * measureIdx (the first measure of the volta range), value is the
 * abcjs ending-list string (e.g. "1", "2", "1,2", "1-3").
 *
 * abcjs volta syntax (verified against
 * `node_modules/abcjs/src/parse/abc_parse_music.js:864-886`):
 *
 *   - The ending opener is a digit-list immediately following a
 *     barline. abcjs accepts an optional leading `[` (line 872).
 *     We emit WITHOUT the `[` to keep token length minimal —
 *     `|1` is valid and identical visually to `|[1`.
 *
 *   - The digit-list may use commas (`1,2,4`) or dashes for
 *     ranges (`1-3`). We emit a comma-separated list since the
 *     score model carries an explicit `number[]` (no inferred
 *     ranges; user expresses runs as `[1,2,3]` not `[1,3]`).
 *
 *   - The volta CLOSES automatically when abcjs encounters the
 *     next non-thin barline (line 269: `if (multilineVars.inEnding
 *     && bar.type !== 'bar_thin')`). For a multi-bar volta the
 *     intermediate barlines stay thin; only the closing barline of
 *     the volta's endMeasureIdx needs to be non-thin (typically a
 *     `:|` repeat-end or `||` double). Users set endBarline
 *     explicitly via setEndBarline (M16) for proper closing.
 *
 *   - When two voltas share an endpoint (back-to-back endings on
 *     the same passage), each gets its own opener at its
 *     startMeasureIdx; the previous volta's closing barline
 *     simultaneously closes one and (implicitly) opens the next.
 *
 * Voltas whose startMeasureIdx is out of range are silently
 * dropped (validateCrossRefs catches data integrity issues
 * upstream).
 */
function buildVoltaOpenersByMeasure(score: Score): Map<number, string> {
  const out = new Map<number, string>()
  const voltas = score.voltas
  if (!voltas || voltas.length === 0) return out
  for (const v of voltas) {
    if (v.startMeasureIdx < 0 || v.startMeasureIdx >= score.measures.length) continue
    // Build the digit-list. The schema enforces 1..9 per ending +
    // no duplicates, so a simple join works without further escape.
    // When multiple voltas share a startMeasureIdx (rare; user
    // intent unclear), concatenate with commas — abcjs parses any
    // comma-separated digit list as one opener.
    const digits = v.endings.join(',')
    const existing = out.get(v.startMeasureIdx)
    out.set(v.startMeasureIdx, existing === undefined ? digits : `${existing},${digits}`)
  }
  return out
}

/**
 * Render the per-event chord symbol as an abcjs chord-symbol prefix.
 * abcjs syntax distinguishes:
 *   `"Cmaj7"`   (bare quoted text) — chord symbol; renders above the
 *               staff in the chord-symbol font (sans-serif bold by
 *               default; can be styled via %%gchordfont)
 *   `"^text"`   — generic above-staff annotation (italic Helvetica
 *               via the M3-PR-3 %%annotationfont directive)
 *   `"_text"`   — generic below-staff annotation
 *
 * Bare quoted text routes through abcjs's chord-symbol-specific
 * layout (different vertical positioning + font) — distinct from the
 * generic annotation channel used for rehearsal marks / tempo text /
 * etc.
 *
 * Escape rules mirror escapeAnnotationText (strip raw backslashes;
 * escape literal "; collapse newlines) since the underlying token
 * delimiter is the same.
 */
function chordSymbolToAbc(event: Event): string {
  if (!event.chordSymbol) return ''
  const formatted = formatChordSymbol(event.chordSymbol)
  const safe = formatted
    .replace(/\\/g, '')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]+/g, ' ')
  return `"${safe}"`
}

/**
 * Map our 5-form Fermata enum to abcjs's single `!fermata!` decoration.
 * The duration distinction (very-short / short / standard / long /
 * very-long) is preserved in the score JSON for downstream use; a
 * follow-up PR adds the custom-glyph render path so the variants paint
 * visually distinct.
 */
function fermataToAbc(f: Event['fermata']): string {
  return f ? '!fermata!' : ''
}

function bowingToAbc(b: Event['bowing']): string {
  switch (b) {
    case 'up': return '!upbow!'
    case 'down': return '!downbow!'
    default: return ''
  }
}

function breathMarkToAbc(b: Event['breathMark']): string {
  return b ? '!breath!' : ''
}

/**
 * Caesura ("railroad tracks") maps to abcjs's mediumphrase decoration
 * — the visually closest match. shortphrase is a single tick (too
 * light) and longphrase is the heaviest variant. mediumphrase reads
 * as the standard caesura glyph in rendered output.
 */
function caesuraToAbc(c: Event['caesura']): string {
  return c ? '!mediumphrase!' : ''
}

/**
 * Single-note tremolo as a decoration. abcjs's `legalAccents` registers
 * `/`, `//`, `///`, `////` as decoration tokens that MUST be wrapped
 * in `!...!` — bare slashes after a note are parsed by `getFraction`
 * as duration divisors (`C2//` = 64th, not a quarter with tremolo), so
 * the visual effect would silently disappear and the duration would be
 * wrong. The schema allows up to 5 slashes; abcjs caps at 4, so clamp.
 * The measured / unmeasured distinction is not representable in ABC;
 * both render identically and a follow-up PR adds the differentiation.
 */
function tremoloToAbc(tremolo: Event['tremolo']): string {
  if (!tremolo) return ''
  const n = Math.min(tremolo.slashes, 4)
  return `!${'/'.repeat(n)}!`
}

/**
 * Render the decoration glyphs that "live between the previous note
 * and this note": breath mark + caesura. These fields are stored on
 * the PREVIOUS event (semantics: "after this note") but ABC parses
 * them as PREFIX decorations on the FOLLOWING note (the glyph paints
 * in the gap before the next note's notehead), so the emit pipeline
 * pre-prepends them onto event N from event N-1's data. See the
 * `pendingPrefix` thread through `emitMeasureWithRanges` /
 * `emitVoiceBody` for the carry-forward.
 *
 * Source-map note: the breath/caesura chars become part of the
 * FOLLOWING event's range. Click resolution on the glyph therefore
 * resolves to event N, even though the data lives on event N-1. UI
 * code that handles "click breath glyph → toggle field" must subtract
 * one from the resolved event index. Tracked in the M2-PR-5 UI work.
 */
function trailingPrefixFromEvent(event: Event): string {
  return breathMarkToAbc(event.breathMark) + caesuraToAbc(event.caesura)
}

/**
 * Render one per-pitch fingering entry as the ABC fragment that paints
 * its glyphs above the staff. Returns "" for null slots (the "skip
 * this pitch" sentinel introduced in M5-PR-1).
 *
 * Encoding choices per family:
 * - Digit-bearing systems (piano / string / guitar-lh / organ) use the
 *   abcjs built-in fingering decorations `!0!`–`!5!`, which paint as
 *   small italic digits above the note in the standard fingering glyph.
 * - Letter-bearing guitar-rh uses a `"^p"`-style above-staff annotation
 *   (italic via the `%%annotationfont` directive in the headers).
 * - Per-system extras attach as additional `"^..."` annotations beside
 *   the digit: string `stringRoman` ("III"), guitar-lh `stringNum`
 *   (in parens), guitar-lh `fret` Roman, organ `foot` (∪ heel / ∧ toe)
 *   and `thumbDirection` (parenthesis glyph).
 *
 * For chord stacks the per-pitch chunks concatenate without per-pitch
 * targeting in ABC: abcjs's stackedDecoration routes the digits as a
 * single vertical column above the topmost note of the chord, NOT one
 * digit per pitch as conventional engraving (Gould, Behind Bars
 * pp. 122–124) would prefer. Per-note vertical alignment is a known
 * abcjs limitation tracked as a follow-up engraving-quality PR; the
 * score JSON remains the source of truth for downstream tools, and
 * click-back-to-source resolves correctly because pitch source ranges
 * still live inside the `[...]` chord brackets.
 */
function fingeringChunkToAbc(f: Fingering | null): string {
  if (f === null) return ''
  switch (f.system) {
    case 'piano': {
      const decoration = `!${f.value}!`
      const sub = f.substitution !== undefined && f.substitution !== ''
        ? `"^${f.substitution}"`
        : ''
      return decoration + sub
    }
    case 'string': {
      const decoration = `!${f.finger}!`
      const roman = f.stringRoman !== undefined ? `"^${f.stringRoman}"` : ''
      return decoration + roman
    }
    case 'guitar-lh': {
      const decoration = `!${f.value}!`
      const stringNum = f.stringNum !== undefined ? `"^(${f.stringNum})"` : ''
      const fret = f.fret !== undefined ? `"^${f.fret}"` : ''
      return decoration + stringNum + fret
    }
    case 'guitar-rh':
      return `"^${f.value}"`
    case 'organ': {
      const decoration = `!${f.value}!`
      const foot = f.foot === 'heel' ? '"^∪"' : f.foot === 'toe' ? '"^∧"' : ''
      const thumb = f.thumbDirection !== undefined ? `"^${f.thumbDirection}"` : ''
      return decoration + foot + thumb
    }
  }
}

function fingeringsToAbc(event: Event): string {
  if (!event.fingerings || event.fingerings.length === 0) return ''
  return event.fingerings.map(fingeringChunkToAbc).join('')
}

/**
 * Conventional notation labels for each performance-technique kind.
 * Painted as italic text above the staff via ABC's "^..." annotation
 * syntax — abcjs interprets the `^` prefix inside a quoted string as
 * "place this text above the staff". The italic styling comes from
 * the `%%annotationfont` directive emitted in the score header (see
 * the `headers` array in scoreToAbcWithMap); abcjs's default
 * annotationfont is upright Helvetica, which would render the
 * markers in Roman and miss the publisher convention.
 *
 * Abbreviations match standard publisher practice (Sibelius / Dorico
 * defaults): "pizz." not "pizzicato"; "sul pont." not "sul ponticello";
 * "con sord." for mute-on, "senza sord." for mute-off.
 */
const TECHNIQUE_TEXT: Record<TechniqueKind, string> = {
  pizz: 'pizz.',
  arco: 'arco',
  'col-legno-battuto': 'col legno batt.',
  'col-legno-tratto': 'col legno tr.',
  'sul-ponticello': 'sul pont.',
  'sul-tasto': 'sul tasto',
  flautando: 'flaut.',
  ord: 'ord.',
  'snap-pizz': 'snap pizz.',
  'LH-pizz': 'L.H. pizz.',
  tremolo: 'trem.',
  'mute-on': 'con sord.',
  'mute-off': 'senza sord.',
}

/**
 * Build a lookup of technique-annotation prefix strings keyed by the
 * event they attach to. Each TechniqueChange targets
 * (staffIdx, voiceIdx, measureIdx, eventIdx ?? 0) and produces a
 * `"^pizz."` style annotation that ABCJS paints above the staff at
 * the start of the targeted note. Out-of-range markers (eventIdx past
 * the measure end, missing measure) would silently disappear at this
 * level; `validateTechniqueStates` in validateCrossRefs catches such
 * inconsistencies before the renderer ever sees them.
 *
 * Multiple changes at the same event concatenate in the order they
 * appear in score.techniqueStates; the input order is intentionally
 * preserved so deterministic editor sequences stay readable.
 */
function buildTechniqueAnnotationMap(score: Score): Map<string, string> {
  const out = new Map<string, string>()
  const states = score.techniqueStates
  if (!states || states.length === 0) return out
  for (const t of states) {
    const evIdx = t.eventIdx ?? 0
    const key = `${t.staffIdx}:${t.voiceIdx}:${t.measureIdx}:${evIdx}`
    const annotation = `"^${TECHNIQUE_TEXT[t.kind]}"`
    const prior = out.get(key)
    out.set(key, prior ? prior + annotation : annotation)
  }
  return out
}

function techniqueAnnotationAt(
  techniqueAnnotations: Map<string, string>,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
): string {
  return techniqueAnnotations.get(`${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`) ?? ''
}

/**
 * Map an Annotation position to the abcjs annotation prefix char:
 *   above → "^"   below → "_"   left → "<"   right → ">"
 */
function annotationPositionChar(p: Annotation['target']['position']): string {
  switch (p) {
    case 'above': return '^'
    case 'below': return '_'
    case 'left':  return '<'
    case 'right': return '>'
  }
}

/**
 * Escape characters that would corrupt the abcjs annotation token.
 * Annotations are wrapped in double-quotes: a literal `"` inside the
 * text would close the token early, so we escape to `\"`.
 *
 * Backslashes are STRIPPED rather than doubled — abcjs's chord-symbol
 * tokenizer (`abc_tokenizer.js`'s substInChord) has no `\\` → `\`
 * decode, only `\"` → `"` and `\n` → newline. A literal `\\` in the
 * source keeps the parser's escape state on, swallowing the closing
 * quote and producing "Missing closing quote" warnings + garbled
 * rendering. Backslashes in annotation text are vanishingly rare
 * (users type rehearsal letters, tempo words, expression marks — no
 * Unix paths), so the strip is a safe, predictable choice.
 *
 * Newlines / carriage returns / tabs collapse to a single space —
 * annotations are single-line in abcjs.
 */
function escapeAnnotationText(text: string): string {
  return text
    .replace(/\\/g, '')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]+/g, ' ')
}

/**
 * Build a lookup of annotation prefix strings keyed by the event they
 * attach to. Each Annotation targets (measureIdx, eventIdx ?? 0) on
 * the PRIMARY staff/voice (staff 0, voice 0) — annotations are score-
 * level, not per-voice; the primary anchor is where abcjs paints them.
 *
 * Style differentiation (boxed rehearsal marks, bold tempo text, etc.)
 * is deferred — for now all styles render as italic Helvetica via the
 * global %%annotationfont directive. The data round-trips and a future
 * PR adds per-style fonts via %%setfont-1 / "^$1text$0" machinery.
 *
 * spanEnd is also deferred — abcjs has no generic "dashed line under
 * arbitrary text" syntax (hairpins are the closest equivalent for
 * dynamics but not for verbal instructions like "rit. ____"). The
 * leading annotation renders; the spanEnd persists in the score JSON
 * for a future render-quality follow-up.
 *
 * Multiple annotations at the same event concatenate in input order
 * so deterministic editor sequences read predictably.
 */
function buildAnnotationMap(score: Score): Map<string, string> {
  const out = new Map<string, string>()
  const annotations = score.annotations
  if (!annotations || annotations.length === 0) return out
  for (const a of annotations) {
    const evIdx = a.target.eventIdx ?? 0
    // Annotations are score-level; anchor to staff 0, voice 0 — the
    // primary line is where abcjs's per-voice rendering will surface
    // them. extraVoices and secondStaff inherit visually via abcjs's
    // alignment; they don't get their own copy.
    const key = `0:0:${a.target.measureIdx}:${evIdx}`
    const posChar = annotationPositionChar(a.target.position)
    const safeText = escapeAnnotationText(a.text)
    const token = `"${posChar}${safeText}"`
    const prior = out.get(key)
    out.set(key, prior ? prior + token : token)
  }
  return out
}

function annotationAt(
  annotations: Map<string, string>,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
): string {
  return annotations.get(`${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`) ?? ''
}

/**
 * Pre-allocated empty map for the non-primary voices that don't
 * receive annotations. Same-reference comparisons elsewhere read this
 * as "no annotations to render" without allocating per voice.
 */
const EMPTY_ANNOTATION_MAP: Map<string, string> = new Map()

/**
 * abcjs decoration tokens for hairpin endpoints. The wedge opens at the
 * start event and closes at the end event; the matching open/close
 * tokens cross-reference each other in the parser's spanning
 * resolution. crescendo = `!<(!` … `!<)!`; diminuendo = `!>(!` … `!>)!`.
 */
const HAIRPIN_DECORATION: Record<
  'hairpin-cresc' | 'hairpin-dim',
  { start: string; end: string }
> = {
  'hairpin-cresc': { start: '!<(!', end: '!<)!' },
  'hairpin-dim': { start: '!>(!', end: '!>)!' },
}

/**
 * Resolve the abcjs annotation-prefix character (`^` above, `_` below)
 * from a `span.placement` value plus a kind-dependent default. Used by
 * every span renderer that emits text annotations: tempo spans
 * (M14-PR-2 + the M14 placement follow-up), octave spans (M20-PR-2),
 * tremolo-between (M20-PR-2). Centralizes the "default-enum-value"
 * trap fix: the naive `placement ?? defaultPos` only catches undefined
 * and null, but SpanSchema.placement also has the explicit `'default'`
 * string literal meaning "let the engraver decide" (types.ts:720),
 * which must fall through to the kind-based default rather than route
 * above by accident.
 */
function spanPositionChar(
  placement: 'above' | 'below' | 'default' | undefined,
  defaultPos: 'above' | 'below',
): '^' | '_' {
  const resolved =
    placement === undefined || placement === 'default' ? defaultPos : placement
  return resolved === 'below' ? '_' : '^'
}

/**
 * Build a per-event decoration map for hairpin spans (M11-PR-4).
 * Returns a Map<eventKey, prefix-string> keyed by
 * `${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`. The string is
 * inserted into the event's decoration prefix chain (see
 * emitEventWithRange) so abcjs sees the hairpin open/close tokens
 * positioned at the right notes.
 *
 * For each hairpin in score.spans (filtered via isHairpin):
 *  - At the start event: terminal startDynamic glyph (if set, and not
 *    duplicated by the event's own `dynamic` field) + open token
 *    `!<(!` / `!>(!`.
 *  - At the end event: close token `!<)!` / `!>)!` + terminal
 *    endDynamic glyph (when set and not duplicated by event.dynamic).
 *
 * Dedupe: when the event already carries a `dynamic` (or
 * `dynamic_structured.base`) that matches the hairpin's terminal
 * dynamic, the hairpin's glyph is suppressed — emitEventWithRange
 * will emit the event-level dynamic glyph downstream, so emitting the
 * hairpin's terminal too would produce two stacked `!p!` glyphs.
 *
 * Ordering: same event can carry multiple hairpin endpoints (one
 * ending here + another starting). To produce stable output
 * regardless of score.spans array order, run TWO passes — first
 * append all close-glyphs, then all open-glyphs. This puts every
 * `crescendo)` BEFORE every `crescendo(` at a boundary note, which
 * matches abcjs's expectation that the close-glyph terminates the
 * pending wedge before a new one begins.
 *
 * Spans with unresolvable endpoint ids (data-integrity issue, should
 * have been caught by validateCrossRefs) are silently skipped — the
 * renderer is the wrong place to error.
 */
function buildHairpinDecorationMap(score: Score): Map<string, string> {
  const out = new Map<string, string>()
  const spans = score.spans
  if (!spans || spans.length === 0) return out

  // Build eventId → location lookup once for O(spans + events) time
  // instead of O(spans × events) by repeated walks.
  const idIndex = indexEventIdsForRender(score)

  type ResolvedHairpin = {
    span: Span & { kind: 'hairpin-cresc' | 'hairpin-dim' }
    startLoc: { staffIdx: number; voiceIdx: number; measureIdx: number; eventIdx: number }
    endLoc: { staffIdx: number; voiceIdx: number; measureIdx: number; eventIdx: number }
    startEvent: Event
    endEvent: Event
  }
  const resolved: ResolvedHairpin[] = []
  for (const span of spans) {
    if (!isHairpin(span)) continue
    const startLoc = idIndex.get(span.startEventId)
    const endLoc = idIndex.get(span.endEventId)
    if (!startLoc || !endLoc) continue
    const startEvent = getVoiceMeasures(score, startLoc.staffIdx, startLoc.voiceIdx)[startLoc.measureIdx]?.events[startLoc.eventIdx]
    const endEvent = getVoiceMeasures(score, endLoc.staffIdx, endLoc.voiceIdx)[endLoc.measureIdx]?.events[endLoc.eventIdx]
    if (!startEvent || !endEvent) continue
    resolved.push({ span, startLoc, endLoc, startEvent, endEvent })
  }

  // Pass 1: close-glyphs (and terminal endDynamic if not duplicated).
  for (const r of resolved) {
    const tokens = HAIRPIN_DECORATION[r.span.kind]
    const endDynDup =
      r.span.endDynamic !== undefined && getDynamicBase(r.endEvent) === r.span.endDynamic
    const endGlyph =
      tokens.end +
      (r.span.endDynamic !== undefined && !endDynDup ? dynamicToAbc(r.span.endDynamic) : '')
    const endKey = `${r.endLoc.staffIdx}:${r.endLoc.voiceIdx}:${r.endLoc.measureIdx}:${r.endLoc.eventIdx}`
    out.set(endKey, (out.get(endKey) ?? '') + endGlyph)
  }
  // Pass 2: open-glyphs (with terminal startDynamic when not duplicated).
  for (const r of resolved) {
    const tokens = HAIRPIN_DECORATION[r.span.kind]
    const startDynDup =
      r.span.startDynamic !== undefined && getDynamicBase(r.startEvent) === r.span.startDynamic
    const startGlyph =
      (r.span.startDynamic !== undefined && !startDynDup ? dynamicToAbc(r.span.startDynamic) : '') +
      tokens.start
    const startKey = `${r.startLoc.staffIdx}:${r.startLoc.voiceIdx}:${r.startLoc.measureIdx}:${r.startLoc.eventIdx}`
    out.set(startKey, (out.get(startKey) ?? '') + startGlyph)
  }
  return out
}

function hairpinAt(
  map: Map<string, string>,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
): string {
  return map.get(`${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`) ?? ''
}

/**
 * Per-event slur paren accumulator (M12-PR-3). `open` is appended at
 * the END of the decoration prefix chain (closest to the pitch) so
 * the abcjs parser sees `(C2` as open-slur + core-note. `close` is
 * appended after the duration + tie so abcjs sees `D2)` as core-note
 * + close-slur.
 */
type SlurParens = { open: string; close: string }

/**
 * Build a per-event slur-paren map. For each slur span:
 *  - At the start event: append `(` to `open`.
 *  - At the end event: append `)` to `close`.
 *
 * Same two-pass build as hairpins: collect closes first, then opens,
 * so a single event that is both the END of one slur and the START
 * of another renders as `)(` (close before open). Multiple slurs on
 * the same endpoint accumulate (e.g. nested slurs of different
 * lengths produce `((` and `))`).
 *
 * `phrase-slur` and `slur` both emit the same paren tokens in this PR;
 * a future PR can differentiate them via abcjs styling (e.g. dashed
 * for phrase) once the renderer-side support is settled.
 *
 * Spans with unresolvable endpoint ids (validateCrossRefs should
 * have caught this earlier) are silently skipped.
 */
function buildSlurParenMap(score: Score): Map<string, SlurParens> {
  const out = new Map<string, SlurParens>()
  const spans = score.spans
  if (!spans || spans.length === 0) return out
  const idIndex = indexEventIdsForRender(score)

  type Resolved = {
    startKey: string
    endKey: string
  }
  const resolved: Resolved[] = []
  for (const span of spans) {
    if (!isSlur(span)) continue
    const startLoc = idIndex.get(span.startEventId)
    const endLoc = idIndex.get(span.endEventId)
    if (!startLoc || !endLoc) continue
    resolved.push({
      startKey: `${startLoc.staffIdx}:${startLoc.voiceIdx}:${startLoc.measureIdx}:${startLoc.eventIdx}`,
      endKey: `${endLoc.staffIdx}:${endLoc.voiceIdx}:${endLoc.measureIdx}:${endLoc.eventIdx}`,
    })
  }
  // Pass 1: closes.
  for (const r of resolved) {
    const cur = out.get(r.endKey) ?? { open: '', close: '' }
    out.set(r.endKey, { ...cur, close: cur.close + ')' })
  }
  // Pass 2: opens.
  for (const r of resolved) {
    const cur = out.get(r.startKey) ?? { open: '', close: '' }
    out.set(r.startKey, { ...cur, open: cur.open + '(' })
  }
  return out
}

/**
 * Pre-allocated empty-slur value returned by `slurParensAt` on a
 * lookup miss. Frozen so an accidental mutation (e.g. a future caller
 * writing `slurs.open += '('`) throws instead of silently corrupting
 * the shared empty for the rest of the render. Matches the doc-comment
 * pattern on EMPTY_ANNOTATION_MAP / EMPTY_MARKER_MAP elsewhere in
 * this module.
 */
const EMPTY_SLUR_PARENS: SlurParens = Object.freeze({ open: '', close: '' })

function slurParensAt(
  map: Map<string, SlurParens>,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
): SlurParens {
  return map.get(`${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`) ?? EMPTY_SLUR_PARENS
}

/**
 * Build a per-event tempo-span annotation map (M14-PR-2). For each
 * tempo span (kind: 'accel' | 'rit'):
 *
 *   - At the start event: prepend the kind label as an italic
 *     annotation. Examples: `"^accel."` / `"^rit."` (above) or
 *     `"_accel."` / `"_rit."` (below) — the prefix char is orthogonal
 *     to the kind. Selected by `span.placement`:
 *       - 'above' → `^`
 *       - 'below' → `_`
 *       - 'default' or undefined → `^` (tempo convention is above)
 *   - At the end event: append the optional terminal label
 *     (endTempoText, endTempoBpm, or both) so the rendered output
 *     paints the target tempo. Examples (above placement):
 *       - endTempoBpm:144 only           → `"^♩=144"`
 *       - endTempoText:'a tempo' only    → `"^a tempo"`
 *       - both                           → `"^a tempo (♩=144)"`
 *     Below placement swaps `^` for `_` on the same labels.
 *
 * Same two-pass build as hairpins / slurs (collect ends first, then
 * starts) so multiple tempo spans whose start/end coincide render in
 * a stable order. Spans with unresolvable endpoints (data integrity
 * issue) are silently skipped.
 *
 * Renderer wire-up status: the LABEL text renders today; the dashed-
 * line continuation between start and end is deferred — abcjs has no
 * native vocabulary for "dashed line under italic text" spanning a
 * range of notes. The text labels alone are publisher-grade for the
 * common case (the dashed line is a visual cue, the labels carry the
 * semantic content). Future PR may add an SVG post-processing pass.
 */
function buildTempoSpanAnnotationMap(score: Score): Map<string, string> {
  const out = new Map<string, string>()
  const spans = score.spans
  if (!spans || spans.length === 0) return out
  const idIndex = indexEventIdsForRender(score)

  type Resolved = {
    span: Span & { kind: 'accel' | 'rit' }
    startKey: string
    endKey: string
    positionChar: '^' | '_'
  }
  const resolved: Resolved[] = []
  for (const span of spans) {
    if (!isTempoSpan(span)) continue
    const startLoc = idIndex.get(span.startEventId)
    const endLoc = idIndex.get(span.endEventId)
    if (!startLoc || !endLoc) continue
    // Tempo convention is above-staff; spanPositionChar resolves the
    // 'default' enum-value + undefined cases against that default.
    const positionChar = spanPositionChar(span.placement, 'above')
    resolved.push({
      span,
      startKey: `${startLoc.staffIdx}:${startLoc.voiceIdx}:${startLoc.measureIdx}:${startLoc.eventIdx}`,
      endKey: `${endLoc.staffIdx}:${endLoc.voiceIdx}:${endLoc.measureIdx}:${endLoc.eventIdx}`,
      positionChar,
    })
  }

  // Pass 1: end labels. Skip when neither endTempoText nor
  // endTempoBpm is set — a bare tempo line without a terminal label
  // is valid and common ("accel." with no target is a hint to "speed
  // up indefinitely"; the player decides the new pulse).
  for (const r of resolved) {
    const text = formatEndTempoLabel(r.span.endTempoText, r.span.endTempoBpm)
    if (text === '') continue
    const glyph = `"${r.positionChar}${escapeAnnotationText(text)}"`
    out.set(r.endKey, (out.get(r.endKey) ?? '') + glyph)
  }
  // Pass 2: start labels. Always emitted (the kind label is the
  // span's primary visual content).
  for (const r of resolved) {
    const label = r.span.kind === 'accel' ? 'accel.' : 'rit.'
    const glyph = `"${r.positionChar}${escapeAnnotationText(label)}"`
    out.set(r.startKey, (out.get(r.startKey) ?? '') + glyph)
  }
  return out
}

/**
 * Format the terminal-tempo label for a tempo span's end event.
 * Returns the empty string when neither field is set (caller skips
 * emission). Combination rules:
 *
 *   - Both:                        "a tempo (♩=144)"
 *   - endTempoText only:           "a tempo"
 *   - endTempoBpm only:            "♩=60"
 *
 * The ♩ glyph matches the M9-PR-3 metric-modulation convention.
 */
function formatEndTempoLabel(text: string | undefined, bpm: number | undefined): string {
  if (text && bpm !== undefined) return `${text} (♩=${bpm})`
  if (text) return text
  if (bpm !== undefined) return `♩=${bpm}`
  return ''
}

function tempoSpanAnnotationAt(
  map: Map<string, string>,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
): string {
  return map.get(`${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`) ?? ''
}

/**
 * Build a per-event octave-span annotation map (M20-PR-2). abcjs has no
 * native vocabulary for 8va/8vb/15ma/15mb ottava lines, so the
 * renderer emits italic above/below-staff annotations at the start
 * event: \`"^8va"\`, \`"_8vb"\`, etc. The dashed continuation line
 * (the visual cue that follows the abbreviation across N notes) is
 * deferred to an SVG post-processing pass.
 *
 * Default placement: 8va/15ma above (octave-up notation sits above the
 * staff), 8vb/15mb below. The annotation prefix char is the abcjs
 * `^` (above) or `_` (below) token; both render in the same italic
 * %%annotationfont as score-level annotations and tempo spans.
 *
 * Two-pass build (closes first, opens after) matches the hairpin /
 * slur / tempo precedent so the output is stable regardless of
 * score.spans array order. Spans with unresolvable endpoints are
 * silently skipped (validateCrossRefs is the right place to error).
 */
function buildOctaveSpanAnnotationMap(score: Score): Map<string, string> {
  const out = new Map<string, string>()
  const spans = score.spans
  if (!spans || spans.length === 0) return out
  const idIndex = indexEventIdsForRender(score)

  type Resolved = {
    span: Span & { kind: '8va' | '8vb' | '15ma' | '15mb' }
    startKey: string
    endKey: string
  }
  const resolved: Resolved[] = []
  for (const span of spans) {
    if (!isOctaveSpan(span)) continue
    const startLoc = idIndex.get(span.startEventId)
    const endLoc = idIndex.get(span.endEventId)
    if (!startLoc || !endLoc) continue
    resolved.push({
      span,
      startKey: `${startLoc.staffIdx}:${startLoc.voiceIdx}:${startLoc.measureIdx}:${startLoc.eventIdx}`,
      endKey: `${endLoc.staffIdx}:${endLoc.voiceIdx}:${endLoc.measureIdx}:${endLoc.eventIdx}`,
    })
  }
  // End-label emission is deferred — the dashed continuation line
  // (visual cue under the abbreviation) is an SVG post-pass concern
  // for a future PR. Kind label sits on the START event only.
  for (const r of resolved) {
    // Kind-based default: 8va/15ma sit ABOVE the staff, 8vb/15mb
    // BELOW. spanPositionChar handles the 'default' enum-value +
    // undefined fall-through against this kind-based default.
    const defaultPos = r.span.kind === '8va' || r.span.kind === '15ma' ? 'above' : 'below'
    const positionChar = spanPositionChar(r.span.placement, defaultPos)
    const glyph = `"${positionChar}${escapeAnnotationText(r.span.kind)}"`
    out.set(r.startKey, (out.get(r.startKey) ?? '') + glyph)
  }
  return out
}

function octaveSpanAnnotationAt(
  map: Map<string, string>,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
): string {
  return map.get(`${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`) ?? ''
}

/**
 * Build a per-event glissando decoration map (M20-PR-2). Emits abcjs
 * native `!glissando(!` / `!glissando)!` tokens at the start/end
 * events — verified against
 * \`node_modules/abcjs/src/parse/abc_parse_settings.js:89-90\`.
 *
 * Optional `glissText: true` adds a `"^gliss."` annotation glyph at
 * the start event for the conventional text label; `glissStyle` is
 * persist-only today (abcjs has no public hook to differentiate
 * straight vs wavy glissando rendering; future PR may handle via
 * SVG post-processing).
 *
 * Two-pass build (closes first, opens after) for stable output
 * regardless of span array order.
 */
function buildGlissandoDecorationMap(score: Score): Map<string, string> {
  const out = new Map<string, string>()
  const spans = score.spans
  if (!spans || spans.length === 0) return out
  const idIndex = indexEventIdsForRender(score)

  type Resolved = {
    span: Span & { kind: 'glissando' }
    startKey: string
    endKey: string
  }
  const resolved: Resolved[] = []
  for (const span of spans) {
    if (!isGlissando(span)) continue
    const startLoc = idIndex.get(span.startEventId)
    const endLoc = idIndex.get(span.endEventId)
    if (!startLoc || !endLoc) continue
    resolved.push({
      span,
      startKey: `${startLoc.staffIdx}:${startLoc.voiceIdx}:${startLoc.measureIdx}:${startLoc.eventIdx}`,
      endKey: `${endLoc.staffIdx}:${endLoc.voiceIdx}:${endLoc.measureIdx}:${endLoc.eventIdx}`,
    })
  }
  // Pass 1: closes.
  for (const r of resolved) {
    out.set(r.endKey, (out.get(r.endKey) ?? '') + '!glissando)!')
  }
  // Pass 2: opens.
  for (const r of resolved) {
    const textGlyph = r.span.glissText ? `"^${escapeAnnotationText('gliss.')}"` : ''
    out.set(r.startKey, (out.get(r.startKey) ?? '') + textGlyph + '!glissando(!')
  }
  return out
}

function glissandoDecorationAt(
  map: Map<string, string>,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
): string {
  return map.get(`${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`) ?? ''
}

/**
 * Build a per-event trill-line decoration map (M20-PR-2). Emits abcjs
 * native `!trill(!` / `!trill)!` tokens — verified against
 * \`node_modules/abcjs/src/parse/abc_parse_settings.js:51-52\`. These
 * draw a wavy continuation line ("tr~~~~") extending from a trill
 * ornament across the span's range.
 *
 * Note: the trill ornament itself (the `tr` glyph) lives on
 * Event.ornament: 'trill' (M2-PR-3); this span is the EXTENSION line
 * only. Users who want trills should set the ornament + insert the
 * trill-line span together.
 */
function buildTrillLineDecorationMap(score: Score): Map<string, string> {
  const out = new Map<string, string>()
  const spans = score.spans
  if (!spans || spans.length === 0) return out
  const idIndex = indexEventIdsForRender(score)

  type Resolved = { startKey: string; endKey: string }
  const resolved: Resolved[] = []
  for (const span of spans) {
    if (!isTrillLine(span)) continue
    const startLoc = idIndex.get(span.startEventId)
    const endLoc = idIndex.get(span.endEventId)
    if (!startLoc || !endLoc) continue
    resolved.push({
      startKey: `${startLoc.staffIdx}:${startLoc.voiceIdx}:${startLoc.measureIdx}:${startLoc.eventIdx}`,
      endKey: `${endLoc.staffIdx}:${endLoc.voiceIdx}:${endLoc.measureIdx}:${endLoc.eventIdx}`,
    })
  }
  // Pass 1: closes.
  for (const r of resolved) {
    out.set(r.endKey, (out.get(r.endKey) ?? '') + '!trill)!')
  }
  // Pass 2: opens.
  for (const r of resolved) {
    out.set(r.startKey, (out.get(r.startKey) ?? '') + '!trill(!')
  }
  return out
}

function trillLineDecorationAt(
  map: Map<string, string>,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
): string {
  return map.get(`${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`) ?? ''
}

/**
 * Build a per-event tremolo-between annotation map (M20-PR-2). abcjs
 * has no native between-note tremolo vocabulary, so the renderer
 * emits a `"^trem."` annotation at the start event. The visual
 * paired-beam-and-slashes between the two notes is deferred to an
 * SVG post-processing pass (or an upstream abcjs feature, if one
 * lands).
 *
 * Distinct from Event.tremolo (M2-PR-1) which is the SINGLE-NOTE
 * repeated-tremolo (slashes through the stem); this span is the
 * BETWEEN-TWO-NOTES fingered tremolo (alternation pattern).
 */
function buildTremoloBetweenAnnotationMap(score: Score): Map<string, string> {
  const out = new Map<string, string>()
  const spans = score.spans
  if (!spans || spans.length === 0) return out
  const idIndex = indexEventIdsForRender(score)

  type Resolved = { startKey: string; positionChar: '^' | '_' }
  const resolved: Resolved[] = []
  for (const span of spans) {
    if (!isTremoloBetween(span)) continue
    const startLoc = idIndex.get(span.startEventId)
    const endLoc = idIndex.get(span.endEventId)
    if (!startLoc || !endLoc) continue
    // Tremolo-between convention is above-staff; spanPositionChar
    // resolves the 'default' enum-value + undefined cases.
    resolved.push({
      startKey: `${startLoc.staffIdx}:${startLoc.voiceIdx}:${startLoc.measureIdx}:${startLoc.eventIdx}`,
      positionChar: spanPositionChar(span.placement, 'above'),
    })
  }
  // Single-pass — annotation lives only on the start event.
  for (const r of resolved) {
    const glyph = `"${r.positionChar}${escapeAnnotationText('trem.')}"`
    out.set(r.startKey, (out.get(r.startKey) ?? '') + glyph)
  }
  return out
}

function tremoloBetweenAnnotationAt(
  map: Map<string, string>,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
): string {
  return map.get(`${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`) ?? ''
}

/**
 * Pre-allocated empty map for the non-primary voices that don't
 * receive jump-marker decorations. Same-reference comparison
 * elsewhere reads this as "no jump markers to render" without
 * allocating per voice. Matches EMPTY_ANNOTATION_MAP / EMPTY_VOLTA_*
 * idiom.
 */
const EMPTY_JUMP_MARKER_MAP: Map<string, string> = new Map()

/**
 * abcjs decoration tokens for jump markers + Segno/Coda landmarks
 * (M18-PR-2). Verified against
 * `node_modules/abcjs/src/parse/abc_parse_settings.js:29-65`:
 *
 *   - `!D.C.!` / `!D.S.!`                 — bare jump labels
 *   - `!D.C.alcoda!` / `!D.C.alfine!`     — D.C. + branch instruction
 *   - `!D.S.alcoda!` / `!D.S.alfine!`     — D.S. + branch instruction
 *   - `!fine!`                            — Fine landmark label
 *   - `!segno!` / `!coda!`                — Segno + Coda glyphs
 *
 * `To Coda` has no native abcjs decoration token. Emitted as a
 * generic italic annotation (`"^To Coda"`) so it still renders above
 * the staff at the correct measure; the abcjs renderer aligns it
 * with the bar boundary the same way it would a `!fine!`.
 *
 * The space-stripping (`D.C. al Coda` → `D.C.alcoda`) is required:
 * abcjs's legalAccents table uses the no-space form.
 */
const JUMP_KIND_TO_ABCJS_DECORATION: Record<JumpKind, string | null> = {
  'D.C.': '!D.C.!',
  'D.S.': '!D.S.!',
  'D.C. al Coda': '!D.C.alcoda!',
  'D.S. al Coda': '!D.S.alcoda!',
  'D.C. al Fine': '!D.C.alfine!',
  'D.S. al Fine': '!D.S.alfine!',
  'To Coda': null, // emitted as "^To Coda" annotation below
  Fine: '!fine!',
}

/**
 * Build a per-event decoration map for jump markers + Segno/Coda
 * landmarks (M18-PR-2). Returns a Map<eventKey, prefix-string> keyed
 * by `${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`. Each entry
 * holds the decoration token (`!D.C.!`) OR the generic annotation
 * (`"^To Coda"`) that should attach to that event.
 *
 * Anchoring rules (mirrors the JumpMarker.side enum):
 *   - side: 'start' → first event of the measure (eventIdx = 0)
 *   - side: 'end'   → last event of the measure (eventIdx = N - 1)
 *
 * abcjs decorations always attach to the NEXT note token, so the
 * prefix must sit before the pitch — emitEventWithRange threads
 * decoration prefixes through the same channel as annotations.
 *
 * Routing: jump markers + Segno + Coda render on the PRIMARY voice
 * only (staff 0, voice 0). abcjs draws the labels above the system
 * regardless of which voice carries them — surfacing them on every
 * voice would produce stacked duplicates. Same convention as voltas
 * (M17-PR-2) and score-level annotations.
 *
 * Markers with out-of-range measureIdx are silently dropped — the
 * renderer is the wrong place to error (validateCrossRefs catches
 * data integrity issues upstream).
 */
function buildJumpMarkerDecorationMap(score: Score): Map<string, string> {
  const out = new Map<string, string>()
  const jumpMarkers = score.jumpMarkers
  const segnoMarkers = score.segnoMarkers
  const codaMarkers = score.codaMarkers
  if (
    (!jumpMarkers || jumpMarkers.length === 0) &&
    (!segnoMarkers || segnoMarkers.length === 0) &&
    (!codaMarkers || codaMarkers.length === 0)
  ) {
    return out
  }
  const measureCount = score.measures.length
  const resolveEventIdx = (measureIdx: number, side: 'start' | 'end'): number => {
    if (side === 'start') return 0
    const m = score.measures[measureIdx]
    return Math.max(0, m.events.length - 1)
  }
  const append = (key: string, glyph: string): void => {
    const prior = out.get(key)
    out.set(key, prior ? prior + glyph : glyph)
  }

  // Stable within-pass ordering: sort each input by
  // (measureIdx, side, kind/id) so two markers at the same anchor
  // produce identical ABC regardless of the source array order. The
  // two-pass build (landmarks then instructions) handles cross-pass
  // ordering; this sort handles intra-pass ordering. Slicing first
  // keeps the helper non-mutating (the score is shared with other
  // renderers and the orchestrator).
  const sortedSegnos = (segnoMarkers ?? [])
    .slice()
    .sort((a, b) => a.measureIdx - b.measureIdx || a.side.localeCompare(b.side) || a.id.localeCompare(b.id))
  const sortedCodas = (codaMarkers ?? [])
    .slice()
    .sort((a, b) => a.measureIdx - b.measureIdx || a.side.localeCompare(b.side) || a.id.localeCompare(b.id))
  const sortedJumps = (jumpMarkers ?? [])
    .slice()
    .sort(
      (a, b) =>
        a.measureIdx - b.measureIdx ||
        a.side.localeCompare(b.side) ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
    )

  // Pass 1: landmarks (Segno, Coda). These come FIRST so a Coda
  // glyph paired with a "To Coda" annotation at the same event
  // (rare engraving — typically the Coda landmark sits at the JUMP
  // TARGET measure and the "To Coda" annotation sits at the JUMP
  // ORIGIN, on different measures) renders with the glyph to the
  // left of the text. Concat order controls the prefix sequence;
  // abcjs's parser accepts the merged prefix.
  for (const s of sortedSegnos) {
    if (s.measureIdx < 0 || s.measureIdx >= measureCount) continue
    const evIdx = resolveEventIdx(s.measureIdx, s.side)
    append(`0:0:${s.measureIdx}:${evIdx}`, '!segno!')
  }
  for (const c of sortedCodas) {
    if (c.measureIdx < 0 || c.measureIdx >= measureCount) continue
    const evIdx = resolveEventIdx(c.measureIdx, c.side)
    append(`0:0:${c.measureIdx}:${evIdx}`, '!coda!')
  }
  // Pass 2: jump-marker instructions. Decoration glyph for kinds
  // abcjs natively supports; italic annotation for "To Coda" (no
  // native token). Either way attaches to the resolved event. The
  // annotation text routes through escapeAnnotationText for parity
  // with the other annotation channels — even though the JumpKind
  // enum is fixed and currently safe, futureproofing keeps the
  // emission consistent with annotation / lyric / chord paths.
  for (const j of sortedJumps) {
    if (j.measureIdx < 0 || j.measureIdx >= measureCount) continue
    const evIdx = resolveEventIdx(j.measureIdx, j.side)
    const decoration = JUMP_KIND_TO_ABCJS_DECORATION[j.kind]
    const glyph = decoration ?? `"^${escapeAnnotationText(j.kind)}"`
    append(`0:0:${j.measureIdx}:${evIdx}`, glyph)
  }
  return out
}

function jumpMarkerDecorationAt(
  map: Map<string, string>,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
): string {
  return map.get(`${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`) ?? ''
}

/**
 * Render the lyric w: lines for one voice's measures (M15-PR-2).
 *
 * Returns an array of strings — one entry per active verse, in
 * ascending verse order. Each entry is the body of a `w:` line
 * (without the `w:` prefix). Caller prepends `w:` and concatenates
 * with the voice body.
 *
 * abcjs `w:` grammar (verified against
 * `node_modules/abcjs/src/parse/abc_parse.js:215-315`):
 *   - syllables separated by SPACE (one syllable per note)
 *   - trailing `-` on a syllable = hyphenated continuation (next
 *     note carries the next syllable of the same word, hyphen
 *     drawn between them)
 *   - `_` after a syllable = melisma extender (carries this
 *     syllable across the next note; renderer draws an
 *     underscore line)
 *   - `*` (with surrounding spaces) = skip this note (no syllable)
 *   - `|` = align with next bar (we always emit on bar boundaries)
 *   - `~` inside a syllable = non-breaking space; we round-trip
 *     literal spaces in user-typed syllables to `~`
 *   - `\-`, `\_`, `\*`, `\|`, `\~` = escape literal chars in
 *     syllable text
 *
 * One verse may have syllables on only some events. Events without
 * a syllable for the active verse emit `*` (skip). When ALL events
 * in a verse line are `*`, the verse contributes nothing and is
 * dropped — guards against rendering an empty `w: * * * *` line
 * the user didn't intend.
 */
function buildLyricsLines(
  measures: readonly Measure[],
  maxVerse: number,
): string[] {
  if (maxVerse === 0) return []
  // Discover which verses are actually used in THIS voice — the
  // score-wide maxVerse may include verses that only appear on
  // other voices (e.g. v3 is only on the alto line). Walk the
  // voice's events once to collect the set.
  const activeVerses = new Set<number>()
  for (const m of measures) {
    for (const ev of m.events) {
      for (const s of ev.lyrics ?? []) {
        activeVerses.add(s.verse)
      }
    }
  }
  if (activeVerses.size === 0) return []

  const out: string[] = []
  const sortedVerses = [...activeVerses].sort((a, b) => a - b)
  for (const verse of sortedVerses) {
    const tokens: string[] = []
    for (let mi = 0; mi < measures.length; mi++) {
      const m = measures[mi]
      for (const ev of m.events) {
        // Rests ALWAYS emit `*` regardless of any syllable in the
        // event's lyrics array. abcjs's w: parser
        // (abc_parse.js:303) advances word_list only on non-rest
        // notes, so emitting a real syllable token at a rest would
        // shift every subsequent syllable left by one and drop the
        // last syllable from the verse. The syllable data still
        // round-trips through save/load (the JSON stays intact);
        // the renderer just can't visualize a syllable under a
        // rest. Anglican psalter convention is a known deferred
        // case.
        const isRest = ev.pitches.length === 1 && ev.pitches[0].step === 'rest'
        if (isRest) {
          tokens.push('*')
          continue
        }
        const syl = getSyllable(ev, verse)
        if (!syl) {
          tokens.push('*')
          continue
        }
        let text = escapeLyricSyllable(syl.syllable)
        // Trailing `-` marks hyphenated continuation. Mutually
        // exclusive with extender per M15-PR-1 setLyric guard, so
        // only one of the suffix branches fires.
        if (syl.hyphen) text = text + '-'
        else if (syl.extender) text = text + '_'
        tokens.push(text)
      }
      // Bar boundary: abcjs uses `|` to anchor the syllable line
      // to the bar so visual alignment survives wide-bar rendering.
      // Suppress the final bar to avoid a trailing `|` (the body
      // ABC also ends without a closing `|` token at the very end).
      if (mi < measures.length - 1) tokens.push('|')
    }
    out.push(tokens.join(' '))
  }
  return out
}

/**
 * Escape a user-typed syllable for safe inclusion in an abcjs w:
 * line. Per the parser at abc_parse.js:215-246 + the downstream
 * tokenizer.translateString at abc_tokenizer.js:565:
 *   - spaces split syllables; literal spaces become `~` (non-
 *     breaking space)
 *   - `-`, `_`, `*`, `|`, `~` are abcjs control chars; literals
 *     escape with leading `\`
 *   - BACKSLASH cannot survive a round-trip. abcjs's
 *     translateString consumes `\X` for accent / music-glyph
 *     lookups (`\b` → ♭, `\#` → ♯, `\AE` → Æ, etc.) so a literal
 *     `\b` in a syllable would render as ♭. There is no safe
 *     escape sequence; strip backslashes outright. Syllables are
 *     human text with no legitimate backslash use.
 */
function escapeLyricSyllable(text: string): string {
  return text
    .replace(/\\/g, '')
    .replace(/([-_*|~])/g, '\\$1')
    .replace(/ /g, '~')
}

function indexEventIdsForRender(
  score: Score,
): Map<string, { staffIdx: number; voiceIdx: number; measureIdx: number; eventIdx: number }> {
  const out = new Map<
    string,
    { staffIdx: number; voiceIdx: number; measureIdx: number; eventIdx: number }
  >()
  const staffCount = getStaffCount(score)
  for (let s = 0; s < staffCount; s++) {
    const voiceCount = getVoiceCount(score, s)
    for (let v = 0; v < voiceCount; v++) {
      const measures = getVoiceMeasures(score, s, v)
      for (let mi = 0; mi < measures.length; mi++) {
        const events = measures[mi].events
        for (let ei = 0; ei < events.length; ei++) {
          const id = events[ei].id
          if (id) out.set(id, { staffIdx: s, voiceIdx: v, measureIdx: mi, eventIdx: ei })
        }
      }
    }
  }
  return out
}

/**
 * Map a MetricModulationNote to a renderable annotation glyph. The
 * music-notation Unicode block has BMP-safe glyphs for quarter (♩)
 * and eighth (♪); half is astral (𝅗𝅥) but JavaScript handles it as
 * a normal string and modern fonts render it. Sixteenth has no
 * dedicated BMP glyph; we use ♬ (beamed-16ths, U+266C) as a
 * conventional approximation that reads correctly in context.
 *
 * Dotted variants append a literal period — abcjs annotations
 * don't have a true dotted-note ligature in BMP.
 *
 * Why annotations instead of an inline `[Q:1/4=3/8]` ratio Q:
 * directive: abcjs's tempo parser (abc_parse_header.js) consumes
 * `1/4` as the note value, then expects `=N` where N is an integer
 * bpm — it cannot parse `=3/8`. The ratio Q: emission emits a
 * warning and silently drops the tempo element. Rendering the
 * modulation as a `"^♩=♩."` annotation prefix keeps the visual
 * label and ducks the parser limitation. (The sibling tempo_bpm
 * Q: still emits separately for playback.)
 */
const METRIC_MOD_NOTE_GLYPH: Record<MetricModulationNote, string> = {
  half: '𝅗𝅥',
  'dotted-half': '𝅗𝅥.',
  quarter: '♩',
  'dotted-quarter': '♩.',
  eighth: '♪',
  'dotted-eighth': '♪.',
  sixteenth: '♬',
}

/**
 * Escape characters that would corrupt the Q: directive's quoted
 * text. abcjs's parser treats `"` as the text delimiter; backslashes
 * stay literal (see escapeAnnotationText for the same rule on
 * annotations).
 */
function escapeTempoText(text: string): string {
  return text
    .replace(/\\/g, '')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]+/g, ' ')
}

/**
 * Compose the ABC prefix for a single Marker. Order of inline
 * directives doesn't strictly matter for abcjs, but we group them
 * meter → key → clef → tempo → metric-modulation for readability
 * in the generated source.
 *
 * Returns '' when the marker carries no renderable change. (The
 * schema refine should prevent this, but be defensive.)
 *
 * Limitations:
 * - clef changes emit a `[K:<currentKey> clef=<newClef>]` directive
 *   which IMPLICITLY restates the key. When the marker also carries
 *   a key change, the explicit key change wins and the clef change
 *   piggybacks on it. When neither is set on this marker but the
 *   marker has clef, we restate the score-level key.
 * - Multiple clefs[] entries are emitted as separate K: directives;
 *   in a multi-staff score they apply per V: voice line. The current
 *   single-prefix-per-measure model doesn't route to V:-specific
 *   contexts — multi-staff mid-piece clef rendering is deferred.
 */
function markerToAbc(m: Marker, scoreKey: Score['key']): string {
  let out = ''
  if (m.meter !== undefined) out += `[M:${m.meter}]`
  if (m.key !== undefined) out += `[K:${m.key}]`
  if (m.clefs && m.clefs.length > 0) {
    // When the marker also changes key, the clef is folded into the
    // previous [K:...] — but since we've already emitted the [K:...]
    // closed, we restate. abcjs accepts adjacent [K:...] directives.
    const keyToUse = m.key ?? scoreKey
    for (const c of m.clefs) {
      out += `[K:${keyToUse} clef=${c.clef}]`
    }
  }
  if (m.tempo_bpm !== undefined || m.tempo_text !== undefined) {
    const textPart =
      m.tempo_text !== undefined ? `"${escapeTempoText(m.tempo_text)}" ` : ''
    if (m.tempo_bpm !== undefined) {
      out += `[Q:${textPart}1/4=${m.tempo_bpm}]`
    } else {
      // Tempo text alone — no Q: number is required, but abcjs's Q:
      // directive needs a value to register at all. Use the score's
      // top-level tempo_bpm fallback when the marker omits one;
      // when nothing's available, fall back to a 100 bpm placeholder
      // — the playback engine doesn't read mid-piece tempo from
      // text alone anyway. To avoid that complication for tempo-text-
      // only markers, emit a plain annotation instead.
      out += `"^${escapeTempoText(m.tempo_text!)}"`
    }
  }
  if (m.metricModulation !== undefined) {
    const fromGlyph = METRIC_MOD_NOTE_GLYPH[m.metricModulation.fromNote]
    const toGlyph = METRIC_MOD_NOTE_GLYPH[m.metricModulation.toNote]
    // Emit as annotation prefix above the staff. abcjs cannot parse
    // `[Q:1/4=3/8]` (see METRIC_MOD_NOTE_GLYPH comment), so the
    // visual label rides on the annotation channel instead. The
    // tempo_bpm Q: directive (above) handles playback semantics.
    out += `"^${fromGlyph} = ${toGlyph}"`
  }
  return out
}

/**
 * Build a lookup of marker prefix strings keyed by measureIdx for
 * the PRIMARY voice. Markers attach to measure boundaries, not to
 * specific events; they emit at the START of the targeted measure.
 *
 * Multiple markers at the same measureIdx (each changing a different
 * field — validateMarkers catches same-field collisions) concatenate
 * in input order so deterministic editor sequences stay readable.
 */
function buildMarkerInsertsByMeasure(score: Score): Map<number, string> {
  const out = new Map<number, string>()
  const markers = score.markers
  if (!markers || markers.length === 0) return out
  for (const m of markers) {
    const prefix = markerToAbc(m, score.key)
    if (prefix === '') continue
    const prior = out.get(m.measureIdx)
    out.set(m.measureIdx, prior ? prior + prefix : prefix)
  }
  return out
}

const EMPTY_MARKER_MAP: Map<number, string> = new Map()
// M17-PR-2: shared empty volta opener map for non-primary voice
// lines (voltas align across the system from the primary voice).
const EMPTY_VOLTA_OPENERS: Map<number, string> = new Map()

/**
 * Strip newlines and carriage returns from header text. ABC headers
 * are line-oriented (one directive per line); embedded \n would break
 * the parse. Other special chars like `:` are fine in header values
 * since the parser splits on the first `:` only.
 */
function sanitizeHeaderText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim()
}

function emitEventWithRange(
  event: Event,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  eventIdx: number,
  startOffset: number,
  /**
   * Decoration text inherited from the previous event (breath /
   * caesura). Counted into this event's range so the binary-search
   * click resolver still locates it.
   */
  prependedDecorations: string,
  /**
   * Technique annotation ("^pizz." etc.) attached to this event. Sits
   * before the abcjs decorations so the italic label renders to the
   * LEFT of any !mf! or !accent! glyph in the same column. Included
   * in the event's range like every other prefix.
   */
  techniqueAnnotation: string,
  /**
   * Slur-open parens (M12-PR-3). Emitted at the END of the decoration
   * prefix chain, immediately before the pitch token, so abcjs parses
   * `(C2` as open-slur + core-note. Multiple slurs starting at the
   * same event accumulate as `((`.
   */
  slurOpens: string,
  /**
   * Slur-close parens (M12-PR-3). Emitted after the duration + tie so
   * abcjs parses `D2)` as core-note + close-slur. Multiple slurs
   * ending at the same event accumulate as `))`.
   */
  slurCloses: string,
): { text: string; range: EventRange } {
  if (event.pitches.length > 1 && event.pitches.some((p) => p.step === 'rest')) {
    throw new ValidationError(
      'Rest cannot appear inside a chord stack',
      'rest_in_chord',
      { measure: measureIdx + 1, event: eventIdx + 1 },
    )
  }

  // Read structured + legacy via the helpers so the renderer honors
  // dynamic_structured.base when `dynamic` is unset, and articulations[]
  // when the singular articulation field is unset.
  // Decoration prefix order: inherited (breath/caesura from prior
  // event), technique annotation (italic above-staff text), tremolo,
  // dynamic, fermata, ornament, fingerings (per-pitch digit/letter
  // glyphs above the staff), bowing, articulations, then the grace
  // prefix immediately before the principal note. Tremolo MUST be a
  // `!//!` decoration — bare slashes after the duration would be parsed
  // as duration divisors by abcjs.
  //
  // Grace-notes precedence: when structured graceNotes is present +
  // non-empty, suppress the legacy ornament:"grace" default — emitting
  // both would produce two stacked grace groups in front of the
  // principal. The legacy field stays in the score JSON for back-
  // compat readers; only the rendered output prefers the structured
  // form.
  const structuredGracePrefix = graceNotesToAbc(event.graceNotes)
  const ornamentForRender: Ornament | undefined =
    structuredGracePrefix !== '' && event.ornament === 'grace'
      ? undefined
      : event.ornament
  // Per-pitch tie + lv computation (M13-PR-1).
  //
  //   tiedFlags[i] — whether pitch i is tied to its corresponding
  //   pitch in the next event. Computed via isPitchTiedToNext, which
  //   honors the per-pitch flag with fallback to the legacy event-
  //   wide event.tied_to_next. lv pitches NEVER receive a `-` tie
  //   glyph — their open-ended ring is marked by the `"^l.v."`
  //   annotation in the decoration prefix.
  //
  //   anyLv — at least one pitch in the event is laissez-vibrer.
  //   The annotation is emitted once per event (not per pitch) since
  //   it's a generic above-staff label, not a per-notehead glyph.
  //   Per-pitch lv targeting in a chord is a deferred enhancement.
  const tiedFlags = event.pitches.map(
    (p) => !p.lv && isPitchTiedToNext(p, event),
  )
  const anyLv = event.pitches.some((p) => p.lv === true)
  // The literal "l.v." contains no escape-relevant chars today, but
  // route through escapeAnnotationText for symmetry with all other
  // annotation emit paths — a future localized label (e.g. "let ring")
  // or quoted variant would otherwise corrupt the abcjs token.
  const lvAnnotation = anyLv ? `"^${escapeAnnotationText('l.v.')}"` : ''

  // Chord symbol emits FIRST (before any annotation / decoration)
  // so abcjs's chord-symbol layout pass picks it up cleanly — bare
  // quoted text right after a barline / preceding glyph is the
  // canonical form. Lower position in the chain would still parse
  // but mixes chord symbols into the annotation stack.
  const decorations =
    prependedDecorations +
    chordSymbolToAbc(event) +
    lvAnnotation +
    techniqueAnnotation +
    tremoloToAbc(event.tremolo) +
    dynamicToAbc(getDynamicBase(event)) +
    fermataToAbc(event.fermata) +
    ornamentToAbc(ornamentForRender) +
    fingeringsToAbc(event) +
    bowingToAbc(event.bowing) +
    articulationsToAbc(event) +
    structuredGracePrefix +
    // Slur opens go LAST in the prefix chain so the `(` sits
    // immediately before the pitch token (abcjs's "open-slur within
    // core-note" production).
    slurOpens
  const duration = DURATION_ABC[event.duration]

  // Per-pitch tie emission strategy:
  //
  //   - If ALL pitches are tied (and any pitches exist) → emit a
  //     single chord-wide `]-` outside the brackets. This is the
  //     cleanest form and preserves the legacy event-wide path
  //     when no per-pitch overrides are present.
  //   - If SOME (not all) pitches are tied → emit per-pitch `-`
  //     immediately after each tied pitch INSIDE the chord
  //     (e.g. `[C-EG]` ties only the C). abcjs's chord parser
  //     reads the trailing `-` as a per-chord-tone tie marker
  //     (verified against abcjs/src/parse/abc_parse_music.js:379-
  //     384 + 1220-1238 — chordNote.startTie flips per pitch).
  //   - Single-pitch events use tiedFlags[0] directly, dropping
  //     into the same outer-`-` path the legacy renderer used.
  const someTied = tiedFlags.some(Boolean)
  const allTied = tiedFlags.length > 0 && tiedFlags.every(Boolean)
  const useInnerTies = event.pitches.length > 1 && someTied && !allTied

  const pitchRanges: NoteRange[] = []
  let pitchesText: string

  if (event.pitches.length > 1) {
    const inner = event.pitches.map(pitchToAbc)
    // When inner ties are needed, append `-` to each tied pitch
    // token so the pitch+tie pair stays grouped in its range.
    const innerWithTies = useInnerTies
      ? inner.map((s, i) => (tiedFlags[i] ? s + '-' : s))
      : inner
    pitchesText = '[' + innerWithTies.join('') + ']'
    // Cursor starts AFTER the opening `[` (the +1) and advances by the
    // emitted token length per pitch. When useInnerTies is true the
    // token length already includes the trailing `-`, so the range
    // covers `C-` for tied pitches and `C` for untied.
    let cursor = startOffset + decorations.length + 1
    for (let p = 0; p < event.pitches.length; p++) {
      const pStr = innerWithTies[p]
      pitchRanges.push({
        staffIdx, voiceIdx, measureIdx, eventIdx,
        pitchIdx: p,
        startChar: cursor,
        endChar: cursor + pStr.length,
      })
      cursor += pStr.length
    }
  } else {
    pitchesText = pitchToAbc(event.pitches[0])
    pitchRanges.push({
      staffIdx, voiceIdx, measureIdx, eventIdx,
      pitchIdx: 0,
      startChar: startOffset + decorations.length,
      endChar: startOffset + decorations.length + pitchesText.length,
    })
  }

  // Outer chord/note tie: emitted only when the inner per-pitch
  // form is NOT in use AND at least one pitch was tied. For a
  // chord this means all tones were tied; for a single-pitch
  // event this means tiedFlags[0] is true.
  const tie = !useInnerTies && someTied ? '-' : ''
  const text = decorations + pitchesText + duration + tie + slurCloses
  return {
    text,
    range: {
      staffIdx, voiceIdx, measureIdx, eventIdx,
      startChar: startOffset,
      endChar: startOffset + text.length,
      pitchRanges,
    },
  }
}

function emitMeasureWithRanges(
  measure: Measure,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  startOffset: number,
  /**
   * Decoration text inherited from the previous measure's final event
   * (breath / caesura "after" semantics). Prepended to this measure's
   * first emitted event.
   */
  inboundPrefix: string,
  /**
   * Lookup of technique-annotation prefixes by event key. Built once
   * per scoreToAbcWithMap call from score.techniqueStates.
   */
  techniqueAnnotations: Map<string, string>,
  /**
   * Lookup of score-level annotation prefixes by event key. Built once
   * per scoreToAbcWithMap call from score.annotations. Empty map for
   * non-primary voices since annotations anchor to staff 0 voice 0.
   */
  annotations: Map<string, string>,
  /**
   * Lookup of hairpin-decoration prefixes by event key (M11-PR-4).
   * Built from score.spans, filtered to hairpin kinds. Unlike
   * annotations, hairpins emit on the voice their endpoints belong to
   * (not the primary voice) — so secondStaff / extraVoices get the
   * SAME map, and entries route by their staff/voice key prefix.
   */
  hairpinDecorations: Map<string, string>,
  /**
   * Lookup of slur-paren accumulators by event key (M12-PR-3). Same
   * per-voice routing as hairpins; each entry carries {open, close}
   * for the bare `(` / `)` slur tokens that wrap the slurred range.
   */
  slurParens: Map<string, SlurParens>,
  /**
   * Lookup of tempo-span annotation prefixes by event key (M14-PR-2).
   * Built from score.spans filtered to tempo kinds ('accel' / 'rit').
   * Routes per-voice via the staff/voice-prefixed key, matching the
   * hairpin/slur routing.
   */
  tempoSpanAnnotations: Map<string, string>,
  /**
   * Lookup of jump-marker + Segno/Coda decoration prefixes by event
   * key (M18-PR-2). Built from score.jumpMarkers + score.segnoMarkers
   * + score.codaMarkers. PRIMARY-VOICE ONLY (staff 0, voice 0); other
   * voices receive EMPTY_JUMP_MARKER_MAP. abcjs aligns the labels
   * above the system regardless of which voice carries them.
   */
  jumpMarkerDecorations: Map<string, string>,
  /**
   * M20-PR-2 span-family lookups (one map per family). Octave-span
   * + tremolo-between are ANNOTATION glyphs (`"^8va"`, `"^trem."`)
   * because abcjs has no native vocabulary; glissando + trill-line
   * use native abcjs decoration tokens (`!glissando(!`, `!trill(!`).
   * All four route per-voice via the staff/voice-prefixed key,
   * matching hairpin/slur/tempo routing.
   */
  octaveSpanAnnotations: Map<string, string>,
  glissandoDecorations: Map<string, string>,
  trillLineDecorations: Map<string, string>,
  tremoloBetweenAnnotations: Map<string, string>,
): { text: string; ranges: EventRange[]; trailingPrefix: string } {
  let text = ''
  const ranges: EventRange[] = []
  let offset = startOffset
  let pending = inboundPrefix
  let i = 0
  while (i < measure.events.length) {
    const event = measure.events[i]
    if (event.tuplet) {
      let count = 1
      while (
        i + count < measure.events.length &&
        measure.events[i + count].tuplet === event.tuplet
      ) {
        count++
      }
      if (count < event.tuplet) {
        throw new ValidationError(
          `Tuplet group starting at event ${i + 1} has ${count} events; expected ${event.tuplet}`,
          'tuplet_incomplete',
          { measure: measureIdx + 1, event: i + 1 },
        )
      }
      const prefix = `(${event.tuplet}`
      text += prefix
      offset += prefix.length
      for (let j = 0; j < event.tuplet; j++) {
        const evJ = measure.events[i + j]
        // Concatenate score-level annotation BEFORE the technique
        // annotation. Both render as italic above-staff text via
        // the global %%annotationfont; the order keeps verbal
        // labels left of state-change markers in the rare case
        // where both attach to the same event. Tempo-span labels
        // sit alongside score-level annotations (both are italic
        // above-staff text); jump-marker decorations attach to
        // the resolved boundary event; hairpin glyphs come LAST so
        // they sit closest to the pitch in the visual column.
        const annotation =
          annotationAt(annotations, staffIdx, voiceIdx, measureIdx, i + j) +
          tempoSpanAnnotationAt(
            tempoSpanAnnotations, staffIdx, voiceIdx, measureIdx, i + j,
          ) +
          octaveSpanAnnotationAt(
            octaveSpanAnnotations, staffIdx, voiceIdx, measureIdx, i + j,
          ) +
          tremoloBetweenAnnotationAt(
            tremoloBetweenAnnotations, staffIdx, voiceIdx, measureIdx, i + j,
          ) +
          jumpMarkerDecorationAt(
            jumpMarkerDecorations, staffIdx, voiceIdx, measureIdx, i + j,
          ) +
          techniqueAnnotationAt(
            techniqueAnnotations, staffIdx, voiceIdx, measureIdx, i + j,
          ) +
          trillLineDecorationAt(
            trillLineDecorations, staffIdx, voiceIdx, measureIdx, i + j,
          ) +
          glissandoDecorationAt(
            glissandoDecorations, staffIdx, voiceIdx, measureIdx, i + j,
          ) +
          hairpinAt(hairpinDecorations, staffIdx, voiceIdx, measureIdx, i + j)
        const slurs = slurParensAt(slurParens, staffIdx, voiceIdx, measureIdx, i + j)
        const { text: et, range } = emitEventWithRange(
          evJ, staffIdx, voiceIdx, measureIdx, i + j, offset, pending, annotation, slurs.open, slurs.close,
        )
        text += et
        ranges.push(range)
        offset += et.length
        pending = trailingPrefixFromEvent(evJ)
      }
      i += event.tuplet
    } else {
      const annotation =
        annotationAt(annotations, staffIdx, voiceIdx, measureIdx, i) +
        tempoSpanAnnotationAt(
          tempoSpanAnnotations, staffIdx, voiceIdx, measureIdx, i,
        ) +
        octaveSpanAnnotationAt(
          octaveSpanAnnotations, staffIdx, voiceIdx, measureIdx, i,
        ) +
        tremoloBetweenAnnotationAt(
          tremoloBetweenAnnotations, staffIdx, voiceIdx, measureIdx, i,
        ) +
        jumpMarkerDecorationAt(
          jumpMarkerDecorations, staffIdx, voiceIdx, measureIdx, i,
        ) +
        techniqueAnnotationAt(
          techniqueAnnotations, staffIdx, voiceIdx, measureIdx, i,
        ) +
        trillLineDecorationAt(
          trillLineDecorations, staffIdx, voiceIdx, measureIdx, i,
        ) +
        glissandoDecorationAt(
          glissandoDecorations, staffIdx, voiceIdx, measureIdx, i,
        ) +
        hairpinAt(hairpinDecorations, staffIdx, voiceIdx, measureIdx, i)
      const slurs = slurParensAt(slurParens, staffIdx, voiceIdx, measureIdx, i)
      const { text: et, range } = emitEventWithRange(
        event, staffIdx, voiceIdx, measureIdx, i, offset, pending, annotation, slurs.open, slurs.close,
      )
      text += et
      ranges.push(range)
      offset += et.length
      pending = trailingPrefixFromEvent(event)
      i++
    }
  }
  return { text, ranges, trailingPrefix: pending }
}

function emitVoiceBody(
  measures: readonly Measure[],
  staffIdx: number,
  voiceIdx: number,
  startOffset: number,
  techniqueAnnotations: Map<string, string>,
  annotations: Map<string, string>,
  markerInserts: Map<number, string>,
  hairpinDecorations: Map<string, string>,
  slurParens: Map<string, SlurParens>,
  tempoSpanAnnotations: Map<string, string>,
  voltaOpeners: Map<number, string>,
  jumpMarkerDecorations: Map<string, string>,
  octaveSpanAnnotations: Map<string, string>,
  glissandoDecorations: Map<string, string>,
  trillLineDecorations: Map<string, string>,
  tremoloBetweenAnnotations: Map<string, string>,
): { text: string; ranges: EventRange[] } {
  const allRanges: EventRange[] = []
  let body = ''
  let offset = startOffset
  let pendingPrefix = ''
  // Leading startBarline on the first measure (M16-PR-2). Without
  // this branch the first measure's startBarline:'repeat-start'
  // would never reach abcjs — the inter-measure loop only honors
  // measures[m+1].startBarline. Typical use: `|: ... :|` repeat
  // block starting from m0.
  if (measures.length > 0 && measures[0].startBarline !== undefined) {
    const leadGlyph = barlineToAbc(measures[0].startBarline)
    body += leadGlyph
    offset += leadGlyph.length
  }
  // Volta opener at m=0 (M17-PR-2). If no leading startBarline was
  // emitted above AND m=0 starts a volta, prepend `[` + digits so
  // abcjs sees a valid invisible-barline + ending opener. With a
  // startBarline already emitted, the digits attach to that barline
  // directly (no `[` bracket needed; abcjs's parser at
  // abc_parse_music.js:872 makes the bracket optional).
  if (measures.length > 0) {
    const m0Opener = voltaOpeners.get(0)
    if (m0Opener !== undefined) {
      const opener = measures[0].startBarline !== undefined ? m0Opener : `[${m0Opener}`
      body += opener
      offset += opener.length
    }
  }
  for (let m = 0; m < measures.length; m++) {
    const measure = measures[m]
    // Inject mid-piece marker directives at the START of this
    // measure (before any event). markerInserts is non-empty only
    // for the primary voice — secondStaff / extraVoices get an
    // empty map so the [M:...][K:...][Q:...] doesn't repeat per
    // voice line (abcjs aligns inline directives across the system
    // from the primary voice).
    const markerPrefix = markerInserts.get(m) ?? ''
    if (markerPrefix !== '') {
      body += markerPrefix
      offset += markerPrefix.length
    }
    const { text: mt, ranges, trailingPrefix } = emitMeasureWithRanges(
      measure, staffIdx, voiceIdx, m, offset, pendingPrefix, techniqueAnnotations, annotations, hairpinDecorations, slurParens, tempoSpanAnnotations, jumpMarkerDecorations, octaveSpanAnnotations, glissandoDecorations, trillLineDecorations, tremoloBetweenAnnotations,
    )
    body += mt
    allRanges.push(...ranges)
    offset += mt.length
    pendingPrefix = trailingPrefix

    // The "general pause" fermata sits ON the closing barline. In ABC
    // the decoration immediately precedes the barline character so
    // abcjs paints the fermata glyph over the bar. Suppress when the
    // measure's closing event already carries `event.fermata` — the
    // two fermatas would otherwise stack visually and the engraving
    // intent is ambiguous. The barlineFermata data still round-trips
    // through the score JSON; only the rendering merges them.
    const closingEvent = measure.events[measure.events.length - 1]
    const blf = measure.barlineFermata
    if (blf && !closingEvent.fermata) {
      body += '!fermata!'
      offset += '!fermata!'.length
    }

    // Barline glyph emission (M16-PR-2). Default is the thin `|`
    // that pre-M16 always emitted. endBarline overrides for the
    // current measure's closing edge; the NEXT measure's
    // startBarline (if set) prepends its own glyph BEFORE the
    // next measure body, producing the canonical `:|: ` repeat-
    // boundary form when adjacent measures both carry a glyph.
    const endGlyph = barlineToAbc(measure.endBarline)
    body += endGlyph
    offset += endGlyph.length
    // Inter-measure emit order MUST be:
    //   endBarline → nextStartBarline → voltaOpener → `\n`
    // Pre-fix the `\n` injection came BEFORE the volta opener,
    // which silently dropped voltas at m=4/8/12/... because abcjs
    // saw the digit `1` at column 0 and reported it as
    // "Unknown character ignored" (the ending parser requires
    // digits immediately after a bar token on the same line).
    if (m < measures.length - 1) {
      const nextStart = measures[m + 1].startBarline
      if (nextStart !== undefined) {
        const startGlyph = barlineToAbc(nextStart)
        body += startGlyph
        offset += startGlyph.length
      }
      // Volta opener for measures[m+1] (M17-PR-2). Emit AFTER any
      // barline glyphs (current end + next start) since abcjs's
      // ending parser expects digits immediately following a bar
      // token. Use bare digits (no `[`) since a barline always
      // precedes here.
      const nextOpener = voltaOpeners.get(m + 1)
      if (nextOpener !== undefined) {
        body += nextOpener
        offset += nextOpener.length
      }
    }
    if ((m + 1) % 4 === 0 && m < measures.length - 1) {
      body += '\n'
      offset += 1
    }
  }
  // Drop a trailing breath/caesura with nowhere to attach. The data
  // still lives on the final event in the score JSON; only the visual
  // rendering is silently elided (no syntactically valid ABC position
  // exists after the final barline for these decorations).
  return { text: body, ranges: allRanges }
}

/**
 * Build the per-voice plan: total voice count, per-voice (staffIdx,
 * voiceIdx, clef, abcVoiceId) tuples, and a %%score grouping string.
 *
 * Voice IDs run 1..N sequentially across staves. The %%score grouping
 * brackets per-staff voice IDs so abcjs lays them out together: e.g.
 * `(1)` for single-voice single-staff, `(1 2)` for grand-staff w/ one
 * voice each, `(1 2) (3 4)` for SATB across two staves.
 */

/**
 * Build the abcjs `%%` directives that translate score.engravingDefaults
 * into render-time styling (M21-PR-1 / M21-PR-2 / M21-PR-3 / M21-PR-4).
 * Each return entry is a single directive line; the caller pushes them
 * into the header block before the music body.
 *
 * Currently wires the directly-mappable abcjs directives:
 *  Font (M21-PR-1):
 *  - tempoTextFont → %%tempofont (face, size, weight, style)
 *  - lyricFontScale → %%vocalfont (recomputes size from abcjs default 13)
 *  - chordSymbolStyle → %%gchordfont (jazz / plain / roman-numeral)
 *
 *  Page layout (M21-PR-2):
 *  - maxMeasuresPerSystem → %%barsperstaff (wrap after N bars)
 *  - firstSystemIndent → %%indent (in cm; staff-space → cm ≈ 0.5)
 *  - cancelNaturalsOnKeyChange (false) → %%keywarn 0 (abcjs default is on)
 *
 *  Page/beam toggles (M21-PR-3):
 *  - pageLayoutMode ('scroll') → %%continueall (suppress auto line breaks)
 *  - beamSlopeRule ('european-flat') → %%flatbeams (flat-beam style)
 *
 *  Dynamics layer (M21-PR-4 + the 'hidden' follow-up):
 *  - dynamicsPosition ('above' | 'below' | 'hidden') → %%dynamic <pos>
 *    ('auto-by-staff' deliberately NOT emitted — see comment at the
 *    emit site for the SATB-aware semantic mismatch)
 *
 * Fields NOT yet wired (will be addressed in subsequent M21 PRs):
 *  dynamicsPosition ('auto-by-staff' branch), dynamicsStyle,
 *  rehearsalMarkStyle (boxed mark via %%setfont machinery),
 *  editorialAccidentalBrackets, cautionaryAccidentalPolicy,
 *  stemLengthDefault, slurThickness / slurCurvature, tieThickness /
 *  tieCurvature, tupletBracketStyle / tupletNumberStyle,
 *  subsequentSystemIndent (abcjs's %%indent applies uniformly — no
 *  separate first-vs-rest knob), multiRestHBarStyle,
 *  tempoTermsLanguage, courtesyTimeSignatures / courtesyKeySignatures
 *  (abcjs has no end-of-prior-system courtesy directive), beamingPolicy
 *  (abcjs beams by note/meter heuristics; no enum knob),
 *  graceNoteCueSize. Some need abcjs hooks that don't exist
 *  (slurThickness); some need %%postscript / SVG post-processing.
 */
function buildEngravingDefaultsHeaders(score: Score): string[] {
  const out: string[] = []
  const eg = score.engravingDefaults
  if (!eg) return out

  // %%tempofont (tempoTextFont). abcjs's default is Times New Roman,
  // 15pt, bold. The 4 schema values map to {face, size, weight, style}
  // tuples. All emit 15pt; engravers vary the typography rather than
  // the size for tempo text.
  if (eg.tempoTextFont !== undefined) {
    const tempoFont = TEMPO_FONT_DIRECTIVE[eg.tempoTextFont]
    out.push(`%%tempofont ${tempoFont}`)
  }

  // %%vocalfont (lyricFontScale). abcjs's default vocal font is
  // Times New Roman, 13pt, bold. lyricFontScale is a percentage
  // (50..200) so we recompute size = 13 * scale/100, rounded to
  // the nearest integer pt to stay within abcjs's expected
  // integer-pt grammar.
  if (eg.lyricFontScale !== undefined) {
    const scaledSize = Math.round(13 * (eg.lyricFontScale / 100))
    out.push(`%%vocalfont "Times New Roman" ${scaledSize} bold`)
  }

  // %%gchordfont (chordSymbolStyle). abcjs's default gchord font is
  // Helvetica 12pt. Jazz style favors Arial Black 14pt for the bold
  // square-shouldered cap-style symbols ("Cmaj7"); roman-numeral
  // style favors a serif font (Times) at 12pt for the analytical
  // I/IV/V vocabulary; plain stays at the abcjs default but emitted
  // explicitly so the directive is round-trippable.
  if (eg.chordSymbolStyle !== undefined) {
    const gchordFont = GCHORD_FONT_DIRECTIVE[eg.chordSymbolStyle]
    out.push(`%%gchordfont ${gchordFont}`)
  }

  // %%barsperstaff (maxMeasuresPerSystem). Tells abcjs to wrap to a
  // new staff (system) after N bars. Direct 1:1 mapping with the
  // schema's 1..32 range.
  if (eg.maxMeasuresPerSystem !== undefined) {
    out.push(`%%barsperstaff ${eg.maxMeasuresPerSystem}`)
  }

  // %%indent (firstSystemIndent). abcjs interprets this as indent of
  // the FIRST staff/system, in measurement units (cm/in/pt). Schema
  // bound is 0..20 in "staff-spaces" (1 staff-space ≈ 0.5cm at default
  // scale, so 0..10cm range). abcjs has no separate
  // subsequentSystemIndent directive; the schema field persists as
  // metadata but does not affect rendering. Skip the emission when
  // the value is 0 (no-op, and abcjs's default is 0 anyway).
  //
  // Asymmetry note: M21-PR-1's chordSymbolStyle:'plain' emits
  // %%gchordfont explicitly even though it matches abcjs's default,
  // for round-trippability. firstSystemIndent:0 is intentionally
  // different — %%indent 0cm carries zero positioning information
  // (the directive's whole purpose is a non-zero distance), so the
  // emission is pure noise. Same rationale applies to the keywarn
  // skip below.
  if (eg.firstSystemIndent !== undefined && eg.firstSystemIndent > 0) {
    const indentCm = (eg.firstSystemIndent * 0.5).toFixed(2)
    out.push(`%%indent ${indentCm}cm`)
  }

  // %%keywarn (cancelNaturalsOnKeyChange). abcjs's default is to PRINT
  // courtesy naturals on key changes that have fewer accidentals (F
  // major → C major prints a natural on B). Schema toggles this off
  // when cancelNaturalsOnKeyChange is false — emit `%%keywarn 0`. When
  // true (the engraver's preference and abcjs's default), emit nothing
  // so the header block stays compact (see the asymmetry note on
  // %%indent above for the rationale vs the M21-PR-1 chord-font
  // pattern that DOES emit-at-default).
  if (eg.cancelNaturalsOnKeyChange === false) {
    out.push('%%keywarn 0')
  }

  // %%continueall (pageLayoutMode). abcjs's default is to wrap to new
  // lines at automatic break points (page-mode rendering). Schema's
  // 'scroll' value emits %%continueall which suppresses ALL automatic
  // line breaks, producing a single continuous line (the natural
  // "scroll" semantic). 'page' is abcjs's default, no directive
  // needed. The "explicit-emit at default" pattern from M21-PR-1
  // doesn't apply here because %%continueall is a one-way toggle:
  // there's no `%%continueall 0` to turn page mode back on.
  if (eg.pageLayoutMode === 'scroll') {
    out.push('%%continueall')
  }

  // %%flatbeams (beamSlopeRule). abcjs's default produces angled
  // beams (the American steep convention). Schema's 'european-flat'
  // value emits %%flatbeams to enforce the flat-beam style used by
  // editions like Henle and Bärenreiter. 'american-steep' is abcjs's
  // default; no directive needed. Same one-way-toggle rationale as
  // %%continueall.
  if (eg.beamSlopeRule === 'european-flat') {
    out.push('%%flatbeams')
  }

  // %%dynamic (dynamicsPosition). abcjs accepts `auto | above | below |
  // hidden` (abc_parse_directive.js:825 + positionChoices at 751).
  // Schema values 'above' / 'below' / 'hidden' map 1:1. 'auto-by-staff'
  // is NOT emitted: the schema's "auto-by-staff" semantic means "vocal
  // staves get dynamics below, instrumental above" — a SATB-aware
  // routing decision. abcjs's 'auto' is a simpler stem-aware choice
  // that doesn't honor the same SATB convention. Rather than emit a
  // misleading approximation, defer the explicit auto-by-staff
  // routing to a future PR and let abcjs's default layout run.
  if (
    eg.dynamicsPosition === 'above' ||
    eg.dynamicsPosition === 'below' ||
    eg.dynamicsPosition === 'hidden'
  ) {
    out.push(`%%dynamic ${eg.dynamicsPosition}`)
  }

  return out
}

/**
 * tempoTextFont enum → abcjs `%%tempofont` directive payload.
 * Format: `{face} {size} {weight} [style]`. abcjs's font parser
 * accepts `bold`, `italic` (or no style suffix); the literal
 * `normal` keyword triggers "Unknown parameter normal in font
 * definition". Emit `bold italic` (both) or just `bold`/`italic`/
 * neither — never `normal`.
 */
const TEMPO_FONT_DIRECTIVE: Record<
  'italic-bold' | 'bold-roman' | 'italic-roman' | 'plain-roman',
  string
> = {
  // Italian tempo markings (Allegro / Andante) traditionally use
  // italic-bold serif.
  'italic-bold': '"Times New Roman" 15 bold italic',
  // German/French publisher style — bold roman without italic.
  'bold-roman': '"Times New Roman" 15 bold',
  // Italic roman without bold — sparse modern style.
  'italic-roman': '"Times New Roman" 15 italic',
  // Plain roman — the de-emphasized minimalist look (no weight/style
  // suffix; abcjs reads bare "face size" as plain).
  'plain-roman': '"Times New Roman" 15',
}

/**
 * chordSymbolStyle enum → abcjs `%%gchordfont` directive payload.
 * Same `normal` rejection rule applies as TEMPO_FONT_DIRECTIVE.
 */
const GCHORD_FONT_DIRECTIVE: Record<'jazz' | 'plain' | 'roman-numeral', string> = {
  // Jazz lead-sheet convention: Arial Black 14pt — bold cap-style
  // letters, square shoulders, distinctive at small reductions.
  jazz: '"Arial Black" 14 bold',
  // Plain: abcjs default, emitted explicitly so the directive is
  // round-trippable through the renderer's reset.
  plain: '"Helvetica" 12',
  // Roman-numeral analytical chord symbols: a clean serif for the
  // I/IV/V vocabulary so the analysis reads as "harmonic function"
  // rather than as a sounding chord label.
  'roman-numeral': '"Times New Roman" 12',
}

function planVoices(score: Score): {
  voices: Array<{ staffIdx: number; voiceIdx: number; abcId: number; clef: string }>
  scoreDirective: string | undefined
} {
  const voices: Array<{ staffIdx: number; voiceIdx: number; abcId: number; clef: string }> = []
  const groups: string[] = []
  let nextId = 1
  for (let s = 0; s < getStaffCount(score); s++) {
    const clef = getStaffClef(score, s)
    const vc = getVoiceCount(score, s)
    const ids: number[] = []
    for (let v = 0; v < vc; v++) {
      voices.push({ staffIdx: s, voiceIdx: v, abcId: nextId, clef })
      ids.push(nextId)
      nextId++
    }
    groups.push(ids.length === 1 ? `(${ids[0]})` : `(${ids.join(' ')})`)
  }
  // %%score is only required when we have more than one voice (otherwise
  // abcjs renders the single body inline, which is what existing single-
  // staff tests assert against).
  const scoreDirective = voices.length > 1 ? `%%score ${groups.join(' ')}` : undefined
  return { voices, scoreDirective }
}

/**
 * Transpile a Score to ABC notation, returning both the ABC string and
 * a source map of character ranges per event/pitch.
 *
 * Layout: single-voice single-staff scores emit the legacy compact
 * form (header + body, no `%%score` directive). Multi-voice or grand-
 * staff scores emit `%%score (groups)` plus a `V:N clef=...` block per
 * voice, sequentially. Char offsets stay globally ascending so the
 * existing binary search in `resolveClickPosition` continues to work.
 */
export function scoreToAbcWithMap(score: Score): { abc: string; map: SourceMap } {
  const headers: string[] = [
    'X:1',
    `T:${score.title ?? 'Untitled'}`,
    `M:${score.meter}`,
    'L:1/8',
  ]
  if (score.tempo_bpm !== undefined) headers.push(`Q:1/4=${score.tempo_bpm}`)
  // Score-level credit lines (M8-PR-3). Composer maps to the standard
  // ABC `C:` header; copyright maps to `%%footer` which abcjs prints
  // at page bottom. arranger / lyricist don't have standard ABC
  // headers — they round-trip through the score JSON but visual
  // rendering is deferred.
  if (score.composer !== undefined && score.composer !== '') {
    headers.push(`C:${sanitizeHeaderText(score.composer)}`)
  }
  if (score.copyright !== undefined && score.copyright !== '') {
    headers.push(`%%footer ${sanitizeHeaderText(score.copyright)}`)
  }
  // %%annotationfont controls the font of "^text" annotations. abcjs's
  // built-in default is upright Helvetica, but the publisher
  // convention for state-change markers (pizz./arco/sul pont. / etc.)
  // is italic. Emitted unconditionally so a future addition like
  // expressive text annotations inherits the same styling without
  // re-asserting per use.
  headers.push('%%annotationfont Helvetica 12 italic')
  // EngravingDefaults header directives (M21-PR-1). The schema has
  // ~28 fields; this PR wires the directly-mappable abcjs font
  // directives: tempoTextFont, lyricFontScale, chordSymbolStyle.
  // Layout fields (page/scroll, indents, beam slope, slur curvature)
  // are deferred to subsequent M21 PRs or persist-only until abcjs
  // exposes hooks.
  for (const directive of buildEngravingDefaultsHeaders(score)) {
    headers.push(directive)
  }

  const { voices, scoreDirective } = planVoices(score)
  const primaryClef = voices[0]?.clef ?? 'treble'
  const techniqueAnnotations = buildTechniqueAnnotationMap(score)
  const annotationMap = buildAnnotationMap(score)
  const markerInserts = buildMarkerInsertsByMeasure(score)
  const hairpinDecorations = buildHairpinDecorationMap(score)
  const slurParens = buildSlurParenMap(score)
  const tempoSpanAnnotations = buildTempoSpanAnnotationMap(score)
  const voltaOpeners = buildVoltaOpenersByMeasure(score)
  const jumpMarkerDecorations = buildJumpMarkerDecorationMap(score)
  // M20-PR-2 span families. Each routes per-voice via staff/voice-
  // prefixed key (same pattern as hairpinDecorations / slurParens /
  // tempoSpanAnnotations); the edit-op validator rejects cross-staff
  // spans so each map entry matches exactly one voice anyway.
  const octaveSpanAnnotations = buildOctaveSpanAnnotationMap(score)
  const glissandoDecorations = buildGlissandoDecorationMap(score)
  const trillLineDecorations = buildTrillLineDecorationMap(score)
  const tremoloBetweenAnnotations = buildTremoloBetweenAnnotationMap(score)

  // Single voice on a single staff: emit the compact legacy form.
  if (voices.length === 1) {
    const keyLine =
      primaryClef !== 'treble'
        ? `K:${score.key} clef=${primaryClef}`
        : `K:${score.key}`
    headers.push(keyLine)
    const headersText = headers.join('\n') + '\n'
    const { text: body, ranges } = emitVoiceBody(
      getVoiceMeasures(score, 0, 0),
      0, 0,
      headersText.length,
      techniqueAnnotations,
      annotationMap,
      markerInserts,
      hairpinDecorations,
      slurParens,
      tempoSpanAnnotations,
      voltaOpeners,
      jumpMarkerDecorations,
      octaveSpanAnnotations,
      glissandoDecorations,
      trillLineDecorations,
      tremoloBetweenAnnotations,
    )
    // Lyric w: lines (M15-PR-2). One line per active verse.
    // Appended AFTER the voice body so abcjs's body parser sees the
    // voice complete before reading w: continuation lines.
    // getMaxVerse is score-wide; buildLyricsLines re-derives the
    // per-voice active-verse set so verses on other voices don't
    // bleed in.
    const scoreMaxVerse = getMaxVerse(score)
    const lyricLines = buildLyricsLines(
      getVoiceMeasures(score, 0, 0),
      scoreMaxVerse,
    )
    const lyricBlock =
      lyricLines.length > 0
        ? '\n' + lyricLines.map((l) => `w:${l}`).join('\n')
        : ''
    const byEvent = new Map<string, EventRange>()
    for (const r of ranges) {
      byEvent.set(`${r.staffIdx}:${r.voiceIdx}:${r.measureIdx}:${r.eventIdx}`, r)
    }
    return { abc: headersText + body + lyricBlock, map: { events: ranges, byEvent } }
  }

  // Multi-voice (grand-staff or SATB). Headers include the %%score
  // directive and a K: that names the primary staff's clef; each
  // V:N declaration carries its own clef.
  if (scoreDirective) headers.push(scoreDirective)
  headers.push(`K:${score.key} clef=${primaryClef}`)
  const headersText = headers.join('\n') + '\n'

  let abc = headersText
  const allRanges: EventRange[] = []
  for (const v of voices) {
    const line = `V:${v.abcId} clef=${v.clef}`
    abc += line + '\n'
    const startOffset = abc.length
    // Annotations attach only to the primary line (staff 0 voice 0).
    // Pass an empty map for secondStaff / extraVoices so abcjs's per-
    // voice text rendering doesn't duplicate the label below each
    // staff; the primary line's "^A" is visually shared across the
    // system via abcjs's annotation column alignment.
    const annotationsForVoice =
      v.staffIdx === 0 && v.voiceIdx === 0 ? annotationMap : EMPTY_ANNOTATION_MAP
    // Same primary-line restriction for marker inserts — mid-piece
    // [M:...] / [K:...] / [Q:...] directives only emit on the
    // primary voice so abcjs aligns them across the system without
    // restating per voice line.
    const markersForVoice =
      v.staffIdx === 0 && v.voiceIdx === 0 ? markerInserts : EMPTY_MARKER_MAP
    // Hairpins route per-voice (unlike annotations which anchor to the
    // primary line). Pass the full map; hairpinAt's per-event key
    // filters to entries that match this (staff, voice). Today the
    // edit-op validator (M11-PR-2) rejects cross-voice hairpins so
    // each map entry matches exactly one voice anyway — the per-voice
    // routing is forward-looking for when that restriction is relaxed.
    // Voltas (M17-PR-2) emit ONLY on the primary voice — like
    // markers, abcjs aligns the volta bracket visually across the
    // system from the primary voice. Secondary voices get an empty
    // map so the `[1` digits don't repeat per voice line.
    const voltasForVoice =
      v.staffIdx === 0 && v.voiceIdx === 0 ? voltaOpeners : EMPTY_VOLTA_OPENERS
    // Jump markers + Segno + Coda (M18-PR-2) similarly emit ONLY on
    // the primary voice — secondary voices get an empty map so the
    // `!D.C.!` / `!segno!` glyphs don't repeat per voice line. abcjs
    // aligns the labels above the system from the primary voice.
    const jumpMarkersForVoice =
      v.staffIdx === 0 && v.voiceIdx === 0 ? jumpMarkerDecorations : EMPTY_JUMP_MARKER_MAP
    const { text: body, ranges } = emitVoiceBody(
      getVoiceMeasures(score, v.staffIdx, v.voiceIdx),
      v.staffIdx,
      v.voiceIdx,
      startOffset,
      techniqueAnnotations,
      annotationsForVoice,
      markersForVoice,
      hairpinDecorations,
      slurParens,
      tempoSpanAnnotations,
      voltasForVoice,
      jumpMarkersForVoice,
      octaveSpanAnnotations,
      glissandoDecorations,
      trillLineDecorations,
      tremoloBetweenAnnotations,
    )
    abc += body + '\n'
    // Per-voice lyric w: lines (M15-PR-2). For SATB divisi: each
    // voice line emits its OWN w: lines so the soprano and alto can
    // carry different syllables on parallel events. The HIGH-risk
    // case the plan called out is handled by simple per-voice
    // emission; no cross-voice merge logic needed.
    const voiceMeasures = getVoiceMeasures(score, v.staffIdx, v.voiceIdx)
    const lyricLines = buildLyricsLines(voiceMeasures, getMaxVerse(score))
    for (const l of lyricLines) {
      abc += `w:${l}\n`
    }
    allRanges.push(...ranges)
  }
  // Trim trailing newline so existing single-staff tests that check
  // body content don't see an extra blank line.
  if (abc.endsWith('\n')) abc = abc.slice(0, -1)

  const byEvent = new Map<string, EventRange>()
  for (const r of allRanges) {
    byEvent.set(`${r.staffIdx}:${r.voiceIdx}:${r.measureIdx}:${r.eventIdx}`, r)
  }
  return { abc, map: { events: allRanges, byEvent } }
}

/**
 * Resolve an abcjs clickListener char position to a (staffIdx,
 * voiceIdx, measureIdx, eventIdx, pitchIdx?) selection by binary-
 * searching the event ranges. Returns undefined if the position
 * doesn't fall inside any event.
 */
export function resolveClickPosition(
  map: SourceMap,
  startChar: number,
): {
  staffIdx: number
  voiceIdx: number
  measureIdx: number
  eventIdx: number
  pitchIdx?: number
} | undefined {
  const { events } = map
  let lo = 0
  let hi = events.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = events[mid]
    if (startChar < r.startChar) hi = mid - 1
    else if (startChar >= r.endChar) lo = mid + 1
    else {
      for (const pr of r.pitchRanges) {
        if (startChar >= pr.startChar && startChar < pr.endChar) {
          return {
            staffIdx: r.staffIdx,
            voiceIdx: r.voiceIdx,
            measureIdx: r.measureIdx,
            eventIdx: r.eventIdx,
            pitchIdx: pr.pitchIdx,
          }
        }
      }
      return {
        staffIdx: r.staffIdx,
        voiceIdx: r.voiceIdx,
        measureIdx: r.measureIdx,
        eventIdx: r.eventIdx,
      }
    }
  }
  return undefined
}
