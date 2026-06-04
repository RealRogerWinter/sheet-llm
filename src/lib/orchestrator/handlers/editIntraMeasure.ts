import { z } from 'zod'
import type { Score } from '@/lib/music/types'
import { BARLINE_KINDS } from '@/lib/music/types'
import {
  HAIRPIN_KINDS,
  JUMP_KINDS,
  OCTAVE_SPAN_KINDS,
  SLUR_KINDS,
  TEMPO_SPAN_KINDS,
} from '@/lib/music/spans'
import { transformScore, type Operation } from '@/lib/music/editOperations'
import { getMeasureCount, getStaffCount } from '@/lib/music/scoreAccessors'
import { validateScore } from '@/lib/music/validateScore'
import { ValidationError } from '@/lib/music/errors'
import type { Classification, OrchestratorResult } from '../types'
import { selectProvider } from '@/lib/providers/select'
import { callWithFailover } from '@/lib/providers/callWithFailover'
import { ProviderSchemaError } from '@/lib/providers/types'
import type { ProviderToolResult } from '@/lib/providers/types'

const EDIT_TOOL_NAME = 'edit_score'
const MAX_TOKENS = 8_000 // M25-PR-6: render_score emit floor (see tokenBudget.test.ts); was 1500 — truncated dense grand-staff edits

export class EditIntraMeasureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditIntraMeasureError'
  }
}

export interface RunEditIntraMeasureInput {
  classification: Classification
  editedScore: Score | undefined
  /** Used for sticky-per-chat provider selection. */
  chatId?: string
  /** Debug-only: force a different model id (defaults to medium tier). */
  modelOverride?: string
}

/** No-op kept for back-compat with any test still importing it. */
export function _resetIntraMeasureClient(): void {}

export const INTRA_SYSTEM_PROMPT = `You author precise musical edits as Operation arrays. The user provides a Score (JSON) and a natural-language target description. Emit a single \`edit_score\` tool call whose \`ops\` array contains the minimal sequence of Operations needed to fulfill the request.

TARGET SHAPE: every per-note op carries \`target: { staffIdx?, voiceIdx?, measureIdx, eventIdx, pitchIdx? }\`. All indices 0-based.
- staffIdx ∈ {0, 1}. 0 = primary staff (top); 1 = secondStaff (bottom). Omit for single-staff scores. REQUIRED for grand-staff scores.
- voiceIdx ∈ {0, 1, 2, 3}. 0 = primary voice (the staff's \`measures\` field); 1..3 = the staff's \`extraVoices\` entries. Omit for single-voice scores. In SATB the convention is: staff 0 voice 0 = Soprano, staff 0 voice 1 = Alto, staff 1 voice 0 = Tenor, staff 1 voice 1 = Bass.
- measureIdx must reference an existing measure in that (staff, voice).
- eventIdx must reference an existing event in that measure.

OPERATION KINDS (all use { kind, target?, ... } unless noted otherwise):
- changePitch: { kind, target, deltaStep?, deltaOctave? } — transpose a pitch by scale steps (+/-) and/or octaves (+/-). Use deltaStep 1 to go one note up; deltaOctave 1 for one octave up.
- changeDuration: { kind, target, duration } — set the event's duration. duration ∈ {whole, half, quarter, eighth, sixteenth, 32nd, dotted-half, dotted-quarter, dotted-eighth}.
- setAccidental: { kind, target, accidental } — accidental ∈ {natural, sharp, flat, dblsharp, dblflat, none}.
- setArticulation: { kind, target, articulation } — single-articulation legacy form. articulation ∈ {staccato, accent, tenuto, marcato, portato, none}. For stacking, use setArticulations instead.
- setArticulations: { kind, target, articulations } — articulations is an Articulation[] (max 4 entries). Pass [] to clear. Stacking conventions: order is innermost staccato to outermost marcato, marcato+accent is rejected, staccato+tenuto auto-coerces to portato.
- toggleTie: { kind, target } — toggle the EVENT-level tied_to_next flag (ties every pitch in the chord).
- setPitchTie: { kind, target, tied_to_next } — set the PER-PITCH tied_to_next flag on target.pitchIdx. Use for chord tones where only some pitches tie.
- setLv: { kind, target, lv } — set per-pitch laissez vibrer (open-ended tie). target.pitchIdx required.
- setEnharmonicTie: { kind, target, enharmonicTie } — escape hatch for ties that respell enharmonically across the bar (C# → Db). target.pitchIdx required.
- setOrnament: { kind, target, ornament } — ornament ∈ {trill, pralltriller, mordent, upper-mordent, lower-mordent, schneller, turn, inverted-turn, delayed-turn, slide, arpeggio-up, arpeggio-down, non-arpeggio, grace, none}. Pass 'none' to clear.
- setTrillUpperPitch: { kind, target, trillUpperPitch? } — Bach-style tr♯ / tr♭. trillUpperPitch ∈ {natural, sharp, flat, dblsharp, dblflat}. Omit to clear.
- setGraceNotes: { kind, target, graceNotes } — structured before-grace notes on the principal event. graceNotes is an array of grace moments (max 8). Each moment: { pitches: [{step,octave,accidental?}], duration: "eighth"|"sixteenth"|"32nd", slashed?: boolean }. Multiple pitches in one moment = grace CHORD; multiple moments = beamed RUN. slashed:true = acciaccatura. Grace pitches cannot be rests. Pass [] to clear (legacy ornament:"grace" becomes visible again as the fallback).
- setDynamic: { kind, target, dynamic } — dynamic ∈ {pppp, ppp, pp, p, mp, mf, f, ff, fff, ffff, n (niente), fp, fz, sfz, sffz, sfp, sfpp, rfz, rfp, fzp, none}. Pass 'none' to clear.
- setDynamicStructured: { kind, target, dynamic_structured? } — compound dynamic { base, prefix?, suffix? } e.g. {base:'p', prefix:'sub.', suffix:'espressivo'}. Omit to clear.
- setFermata: { kind, target, fermata? } — fermata ∈ {very-short, short, standard, long, very-long}. Omit to clear.
- setBarlineFermata: { kind, staffIdx?, measureIdx, barlineFermata? } — fermata on the closing barline of a measure (symphonic G.P.). Measure-level, NOT per-event. Omit barlineFermata to clear.
- setStartBarline: { kind, staffIdx?, measureIdx, barline? } — barline glyph at the LEFT edge of the measure. Kinds: thin / double / final / repeat-start / repeat-end / repeat-both / invisible / dashed. Use 'repeat-start' to open a repeat block. Omit barline to clear. See BARLINES_REFERENCE for the full vocabulary + repeat patterns.
- setEndBarline: { kind, staffIdx?, measureIdx, barline? } — barline glyph at the RIGHT edge of the measure. Same kinds. Use 'repeat-end' to close, 'final' for piece end, 'double' between sections, 'repeat-both' for back-to-back repeats sharing one barline. Omit to clear.
- setPickup: { kind, staffIdx?, measureIdx, isPickup } — mark measure as anacrusis (partial first bar). Boolean; false strips the field. validateScore loosens duration check when true.
- setFinalPartial: { kind, staffIdx?, measureIdx, isFinalPartial } — mark measure as closing partial that balances the pickup. Same shape as setPickup.
- setBreathMark: { kind, target, breathMark } — true to add the comma glyph, false to clear.
- setCaesura: { kind, target, caesura } — true to add the // pause, false to clear.
- setTremolo: { kind, target, tremolo? } — tremolo is { slashes: 1..5, measured?: boolean }. Omit to clear.
- setBowing: { kind, target, bowing? } — bowing ∈ {up, down}. Omit to clear. String-instrument lines only.
- setJazzInflection: { kind, target, jazzInflection? } — jazzInflection ∈ {fall, doit, scoop, plop, ghost}. Omit to clear. Jazz / big-band notation only.
- insertTechniqueChange: { kind, techniqueChange: { measureIdx, staffIdx, voiceIdx, kind: <technique>, eventIdx? } } — add a STATE-CHANGING performance-technique marker (pizz/arco/sul-ponticello/etc.) to score.techniqueStates. NOT per-event — these persist on the voice from their position forward. technique kind ∈ {pizz, arco, col-legno-battuto, col-legno-tratto, sul-ponticello, sul-tasto, flautando, ord, snap-pizz, LH-pizz, tremolo, mute-on, mute-off}. eventIdx is optional — omit to apply at the start of the measure. Don't emit an id — one is minted. Use ONLY on string-instrument lines.
- removeTechniqueChange: { kind, id } — remove a technique-state marker by its id (read the id from score.techniqueStates in the input JSON).
- setFingering: { kind, target, fingering } — set the per-pitch fingering at target.pitchIdx. target.pitchIdx is required. fingering is a tagged-union object: {system:"piano", value:"0"-"5", substitution?} | {system:"string", finger:0-4, stringRoman?:"I"-"IV"} | {system:"guitar-lh", value:1-4, stringNum?:1-6, fret?:Roman} | {system:"guitar-rh", value:"p"|"i"|"m"|"a"|"c"} | {system:"organ", value:"0"-"5", foot?:"heel"|"toe", thumbDirection?:"("|")"}. Lower-index pitches without an entry are auto-padded with null.
- removeFingering: { kind, target } — clear the fingering at target.pitchIdx; the slot becomes null and trailing nulls are trimmed.
- insertAnnotation: { kind, annotation: { measureIdx, eventIdx?, position, text, style, spanEnd? } } — add a score-level text annotation (rehearsal mark, tempo text, expression marking, plain comment). position ∈ {above, below, left, right}. style ∈ {plain, italic, bold, rehearsal-mark, tempo-text, expression}. eventIdx is optional — omit to anchor at the measure (common for rehearsal marks and tempo text). spanEnd is optional — set for line-extending forms like "rit. ____" / "accel. ____"; must extend FORWARD (spanEnd.measureIdx >= annotation.measureIdx). Don't emit an id — one is minted server-side.
- removeAnnotation: { kind, id } — remove an annotation by its id (read the id from score.annotations in the input JSON).
- updateAnnotation: { kind, id, patch: { text?, style?, target?, spanEnd? } } — patch an existing annotation by id. Any subset of fields. Pass spanEnd: null to clear an existing dashed-line span. Re-anchored target re-validated.
- setScoreMetadata: { kind, patch: { title?, composer?, arranger?, lyricist?, copyright? } } — patch score-level credit lines. Each field: null clears, undefined preserves, a string sets. Empty string '' is rejected (pass null to clear).
- insertMarker: { kind, marker: { measureIdx, key?, meter?, tempo_bpm?, tempo_text?, clefs?, metricModulation? } } — add a mid-piece marker at a measure boundary. At least ONE of key/meter/tempo_bpm/tempo_text/clefs/metricModulation must be set; empty markers are rejected. For a tempo change with a verbal label, set BOTH tempo_bpm and tempo_text on the same marker. metricModulation has shape { fromNote, toNote } with values from {half, dotted-half, quarter, dotted-quarter, eighth, dotted-eighth, sixteenth}. Don't emit an id — one is minted server-side.
- removeMarker: { kind, id } — remove a marker by its id (read the id from score.markers in the input JSON).
- updateMarker: { kind, id, patch: { measureIdx?, key?, meter?, tempo_bpm?, tempo_text?, clefs?, metricModulation? } } — patch an existing marker. Any field can be set to null to clear it; at least one active field must remain (use removeMarker to delete entirely).
- insertVolta: { kind, volta: { startMeasureIdx, endMeasureIdx, endings, endHook?, text? } } — add a 1st/2nd/Nth-time ending bracket to score.voltas. endings is an integer array 1..9 (e.g. [1] for 1st time, [2] for 2nd, [1,2] for both). MUST pair with repeat-start + repeat-end barlines on surrounding measures via setStartBarline/setEndBarline. The closing endBarline on endMeasureIdx must be NON-THIN (repeat-end / double / final) so abcjs closes the bracket. See VOLTAS_REFERENCE.
- removeVolta: { kind, id } — remove a volta by its id.
- updateVolta: { kind, id, patch: { startMeasureIdx?, endMeasureIdx?, endings?, endHook?, text? } } — patch an existing volta. Pass endHook / text as null to clear; start/end/endings can only be replaced.
- insertJumpMarker: { kind, jumpMarker: { measureIdx, side, kind: 'D.C.'|'D.S.'|'D.C. al Coda'|'D.S. al Coda'|'D.C. al Fine'|'D.S. al Fine'|'To Coda'|'Fine', segnoRef?, codaRef?, toCodaRef? } } — add a score-level navigation marker. D.S.* kinds REQUIRE segnoRef pointing at an existing SegnoMarker. *.al-Coda kinds SHOULD have codaRef pointing at an existing CodaMarker. side: "end" is the common case (the instruction fires at measure's end). Ref existence is validated against current score state. Don't emit an id — one is minted server-side. See JUMP_MARKERS_REFERENCE for the full vocabulary + playback semantics.
- removeJumpMarker: { kind, id } — remove a jumpMarker by id. Sweeps any inbound toCodaRef pointers on surviving entries so the surviving array has no dangling references.
- updateJumpMarker: { kind, id, patch: { measureIdx?, side?, kind?, segnoRef?, codaRef?, toCodaRef? } } — patch an existing jumpMarker. Pass any ref as null to clear; undefined preserves; a string sets and validates. The kind field is patchable (a misclassified D.C. can be promoted to D.C. al Coda without delete + insert). Self-referential toCodaRef rejected.
- setChordSymbol: { kind, target, chordSymbol? } — attach a structured lead-sheet chord symbol to the event. chordSymbol shape: { root, quality, seventh, extensions?, alterations?, add?, omit?, bass?, modal? }. Omit chordSymbol to clear (drops the field). See the CHORD_SYMBOLS_REFERENCE block for the full vocabulary + worked examples.
- insertHairpin: { kind, hairpin: { kind, startEventId, endEventId, staffIdx?, voiceIdx?, startDynamic?, endDynamic?, placement? } } — add a crescendo (kind:"hairpin-cresc") or diminuendo (kind:"hairpin-dim") wedge to score.spans. The startEventId / endEventId are stable ids from events in the input JSON; both must be in the SAME staff+voice, with start preceding (or equal to) end in score order. Optional terminal dynamics enable the "p<f" / "f>p" shorthand the renderer can attach at endpoint glyphs. Don't emit an id — one is minted server-side.
- removeHairpin: { kind, id } — remove a hairpin by its id (read from score.spans in the input JSON). Reject if the id points at a non-hairpin span.
- updateHairpin: { kind, id, patch: { kind?, startEventId?, endEventId?, startDynamic?, endDynamic?, placement? } } — patch an existing hairpin by id. Any subset of mutable fields. Pass startDynamic / endDynamic / placement as null to clear. Endpoint re-anchor (startEventId / endEventId in the patch) re-validates same-voice + order. staffIdx / voiceIdx follow the resolved start event and can't be patched independently.
- insertSlur: { kind, slur: { kind, startEventId, endEventId, staffIdx?, voiceIdx?, placement? } } — add a slur (kind:"slur") or phrase-slur (kind:"phrase-slur") legato curve to score.spans. Distinct from per-pitch ties (Pitch.tied_to_next): a tie joins same-pitch notes into one sustained sound, a slur is a phrasing curve across DIFFERENT pitches. Same id / location rules as insertHairpin. Slurs have NO terminal dynamics — they're phrasing, not loudness markings. Don't emit an id.
- removeSlur: { kind, id } — remove a slur by its id. Reject if the id points at a non-slur span (hairpin, glissando — those need their own ops).
- updateSlur: { kind, id, patch: { kind?, startEventId?, endEventId?, placement? } } — patch an existing slur by id. Any subset of mutable fields. Pass placement as null to clear. Endpoint re-anchor re-validates same-voice + order. staffIdx / voiceIdx follow the resolved start event and can't be patched independently.
- insertTempoSpan: { kind, tempoSpan: { kind, startEventId, endEventId, staffIdx?, voiceIdx?, placement?, endTempoBpm?, endTempoText? } } — add an accelerando (kind:"accel") or ritardando (kind:"rit") tempo line to score.spans. Renders as italic above-staff text at the start event ("accel." or "rit."), with an optional terminal label at the end (endTempoBpm renders as "♩=144"; endTempoText renders as the literal string like "a tempo"; both combine as "a tempo (♩=144)"). Same id / location rules as insertHairpin / insertSlur. Distinct from a sibling Marker with tempo_bpm — the span carries the visual continuity; the marker carries the discrete playback transition. Users often want both.
- removeTempoSpan: { kind, id } — remove a tempo span by id. Reject if the id points at a non-tempo span.
- updateTempoSpan: { kind, id, patch: { kind?, startEventId?, endEventId?, placement?, endTempoBpm?, endTempoText? } } — patch an existing tempo span. Any subset of mutable fields. Pass placement / endTempoBpm / endTempoText as null to clear (undefined preserves). Endpoint re-anchor re-validates same-voice + order. staffIdx / voiceIdx follow the resolved start event.
- insertOctaveSpan: { kind, octaveSpan: { kind, startEventId, endEventId, staffIdx?, voiceIdx?, placement? } } — add an octave-displacement line. kind ∈ {"8va","8vb","15ma","15mb"}: 8va = "ottava alta" (sounds 1 octave above print; printed line ABOVE the staff); 8vb = "ottava bassa" (1 octave below; line BELOW); 15ma / 15mb = two octaves up / down (rare; extreme registers like piccolo or contrabass). Default placement matches the kind axis (8va/15ma above, 8vb/15mb below); the explicit placement field overrides. NOT a transposition — the underlying pitch data stays at sounding-pitch; this span is purely a notational shorthand for "the player reads this region one octave above/below what's printed". Same id / location rules as hairpin / slur / tempoSpan.
- removeOctaveSpan: { kind, id } — remove an octave span by id. Reject if the id points at a non-octave span.
- updateOctaveSpan: { kind, id, patch: { kind?, startEventId?, endEventId?, placement? } } — patch an existing octave span. Endpoint re-anchor re-validates same-voice + order. staffIdx / voiceIdx follow the resolved start event.
- insertGlissando: { kind, glissando: { startEventId, endEventId, staffIdx?, voiceIdx?, placement?, glissStyle?, glissText? } } — add a glissando line between two notes (a pitch slide; jazz "fall" / "scoop"; classical "gliss." over a piano keyboard sweep). Single-kind family — no kind axis. Optional glissStyle ("straight"/"wavy") picks the visual variant (straight is the default; wavy is the classical/notational "port." portamento line). Optional glissText:true prepends the "gliss." text label at the start event. Same id / location rules as other spans.
- removeGlissando: { kind, id } — remove a glissando by id. Reject if the id points at a non-glissando span.
- updateGlissando: { kind, id, patch: { startEventId?, endEventId?, placement?, glissStyle?, glissText? } } — patch an existing glissando. Pass placement / glissStyle / glissText as null to clear. No kind field (single-kind family).
- insertTrillLine: { kind, trillLine: { startEventId, endEventId, staffIdx?, voiceIdx?, placement? } } — add a trill EXTENSION line (the wavy "tr~~~" continuation that follows a trill ornament across N notes). Pair with the trill ornament itself on the start event (set Event.ornament:"trill" via setOrnament). Same id / location rules as other spans.
- removeTrillLine: { kind, id } — remove a trill line by id. Reject if non-trill-line.
- updateTrillLine: { kind, id, patch: { startEventId?, endEventId?, placement? } } — patch an existing trill line. Pass placement as null to clear.
- insertTremoloBetween: { kind, tremoloBetween: { startEventId, endEventId, staffIdx?, voiceIdx?, placement? } } — add a fingered (between-note) tremolo. Two-endpoint span. Distinct from Event.tremolo (the SINGLE-NOTE repeated-tremolo with N slashes through the stem — M2-PR-1); this is the BETWEEN-TWO-NOTES alternation pattern ("trem." text above the pair). Same id / location rules as other spans.
- removeTremoloBetween: { kind, id } — remove a tremolo-between by id. Reject if non-tremolo-between.
- updateTremoloBetween: { kind, id, patch: { startEventId?, endEventId?, placement? } } — patch an existing tremolo-between. Pass placement as null to clear.
- setLyric: { kind, target, verse, syllable, hyphen?, extender? } — attach or replace a lyric syllable on the target event for the given verse (1..50). Use hyphen:true on every syllable EXCEPT the last of a multi-syllable word. Use extender:true to mark a melisma; mutually exclusive with hyphen. syllable text 1..40 chars; whitespace-only rejected; backslashes stripped. See LYRICS_REFERENCE for verse stacking + SATB divisi semantics.
- removeLyric: { kind, target, verse } — remove one verse's syllable. Idempotent if absent. Drops the lyrics field when the last verse is removed.
- clearLyrics: { kind, target } — drop the entire lyrics field on the target event. The "wipe all syllables" gesture.
- deleteEvent: { kind, target }
- insertEventAfter: { kind, target, event } — event has the shape { pitches: [{step, octave, accidental?}], duration }.
- addPitchToChord: { kind, target, pitch }
- removePitchFromChord: { kind, target, pitchIdx }
- reorderEvent: { kind, target, direction } — direction ∈ {left, right}.
- insertMeasureAfter: { kind, measureIdx } — Score-level; auto-fans-out across every voice on every staff so they stay bar-aligned. Emit ONE op.
- deleteMeasure: { kind, measureIdx } — Score-level; fans out. PREFER dragMeasureRange with mode:"delete" for new emissions — it also remaps spans + markers + voltas + jumpMarkers, while this legacy single-measure op does NOT (a known latent gap).
- duplicateMeasure: { kind, measureIdx } — Score-level; fans out. PREFER dragMeasureRange with mode:"duplicate" for new emissions — it mints fresh event ids on the copies so spans referencing the originals stay deterministically attached.
- dragMeasureRange: { kind, mode, fromStart, fromEnd, toAfter? } — Score-level RANGE op for delete / move / duplicate. fromStart..fromEnd is inclusive. toAfter is required for move + duplicate (use -1 to insert BEFORE measure 0). Fans out across every (staff, voice) line so they stay bar-aligned. Span semantics: on mode:"move", spans whose endpoints both live INSIDE the range survive (event ids preserved across the splice); on mode:"delete", severed / inside spans are dropped; on mode:"duplicate", the COPIED bars have NO span attachments (the originals' spans are untouched). Score-level entries (markers / voltas / jumpMarkers / annotations / techniqueStates) inside the range MOVE with it on mode:"move" (straddling voltas + annotations are dropped); on mode:"duplicate" they are NOT cloned. mode:"move" rejects toAfter inside [fromStart-1..fromEnd] (no-op); mode:"duplicate" allows toAfter anywhere in [-1..measureCount-1] (interleaves with originals).
- changeClef: { kind, clef, staffIdx? } — Switches one staff's clef without changing pitches.
- addStaff: { kind, clef } — Add a second staff (must NOT already have one). Mirrors the primary staff's bar layout with whole rests.
- removeStaff: { kind, staffIdx } — Must be 1; the primary staff can't be removed.
- addVoice: { kind, staffIdx } — Append an empty extra voice to the staff (cap: 3 extras per staff, for 4 voices total). Fills with meter-sized rests.
- removeVoice: { kind, staffIdx, voiceIdx } — voiceIdx must be ≥ 1 (the primary voice can't be removed — remove the staff instead).

WORKED EXAMPLES:

User wants: "raise the alto's third note up a step" on an SATB score.
The Alto is staff 0 voice 1 (per SATB convention above). The third note has eventIdx=2.
{"ops":[{"kind":"changePitch","target":{"staffIdx":0,"voiceIdx":1,"measureIdx":0,"eventIdx":2},"deltaStep":1}]}

User wants: "delete the last note in the bass-clef staff's first measure" on a grand-staff piano score.
Bass clef is staff 1, voice 0. Find the last eventIdx of measure 0 (look at the JSON).
{"ops":[{"kind":"deleteEvent","target":{"staffIdx":1,"voiceIdx":0,"measureIdx":0,"eventIdx":3}}]}

User wants: "add staccato + accent to the second note of bar 1".
The note has measureIdx=0, eventIdx=1. Stacked articulations use setArticulations.
{"ops":[{"kind":"setArticulations","target":{"measureIdx":0,"eventIdx":1},"articulations":["staccato","accent"]}]}

User wants: "add sub. p espressivo to the downbeat of bar 3".
Downbeat = eventIdx 0 of measureIdx 2. Compound dynamics use setDynamicStructured.
{"ops":[{"kind":"setDynamicStructured","target":{"measureIdx":2,"eventIdx":0},"dynamic_structured":{"base":"p","prefix":"sub.","suffix":"espressivo"}}]}

User wants: "put a fermata on the last note and a G.P. fermata over the closing barline of bar 4".
Two ops: setFermata on the event, setBarlineFermata on the measure.
{"ops":[
  {"kind":"setFermata","target":{"measureIdx":3,"eventIdx":2},"fermata":"standard"},
  {"kind":"setBarlineFermata","measureIdx":3,"barlineFermata":"long"}
]}

User wants: "tie just the top note of the chord in bar 2 over to bar 3" (a chord stack).
Per-pitch tie targets the specific pitchIdx of the top note (the highest pitch in the sorted chord).
{"ops":[{"kind":"setPitchTie","target":{"measureIdx":1,"eventIdx":0,"pitchIdx":2},"tied_to_next":true}]}

User wants: "switch to pizz at the start of bar 5 and back to arco at bar 9" on a cello part.
Two insertTechniqueChange ops; cello is single-staff so staffIdx=0 voiceIdx=0; the markers persist forward until cancelled.
{"ops":[
  {"kind":"insertTechniqueChange","techniqueChange":{"measureIdx":4,"staffIdx":0,"voiceIdx":0,"kind":"pizz"}},
  {"kind":"insertTechniqueChange","techniqueChange":{"measureIdx":8,"staffIdx":0,"voiceIdx":0,"kind":"arco"}}
]}

User wants: "remove that pizz marker at bar 5" (techniqueStates already in the score JSON).
Find the entry's id in the score JSON and emit removeTechniqueChange.
{"ops":[{"kind":"removeTechniqueChange","id":"abc1234567"}]}

User wants: "fingering the C-E-G chord in bar 1 with 1-3-5 (piano)" on a piano grand-staff score.
Three setFingering ops — one per pitch. The chord lives on staff 0 measure 0 event 0 with three pitches sorted ascending (C=0, E=1, G=2).
{"ops":[
  {"kind":"setFingering","target":{"staffIdx":0,"measureIdx":0,"eventIdx":0,"pitchIdx":0},"fingering":{"system":"piano","value":"1"}},
  {"kind":"setFingering","target":{"staffIdx":0,"measureIdx":0,"eventIdx":0,"pitchIdx":1},"fingering":{"system":"piano","value":"3"}},
  {"kind":"setFingering","target":{"staffIdx":0,"measureIdx":0,"eventIdx":0,"pitchIdx":2},"fingering":{"system":"piano","value":"5"}}
]}

User wants: "remove the fingering on the third note of bar 2" (a monophonic violin line).
The third note is eventIdx=2 in measureIdx=1; monophonic so pitchIdx=0.
{"ops":[{"kind":"removeFingering","target":{"measureIdx":1,"eventIdx":2,"pitchIdx":0}}]}

User wants: "add a grace D before the C in bar 1" (Classical acciaccatura).
Single before-grace, slashed (the Classical/Romantic default for a one-note grace).
{"ops":[{"kind":"setGraceNotes","target":{"measureIdx":0,"eventIdx":0},"graceNotes":[{"pitches":[{"step":"D","octave":5,"accidental":"none"}],"duration":"eighth","slashed":true}]}]}

User wants: "a grace-note approach A-B-C into the principal D in bar 2" (beamed run, 3 grace moments).
Three entries in the array — each is a single grace pitch — gives the beamed run; durations sixteenth feels right for a 3-note run.
{"ops":[{"kind":"setGraceNotes","target":{"measureIdx":1,"eventIdx":0},"graceNotes":[
  {"pitches":[{"step":"A","octave":4,"accidental":"none"}],"duration":"sixteenth"},
  {"pitches":[{"step":"B","octave":4,"accidental":"none"}],"duration":"sixteenth"},
  {"pitches":[{"step":"C","octave":5,"accidental":"none"}],"duration":"sixteenth"}
]}]}

User wants: "remove the grace notes from the downbeat of bar 3".
Pass an empty graceNotes array — strips the field; legacy ornament:"grace" (if set) becomes the renderer fallback.
{"ops":[{"kind":"setGraceNotes","target":{"measureIdx":2,"eventIdx":0},"graceNotes":[]}]}

User wants: "add a rehearsal mark A at the start of bar 3".
Measure-level annotation (no eventIdx) for the boxed letter at the section start.
{"ops":[{"kind":"insertAnnotation","annotation":{"measureIdx":2,"position":"above","text":"A","style":"rehearsal-mark"}}]}

User wants: "label bar 1 'Allegro con brio'" (tempo text + character word).
The Allegro is bold roman tempo text; "con brio" can fold in as italic expression — but standard engraving keeps both in one combined tempo-text string.
{"ops":[{"kind":"insertAnnotation","annotation":{"measureIdx":0,"position":"above","text":"Allegro con brio","style":"tempo-text"}}]}

User wants: "add a rit. from the third note of bar 5 to the downbeat of bar 6".
Expression annotation with spanEnd — the renderer extends a dashed line.
{"ops":[{"kind":"insertAnnotation","annotation":{"measureIdx":4,"eventIdx":2,"position":"above","text":"rit.","style":"expression","spanEnd":{"measureIdx":5,"eventIdx":0}}}]}

User wants: "set the composer to J. S. Bach and the copyright to Public Domain".
setScoreMetadata patches one or more credit fields atomically. Pass undefined / omit untouched fields; pass null to clear; pass a string to set.
{"ops":[{"kind":"setScoreMetadata","patch":{"composer":"J. S. Bach","copyright":"Public Domain"}}]}

User wants: "change tempo to Allegro (140 bpm) at bar 5".
insertMarker with tempo_bpm + tempo_text on the same marker so undo brings both back together.
{"ops":[{"kind":"insertMarker","marker":{"measureIdx":4,"tempo_bpm":140,"tempo_text":"Allegro"}}]}

User wants: "switch to 3/4 at bar 9" (mid-piece meter change).
{"ops":[{"kind":"insertMarker","marker":{"measureIdx":8,"meter":"3/4"}}]}

User wants: "metric modulation at bar 10: quarter note = dotted quarter, new tempo 80".
{"ops":[{"kind":"insertMarker","marker":{"measureIdx":9,"tempo_bpm":80,"metricModulation":{"fromNote":"quarter","toNote":"dotted-quarter"}}}]}

User wants: "remove the tempo change at bar 5" (marker already in score.markers).
Find the marker's id in the score JSON and emit removeMarker.
{"ops":[{"kind":"removeMarker","id":"abc1234567"}]}

User wants: "label the downbeat of bar 1 as Cmaj7".
Per-event chord symbol on the first event of measure 0. Build the structured chord directly — root C, quality major, seventh maj7.
{"ops":[{"kind":"setChordSymbol","target":{"measureIdx":0,"eventIdx":0},"chordSymbol":{"root":"C","quality":"major","seventh":"maj7"}}]}

User wants: "add a slash chord C/E to beat 2 of bar 3".
chordSymbol.bass uses type:"note" for slash chords (single bass note).
{"ops":[{"kind":"setChordSymbol","target":{"measureIdx":2,"eventIdx":1},"chordSymbol":{"root":"C","quality":"major","seventh":"none","bass":{"type":"note","value":"E"}}}]}

User wants: "clear the chord symbol on bar 2 beat 4".
Omit the chordSymbol field to clear.
{"ops":[{"kind":"setChordSymbol","target":{"measureIdx":1,"eventIdx":3}}]}

User wants: "add a crescendo from bar 1 beat 1 to bar 4 beat 4, p to f".
Hairpin span with terminal dynamics. Read the event ids from the input JSON — bar 1 beat 1 = measureIdx 0 eventIdx 0, bar 4 beat 4 = measureIdx 3 eventIdx 3 (whatever ids those carry).
{"ops":[{"kind":"insertHairpin","hairpin":{"kind":"hairpin-cresc","startEventId":"<id-of-m0e0>","endEventId":"<id-of-m3e3>","startDynamic":"p","endDynamic":"f"}}]}

User wants: "remove the diminuendo at bar 5" (hairpin already in score.spans).
Find the hairpin's id in score.spans and emit removeHairpin.
{"ops":[{"kind":"removeHairpin","id":"abc1234567"}]}

User wants: "slur the first four notes of bar 1" (instrumental legato).
Slur span addressing the start (m1 b1) and end (m1 b4) events. Plain slur — phrase-slur is reserved for longer broader curves.
{"ops":[{"kind":"insertSlur","slur":{"kind":"slur","startEventId":"<id-of-m0e0>","endEventId":"<id-of-m0e3>"}}]}

User wants: "add a phrase mark above the vocal line from bar 5 through bar 8" (vocal phrase).
Phrase-slur (longer/broader curve) with placement:"above" — standard for vocal phrasing.
{"ops":[{"kind":"insertSlur","slur":{"kind":"phrase-slur","startEventId":"<id-of-m4e0>","endEventId":"<id-of-m7-last>","placement":"above"}}]}

User wants: "tie those four notes together" (colloquial use of "tie" over DIFFERENT pitches).
The user is asking for a slur, NOT per-pitch ties. Ties only connect adjacent notes of the SAME pitch into one sustained sound; when the notes are different pitches, the user means a slur (legato curve). Emit insertSlur, not setPitchTie.
{"ops":[{"kind":"insertSlur","slur":{"kind":"slur","startEventId":"<id-of-m0e0>","endEventId":"<id-of-m0e3>"}}]}

User wants: "accelerando from bar 5 to bar 8".
Tempo span with kind:"accel". No terminal tempo — the player decides the new pulse.
{"ops":[{"kind":"insertTempoSpan","tempoSpan":{"kind":"accel","startEventId":"<id-of-m4e0>","endEventId":"<id-of-m7-last>"}}]}

User wants: "ritardando into ♩=60 at bar 12".
Tempo span with kind:"rit" + endTempoBpm. Start event is whatever event the user wants the "rit." text to appear over (typically the start of the slowdown); end event is the last note before the target tempo.
{"ops":[{"kind":"insertTempoSpan","tempoSpan":{"kind":"rit","startEventId":"<id-of-m10e0>","endEventId":"<id-of-m11-last>","endTempoBpm":60}}]}

User wants: "slow down to a tempo at bar 9".
Tempo span with kind:"rit" + endTempoText "a tempo". Combined text + BPM is "a tempo (♩=120)" — set both fields.
{"ops":[{"kind":"insertTempoSpan","tempoSpan":{"kind":"rit","startEventId":"<id-of-m7e0>","endEventId":"<id-of-m8-last>","endTempoText":"a tempo","endTempoBpm":120}}]}

User wants: "play the right hand an octave higher from bar 5 through bar 8" (piano 8va).
Octave-span with kind:"8va". Default placement is above (correct for 8va by convention). The underlying pitch data stays at sounding pitch — the renderer just paints the "^8va" abbreviation above the range.
{"ops":[{"kind":"insertOctaveSpan","octaveSpan":{"kind":"8va","startEventId":"<id-of-m4e0>","endEventId":"<id-of-m7-last>"}}]}

User wants: "drop the bass an octave down for the second half of bar 3" (piano bass 8vb).
8vb means octave-down line below the staff (default placement: below).
{"ops":[{"kind":"insertOctaveSpan","octaveSpan":{"kind":"8vb","startEventId":"<id-of-m2e2>","endEventId":"<id-of-m2-last>","staffIdx":1}}]}

User wants: "add a glissando from the C in bar 1 to the G in bar 2" (jazz fall / classical pitch slide).
Glissando span. Default visual is straight; add glissText:true for the "gliss." text label.
{"ops":[{"kind":"insertGlissando","glissando":{"startEventId":"<id-of-m0e3>","endEventId":"<id-of-m1e0>","glissText":true}}]}

User wants: "trill extension from beat 1 of bar 4 through the end of bar 5" (a trill that sustains across N notes).
TWO ops: setOrnament on the start event to add the "tr" glyph, then insertTrillLine for the wavy continuation.
{"ops":[
  {"kind":"setOrnament","target":{"measureIdx":3,"eventIdx":0},"ornament":"trill"},
  {"kind":"insertTrillLine","trillLine":{"startEventId":"<id-of-m3e0>","endEventId":"<id-of-m4-last>"}}
]}

User wants: "tremolo between the C and the G in bar 1" (fingered tremolo: fast alternation between TWO notes).
Tremolo-between span. NOT to be confused with Event.tremolo (single-note repeated tremolo via slashes through the stem — use setTremolo for that).
{"ops":[{"kind":"insertTremoloBetween","tremoloBetween":{"startEventId":"<id-of-m0e0>","endEventId":"<id-of-m0e1>"}}]}

User wants: "add lyrics 'A-ma-zing grace' to the first four notes".
Hyphenated continuation on the first 3 syllables, plain syllable on the 4th. Multi-op patch.
{"ops":[
  {"kind":"setLyric","target":{"measureIdx":0,"eventIdx":0},"verse":1,"syllable":"A","hyphen":true},
  {"kind":"setLyric","target":{"measureIdx":0,"eventIdx":1},"verse":1,"syllable":"ma","hyphen":true},
  {"kind":"setLyric","target":{"measureIdx":0,"eventIdx":2},"verse":1,"syllable":"zing"},
  {"kind":"setLyric","target":{"measureIdx":0,"eventIdx":3},"verse":1,"syllable":"grace"}
]}

User wants: "add a second verse 'Earth and all stars' under the existing lyrics".
verse:2 syllables stack BELOW the verse:1 line under the same notes.
{"ops":[
  {"kind":"setLyric","target":{"measureIdx":0,"eventIdx":0},"verse":2,"syllable":"Earth"},
  {"kind":"setLyric","target":{"measureIdx":0,"eventIdx":1},"verse":2,"syllable":"and"},
  {"kind":"setLyric","target":{"measureIdx":0,"eventIdx":2},"verse":2,"syllable":"all"},
  {"kind":"setLyric","target":{"measureIdx":0,"eventIdx":3},"verse":2,"syllable":"stars"}
]}

User wants: "remove the lyrics from bar 3 beat 2".
clearLyrics drops the entire field (all verses on that event). For one-verse-only removal, use removeLyric with the verse number instead.
{"ops":[{"kind":"clearLyrics","target":{"measureIdx":2,"eventIdx":1}}]}

User wants: "make bar 4 start a repeat block that ends at bar 8".
Pair startBarline:'repeat-start' on the opening measure with endBarline:'repeat-end' on the closing measure.
{"ops":[
  {"kind":"setStartBarline","measureIdx":3,"barline":"repeat-start"},
  {"kind":"setEndBarline","measureIdx":7,"barline":"repeat-end"}
]}

User wants: "end the piece with a final barline".
{"ops":[{"kind":"setEndBarline","measureIdx":15,"barline":"final"}]}

User wants: "the first measure is a pickup beat".
isPickup loosens validateScore's duration check so a short first bar passes. The measure itself must contain fewer beats than the meter (e.g. one quarter in 4/4).
{"ops":[{"kind":"setPickup","measureIdx":0,"isPickup":true}]}

User wants: "add a 1st-time and 2nd-time ending to the dance phrase (bars 1-4)".
Pair voltas with repeat-block barlines. The 1st ending closes with a repeat-end barline so abcjs jumps back to the repeat-start; the 2nd ending closes with a final barline.
{"ops":[
  {"kind":"setStartBarline","measureIdx":0,"barline":"repeat-start"},
  {"kind":"insertVolta","volta":{"startMeasureIdx":2,"endMeasureIdx":2,"endings":[1]}},
  {"kind":"setEndBarline","measureIdx":2,"barline":"repeat-end"},
  {"kind":"insertVolta","volta":{"startMeasureIdx":3,"endMeasureIdx":3,"endings":[2]}},
  {"kind":"setEndBarline","measureIdx":3,"barline":"final"}
]}

User wants: "remove the 1st-ending bracket at bar 3" (existing volta).
removeVolta by id (read from score.voltas[]).
{"ops":[{"kind":"removeVolta","id":"abc1234567"}]}

User wants: "add a D.C. at the end" (8-bar piece, no segno needed).
A bare D.C. is the simplest "go back to the top" instruction. side: "end" on the final measure fires at the end of m=7. Mint a unique 10-char id for the new jumpMarker.
{"ops":[{"kind":"insertJumpMarker","jumpMarker":{"id":"jumpdc0001","measureIdx":7,"side":"end","kind":"D.C."}}]}

User wants: "add D.S. al Coda at bar 16" — the Segno + Coda landmarks ALREADY EXIST in score.segnoMarkers / score.codaMarkers (the LLM reads their ids from the input JSON). To Coda at bar 12 gates the post-jump hop.
NOTE: Segno + Coda landmarks must be authored via the render_score path or be present in the existing score. The intra-measure edit pipeline does not yet expose ops to CREATE Segno / Coda landmarks; the LLM should look them up by id in the input score.
{"ops":[
  {"kind":"insertJumpMarker","jumpMarker":{"id":"tocoda0001","measureIdx":11,"side":"end","kind":"To Coda"}},
  {"kind":"insertJumpMarker","jumpMarker":{"id":"dsalcoda01","measureIdx":15,"side":"end","kind":"D.S. al Coda","segnoRef":"<id from score.segnoMarkers>","codaRef":"<id from score.codaMarkers>"}}
]}

User wants: "remove the D.C. at the end" (existing jumpMarker).
{"ops":[{"kind":"removeJumpMarker","id":"jumpabcd01"}]}

User wants: "promote the D.C. to D.C. al Fine and add a Fine at bar 4".
updateJumpMarker patches the kind (so the existing jump is repurposed) + adds the Fine landmark via a second op. Mint a fresh id for the new Fine.
{"ops":[
  {"kind":"updateJumpMarker","id":"jumpabcd01","patch":{"kind":"D.C. al Fine"}},
  {"kind":"insertJumpMarker","jumpMarker":{"id":"finetag001","measureIdx":3,"side":"end","kind":"Fine"}}
]}

User wants: "delete bars 5-8" (4-bar range removal).
dragMeasureRange with mode:"delete" remaps any spans + markers + voltas + jumpMarkers + annotations that reference measures after the deleted range. fromStart and fromEnd are 0-indexed and inclusive — bars 5-8 (1-indexed) → fromStart 4, fromEnd 7.
{"ops":[{"kind":"dragMeasureRange","mode":"delete","fromStart":4,"fromEnd":7}]}

User wants: "move bars 9-12 to right after bar 4" (rearrange).
mode:"move" — toAfter is the destination position in the ORIGINAL layout (so toAfter=3 means insert AFTER bar 4 in 1-indexed terms). Event ids are preserved so any spans crossing the moved range stay valid (just visually farther apart).
{"ops":[{"kind":"dragMeasureRange","mode":"move","fromStart":8,"fromEnd":11,"toAfter":3}]}

User wants: "duplicate bar 4 at the end of the piece" (in a 12-bar score).
mode:"duplicate" — the copy gets fresh event ids. toAfter=11 places the copy AFTER the last existing bar (12 in 1-indexed terms).
{"ops":[{"kind":"dragMeasureRange","mode":"duplicate","fromStart":3,"fromEnd":3,"toAfter":11}]}

User wants: "double the first 4 bars" (repeat a section in place).
mode:"duplicate" with toAfter=fromEnd places the copy immediately after the source. Result: bars [1,2,3,4, 1',2',3',4', 5,6,...].
{"ops":[{"kind":"dragMeasureRange","mode":"duplicate","fromStart":0,"fromEnd":3,"toAfter":3}]}

CONSTRAINTS:
- The SCORE-WIDE key / meter / tempo_bpm / clef on the Score root are NOT in scope here — those are handled by a separate score-level code path (changeKey / changeMeter / changeTempo / changeClef). MID-PIECE changes (e.g. "switch to 3/4 at bar 9") go through insertMarker in this handler. Use setScoreMetadata for title / composer / arranger / lyricist / copyright (this handler is fine for those).
- If your op targets a non-existent (staffIdx, voiceIdx), validation will fail with a descriptive error and you'll be asked to retry. Read the score JSON before you target.
- "Add a bass line / melody / harmony / inner voice / left-hand part" to EXISTING bars means WRITE NOTES INTO THE EXISTING STAFF — on a grand staff the bass clef is staffIdx 1. Change that staff's rests into notes (changePitch / setAccidental / changeDuration) or insertEventAfter. Do NOT addStaff or addVoice for this: a grand staff ALREADY HAS its two staves. addStaff is ONLY for promoting a single-staff score to a grand staff (it fails if a second staff already exists); addVoice is ONLY for a genuinely independent extra voice the user explicitly asked for.

Emit the minimal ops to fulfill the request. Do not include explanatory text — the tool call IS your response.`

// Tool input zod schema — accepts any Operation shape; semantic
// validation happens when ops are applied. Empty array allowed at the
// parse level so we can distinguish "no ops" from "schema error".
const EditScoreInputSchema = z.object({ ops: z.array(z.unknown()) })

export function buildEditScoreSchemaJson(score: Score): Record<string, unknown> {
  const maxMeasureIdx = Math.max(0, getMeasureCount(score) - 1)
  const maxStaffIdx = Math.max(0, getStaffCount(score) - 1)
  // voiceIdx is bounded by a constant max (3 = SATB cap) rather than
  // per-staff. JSON Schema can't condition voiceIdx on a sibling
  // staffIdx field, and per-staff oneOf branches would balloon the
  // schema. transformScore (editOperations.ts:assertVoiceExists)
  // enforces the real bound and throws a descriptive error that the
  // retry pipeline feeds back to the model.
  const MAX_VOICE_IDX = 3
  return {
    type: 'object',
    properties: {
      ops: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            target: {
              type: 'object',
              properties: {
                staffIdx: { type: 'integer', minimum: 0, maximum: maxStaffIdx },
                voiceIdx: { type: 'integer', minimum: 0, maximum: MAX_VOICE_IDX },
                measureIdx: { type: 'integer', minimum: 0, maximum: maxMeasureIdx },
                eventIdx: { type: 'integer', minimum: 0 },
                pitchIdx: { type: 'integer', minimum: 0 },
              },
            },
            staffIdx: { type: 'integer', minimum: 0, maximum: maxStaffIdx },
            measureIdx: { type: 'integer', minimum: 0, maximum: maxMeasureIdx },
            direction: { type: 'string', enum: ['left', 'right'] },
            duration: {
              type: 'string',
              enum: ['whole', 'half', 'quarter', 'eighth', 'sixteenth', '32nd', 'dotted-half', 'dotted-quarter', 'dotted-eighth'],
            },
            accidental: { type: 'string', enum: ['natural', 'sharp', 'flat', 'dblsharp', 'dblflat', 'none'] },
            articulation: {
              type: 'string',
              enum: ['staccato', 'accent', 'tenuto', 'marcato', 'portato', 'none'],
            },
            articulations: {
              type: 'array',
              maxItems: 4,
              items: {
                // 'none' is intentionally excluded — to clear, the LLM
                // passes [] (the contract documented in
                // INTRA_SYSTEM_PROMPT). Allowing 'none' inside the
                // array invites confusing "stacks" like
                // ['staccato','none'] that normalizeArticulations would
                // filter to ['staccato'] anyway.
                type: 'string',
                enum: ['staccato', 'accent', 'tenuto', 'marcato', 'portato'],
              },
            },
            ornament: {
              type: 'string',
              enum: [
                'trill', 'pralltriller', 'mordent', 'upper-mordent', 'lower-mordent',
                'schneller', 'turn', 'inverted-turn', 'delayed-turn', 'slide',
                'arpeggio-up', 'arpeggio-down', 'non-arpeggio', 'grace', 'none',
              ],
            },
            trillUpperPitch: {
              type: 'string',
              enum: ['natural', 'sharp', 'flat', 'dblsharp', 'dblflat'],
            },
            dynamic: {
              type: 'string',
              enum: [
                'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff',
                'n',
                'fp', 'fz', 'sfz', 'sffz', 'sfp', 'sfpp', 'rfz', 'rfp', 'fzp',
                'none',
              ],
            },
            dynamic_structured: {
              type: 'object',
              properties: {
                base: {
                  type: 'string',
                  enum: [
                    'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff',
                    'n',
                    'fp', 'fz', 'sfz', 'sffz', 'sfp', 'sfpp', 'rfz', 'rfp', 'fzp',
                    'none',
                  ],
                },
                prefix: { type: 'string', enum: ['sub.', 'poco', 'meno', 'più'] },
                suffix: { type: 'string' },
              },
              required: ['base'],
            },
            fermata: {
              type: 'string',
              enum: ['very-short', 'short', 'standard', 'long', 'very-long'],
            },
            barlineFermata: {
              type: 'string',
              enum: ['very-short', 'short', 'standard', 'long', 'very-long'],
            },
            // Barline scalars (M16-PR-3). barline enum references
            // BARLINE_KINDS (single source of truth) so a future 9th
            // BarlineSchema value fails the sync-pin test in
            // editIntraMeasure.barlineSchema.test.ts instead of
            // silently skipping. isPickup / isFinalPartial are flat
            // booleans on Measure. Like all op-bag fields, these are
            // permissive — the post-call validator + the op-handler
            // bounds-check measureIdx.
            barline: {
              type: 'string',
              enum: [...BARLINE_KINDS],
            },
            isPickup: { type: 'boolean' },
            isFinalPartial: { type: 'boolean' },
            breathMark: { type: 'boolean' },
            caesura: { type: 'boolean' },
            tremolo: {
              type: 'object',
              properties: {
                slashes: { type: 'integer', enum: [1, 2, 3, 4, 5] },
                measured: { type: 'boolean' },
              },
              required: ['slashes'],
            },
            bowing: { type: 'string', enum: ['up', 'down'] },
            jazzInflection: {
              type: 'string',
              enum: ['fall', 'doit', 'scoop', 'plop', 'ghost'],
            },
            tied_to_next: { type: 'boolean' },
            lv: { type: 'boolean' },
            enharmonicTie: { type: 'boolean' },
            clef: { type: 'string', enum: ['treble', 'bass'] },
            deltaStep: { type: 'integer' },
            deltaOctave: { type: 'integer' },
            pitchIdx: { type: 'integer', minimum: 0 },
            event: { type: 'object' },
            pitch: { type: 'object' },
            title: { type: 'string' },
            // Per-pitch fingering for setFingering. The discriminator
            // here lives on the inner `system` field; the schema is
            // permissive (one of five system shapes) and the post-call
            // zod validator enforces the per-system field constraints.
            fingering: {
              type: 'object',
              properties: {
                system: {
                  type: 'string',
                  enum: ['piano', 'string', 'guitar-lh', 'guitar-rh', 'organ'],
                },
                // piano + organ + guitar-rh use string `value`; string
                // and guitar-lh use integer `finger` / `value`. The
                // bag accepts both; per-system validation catches the
                // shape mismatch after the call.
                value: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'integer' },
                  ],
                },
                finger: { type: 'integer' },
                substitution: { type: 'string' },
                stringRoman: { type: 'string', enum: ['I', 'II', 'III', 'IV'] },
                stringNum: { type: 'integer', enum: [1, 2, 3, 4, 5, 6] },
                fret: { type: 'string' },
                foot: { type: 'string', enum: ['heel', 'toe'] },
                thumbDirection: { type: 'string', enum: ['(', ')'] },
              },
              required: ['system'],
            },
            // Structured before-grace notes (M7-PR-1..PR-3). Array of
            // grace moments; each moment has pitches + duration +
            // optional slashed flag. Pass [] to clear (the optional-
            // bag schema accepts empty arrays). Post-call zod enforces
            // the no-rest grace pitch refine and max:8 grace moments.
            graceNotes: {
              type: 'array',
              maxItems: 8,
              items: {
                type: 'object',
                properties: {
                  pitches: {
                    type: 'array',
                    maxItems: 6,
                    items: {
                      type: 'object',
                      properties: {
                        step: { type: 'string', enum: ['C', 'D', 'E', 'F', 'G', 'A', 'B'] },
                        octave: { type: 'integer' },
                        accidental: {
                          type: 'string',
                          enum: ['natural', 'sharp', 'flat', 'dblsharp', 'dblflat', 'none'],
                        },
                      },
                      required: ['step', 'octave'],
                    },
                  },
                  duration: { type: 'string', enum: ['eighth', 'sixteenth', '32nd'] },
                  slashed: { type: 'boolean' },
                },
                required: ['pitches', 'duration'],
              },
            },
            // Lyric edit-op scalars (M15-PR-3). setLyric / removeLyric
            // accept these as top-level op fields (NOT nested under a
            // sub-object). The shared op-bag schema is permissive;
            // the post-call editOperations.ts handler bounds-checks
            // verse + syllable length and rejects engraving-nonsense
            // (whitespace-only syllable, hyphen+extender both true).
            verse: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
              description: 'Lyric verse number (1..50). Verse 1 is the primary line; 2+ stack below.',
            },
            syllable: {
              type: 'string',
              minLength: 1,
              maxLength: 40,
              description: 'Lyric syllable text. Whitespace-only is rejected; backslashes are stripped.',
            },
            hyphen: {
              type: 'boolean',
              description: 'Lyric continuation flag: true on every syllable EXCEPT the last of a multi-syllable word. Mutually exclusive with extender.',
            },
            extender: {
              type: 'boolean',
              description: 'Lyric melisma flag: true on a syllable that holds across following notes. Mutually exclusive with hyphen.',
            },
            // Score-level performance-technique state (M3-PR-2).
            // techniqueChange.kind is the technique vocabulary; the
            // outer op.kind is the operation discriminant. The two
            // namespaces don't collide because the schema is one big
            // optional bag — buildEditScoreSchemaJson doesn't refine
            // per op.kind.
            techniqueChange: {
              type: 'object',
              properties: {
                measureIdx: { type: 'integer', minimum: 0, maximum: maxMeasureIdx },
                eventIdx: { type: 'integer', minimum: 0 },
                staffIdx: { type: 'integer', minimum: 0, maximum: maxStaffIdx },
                voiceIdx: { type: 'integer', minimum: 0, maximum: MAX_VOICE_IDX },
                kind: {
                  type: 'string',
                  enum: [
                    'pizz', 'arco', 'col-legno-battuto', 'col-legno-tratto',
                    'sul-ponticello', 'sul-tasto', 'flautando', 'ord',
                    'snap-pizz', 'LH-pizz', 'tremolo', 'mute-on', 'mute-off',
                  ],
                },
              },
              required: ['measureIdx', 'staffIdx', 'voiceIdx', 'kind'],
            },
            // Annotation insert payload (M8-PR-2). Bounds re-validated
            // post-call against the live score; the optional-bag schema
            // doesn't refine measureIdx/eventIdx against extant counts.
            annotation: {
              type: 'object',
              properties: {
                measureIdx: { type: 'integer', minimum: 0, maximum: maxMeasureIdx },
                eventIdx: { type: 'integer', minimum: 0 },
                position: { type: 'string', enum: ['above', 'below', 'left', 'right'] },
                text: { type: 'string' },
                style: {
                  type: 'string',
                  enum: ['plain', 'italic', 'bold', 'rehearsal-mark', 'tempo-text', 'expression'],
                },
                spanEnd: {
                  type: 'object',
                  properties: {
                    measureIdx: { type: 'integer', minimum: 0, maximum: maxMeasureIdx },
                    eventIdx: { type: 'integer', minimum: 0 },
                  },
                  required: ['measureIdx'],
                },
              },
              required: ['measureIdx', 'position', 'text', 'style'],
            },
            // updateAnnotation patch payload — any subset of mutable
            // fields. spanEnd accepts null at runtime (clear); the
            // JSON-schema layer can't express the union with null
            // cleanly so we leave it as an object that the op layer
            // post-validates.
            patch: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                style: {
                  type: 'string',
                  enum: ['plain', 'italic', 'bold', 'rehearsal-mark', 'tempo-text', 'expression'],
                },
                target: {
                  type: 'object',
                  properties: {
                    measureIdx: { type: 'integer', minimum: 0, maximum: maxMeasureIdx },
                    eventIdx: { type: 'integer', minimum: 0 },
                    position: { type: 'string', enum: ['above', 'below', 'left', 'right'] },
                  },
                  required: ['measureIdx', 'position'],
                },
                spanEnd: {
                  type: ['object', 'null'],
                  properties: {
                    measureIdx: { type: 'integer', minimum: 0, maximum: maxMeasureIdx },
                    eventIdx: { type: 'integer', minimum: 0 },
                  },
                },
                // Score metadata fields share the patch slot since the
                // schema is one optional bag — setScoreMetadata.patch
                // and updateAnnotation.patch don't collide on these
                // because their op.kind discriminator separates them.
                title: { type: ['string', 'null'] },
                composer: { type: ['string', 'null'] },
                arranger: { type: ['string', 'null'] },
                lyricist: { type: ['string', 'null'] },
                copyright: { type: ['string', 'null'] },
                // updateMarker.patch fields share this slot too (same
                // op.kind discriminator separation).
                tempo_bpm: { type: ['integer', 'null'] },
                tempo_text: { type: ['string', 'null'] },
                metricModulation: {
                  type: ['object', 'null'],
                  properties: {
                    fromNote: {
                      type: 'string',
                      enum: ['half', 'dotted-half', 'quarter', 'dotted-quarter', 'eighth', 'dotted-eighth', 'sixteenth'],
                    },
                    toNote: {
                      type: 'string',
                      enum: ['half', 'dotted-half', 'quarter', 'dotted-quarter', 'eighth', 'dotted-eighth', 'sixteenth'],
                    },
                  },
                },
                // updateHairpin.patch fields share this slot too
                // (M11-PR-3). Same op.kind discriminator separation.
                // `kind` collides with the Operation.kind discriminator
                // at the outer level but inside `patch` it's just the
                // hairpin kind (cresc/dim).
                startEventId: { type: 'string' },
                endEventId: { type: 'string' },
                startDynamic: {
                  type: ['string', 'null'],
                  enum: [
                    'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff',
                    'n',
                    'fp', 'fz', 'sfz', 'sffz', 'sfp', 'sfpp', 'rfz', 'rfp', 'fzp',
                    'none',
                    null,
                  ],
                },
                endDynamic: {
                  type: ['string', 'null'],
                  enum: [
                    'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff',
                    'n',
                    'fp', 'fz', 'sfz', 'sffz', 'sfp', 'sfpp', 'rfz', 'rfp', 'fzp',
                    'none',
                    null,
                  ],
                },
                placement: {
                  type: ['string', 'null'],
                  enum: ['above', 'below', 'default', null],
                },
                // updateHairpin.patch.kind ∈ HAIRPIN_KINDS;
                // updateSlur.patch.kind ∈ SLUR_KINDS;
                // updateTempoSpan.patch.kind ∈ TEMPO_SPAN_KINDS;
                // updateJumpMarker.patch.kind ∈ JUMP_KINDS (M18-PR-4).
                // updateOctaveSpan.patch.kind ∈ OCTAVE_SPAN_KINDS (M20-PR-3).
                // Op.kind discriminator separates them at the outer
                // level; shared bag union is permissive — the post-
                // call validator rejects misuse via per-kind guards
                // (isHairpin, isSlur, isTempoSpan, isOctaveSpan in
                // spans.ts; the jump-marker kind guard lives in
                // editOperations.ts isJumpMarkerKindEnum).
                // Source-of-truth pin tests catch drift in any of
                // the five *_KINDS consts.
                kind: {
                  type: 'string',
                  enum: [
                    ...HAIRPIN_KINDS,
                    ...SLUR_KINDS,
                    ...TEMPO_SPAN_KINDS,
                    ...JUMP_KINDS,
                    ...OCTAVE_SPAN_KINDS,
                  ],
                },
                // Tempo-span-specific terminal-tempo fields. Both
                // can clear via null; both follow the Marker.tempo_*
                // bounds (BPM 30..240, text max 40).
                endTempoBpm: {
                  type: ['integer', 'null'],
                  minimum: 30,
                  maximum: 240,
                },
                endTempoText: {
                  type: ['string', 'null'],
                  maxLength: 40,
                },
                // updateJumpMarker.patch fields (M18-PR-4). The
                // jumpMarker-specific patchable surfaces. measureIdx
                // is shared with updateMarker / updateVolta; side
                // and the three ref fields are jumpMarker-only.
                side: { type: 'string', enum: ['start', 'end'] },
                segnoRef: { type: ['string', 'null'] },
                codaRef: { type: ['string', 'null'] },
                toCodaRef: { type: ['string', 'null'] },
                // updateGlissando.patch fields (M20-PR-3). glissStyle
                // picks straight vs wavy visual variants; glissText
                // toggles the "gliss." text annotation prepended at
                // the start event. Both clear via null; undefined
                // preserves the prior value.
                glissStyle: { type: ['string', 'null'], enum: ['straight', 'wavy', null] },
                glissText: { type: ['boolean', 'null'] },
              },
            },
            // insertMarker payload (M9-PR-2). Mid-piece tempo/key/meter/
            // clef changes + metric-modulation labels. At least one of
            // key/meter/tempo_bpm/tempo_text/clefs/metricModulation must
            // be set — post-call validator enforces.
            marker: {
              type: 'object',
              properties: {
                measureIdx: { type: 'integer', minimum: 0, maximum: maxMeasureIdx },
                key: {
                  type: 'string',
                  enum: [
                    'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#',
                    'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb',
                    'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m',
                    'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm',
                  ],
                },
                meter: {
                  type: 'string',
                  pattern: '^(C\\|?|(?:[1-9]|[12][0-9]|3[0-2])\\/(?:1|2|4|8|16|32))$',
                },
                tempo_bpm: { type: 'integer', minimum: 30, maximum: 240 },
                tempo_text: { type: 'string' },
                clefs: {
                  type: 'array',
                  maxItems: 2,
                  items: {
                    type: 'object',
                    properties: {
                      staffIdx: { type: 'integer', enum: [0, 1] },
                      clef: { type: 'string', enum: ['treble', 'bass'] },
                    },
                    required: ['staffIdx', 'clef'],
                  },
                },
                metricModulation: {
                  type: 'object',
                  properties: {
                    fromNote: {
                      type: 'string',
                      enum: ['half', 'dotted-half', 'quarter', 'dotted-quarter', 'eighth', 'dotted-eighth', 'sixteenth'],
                    },
                    toNote: {
                      type: 'string',
                      enum: ['half', 'dotted-half', 'quarter', 'dotted-quarter', 'eighth', 'dotted-eighth', 'sixteenth'],
                    },
                  },
                  required: ['fromNote', 'toNote'],
                },
              },
              required: ['measureIdx'],
            },
            // insertVolta payload (M17-PR-3). 1st/2nd/Nth-time
            // ending brackets spanning a measure range. Validated
            // post-call by insertVolta + VoltaSchema (start <= end,
            // endings 1..9, no duplicates).
            volta: {
              type: 'object',
              required: ['startMeasureIdx', 'endMeasureIdx', 'endings'],
              properties: {
                startMeasureIdx: { type: 'integer', minimum: 0, maximum: maxMeasureIdx },
                endMeasureIdx: { type: 'integer', minimum: 0, maximum: maxMeasureIdx },
                endings: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 9,
                  items: { type: 'integer', minimum: 1, maximum: 9 },
                },
                endHook: { type: 'string', enum: ['closed', 'open'] },
                text: { type: 'string', maxLength: 40 },
              },
            },
            // insertJumpMarker payload (M18-PR-4). Score-level
            // navigation marker (D.C. / D.S. / Fine / Coda / Segno
            // / To Coda / *.al-Coda / *.al-Fine). The per-ref
            // existence is validated against current Score state in
            // insertJumpMarker (editOperations.ts) at apply time.
            // The kind enum is the spread of JUMP_KINDS so the
            // source-of-truth pin test in editIntraMeasure.jumpMarkerSchema
            // catches any drift between the const and the wire enum.
            jumpMarker: {
              type: 'object',
              required: ['measureIdx', 'side', 'kind'],
              properties: {
                measureIdx: { type: 'integer', minimum: 0, maximum: maxMeasureIdx },
                side: { type: 'string', enum: ['start', 'end'] },
                kind: {
                  type: 'string',
                  enum: [...JUMP_KINDS],
                },
                segnoRef: { type: 'string' },
                codaRef: { type: 'string' },
                toCodaRef: { type: 'string' },
              },
            },
            // insertHairpin payload (M11-PR-3). startEventId /
            // endEventId reference event ids visible in the input
            // JSON. Cross-voice / reversed-order rejection happens in
            // the post-call validator (editOperations.transformScore).
            // No additionalProperties:false — matches the marker /
            // annotation / chordSymbol precedent and lets the LLM
            // optionally emit an `id` (insertHairpin accepts one and
            // rejects on collision; the prompt says omit it).
            hairpin: {
              type: 'object',
              required: ['kind', 'startEventId', 'endEventId'],
              properties: {
                kind: { type: 'string', enum: ['hairpin-cresc', 'hairpin-dim'] },
                startEventId: { type: 'string' },
                endEventId: { type: 'string' },
                staffIdx: { type: 'integer', enum: [0, 1] },
                voiceIdx: { type: 'integer', enum: [0, 1, 2, 3] },
                startDynamic: {
                  type: 'string',
                  enum: [
                    'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff',
                    'n',
                    'fp', 'fz', 'sfz', 'sffz', 'sfp', 'sfpp', 'rfz', 'rfp', 'fzp',
                    'none',
                  ],
                },
                endDynamic: {
                  type: 'string',
                  enum: [
                    'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff',
                    'n',
                    'fp', 'fz', 'sfz', 'sffz', 'sfp', 'sfpp', 'rfz', 'rfp', 'fzp',
                    'none',
                  ],
                },
                placement: { type: 'string', enum: ['above', 'below', 'default'] },
              },
            },
            // insertSlur payload (M12-PR-2). Same address-by-event-id
            // model as the hairpin payload; no terminal dynamics
            // (slurs are phrasing, not loudness markings). No
            // additionalProperties:false — matches the marker /
            // annotation / chordSymbol / hairpin precedent and lets
            // the LLM optionally emit an `id` (insertSlur accepts one
            // and rejects on collision; the prompt says omit it).
            slur: {
              type: 'object',
              required: ['kind', 'startEventId', 'endEventId'],
              properties: {
                kind: { type: 'string', enum: ['slur', 'phrase-slur'] },
                startEventId: { type: 'string' },
                endEventId: { type: 'string' },
                staffIdx: { type: 'integer', enum: [0, 1] },
                voiceIdx: { type: 'integer', enum: [0, 1, 2, 3] },
                placement: { type: 'string', enum: ['above', 'below', 'default'] },
              },
            },
            // insertTempoSpan payload (M14-PR-3). Address-by-event-id
            // model matches hairpin / slur. Optional endTempoBpm
            // (30..240 matches Marker.tempo_bpm) + endTempoText
            // (max 40 chars matches Marker.tempo_text) carry the
            // terminal label painted at the end event. No
            // additionalProperties:false to allow optional id.
            tempoSpan: {
              type: 'object',
              required: ['kind', 'startEventId', 'endEventId'],
              properties: {
                kind: { type: 'string', enum: ['accel', 'rit'] },
                startEventId: { type: 'string' },
                endEventId: { type: 'string' },
                staffIdx: { type: 'integer', enum: [0, 1] },
                voiceIdx: { type: 'integer', enum: [0, 1, 2, 3] },
                placement: { type: 'string', enum: ['above', 'below', 'default'] },
                endTempoBpm: { type: 'integer', minimum: 30, maximum: 240 },
                endTempoText: { type: 'string', maxLength: 40 },
              },
            },
            // insertOctaveSpan payload (M20-PR-3). Octave-displacement
            // line above (8va/15ma) or below (8vb/15mb) the staff.
            // Same address-by-event-id model as hairpin / slur /
            // tempoSpan. kind is required; placement defaults to
            // "above" for 8va/15ma and "below" for 8vb/15mb.
            octaveSpan: {
              type: 'object',
              required: ['kind', 'startEventId', 'endEventId'],
              properties: {
                kind: { type: 'string', enum: [...OCTAVE_SPAN_KINDS] },
                startEventId: { type: 'string' },
                endEventId: { type: 'string' },
                staffIdx: { type: 'integer', enum: [0, 1] },
                voiceIdx: { type: 'integer', enum: [0, 1, 2, 3] },
                placement: { type: 'string', enum: ['above', 'below', 'default'] },
              },
            },
            // insertGlissando payload (M20-PR-3). Single-kind family;
            // optional glissStyle picks straight vs wavy visual
            // variants; optional glissText toggles the "gliss." text
            // annotation.
            glissando: {
              type: 'object',
              required: ['startEventId', 'endEventId'],
              properties: {
                startEventId: { type: 'string' },
                endEventId: { type: 'string' },
                staffIdx: { type: 'integer', enum: [0, 1] },
                voiceIdx: { type: 'integer', enum: [0, 1, 2, 3] },
                placement: { type: 'string', enum: ['above', 'below', 'default'] },
                glissStyle: { type: 'string', enum: ['straight', 'wavy'] },
                glissText: { type: 'boolean' },
              },
            },
            // insertTrillLine payload (M20-PR-3). Single-kind family;
            // extends a trill ornament (Event.ornament: 'trill') with
            // a wavy continuation line. No special decorators.
            trillLine: {
              type: 'object',
              required: ['startEventId', 'endEventId'],
              properties: {
                startEventId: { type: 'string' },
                endEventId: { type: 'string' },
                staffIdx: { type: 'integer', enum: [0, 1] },
                voiceIdx: { type: 'integer', enum: [0, 1, 2, 3] },
                placement: { type: 'string', enum: ['above', 'below', 'default'] },
              },
            },
            // insertTremoloBetween payload (M20-PR-3). Fingered tremolo
            // — fast alternation between two notes. Distinct from
            // Event.tremolo (single-note slashes through the stem).
            tremoloBetween: {
              type: 'object',
              required: ['startEventId', 'endEventId'],
              properties: {
                startEventId: { type: 'string' },
                endEventId: { type: 'string' },
                staffIdx: { type: 'integer', enum: [0, 1] },
                voiceIdx: { type: 'integer', enum: [0, 1, 2, 3] },
                placement: { type: 'string', enum: ['above', 'below', 'default'] },
              },
            },
            // setChordSymbol payload (M10-PR-3). Structured lead-sheet
            // chord — root + quality + seventh required, all others
            // optional. The post-call Zod validator enforces the
            // NoteNameSchema on root + alterations regex; this
            // optional-bag schema is permissive.
            chordSymbol: {
              type: 'object',
              properties: {
                root: { type: 'string', pattern: '^[A-G](#|b)?$' },
                quality: {
                  type: 'string',
                  enum: ['major', 'minor', 'diminished', 'augmented', 'sus2', 'sus4'],
                },
                seventh: {
                  type: 'string',
                  enum: ['none', 'maj7', 'dom7', 'min7', 'dim7', 'halfdim7'],
                },
                extensions: {
                  type: 'array',
                  items: { type: 'integer', enum: [9, 11, 13] },
                },
                alterations: {
                  type: 'array',
                  // Pattern mirrors types.ts:367 ChordSymbolSchema
                  // so bad alteration strings reject at the schema
                  // boundary instead of needing a Zod retry round-trip.
                  items: { type: 'string', pattern: '^(b|#)?\\d{1,2}$|^alt$' },
                },
                add: {
                  type: 'array',
                  items: { type: 'integer', enum: [2, 4, 6, 9, 11, 13] },
                },
                omit: {
                  type: 'array',
                  items: { type: 'integer', enum: [3, 5, 7] },
                },
                bass: { type: 'object' },
                modal: {
                  type: 'string',
                  enum: ['Ionian', 'Dorian', 'Phrygian', 'Lydian', 'Mixolydian', 'Aeolian', 'Locrian'],
                },
                display: { type: 'string' },
              },
              required: ['root', 'quality', 'seventh'],
            },
            id: { type: 'string' },
            // dragMeasureRange (M19-PR-4). Structural range op for
            // delete / move / duplicate. Fields are flat on the op
            // bag — the post-call op-handler validates the mode-
            // specific combination (toAfter required for move +
            // duplicate; range validity; toAfter overlap for move).
            mode: {
              type: 'string',
              enum: ['delete', 'move', 'duplicate'],
              description: 'dragMeasureRange mode. delete removes [fromStart..fromEnd]; move splices the range to AFTER toAfter; duplicate copies the range AFTER toAfter (originals stay).',
            },
            fromStart: {
              type: 'integer',
              minimum: 0,
              maximum: maxMeasureIdx,
              description: '0-indexed first measure of the source range (inclusive).',
            },
            fromEnd: {
              type: 'integer',
              minimum: 0,
              maximum: maxMeasureIdx,
              description: '0-indexed last measure of the source range (inclusive). Must satisfy fromEnd >= fromStart.',
            },
            toAfter: {
              type: 'integer',
              minimum: -1,
              maximum: maxMeasureIdx,
              description: 'Destination position (in the ORIGINAL layout) for move + duplicate modes. The range lands AFTER this measureIdx. Use -1 to insert BEFORE measure 0. mode:"move" rejects toAfter inside [fromStart-1..fromEnd] (no-op or undefined).',
            },
          },
          required: ['kind'],
        },
      },
    },
    required: ['ops'],
  }
}

function buildUserText(
  input: RunEditIntraMeasureInput,
  validationFeedback?: string,
): string {
  const target = input.classification.target_description ?? input.classification.notes ?? '(unspecified)'
  return [
    `TARGET: ${target}`,
    ...(validationFeedback
      ? [
          '',
          'YOUR PREVIOUS ATTEMPT FAILED VALIDATION:',
          validationFeedback,
          '',
          "Fix the issue and emit again. Pay close attention to per-measure duration sums matching the score's meter (e.g. 4/4 = 8 eighths per measure).",
        ]
      : []),
    '',
    // M26 PR-3 — input cap: compact JSON (no pretty-print) is ~3x fewer tokens
    // than the indented dump, with NO measureIdx hazard — the full score is
    // sent so every absolute measure index is intact, and the per-call tool
    // schema still derives maxMeasureIdx from the live score, so emitted ops
    // address absolute positions exactly as before.
    'CURRENT SCORE (compact JSON):',
    JSON.stringify(input.editedScore),
  ].join('\n')
}

/**
 * Author + apply precise intra-measure edits via the medium-tier
 * provider with a per-call tool schema bounded to the live score's
 * measure count. Stateless single-shot — score is passed inline.
 */
export async function runEditIntraMeasure(
  input: RunEditIntraMeasureInput,
): Promise<OrchestratorResult> {
  const t0 = Date.now()
  if (!input.editedScore) {
    throw new EditIntraMeasureError(
      'edit_intra_measure requires a current score; none was sent with the request',
    )
  }

  const selected = selectProvider('medium', input.chatId)

  // Validation-retry loop (M3.5-PR-5b): re-prompt once on ValidationError
  // with the failure message threaded into the user text. Only retries
  // ValidationError; ProviderSchemaError (malformed tool input) and
  // UpstreamError (already handled by callWithFailover) fall through.
  let toolResult!: ProviderToolResult<z.infer<typeof EditScoreInputSchema>>
  let next!: Score
  let rawOps!: unknown[]
  // User-facing warnings for ops that couldn't apply but were skipped (so one
  // bad op doesn't abort the whole edit). Reset per attempt; reflects the final
  // accepted attempt.
  let skippedOps: string[] = []
  let lastValidationError: string | undefined
  let attempt = 0
  while (true) {
    attempt++
    try {
      toolResult = await callWithFailover(
        { ...selected, chatId: input.chatId },
        {
          name: EDIT_TOOL_NAME,
          description: 'Emit the minimal ops to fulfill the target_description.',
          inputSchema: EditScoreInputSchema,
          inputSchemaJson: buildEditScoreSchemaJson(input.editedScore),
        },
        {
          systemPrompt: INTRA_SYSTEM_PROMPT,
          userText: buildUserText(input, lastValidationError),
          toolChoice: 'required',
          maxTokens: MAX_TOKENS,
          temperature: 0,
          // A targeted intra-measure edit is mechanical, not open-ended —
          // run it cheap rather than at Sonnet's default high effort.
          effort: 'low',
          thinking: 'disabled',
          modelOverride: input.modelOverride ?? selected.model,
          providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
        },
      )
    } catch (e) {
      if (e instanceof ProviderSchemaError) {
        throw new EditIntraMeasureError(
          `edit_intra_measure: ${e.message}`,
        )
      }
      throw e
    }

    rawOps = toolResult.input.ops
    if (rawOps.length === 0) {
      throw new EditIntraMeasureError('edit_intra_measure: model emitted no ops')
    }

    next = JSON.parse(JSON.stringify(input.editedScore))
    skippedOps = []
    let appliedCount = 0
    for (let i = 0; i < rawOps.length; i++) {
      const op = rawOps[i] as Operation
      try {
        next = transformScore(next, op)
        appliedCount++
      } catch (e) {
        // Tolerant application: skip an op that can't apply (e.g. addStaff on a
        // score that already has two staves) and keep going, rather than
        // aborting the whole edit on one bad op. Skips become user warnings.
        const msg = e instanceof Error ? e.message : 'unknown'
        skippedOps.push(`Skipped "${(op as { kind?: string }).kind ?? 'op'}" — ${msg}`)
      }
    }
    if (appliedCount === 0) {
      // Every op failed — surface the real reason(s) (more actionable than the
      // generic fall-through message) and don't retry into the same wall.
      throw new EditIntraMeasureError(
        `edit_intra_measure: no ops could be applied — ${skippedOps.join('; ')}`,
      )
    }

    try {
      validateScore(next)
      if (attempt > 1 && process.env.ORCHESTRATOR_LOG_SILENT !== '1') {
        console.warn(
          `[handler retry attempt=${attempt} succeeded] edit_intra_measure recovered after validation feedback`,
        )
      }
      break
    } catch (e) {
      if (e instanceof ValidationError && attempt < 2) {
        lastValidationError = e.message
        if (process.env.ORCHESTRATOR_LOG_SILENT !== '1') {
          console.warn(
            `[handler retry] edit_intra_measure attempt=${attempt} validation failed: ${e.message.slice(0, 200)} — retrying with feedback`,
          )
        }
        continue
      }
      if (e instanceof ValidationError) {
        throw new EditIntraMeasureError(
          `edit_intra_measure result failed validation: ${e.message}`,
        )
      }
      throw e
    }
  }

  return {
    score: next,
    classification: input.classification,
    model: toolResult.model,
    latencyMs: Date.now() - t0,
    toolUseId: toolResult.toolUseId,
    // The intra-measure system prompt instructs the model NOT to emit
    // text, but capture it when it does anyway — LLM-emitted narration
    // describes the actual change in context and outranks the canned
    // op-aggregate fallback that `summarizeAction` would otherwise pick.
    introText: toolResult.introText,
    appliedOps: rawOps as Operation[],
    ...(skippedOps.length ? { warnings: skippedOps } : {}),
    ...(toolResult.usage
      ? {
          usage: {
            inputTokens: toolResult.usage.inputTokens,
            outputTokens: toolResult.usage.outputTokens,
            cachedInputTokens: toolResult.usage.cachedInputTokens,
          },
        }
      : {}),
  }
}
