import type {
  Accidental,
  Annotation,
  AnnotationStyle,
  Articulation,
  Barline,
  ChordSymbol,
  Clef,
  Duration,
  Dynamic,
  DynamicMarking,
  Event,
  Fermata,
  Fingering,
  GraceNote,
  JumpMarker,
  Key,
  LyricSyllable,
  Marker,
  Measure,
  Meter,
  MetricModulation,
  Ornament,
  Pitch,
  Score,
  Span,
  Staff,
  TechniqueChange,
  TechniqueKind,
  TrillUpperPitch,
  Volta,
} from './types'
import { createAnnotationId } from './annotations'
import { createEventId } from './eventIds'
import { createMarkerId } from './markers'
import {
  createSpanId,
  isGlissando,
  isHairpin,
  isOctaveSpan,
  isSlur,
  isTempoSpan,
  isTremoloBetween,
  isTrillLine,
  JUMP_KINDS,
  type HairpinKind,
  type JumpMarkerKind,
  type OctaveSpanKind,
  type SlurKind,
  type TempoSpanKind,
} from './spans'
import { ArticulationStackingError, normalizeArticulations } from './articulations'
import { sortPitchesAscending } from './chords'
import { removeFingeringAt, setFingeringAt } from './fingerings'
import { removeSyllable, setSyllable } from './lyrics'
import { fillMeasureWithRests } from './measureBalance'
import {
  dropSeveredAndInteriorSpans,
  extractRangeEntries,
  reattachExtractedEntries,
  remapIndexAfterInsert,
  remapIndexAfterRegionReplace,
  remapScoreReferences,
  stripRangeEntries,
} from './structuralOps'
import { createTechniqueId } from './techniques'
import { validateScore } from './validateScore'
import {
  findEventLocationById,
  getStaffCount,
  getStaffMeasureAt,
  getStaffMeasures,
  getVoiceCount,
  getVoiceMeasureAt,
  getVoiceMeasures,
  withAllStaffMeasures,
  withStaffMeasures,
  withVoiceMeasures,
} from './scoreAccessors'

/**
 * Target a specific (staff, voice, measure, event, pitch) tuple.
 * `staffIdx` and `voiceIdx` are optional and default to 0 so legacy
 * single-staff single-voice edits keep working unchanged.
 *
 * Out-of-range (staffIdx, voiceIdx) throws EditError — see
 * `assertVoiceExists`. The retry pipeline (`scoreRetry.ts`) feeds the
 * error back to the LLM so the model can re-target on the next turn.
 */
export type Target = {
  staffIdx?: number
  voiceIdx?: number
  measureIdx: number
  eventIdx: number
  pitchIdx?: number
}

export type Operation =
  | { kind: 'changePitch'; target: Target; deltaStep?: number; deltaOctave?: number }
  | { kind: 'changeDuration'; target: Target; duration: Duration }
  | { kind: 'setAccidental'; target: Target; accidental: Accidental }
  | { kind: 'setArticulation'; target: Target; articulation: Articulation }
  | { kind: 'toggleTie'; target: Target }
  | { kind: 'deleteEvent'; target: Target }
  | { kind: 'insertEventAfter'; target: Target; event: Event }
  | { kind: 'addPitchToChord'; target: Target; pitch: Pitch }
  | { kind: 'removePitchFromChord'; target: Target; pitchIdx: number }
  | { kind: 'setEventPitches'; target: Target; pitches: Pitch[] }
  | { kind: 'changeKey'; key: Key }
  | { kind: 'changeMeter'; meter: Meter }
  | { kind: 'changeTempo'; tempo_bpm: number }
  | { kind: 'changeTitle'; title: string }
  | { kind: 'changeClef'; clef: Clef; staffIdx?: number }
  | { kind: 'addStaff'; clef: Clef }
  | { kind: 'removeStaff'; staffIdx: number }
  | { kind: 'addVoice'; staffIdx: number }
  | { kind: 'removeVoice'; staffIdx: number; voiceIdx: number }
  | { kind: 'insertMeasureAfter'; measureIdx: number }
  | { kind: 'deleteMeasure'; measureIdx: number }
  | { kind: 'duplicateMeasure'; measureIdx: number }
  | { kind: 'reorderEvent'; target: Target; direction: 'left' | 'right' }
  // ─── Per-note markings (M2-PR-3) ──────────────────────────────────
  // For optional event-level fields, pass the value to set or omit
  // to clear. The transform strips the key when clearing so
  // back-compat helpers don't see undefined values.
  | { kind: 'setArticulations'; target: Target; articulations: Articulation[] }
  | { kind: 'setOrnament'; target: Target; ornament: Ornament }
  | { kind: 'setTrillUpperPitch'; target: Target; trillUpperPitch?: TrillUpperPitch }
  // Single-shot setter for the whole graceNotes array (matches the
  // setArticulations idiom — caller composes the new array client-
  // side). Empty array strips the field so legacy ornament:'grace'
  // becomes visible again as the renderer's fallback.
  | { kind: 'setGraceNotes'; target: Target; graceNotes: GraceNote[] }
  | { kind: 'setDynamic'; target: Target; dynamic: Dynamic }
  | { kind: 'setDynamicStructured'; target: Target; dynamic_structured?: DynamicMarking }
  | { kind: 'setFermata'; target: Target; fermata?: Fermata }
  | { kind: 'setBarlineFermata'; staffIdx?: number; measureIdx: number; barlineFermata?: Fermata }
  // ─── Measure barlines + anacrusis (M16-PR-1) ──────────────────────
  // startBarline = LEFT edge glyph; endBarline = RIGHT edge glyph.
  // Both default to 'thin' when omitted from the schema; setting
  // either to undefined clears the field (renderer falls back to
  // the default thin barline). The 8 kinds (thin / double / final
  // / repeat-start / repeat-end / repeat-both / invisible / dashed)
  // are enforced by BarlineSchema at parse time.
  | { kind: 'setStartBarline'; staffIdx?: number; measureIdx: number; barline?: Barline }
  | { kind: 'setEndBarline'; staffIdx?: number; measureIdx: number; barline?: Barline }
  // Anacrusis flags. isPickup marks a partial first measure (short
  // duration permitted by validateScore); isFinalPartial marks the
  // hymn-tune closing partial that balances the pickup. Both are
  // booleans persisted on the Measure; setting false strips the
  // field so the persisted JSON stays clean.
  | { kind: 'setPickup'; staffIdx?: number; measureIdx: number; isPickup: boolean }
  | { kind: 'setFinalPartial'; staffIdx?: number; measureIdx: number; isFinalPartial: boolean }
  | { kind: 'setBreathMark'; target: Target; breathMark: boolean }
  | { kind: 'setCaesura'; target: Target; caesura: boolean }
  | {
      kind: 'setTremolo'
      target: Target
      tremolo?: { slashes: 1 | 2 | 3 | 4 | 5; measured?: boolean }
    }
  | { kind: 'setBowing'; target: Target; bowing?: 'up' | 'down' }
  | {
      kind: 'setJazzInflection'
      target: Target
      jazzInflection?: 'fall' | 'doit' | 'scoop' | 'plop' | 'ghost'
    }
  // Per-event chord symbol (M10-PR-2). Lead-sheet harmony label
  // attached to an event; renders above the staff as e.g. "Cmaj7".
  // Pass `chordSymbol` to set; omit to clear (the field drops from
  // the persisted JSON).
  | { kind: 'setChordSymbol'; target: Target; chordSymbol?: ChordSymbol }
  // Per-PITCH ops — target.pitchIdx selects which pitch in the chord.
  // Booleans use false-to-clear semantics so the persisted JSON drops
  // the key entirely when toggled off.
  | { kind: 'setPitchTie'; target: Target; tied_to_next: boolean }
  | { kind: 'setLv'; target: Target; lv: boolean }
  | { kind: 'setEnharmonicTie'; target: Target; enharmonicTie: boolean }
  // Per-pitch fingerings. The fingering lives on Event.fingerings at
  // the same index as the pitch; the helper in fingerings.ts pads
  // missing earlier slots with null so the LLM/editor can finger any
  // pitch in any order. removeFingering at a valid-but-already-empty
  // pitchIdx is intentionally idempotent (no-op) — re-asking to clear
  // an already-cleared slot is benign, not a retry signal.
  | { kind: 'setFingering'; target: Target; fingering: Fingering }
  | { kind: 'removeFingering'; target: Target }
  // ─── Lyrics (M15-PR-1) ────────────────────────────────────────────
  // Per-event, per-verse syllable. setLyric replaces any existing
  // syllable on the same (event, verse); removeLyric drops the verse
  // entry; clearLyrics drops the entire lyrics field on the event.
  // verse bounds (1..50) match LyricSyllableSchema; syllable length
  // bounds (1..40 chars) match the schema too. Rests CAN carry
  // syllables (Anglican psalter convention — the syllable holds
  // through the rest visually) but the editor UI typically guards
  // this.
  | {
      kind: 'setLyric'
      target: Target
      verse: number
      syllable: string
      hyphen?: boolean
      extender?: boolean
    }
  | { kind: 'removeLyric'; target: Target; verse: number }
  | { kind: 'clearLyrics'; target: Target }
  // ─── Performance technique state (M3-PR-2) ────────────────────────
  // Score-level (not per-event); pizz./arco/sul-ponticello/etc. persist
  // from their position on a voice forward until cancelled. Address by
  // (staffIdx, voiceIdx, measureIdx, optional eventIdx) for insertion;
  // address by id for removal.
  | {
      kind: 'insertTechniqueChange'
      techniqueChange: {
        id?: string
        measureIdx: number
        eventIdx?: number
        staffIdx: number
        voiceIdx: number
        kind: TechniqueKind
      }
    }
  | { kind: 'removeTechniqueChange'; id: string }
  // ─── Annotations (M8-PR-1) ────────────────────────────────────────
  // Score-level free-text annotations (rehearsal marks, tempo text,
  // expression markings, plain comments). Anchored to a measure or a
  // specific event with above/below/left/right placement. Optional
  // spanEnd for line-extending forms like "rit. ____" / "accel. ____".
  // Address by (measureIdx, optional eventIdx, position) for insertion;
  // address by id for update/remove.
  | {
      kind: 'insertAnnotation'
      annotation: {
        id?: string
        measureIdx: number
        eventIdx?: number
        position: 'above' | 'below' | 'left' | 'right'
        text: string
        style: AnnotationStyle
        spanEnd?: { measureIdx: number; eventIdx?: number }
      }
    }
  | { kind: 'removeAnnotation'; id: string }
  | {
      kind: 'updateAnnotation'
      id: string
      // Patch — any subset of mutable fields. Position and target
      // re-anchoring is allowed via patch.target. Pass spanEnd: null
      // to clear an existing span.
      patch: {
        text?: string
        style?: AnnotationStyle
        target?: {
          measureIdx: number
          eventIdx?: number
          position: 'above' | 'below' | 'left' | 'right'
        }
        spanEnd?: { measureIdx: number; eventIdx?: number } | null
      }
    }
  // ─── Score metadata (M8-PR-1) ─────────────────────────────────────
  // Patch title / composer / arranger / lyricist / copyright on the
  // Score root. Each field is independently optional in the patch;
  // pass `null` to clear an existing value, omit to leave unchanged,
  // pass a string to set. Empty string is rejected (the schema's
  // .max() validators don't enforce non-empty; a future PR may add a
  // .min(1) refine — for now the op rejects '' to match user intent).
  | {
      kind: 'setScoreMetadata'
      patch: {
        title?: string | null
        composer?: string | null
        arranger?: string | null
        lyricist?: string | null
        copyright?: string | null
      }
    }
  // ─── Mid-piece markers (M9-PR-1) ──────────────────────────────────
  // Score-level markers at measure boundaries — tempo changes, mid-
  // piece key/meter/clef changes, metric modulation labels. Address
  // by id for update/remove; insert mints a fresh id when missing.
  | {
      kind: 'insertMarker'
      marker: {
        id?: string
        measureIdx: number
        key?: Key
        meter?: Meter
        tempo_bpm?: number
        tempo_text?: string
        clefs?: Array<{ staffIdx: 0 | 1; clef: Clef }>
        metricModulation?: MetricModulation
      }
    }
  | { kind: 'removeMarker'; id: string }
  | {
      kind: 'updateMarker'
      id: string
      // Patch — any subset of mutable fields. Pass any field as
      // `null` to clear it from the marker (must keep at least one
      // active field — refine catches violations).
      patch: {
        measureIdx?: number
        key?: Key | null
        meter?: Meter | null
        tempo_bpm?: number | null
        tempo_text?: string | null
        clefs?: Array<{ staffIdx: 0 | 1; clef: Clef }> | null
        metricModulation?: MetricModulation | null
      }
    }
  // ─── Voltas (M17-PR-1) ────────────────────────────────────────────
  // 1st / 2nd / Nth-time endings spanning a measure range. Address by
  // id for update/remove; insert mints a fresh id when missing. The
  // op validates startMeasureIdx <= endMeasureIdx + bounds + endings
  // 1..9 + no-duplicate-endings.
  | {
      kind: 'insertVolta'
      volta: {
        id?: string
        startMeasureIdx: number
        endMeasureIdx: number
        endings: number[]
        endHook?: 'closed' | 'open'
        text?: string
      }
    }
  | { kind: 'removeVolta'; id: string }
  | {
      kind: 'updateVolta'
      id: string
      // Patch — any subset of mutable fields. Pass endHook / text
      // as `null` to clear (undefined preserves); startMeasureIdx /
      // endMeasureIdx / endings are required-on-the-volta so they
      // can only be replaced, never cleared.
      patch: {
        startMeasureIdx?: number
        endMeasureIdx?: number
        endings?: number[]
        endHook?: 'closed' | 'open' | null
        text?: string | null
      }
    }
  // ─── Jump markers (M18-PR-1) ──────────────────────────────────────
  // D.C. / D.S. / Fine / Coda / *.al-Coda / *.al-Fine landmarks
  // attached to a measure edge. Address by id for update/remove;
  // insert mints a fresh id when missing. JumpMarker links to Segno
  // / Coda landmarks via segnoRef / codaRef / toCodaRef — the
  // edit-op only checks bounds + id-collision + ref existence
  // (per kind), leaving the full pairing semantics (e.g. D.S. al
  // Coda must reference both a Segno and a To-Coda) to
  // validateCrossRefs at save time so partial in-progress edits
  // don't hard-fail.
  | {
      kind: 'insertJumpMarker'
      jumpMarker: {
        id?: string
        measureIdx: number
        side: 'start' | 'end'
        kind: JumpMarkerKind
        segnoRef?: string
        codaRef?: string
        toCodaRef?: string
      }
    }
  | { kind: 'removeJumpMarker'; id: string }
  | {
      kind: 'updateJumpMarker'
      id: string
      // Patch — any subset of mutable fields. Pass any ref as
      // `null` to clear it; undefined preserves; a string sets.
      // The marker's `kind` is patchable so a misclassified D.C.
      // can be promoted to D.C. al Coda without delete + insert.
      patch: {
        measureIdx?: number
        side?: 'start' | 'end'
        kind?: JumpMarkerKind
        segnoRef?: string | null
        codaRef?: string | null
        toCodaRef?: string | null
      }
    }
  // ─── Hairpin spans (M11-PR-2) ─────────────────────────────────────
  // Crescendo / diminuendo wedges. First SPAN op family wired through
  // edit-ops; slurs landed in M12, 8va / glissando follow in M13+. Address by
  // startEventId + endEventId for insertion; address by id for
  // update/remove. The op validates same-voice + start <= end + that
  // both endpoints resolve to events. Cross-voice and cross-staff
  // hairpins are rejected (Phase 1 deferral; same as the
  // validateCrossRefs check). Terminal dynamics (startDynamic /
  // endDynamic) enable the "p<f" shorthand the renderer can emit at
  // the hairpin endpoints.
  | {
      kind: 'insertHairpin'
      hairpin: {
        id?: string
        kind: HairpinKind
        startEventId: string
        endEventId: string
        // Optional; default to the resolved start-event location.
        // Schema enforces 0..1 / 0..3 bounds at parse time.
        staffIdx?: number
        voiceIdx?: number
        startDynamic?: Dynamic
        endDynamic?: Dynamic
        placement?: 'above' | 'below' | 'default'
      }
    }
  | { kind: 'removeHairpin'; id: string }
  | {
      kind: 'updateHairpin'
      id: string
      // Patch — any subset of mutable fields. Pass startDynamic /
      // endDynamic / placement as `null` to clear. staffIdx /
      // voiceIdx are NOT patchable: they follow the resolved start
      // event location (re-anchoring via startEventId carries them
      // along). To move a hairpin to a different voice, delete + insert.
      patch: {
        kind?: HairpinKind
        startEventId?: string
        endEventId?: string
        startDynamic?: Dynamic | null
        endDynamic?: Dynamic | null
        placement?: 'above' | 'below' | 'default' | null
      }
    }
  // ─── Slur spans (M12-PR-1) ────────────────────────────────────────
  // Slur / phrase-slur curves. Second SPAN op family wired through
  // edit-ops. Same address-by-endpoint-id model as hairpins; same
  // same-voice + start <= end validation; cross-voice / cross-staff
  // slurs are rejected in Phase 1 (vocal-SATB cross-voice slurs are
  // a Phase 2 deferral noted on SpanSchema). Slurs have NO terminal
  // dynamics — those are hairpin-specific. The `phrase-slur` kind is
  // a longer/broader curve typically reserved for breath phrases in
  // vocal music or rhetorical groupings in instrumental music; both
  // emit the same `(...)` syntax in abcjs and the renderer picks the
  // visual variant.
  | {
      kind: 'insertSlur'
      slur: {
        id?: string
        kind: SlurKind
        startEventId: string
        endEventId: string
        // Optional; default to the resolved start-event location.
        // Schema enforces 0..1 / 0..3 bounds at parse time.
        staffIdx?: number
        voiceIdx?: number
        placement?: 'above' | 'below' | 'default'
      }
    }
  | { kind: 'removeSlur'; id: string }
  | {
      kind: 'updateSlur'
      id: string
      // Patch — any subset of mutable fields. Pass placement as `null`
      // to clear. staffIdx / voiceIdx are NOT patchable; they follow
      // the resolved start event location (re-anchoring via
      // startEventId carries them along).
      patch: {
        kind?: SlurKind
        startEventId?: string
        endEventId?: string
        placement?: 'above' | 'below' | 'default' | null
      }
    }
  // ─── Tempo-span ops (M14) ────────────────────────────────────────
  // Tempo-line spans: "accel." (speeding up) or "rit." (slowing down).
  // Distinct from Annotation+spanEnd: these are typed spans, so the
  // renderer/UI can paint structured tempo-line glyphs while
  // annotations remain a generic-text channel. Same validation rules
  // as hairpin/slur (same-voice, forward-only, no cross-staff in
  // Phase 1). Optional `endTempoBpm` / `endTempoText` carry the
  // target tempo label painted at the end event ("accel. → ♩=144").
  | {
      kind: 'insertTempoSpan'
      tempoSpan: {
        id?: string
        kind: TempoSpanKind
        startEventId: string
        endEventId: string
        staffIdx?: number
        voiceIdx?: number
        placement?: 'above' | 'below' | 'default'
        endTempoBpm?: number
        endTempoText?: string
      }
    }
  | { kind: 'removeTempoSpan'; id: string }
  | {
      kind: 'updateTempoSpan'
      id: string
      // Patch — pass placement / endTempoBpm / endTempoText as `null`
      // to clear; undefined preserves the prior value.
      patch: {
        kind?: TempoSpanKind
        startEventId?: string
        endEventId?: string
        placement?: 'above' | 'below' | 'default' | null
        endTempoBpm?: number | null
        endTempoText?: string | null
      }
    }
  // ─── Octave-span ops (M20-PR-1) ───────────────────────────────────
  // 8va / 8vb / 15ma / 15mb: octave-displacement lines above or below
  // the staff. Same address-by-endpoint-id model + same-voice +
  // forward-only validation as hairpin/slur/tempo-span. No
  // terminal-dynamic / glissando-text / tempo decorators — just kind
  // + range + placement. The renderer paints the appropriate Italian
  // abbreviation as an above/below annotation at the start event;
  // 8va/15ma default placement is 'above', 8vb/15mb default to 'below'.
  | {
      kind: 'insertOctaveSpan'
      octaveSpan: {
        id?: string
        kind: OctaveSpanKind
        startEventId: string
        endEventId: string
        staffIdx?: number
        voiceIdx?: number
        placement?: 'above' | 'below' | 'default'
      }
    }
  | { kind: 'removeOctaveSpan'; id: string }
  | {
      kind: 'updateOctaveSpan'
      id: string
      // Patch — undefined preserves, null clears placement, value sets.
      // staffIdx/voiceIdx follow the resolved start event so a re-
      // anchor via startEventId carries them.
      patch: {
        kind?: OctaveSpanKind
        startEventId?: string
        endEventId?: string
        placement?: 'above' | 'below' | 'default' | null
      }
    }
  // ─── Glissando span ops (M20-PR-1) ────────────────────────────────
  // Single-kind family. SpanSchema already has glissStyle ('straight'
  // | 'wavy') + glissText (boolean) decorators; these are exposed
  // through insert + update. The renderer emits abcjs's native
  // `!glissando(!` / `!glissando)!` decoration pair.
  | {
      kind: 'insertGlissando'
      glissando: {
        id?: string
        startEventId: string
        endEventId: string
        staffIdx?: number
        voiceIdx?: number
        placement?: 'above' | 'below' | 'default'
        glissStyle?: 'straight' | 'wavy'
        glissText?: boolean
      }
    }
  | { kind: 'removeGlissando'; id: string }
  | {
      kind: 'updateGlissando'
      id: string
      patch: {
        startEventId?: string
        endEventId?: string
        placement?: 'above' | 'below' | 'default' | null
        glissStyle?: 'straight' | 'wavy' | null
        glissText?: boolean | null
      }
    }
  // ─── Trill-line span ops (M20-PR-1) ───────────────────────────────
  // Extends a trill ornament (Event.ornament: 'trill' from M2-PR-3)
  // with a wavy continuation line across N events. Renderer emits
  // abcjs's native `!trill(!` / `!trill)!` tokens. No special
  // decorators — kind + range + placement only.
  | {
      kind: 'insertTrillLine'
      trillLine: {
        id?: string
        startEventId: string
        endEventId: string
        staffIdx?: number
        voiceIdx?: number
        placement?: 'above' | 'below' | 'default'
      }
    }
  | { kind: 'removeTrillLine'; id: string }
  | {
      kind: 'updateTrillLine'
      id: string
      patch: {
        startEventId?: string
        endEventId?: string
        placement?: 'above' | 'below' | 'default' | null
      }
    }
  // ─── Tremolo-between span ops (M20-PR-1) ──────────────────────────
  // Fingered tremolo: fast alternation between two notes. Distinct
  // from Event.tremolo (single-note repeated tremolo with N slashes
  // through the stem — M2-PR-1). Two-endpoint span; renderer emits
  // a `"^trem."` annotation at the start event (abcjs has no native
  // between-note tremolo vocabulary). Visual paired-beam-and-slashes
  // between the two notes is a future PR.
  | {
      kind: 'insertTremoloBetween'
      tremoloBetween: {
        id?: string
        startEventId: string
        endEventId: string
        staffIdx?: number
        voiceIdx?: number
        placement?: 'above' | 'below' | 'default'
      }
    }
  | { kind: 'removeTremoloBetween'; id: string }
  | {
      kind: 'updateTremoloBetween'
      id: string
      patch: {
        startEventId?: string
        endEventId?: string
        placement?: 'above' | 'below' | 'default' | null
      }
    }
  // ─── Structural multi-measure ops (M3.5-PR-3) ─────────────────────
  // Append new measures to the END of the score. `perVoiceContent`
  // optionally specifies measures for every (staffIdx, voiceIdx) so
  // the LLM can author both hands of a grand staff at once; absent
  // entries default to rests at meter capacity. The new measures must
  // sum to the meter (validated post-apply by validateScore).
  //
  // Boundary handling lives in the orchestrator handler
  // (`runExtendComposition`) — this op is the pure structural
  // mutation: append rows, fan out other staves/voices with rests,
  // clear isFinalPartial on the previously-last measure, remap nothing
  // (appending doesn't shift any existing index).
  | {
      kind: 'appendMeasures'
      measures: Measure[]
      /** Optional per-(staff, voice) content. Outer index = staffIdx
       *  (0 = primary, 1 = secondStaff). Each voices[v] is the measure
       *  list for that voice. When omitted or partial, missing voices
       *  receive rests at meter capacity. */
      perVoiceContent?: Array<{ voices: Measure[][] }>
    }
  // Insert N measures AFTER `afterMeasureIdx`. Indices > afterMeasureIdx
  // shift by +count for techniqueStates / voltas / markers /
  // annotations / jumpMarkers. Existing spans are unaffected (event-id
  // based); `spansToAdd` (D4) carries copied spans whose endpoints
  // reference the inserted measures' (fresh) event ids.
  | {
      kind: 'insertMeasuresAfter'
      afterMeasureIdx: number
      measures: Measure[]
      perVoiceContent?: Array<{ voices: Measure[][] }>
      /** D4: spans to append, already remapped to the inserted events'
       *  fresh ids (see `remapSpansToFreshIds`). */
      spansToAdd?: Span[]
    }
  // Replace measures in [startMeasureIdx..endMeasureIdx] (inclusive)
  // with the supplied content. Indices INSIDE the range collapse to
  // the last new measure or get dropped (orphan policy in
  // remapIndexAfterRegionReplace). Spans whose start OR end event
  // lives inside the replaced range are detected by the handler and
  // surfaced as a `severedSpans` warning; this op drops them.
  // `spansToAdd` (D4) appends copied spans pointed at the replacement
  // events' fresh ids, after the interior/severed drop.
  | {
      kind: 'regionReplace'
      startMeasureIdx: number
      endMeasureIdx: number
      measures: Measure[]
      perVoiceContent?: Array<{ voices: Measure[][] }>
      spansToAdd?: Span[]
    }
  // ─── dragMeasureRange (M19-PR-2) ──────────────────────────────────
  // User-driven measure-range structural ops backing the editor's
  // drag-and-drop measure interaction (M19-PR-5+). All modes preserve
  // the cross-staff bar-alignment invariant by going through the same
  // per-(staff, voice) splice helpers as appendMeasures /
  // insertMeasuresAfter / regionReplace.
  //
  // delete:    Remove [fromStart..fromEnd]. Equivalent to regionReplace
  //            with empty measures, but the discriminated `delete` mode
  //            gives the UI dispatcher a clearer surface and yields a
  //            better summarizeAction string. Spans severed or fully
  //            inside the range are dropped (matches regionReplace).
  // move:      Remove [fromStart..fromEnd] and insert it AFTER toAfter
  //            (in the original layout's coordinates; toAfter must NOT
  //            lie inside [fromStart-1..fromEnd]). Event IDs are
  //            preserved so spans whose endpoints live in the moved
  //            range survive automatically. Score-level entries scoped
  //            to the moved range (techniqueStates / markers /
  //            jumpMarkers / segno / coda / fully-inside voltas /
  //            fully-inside annotations) follow the range to the
  //            destination. Voltas + annotations STRADDLING the range
  //            (one endpoint inside, one outside) are dropped because
  //            their span semantic would be broken across the move.
  | {
      kind: 'dragMeasureRange'
      mode: 'delete'
      fromStart: number
      fromEnd: number
    }
  | {
      kind: 'dragMeasureRange'
      mode: 'move'
      fromStart: number
      fromEnd: number
      /** Destination position: place the moved range AFTER this measureIdx
       *  in the ORIGINAL layout. Use -1 to place before measure 0.
       *  Must satisfy: toAfter < fromStart - 1 OR toAfter > fromEnd. */
      toAfter: number
    }
  // duplicate (M19-PR-3): copy [fromStart..fromEnd] in place and
  // insert the copy AFTER toAfter. Source range stays put. Each
  // copied Event gets a fresh id via createEventId so spans that
  // reference the original ids stay attached to the originals (the
  // duplicates have no spans). Score-level entries (markers /
  // voltas / jumpMarkers / etc.) in the source range are NOT
  // duplicated — they carry unique ids and the user can add fresh
  // ones at the duplicated range via the usual popovers if desired.
  // toAfter MAY lie inside [fromStart..fromEnd] (the duplicate
  // doesn't remove the source, so the destination overlapping with
  // the source is well-defined: the copy interleaves with the
  // originals).
  | {
      kind: 'dragMeasureRange'
      mode: 'duplicate'
      fromStart: number
      fromEnd: number
      toAfter: number
    }

export class EditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditError'
  }
}

const STEP_ORDER: Exclude<Pitch['step'], 'rest'>[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B']

function transposePitch(pitch: Pitch, deltaStep: number, deltaOctave: number): Pitch {
  if (pitch.step === 'rest') {
    throw new EditError('Cannot transpose a rest')
  }
  let stepIdx = STEP_ORDER.indexOf(pitch.step)
  let octave = pitch.octave + deltaOctave
  stepIdx += deltaStep
  while (stepIdx >= STEP_ORDER.length) {
    stepIdx -= STEP_ORDER.length
    octave += 1
  }
  while (stepIdx < 0) {
    stepIdx += STEP_ORDER.length
    octave -= 1
  }
  if (octave < 0 || octave > 9) {
    throw new EditError(`Octave ${octave} out of supported range (0..9)`)
  }
  return { ...pitch, step: STEP_ORDER[stepIdx], octave }
}

function staffOf(target: Target): number {
  return target.staffIdx ?? 0
}

function voiceOf(target: Target): number {
  return target.voiceIdx ?? 0
}

/**
 * Throw a descriptive EditError when (staffIdx, voiceIdx) addresses a
 * voice that doesn't exist. The retry pipeline (`scoreRetry.ts`)
 * embeds the error message verbatim into the next user turn, so the
 * LLM gets enough context to re-target on the next attempt.
 */
function assertVoiceExists(score: Score, staffIdx: number, voiceIdx: number): void {
  const sc = getStaffCount(score)
  if (staffIdx < 0 || staffIdx >= sc) {
    throw new EditError(
      `Target staffIdx=${staffIdx} does not exist; score has ${sc} stave${sc === 1 ? '' : 's'} (valid staffIdx: 0${sc > 1 ? '..1' : ''}).`,
    )
  }
  const vc = getVoiceCount(score, staffIdx)
  if (voiceIdx < 0 || voiceIdx >= vc) {
    throw new EditError(
      `Target (staffIdx=${staffIdx}, voiceIdx=${voiceIdx}) does not exist; staff ${staffIdx} has ${vc} voice${vc === 1 ? '' : 's'} (valid voiceIdx: 0${vc > 1 ? `..${vc - 1}` : ''}).`,
    )
  }
}

/**
 * Throw EditError when staffIdx addresses a staff that doesn't exist.
 * Used by measure-level ops (setStartBarline / setEndBarline / etc.)
 * where the existing `getStaffMeasures` would silently fall back to
 * `score.measures` on a missing secondStaff and produce a misleading
 * no-op. Stricter than assertVoiceExists since it skips the voice
 * check — measure-level ops don't target a specific voice.
 */
function assertStaffExists(score: Score, staffIdx: number): void {
  const sc = getStaffCount(score)
  if (staffIdx < 0 || staffIdx >= sc) {
    throw new EditError(
      `Target staffIdx=${staffIdx} does not exist; score has ${sc} stave${sc === 1 ? '' : 's'} (valid staffIdx: 0${sc > 1 ? '..1' : ''}).`,
    )
  }
}

/**
 * Validate a volta's `endings` array (M17-PR-1). Throws EditError
 * with the op name in the message so insertVolta + updateVolta
 * share one helper without losing context. Mirrors the per-volta
 * checks in VoltaSchema (length 1..9, each integer 1..9, no
 * duplicates).
 */
function assertVoltaEndings(endings: number[], opName: string): void {
  if (endings.length === 0 || endings.length > 9) {
    throw new EditError(
      `${opName} endings array must have 1..9 entries; got ${endings.length}`,
    )
  }
  for (const e of endings) {
    if (!Number.isInteger(e) || e < 1 || e > 9) {
      throw new EditError(
        `${opName} ending ${e} out of range; must be an integer 1..9`,
      )
    }
  }
  if (new Set(endings).size !== endings.length) {
    throw new EditError(
      `${opName} endings array has duplicates: [${endings.join(', ')}]`,
    )
  }
}

/**
 * Runtime guard on the JumpMarker kind enum. Mirrors the JumpKindSchema
 * z.enum so an LLM- or wire-supplied unknown kind surfaces as an
 * EditError before reaching validateScore. The source-of-truth set
 * lives in spans.ts (JUMP_KINDS).
 */
function isJumpMarkerKindEnum(k: string): k is JumpMarkerKind {
  return (JUMP_KINDS as readonly string[]).includes(k)
}

function getMeasure(score: Score, staffIdx: number, measureIdx: number): Measure {
  const m = getStaffMeasureAt(score, staffIdx, measureIdx)
  if (!m) throw new EditError(`Measure ${measureIdx} not found on staff ${staffIdx}`)
  return m
}

function getVoiceMeasure(
  score: Score,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
): Measure {
  assertVoiceExists(score, staffIdx, voiceIdx)
  const m = getVoiceMeasureAt(score, staffIdx, voiceIdx, measureIdx)
  if (!m) {
    throw new EditError(
      `Measure ${measureIdx} not found on staff ${staffIdx} voice ${voiceIdx}`,
    )
  }
  return m
}

function getEvent(score: Score, target: Target): Event {
  const m = getVoiceMeasure(score, staffOf(target), voiceOf(target), target.measureIdx)
  const e = m.events[target.eventIdx]
  if (!e) throw new EditError(`Event ${target.eventIdx} not found in measure ${target.measureIdx}`)
  return e
}

function withMeasure(
  score: Score,
  staffIdx: number,
  measureIdx: number,
  mapper: (m: Measure) => Measure,
): Score {
  return withStaffMeasures(score, staffIdx, (ms) =>
    ms.map((m, i) => (i === measureIdx ? mapper(m) : m)),
  )
}

function withVoiceMeasure(
  score: Score,
  staffIdx: number,
  voiceIdx: number,
  measureIdx: number,
  mapper: (m: Measure) => Measure,
): Score {
  assertVoiceExists(score, staffIdx, voiceIdx)
  return withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
    ms.map((m, i) => (i === measureIdx ? mapper(m) : m)),
  )
}

function withEvent(score: Score, target: Target, mapper: (e: Event) => Event): Score {
  return withVoiceMeasure(
    score,
    staffOf(target),
    voiceOf(target),
    target.measureIdx,
    (m) => ({
      ...m,
      events: m.events.map((e, i) => (i === target.eventIdx ? mapper(e) : e)),
    }),
  )
}

function withPitch(score: Score, target: Target, mapper: (p: Pitch) => Pitch): Score {
  const pitchIdx = target.pitchIdx ?? 0
  // Guard against silent no-ops when the LLM addresses a pitchIdx outside
  // the chord. Without this check, `map` walks the array without ever
  // hitting the index, the event is rebuilt unchanged, validateScore
  // passes, and the handler reports success despite no edit occurring —
  // the LLM gets no signal it should retry. Surface the mismatch as
  // EditError so scoreRetry can feed it back.
  return withEvent(score, target, (e) => {
    if (pitchIdx < 0 || pitchIdx >= e.pitches.length) {
      throw new EditError(
        `pitchIdx ${pitchIdx} out of range; event has ${e.pitches.length} pitch${e.pitches.length === 1 ? '' : 'es'}`,
      )
    }
    return {
      ...e,
      pitches: e.pitches.map((p, i) => (i === pitchIdx ? mapper(p) : p)),
    }
  })
}

/**
 * Pure transform: apply an Operation to a Score and return the new
 * Score. Does NOT validate — callers can choose whether validation
 * is hard (`applyOperation`) or soft (eg. accept temporarily invalid
 * states during multi-op edits).
 *
 * Structural ops (insertMeasureAfter / deleteMeasure / duplicateMeasure)
 * fan out across every staff so the staves stay bar-aligned. The LLM
 * still emits one op; we do the fan-out.
 */
export function transformScore(score: Score, op: Operation): Score {
  let next: Score
  switch (op.kind) {
    case 'changePitch': {
      next = withPitch(score, op.target, (p) =>
        transposePitch(p, op.deltaStep ?? 0, op.deltaOctave ?? 0),
      )
      break
    }
    case 'changeDuration': {
      next = withEvent(score, op.target, (e) => ({ ...e, duration: op.duration }))
      break
    }
    case 'setAccidental': {
      next = withPitch(score, op.target, (p) => {
        if (p.step === 'rest') throw new EditError('Cannot set accidental on a rest')
        return { ...p, accidental: op.accidental }
      })
      break
    }
    case 'setArticulation': {
      next = withEvent(score, op.target, (e) => ({ ...e, articulation: op.articulation }))
      break
    }
    case 'toggleTie': {
      next = withEvent(score, op.target, (e) => ({ ...e, tied_to_next: !e.tied_to_next }))
      break
    }
    case 'deleteEvent': {
      const m = getVoiceMeasure(
        score,
        staffOf(op.target),
        voiceOf(op.target),
        op.target.measureIdx,
      )
      if (m.events.length <= 1) {
        // Deleting the only event would leave an empty (and therefore
        // invalid) bar. The musical reading of "delete the only note in
        // this bar" is "turn the bar into a rest" — so convert it in place,
        // same duration so the measure still sums correctly, and keep the
        // event id so any span / tie referencing it stays anchored (a
        // dangling endpoint id would fail validateScore). This replaces the
        // old hard throw that aborted the whole edit and fell through to the
        // slow legacy path.
        next = withVoiceMeasure(
          score,
          staffOf(op.target),
          voiceOf(op.target),
          op.target.measureIdx,
          (mm) => {
            const only = mm.events[0]
            const rest: Event = {
              ...(only?.id !== undefined ? { id: only.id } : {}),
              kind: 'rest',
              pitches: [{ step: 'rest', octave: 4 }],
              duration: only?.duration ?? 'whole',
            }
            return { ...mm, events: [rest] }
          },
        )
        break
      }
      next = withVoiceMeasure(
        score,
        staffOf(op.target),
        voiceOf(op.target),
        op.target.measureIdx,
        (m) => ({
          ...m,
          events: m.events.filter((_, i) => i !== op.target.eventIdx),
        }),
      )
      break
    }
    case 'insertEventAfter': {
      next = withVoiceMeasure(
        score,
        staffOf(op.target),
        voiceOf(op.target),
        op.target.measureIdx,
        (m) => ({
          ...m,
          events: [
            ...m.events.slice(0, op.target.eventIdx + 1),
            op.event,
            ...m.events.slice(op.target.eventIdx + 1),
          ],
        }),
      )
      break
    }
    case 'addPitchToChord': {
      const e = getEvent(score, op.target)
      if (e.pitches.length >= 6) throw new EditError('Chord already has 6 pitches')
      if (op.pitch.step === 'rest') throw new EditError('Cannot add a rest to a chord')
      if (e.pitches.some((p) => p.step === 'rest')) {
        throw new EditError('Cannot add a pitch to a rest event')
      }
      next = withEvent(score, op.target, (e) => ({
        ...e,
        pitches: sortPitchesAscending([...e.pitches, op.pitch], score.key),
      }))
      break
    }
    case 'removePitchFromChord': {
      const e = getEvent(score, op.target)
      if (e.pitches.length <= 1) {
        throw new EditError('Cannot remove the only pitch in an event')
      }
      next = withEvent(score, op.target, (e) => ({
        ...e,
        pitches: e.pitches.filter((_, i) => i !== op.pitchIdx),
      }))
      break
    }
    case 'setEventPitches': {
      if (op.pitches.length < 1 || op.pitches.length > 6) {
        throw new EditError(`Event must have 1..6 pitches (got ${op.pitches.length})`)
      }
      if (op.pitches.length > 1 && op.pitches.some((p) => p.step === 'rest')) {
        throw new EditError('Cannot mix a rest with other pitches in an event')
      }
      next = withEvent(score, op.target, (e) => ({
        ...e,
        pitches: sortPitchesAscending(op.pitches, score.key),
      }))
      break
    }
    case 'changeKey': {
      next = { ...score, key: op.key }
      break
    }
    case 'changeMeter': {
      next = { ...score, meter: op.meter }
      break
    }
    case 'changeTempo': {
      if (op.tempo_bpm < 30 || op.tempo_bpm > 240) {
        throw new EditError(`Tempo ${op.tempo_bpm} out of supported range (30..240)`)
      }
      next = { ...score, tempo_bpm: op.tempo_bpm }
      break
    }
    case 'changeTitle': {
      next = { ...score, title: op.title.slice(0, 80) }
      break
    }
    case 'changeClef': {
      const staffIdx = op.staffIdx ?? 0
      if (staffIdx === 1) {
        if (!score.secondStaff) throw new EditError('No secondStaff to change clef on')
        next = { ...score, secondStaff: { ...score.secondStaff, clef: op.clef } }
      } else {
        // Primary staff. Treble is the default; omit the field rather
        // than store 'treble' explicitly so test fixtures keep matching.
        if (op.clef === 'treble') {
          const { clef: _omit, ...rest } = score
          void _omit
          next = rest as Score
        } else {
          next = { ...score, clef: op.clef }
        }
      }
      break
    }
    case 'addStaff': {
      if (score.secondStaff) throw new EditError('Score already has two staves')
      // Mirror the primary staff's bar layout with rests sized to the
      // meter (not hard-coded whole rests — those only sum correctly in
      // 4/4 / C). The LLM/user can fill it in afterward.
      const restMeasures: Measure[] = score.measures.map(() => fillMeasureWithRests(score.meter))
      const newStaff: Staff = { clef: op.clef, measures: restMeasures }
      next = { ...score, secondStaff: newStaff }
      break
    }
    case 'removeStaff': {
      if (op.staffIdx !== 1) {
        throw new EditError('Only the second staff can be removed; the primary staff is required')
      }
      if (!score.secondStaff) throw new EditError('No secondStaff to remove')
      const { secondStaff: _drop, ...rest } = score
      void _drop
      next = rest as Score
      break
    }
    case 'addVoice': {
      // Append a new voice to the given staff, filled with meter-sized
      // rests so it stays bar-aligned with every other voice. Caps at
      // 3 extra voices per staff (SchemaSchema's extraVoices.max(3)),
      // for 4 voices total per staff.
      const staffIdx = op.staffIdx
      if (staffIdx < 0 || staffIdx >= getStaffCount(score)) {
        throw new EditError(`Staff ${staffIdx} does not exist`)
      }
      const measureCount = getStaffMeasures(score, staffIdx).length
      const newVoice = {
        measures: Array.from({ length: measureCount }, () => fillMeasureWithRests(score.meter)),
      }
      if (staffIdx === 1) {
        const ss = score.secondStaff!
        const extras = ss.extraVoices ?? []
        if (extras.length >= 3) throw new EditError('Staff already has the maximum of 4 voices')
        next = { ...score, secondStaff: { ...ss, extraVoices: [...extras, newVoice] } }
      } else {
        const extras = score.extraVoices ?? []
        if (extras.length >= 3) throw new EditError('Staff already has the maximum of 4 voices')
        next = { ...score, extraVoices: [...extras, newVoice] }
      }
      break
    }
    case 'removeVoice': {
      const { staffIdx, voiceIdx } = op
      if (voiceIdx < 1) {
        throw new EditError('Cannot remove the primary voice; remove the staff instead')
      }
      if (staffIdx < 0 || staffIdx >= getStaffCount(score)) {
        throw new EditError(`Staff ${staffIdx} does not exist`)
      }
      const extras =
        staffIdx === 1 ? score.secondStaff?.extraVoices : score.extraVoices
      if (!extras || voiceIdx - 1 >= extras.length) {
        throw new EditError(`Voice ${voiceIdx} does not exist on staff ${staffIdx}`)
      }
      const nextExtras = extras.filter((_, i) => i !== voiceIdx - 1)
      if (staffIdx === 1) {
        const ss = score.secondStaff!
        if (nextExtras.length === 0) {
          const { extraVoices: _drop, ...rest } = ss
          void _drop
          next = { ...score, secondStaff: rest as typeof ss }
        } else {
          next = { ...score, secondStaff: { ...ss, extraVoices: nextExtras } }
        }
      } else {
        if (nextExtras.length === 0) {
          const { extraVoices: _drop, ...rest } = score
          void _drop
          next = rest as Score
        } else {
          next = { ...score, extraVoices: nextExtras }
        }
      }
      break
    }
    case 'insertMeasureAfter': {
      // Insert an empty measure of rests sized to the meter. Fans out
      // across every staff so they stay bar-aligned.
      const newMeasure: Measure = fillMeasureWithRests(score.meter)
      next = withAllStaffMeasures(score, (ms) => [
        ...ms.slice(0, op.measureIdx + 1),
        newMeasure,
        ...ms.slice(op.measureIdx + 1),
      ])
      break
    }
    case 'deleteMeasure': {
      if (score.measures.length <= 1) {
        throw new EditError('Cannot delete the only measure')
      }
      next = withAllStaffMeasures(score, (ms) => ms.filter((_, i) => i !== op.measureIdx))
      break
    }
    case 'duplicateMeasure': {
      // Each staff duplicates its OWN measure (so the duplicated bar
      // contains the same content on both staves, kept independent).
      next = withAllStaffMeasures(score, (ms) => {
        const src = ms[op.measureIdx]
        if (!src) return ms
        const clone: Measure = JSON.parse(JSON.stringify(src))
        return [...ms.slice(0, op.measureIdx + 1), clone, ...ms.slice(op.measureIdx + 1)]
      })
      break
    }
    case 'reorderEvent': {
      const staffIdx = staffOf(op.target)
      const voiceIdx = voiceOf(op.target)
      const { measureIdx, eventIdx } = op.target
      const measures = getVoiceMeasures(score, staffIdx, voiceIdx)
      const measure = getVoiceMeasure(score, staffIdx, voiceIdx, measureIdx)
      const event = measure.events[eventIdx]
      if (!event) throw new EditError(`Event ${eventIdx} not found in measure ${measureIdx}`)

      if (op.direction === 'right' && eventIdx < measure.events.length - 1) {
        // Swap with the next event in the same measure.
        const newEvents = [...measure.events]
        ;[newEvents[eventIdx], newEvents[eventIdx + 1]] = [newEvents[eventIdx + 1], newEvents[eventIdx]]
        next = withVoiceMeasure(score, staffIdx, voiceIdx, measureIdx, (m) => ({
          ...m,
          events: newEvents,
        }))
      } else if (op.direction === 'left' && eventIdx > 0) {
        const newEvents = [...measure.events]
        ;[newEvents[eventIdx], newEvents[eventIdx - 1]] = [newEvents[eventIdx - 1], newEvents[eventIdx]]
        next = withVoiceMeasure(score, staffIdx, voiceIdx, measureIdx, (m) => ({
          ...m,
          events: newEvents,
        }))
      } else if (op.direction === 'right' && measureIdx < measures.length - 1) {
        // Move event to start of next measure (same voice).
        const newCurrent = { ...measure, events: measure.events.filter((_, i) => i !== eventIdx) }
        const nextMeasure = getVoiceMeasure(score, staffIdx, voiceIdx, measureIdx + 1)
        const newNext = { ...nextMeasure, events: [event, ...nextMeasure.events] }
        if (newCurrent.events.length === 0) {
          throw new EditError('Cannot empty a measure by moving its only event')
        }
        next = withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
          ms.map((m, i) => {
            if (i === measureIdx) return newCurrent
            if (i === measureIdx + 1) return newNext
            return m
          }),
        )
      } else if (op.direction === 'left' && measureIdx > 0) {
        // Move event to end of previous measure (same voice).
        const newCurrent = { ...measure, events: measure.events.filter((_, i) => i !== eventIdx) }
        const prevMeasure = getVoiceMeasure(score, staffIdx, voiceIdx, measureIdx - 1)
        const newPrev = { ...prevMeasure, events: [...prevMeasure.events, event] }
        if (newCurrent.events.length === 0) {
          throw new EditError('Cannot empty a measure by moving its only event')
        }
        next = withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
          ms.map((m, i) => {
            if (i === measureIdx - 1) return newPrev
            if (i === measureIdx) return newCurrent
            return m
          }),
        )
      } else {
        // At score boundary in the requested direction; no-op.
        next = score
      }
      break
    }
    // ─── Per-note markings (M2-PR-3) ──────────────────────────────────
    case 'setArticulations': {
      // Route the input through normalizeArticulations so the array
      // honors the stacking conventions the INTRA_SYSTEM_PROMPT promises:
      // marcato+accent rejected, staccato+tenuto auto-coerced to portato,
      // canonical innermost-staccato → outermost-marcato order. The
      // ArticulationStackingError surfaces as EditError so scoreRetry
      // gets a meaningful retry signal.
      let normalized: Articulation[]
      try {
        normalized = normalizeArticulations(op.articulations)
      } catch (e) {
        if (e instanceof ArticulationStackingError) {
          throw new EditError(e.message)
        }
        throw e
      }
      next = withEvent(score, op.target, (e) => {
        // Strip the legacy singular field when adopting the array form
        // so getArticulations doesn't double-count.
        const { articulation: _legacy, articulations: _old, ...rest } = e
        void _legacy
        void _old
        if (normalized.length === 0) return rest
        return { ...rest, articulations: normalized }
      })
      break
    }
    case 'setOrnament': {
      next = withEvent(score, op.target, (e) => ({ ...e, ornament: op.ornament }))
      break
    }
    case 'setTrillUpperPitch': {
      next = withEvent(score, op.target, (e) => {
        const { trillUpperPitch: _drop, ...rest } = e
        void _drop
        if (op.trillUpperPitch === undefined) return rest
        return { ...rest, trillUpperPitch: op.trillUpperPitch }
      })
      break
    }
    case 'setGraceNotes': {
      // Single-shot setter — caller composes the new array (add /
      // remove / reorder happens client-side). Empty array strips
      // the field so legacy ornament:'grace' becomes visible again
      // as the renderer's fallback (mirrors setArticulations).
      //
      // Intentional asymmetry vs setArticulations: no normalize-
      // GraceNotes step exists because graces have no stacking
      // grammar (no analogue of marcato+accent rejection or staccato-
      // tenuto→portato coercion). If a future PR introduces such
      // rules (e.g. dedupe consecutive identical grace moments),
      // add a normalizer module here.
      next = withEvent(score, op.target, (e) => {
        const { graceNotes: _drop, ...rest } = e
        void _drop
        if (op.graceNotes.length === 0) return rest
        return { ...rest, graceNotes: op.graceNotes }
      })
      break
    }
    case 'setDynamic': {
      // Strip dynamic_structured when setting the simple form — at
      // render time getDynamicMarking returns dynamic_structured first
      // (dynamics.ts:12), so leaving a stale structured value would
      // silently shadow the new simple dynamic.
      next = withEvent(score, op.target, (e) => {
        const { dynamic_structured: _drop, ...rest } = e
        void _drop
        return { ...rest, dynamic: op.dynamic }
      })
      break
    }
    case 'setDynamicStructured': {
      // Strip the singular dynamic for symmetry with setDynamic so
      // only the one field "wins" at render time, no stale residue.
      next = withEvent(score, op.target, (e) => {
        const { dynamic_structured: _drop1, dynamic: _drop2, ...rest } = e
        void _drop1
        void _drop2
        if (op.dynamic_structured === undefined) return rest
        return { ...rest, dynamic_structured: op.dynamic_structured }
      })
      break
    }
    case 'setFermata': {
      next = withEvent(score, op.target, (e) => {
        const { fermata: _drop, ...rest } = e
        void _drop
        if (op.fermata === undefined) return rest
        return { ...rest, fermata: op.fermata }
      })
      break
    }
    case 'setBarlineFermata': {
      const staffIdx = op.staffIdx ?? 0
      // Guard against silent no-op when measureIdx is out of range —
      // same failure mode as withPitch above. validateScore would let
      // an unchanged score through, leaving the LLM with no retry
      // signal that the target was invalid. Also explicitly reject
      // staffIdx:1 on a single-staff score (getStaffMeasures falls
      // back to score.measures so the bounds check would pass and the
      // mutation would silently target the wrong staff).
      assertStaffExists(score, staffIdx)
      const measureCount = getStaffMeasures(score, staffIdx).length
      if (op.measureIdx < 0 || op.measureIdx >= measureCount) {
        throw new EditError(
          `setBarlineFermata measureIdx ${op.measureIdx} out of range; staff ${staffIdx} has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      next = withMeasure(score, staffIdx, op.measureIdx, (m) => {
        const { barlineFermata: _drop, ...rest } = m
        void _drop
        if (op.barlineFermata === undefined) return rest
        return { ...rest, barlineFermata: op.barlineFermata }
      })
      break
    }
    case 'setStartBarline': {
      const staffIdx = op.staffIdx ?? 0
      assertStaffExists(score, staffIdx)
      const measureCount = getStaffMeasures(score, staffIdx).length
      if (op.measureIdx < 0 || op.measureIdx >= measureCount) {
        throw new EditError(
          `setStartBarline measureIdx ${op.measureIdx} out of range; staff ${staffIdx} has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      // NOTE: M16-PR-1 lands the data layer only — the renderer
      // (scoreToAbcWithMap unconditionally emits `|` between
      // measures) ignores startBarline / endBarline until M16-PR-2.
      // Score JSON round-trips correctly; visual rendering pending.
      next = withMeasure(score, staffIdx, op.measureIdx, (m) => {
        const { startBarline: _drop, ...rest } = m
        void _drop
        if (op.barline === undefined) return rest
        return { ...rest, startBarline: op.barline }
      })
      break
    }
    case 'setEndBarline': {
      const staffIdx = op.staffIdx ?? 0
      assertStaffExists(score, staffIdx)
      const measureCount = getStaffMeasures(score, staffIdx).length
      if (op.measureIdx < 0 || op.measureIdx >= measureCount) {
        throw new EditError(
          `setEndBarline measureIdx ${op.measureIdx} out of range; staff ${staffIdx} has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      next = withMeasure(score, staffIdx, op.measureIdx, (m) => {
        const { endBarline: _drop, ...rest } = m
        void _drop
        if (op.barline === undefined) return rest
        return { ...rest, endBarline: op.barline }
      })
      break
    }
    case 'setPickup': {
      const staffIdx = op.staffIdx ?? 0
      assertStaffExists(score, staffIdx)
      const measureCount = getStaffMeasures(score, staffIdx).length
      if (op.measureIdx < 0 || op.measureIdx >= measureCount) {
        throw new EditError(
          `setPickup measureIdx ${op.measureIdx} out of range; staff ${staffIdx} has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      // false strips the field so persisted JSON stays clean.
      next = withMeasure(score, staffIdx, op.measureIdx, (m) => {
        const { isPickup: _drop, ...rest } = m
        void _drop
        if (!op.isPickup) return rest
        return { ...rest, isPickup: true }
      })
      break
    }
    case 'setFinalPartial': {
      const staffIdx = op.staffIdx ?? 0
      assertStaffExists(score, staffIdx)
      const measureCount = getStaffMeasures(score, staffIdx).length
      if (op.measureIdx < 0 || op.measureIdx >= measureCount) {
        throw new EditError(
          `setFinalPartial measureIdx ${op.measureIdx} out of range; staff ${staffIdx} has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      next = withMeasure(score, staffIdx, op.measureIdx, (m) => {
        const { isFinalPartial: _drop, ...rest } = m
        void _drop
        if (!op.isFinalPartial) return rest
        return { ...rest, isFinalPartial: true }
      })
      break
    }
    case 'setBreathMark': {
      next = withEvent(score, op.target, (e) => {
        const { breathMark: _drop, ...rest } = e
        void _drop
        if (!op.breathMark) return rest
        return { ...rest, breathMark: true }
      })
      break
    }
    case 'setCaesura': {
      next = withEvent(score, op.target, (e) => {
        const { caesura: _drop, ...rest } = e
        void _drop
        if (!op.caesura) return rest
        return { ...rest, caesura: true }
      })
      break
    }
    case 'setTremolo': {
      next = withEvent(score, op.target, (e) => {
        const { tremolo: _drop, ...rest } = e
        void _drop
        if (op.tremolo === undefined) return rest
        return { ...rest, tremolo: op.tremolo }
      })
      break
    }
    case 'setBowing': {
      // Bowing on a rest is nonsensical — reject so the LLM corrects
      // its target on retry rather than silently producing weird data.
      const ev = getEvent(score, op.target)
      if (ev.pitches.every((p) => p.step === 'rest') && op.bowing !== undefined) {
        throw new EditError('Cannot set bowing on a rest')
      }
      next = withEvent(score, op.target, (e) => {
        const { bowing: _drop, ...rest } = e
        void _drop
        if (op.bowing === undefined) return rest
        return { ...rest, bowing: op.bowing }
      })
      break
    }
    case 'setJazzInflection': {
      next = withEvent(score, op.target, (e) => {
        const { jazzInflection: _drop, ...rest } = e
        void _drop
        if (op.jazzInflection === undefined) return rest
        return { ...rest, jazzInflection: op.jazzInflection }
      })
      break
    }
    case 'setChordSymbol': {
      // Single-shot setter for the per-event chord symbol. Omit to
      // clear (drops the key from the persisted JSON). Caller is
      // responsible for constructing the structured ChordSymbol —
      // the popover (M10-PR-5) parses free-text via parseChordSymbol;
      // the LLM (M10-PR-3) emits the structured object directly.
      next = withEvent(score, op.target, (e) => {
        const { chordSymbol: _drop, ...rest } = e
        void _drop
        if (op.chordSymbol === undefined) return rest
        return { ...rest, chordSymbol: op.chordSymbol }
      })
      break
    }
    case 'setPitchTie': {
      // Persist the explicit value (true OR false) — `false` is the
      // documented override for the legacy event-wide `tied_to_next:true`
      // when only some chord tones should release the tie. Stripping
      // the per-pitch flag would let isPitchTiedToNext fall back to the
      // event-wide flag and silently keep the pitch tied. See
      // pitchTies.ts:24-26 for the precedence rules.
      next = withPitch(score, op.target, (p) => {
        if (p.step === 'rest' && op.tied_to_next) {
          throw new EditError('Cannot tie a rest')
        }
        return { ...p, tied_to_next: op.tied_to_next }
      })
      break
    }
    case 'setLv': {
      next = withPitch(score, op.target, (p) => {
        if (p.step === 'rest' && op.lv) {
          throw new EditError('Cannot apply laissez vibrer to a rest')
        }
        const { lv: _drop, ...rest } = p
        void _drop
        if (!op.lv) return rest
        return { ...rest, lv: true }
      })
      break
    }
    case 'setEnharmonicTie': {
      next = withPitch(score, op.target, (p) => {
        if (p.step === 'rest' && op.enharmonicTie) {
          throw new EditError('Cannot apply enharmonic tie to a rest')
        }
        const { enharmonicTie: _drop, ...rest } = p
        void _drop
        if (!op.enharmonicTie) return rest
        return { ...rest, enharmonicTie: true }
      })
      break
    }
    case 'setFingering': {
      // Per-pitch op; bounds-check the pitchIdx against the chord
      // before delegating to the helper so the LLM gets a meaningful
      // retry signal on bad target indices.
      const pitchIdx = op.target.pitchIdx ?? 0
      const ev = getEvent(score, op.target)
      if (pitchIdx < 0 || pitchIdx >= ev.pitches.length) {
        throw new EditError(
          `setFingering pitchIdx ${pitchIdx} out of range; event has ${ev.pitches.length} pitch${ev.pitches.length === 1 ? '' : 'es'}`,
        )
      }
      if (ev.pitches[pitchIdx].step === 'rest') {
        throw new EditError('Cannot set fingering on a rest')
      }
      next = withEvent(score, op.target, (e) => setFingeringAt(e, pitchIdx, op.fingering))
      break
    }
    case 'removeFingering': {
      const pitchIdx = op.target.pitchIdx ?? 0
      const ev = getEvent(score, op.target)
      if (pitchIdx < 0 || pitchIdx >= ev.pitches.length) {
        throw new EditError(
          `removeFingering pitchIdx ${pitchIdx} out of range; event has ${ev.pitches.length} pitch${ev.pitches.length === 1 ? '' : 'es'}`,
        )
      }
      next = withEvent(score, op.target, (e) => removeFingeringAt(e, pitchIdx))
      break
    }
    case 'setLyric': {
      // Bounds-check verse + syllable length against the schema so the
      // LLM gets a meaningful retry signal instead of a downstream
      // validateScore explosion. Mirrors the schema bounds at
      // LyricSyllableSchema (types.ts:419-424).
      if (!Number.isInteger(op.verse) || op.verse < 1 || op.verse > 50) {
        throw new EditError(
          `setLyric verse ${op.verse} out of range; must be an integer 1..50`,
        )
      }
      if (op.syllable.length < 1 || op.syllable.length > 40) {
        throw new EditError(
          `setLyric syllable length ${op.syllable.length} out of range; must be 1..40 chars`,
        )
      }
      // Reject whitespace-only syllables: the schema allows them
      // technically (.min(1) on string length), but a syllable that
      // renders as blank under the noteheads is almost always a typo.
      // Users who want literal vocalises encode them as "ah", "oh",
      // etc. — never a bare space character.
      if (op.syllable.trim().length === 0) {
        throw new EditError(
          'setLyric syllable cannot be whitespace-only; use "ah" or "oh" for vocalises',
        )
      }
      // Engraving convention: a syllable carries EITHER a hyphen
      // (continuation: "Glo-ri-a") OR an extender (melisma: "A____")
      // but never both — the visual semantics are mutually exclusive
      // and engravers / readers would not know which to render.
      if (op.hyphen === true && op.extender === true) {
        throw new EditError(
          'setLyric: hyphen and extender are mutually exclusive — a syllable continues OR extends, not both',
        )
      }
      const syllable: LyricSyllable = { verse: op.verse, syllable: op.syllable }
      if (op.hyphen === true) syllable.hyphen = true
      if (op.extender === true) syllable.extender = true
      next = withEvent(score, op.target, (e) => setSyllable(e, syllable))
      break
    }
    case 'removeLyric': {
      // Verse bounds-check; idempotent if the verse isn't present
      // (removeSyllable filters by predicate so missing-verse is a
      // benign no-op — re-asking to clear an already-cleared verse is
      // not a retry signal).
      if (!Number.isInteger(op.verse) || op.verse < 1 || op.verse > 50) {
        throw new EditError(
          `removeLyric verse ${op.verse} out of range; must be an integer 1..50`,
        )
      }
      next = withEvent(score, op.target, (e) => removeSyllable(e, op.verse))
      break
    }
    case 'clearLyrics': {
      // Drop the entire lyrics field on the event. Distinct from
      // removeLyric which targets one verse — clearLyrics is the
      // "delete every syllable" gesture for cases like wiping
      // hand-imported text before re-entering.
      next = withEvent(score, op.target, (e) => {
        const { lyrics: _drop, ...rest } = e
        void _drop
        return rest
      })
      break
    }
    case 'insertTechniqueChange': {
      const tc = op.techniqueChange
      // Validate (staffIdx, voiceIdx) exist on the live score so the
      // LLM gets a meaningful retry error rather than a downstream
      // validateScore explosion.
      assertVoiceExists(score, tc.staffIdx, tc.voiceIdx)
      const voiceMeasures = getVoiceMeasures(score, tc.staffIdx, tc.voiceIdx)
      if (tc.measureIdx < 0 || tc.measureIdx >= voiceMeasures.length) {
        throw new EditError(
          `insertTechniqueChange measureIdx ${tc.measureIdx} out of range; staff ${tc.staffIdx} voice ${tc.voiceIdx} has ${voiceMeasures.length} measure${voiceMeasures.length === 1 ? '' : 's'}`,
        )
      }
      if (tc.eventIdx !== undefined) {
        const events = voiceMeasures[tc.measureIdx].events
        if (tc.eventIdx < 0 || tc.eventIdx >= events.length) {
          throw new EditError(
            `insertTechniqueChange eventIdx ${tc.eventIdx} out of range; measure ${tc.measureIdx} has ${events.length} event${events.length === 1 ? '' : 's'}`,
          )
        }
      }
      // Reject LLM-supplied ids that collide with existing ones — the
      // model occasionally copy-pastes an id from the score JSON, and
      // a duplicate would let removeTechniqueChange wipe both entries.
      // The editor's createTechniqueChange already mints unique ids, so
      // the collision path only fires on bad LLM output.
      const existing = score.techniqueStates ?? []
      if (tc.id !== undefined && existing.some((t) => t.id === tc.id)) {
        throw new EditError(
          `insertTechniqueChange id "${tc.id}" collides with an existing techniqueStates entry; omit the id and let the system mint one`,
        )
      }
      // Mint id when missing so removeTechniqueChange has a stable handle.
      const newChange: TechniqueChange = {
        id: tc.id ?? createTechniqueId(),
        measureIdx: tc.measureIdx,
        staffIdx: tc.staffIdx,
        voiceIdx: tc.voiceIdx,
        kind: tc.kind,
        ...(tc.eventIdx !== undefined ? { eventIdx: tc.eventIdx } : {}),
      }
      next = { ...score, techniqueStates: [...existing, newChange] }
      break
    }
    case 'appendMeasures': {
      next = applyStructuralAppendOrInsert(score, op.measures, op.perVoiceContent, /* insertIdx */ score.measures.length - 1)
      // Clear isFinalPartial on the previously-last measure on every
      // staff+voice — what was "the end" is no longer the end.
      const prevLastIdx = score.measures.length - 1
      if (prevLastIdx >= 0) {
        next = withAllVoiceMeasures(next, (ms) => {
          if (prevLastIdx >= ms.length) return ms
          return ms.map((m, i) => {
            if (i !== prevLastIdx) return m
            if (!m.isFinalPartial) return m
            const { isFinalPartial: _drop, ...rest } = m
            void _drop
            return rest as Measure
          })
        })
      }
      break
    }
    case 'insertMeasuresAfter': {
      const measureCount = score.measures.length
      if (op.afterMeasureIdx < -1 || op.afterMeasureIdx >= measureCount) {
        throw new EditError(
          `insertMeasuresAfter afterMeasureIdx ${op.afterMeasureIdx} out of range; score has ${measureCount} measure${measureCount === 1 ? '' : 's'} (valid: -1..${measureCount - 1})`,
        )
      }
      next = applyStructuralAppendOrInsert(score, op.measures, op.perVoiceContent, op.afterMeasureIdx)
      // Remap forward: indices > afterMeasureIdx shift by +count.
      const count = op.measures.length
      next = remapScoreReferences(next, (idx) =>
        remapIndexAfterInsert(idx, op.afterMeasureIdx, count),
      )
      // D4: append carried spans (endpoints already remapped to the
      // inserted measures' fresh ids).
      if (op.spansToAdd && op.spansToAdd.length > 0) {
        next = { ...next, spans: [...(next.spans ?? []), ...op.spansToAdd] }
      }
      break
    }
    case 'regionReplace': {
      const measureCount = score.measures.length
      if (
        op.startMeasureIdx < 0 ||
        op.endMeasureIdx >= measureCount ||
        op.startMeasureIdx > op.endMeasureIdx
      ) {
        throw new EditError(
          `regionReplace range [${op.startMeasureIdx}..${op.endMeasureIdx}] invalid; score has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      const replacedLen = op.endMeasureIdx - op.startMeasureIdx + 1
      const newCount = op.measures.length
      if (newCount === 0) {
        // No replacement content — equivalent to range-delete. Reject
        // when it would empty the score (validation guard).
        if (measureCount - replacedLen <= 0) {
          throw new EditError('regionReplace would empty the score')
        }
      }
      next = applyRegionReplace(score, op.startMeasureIdx, op.endMeasureIdx, op.measures, op.perVoiceContent)
      // Drop spans fully-inside or severed by the replaced range.
      // Severance is also surfaced to the orchestrator handler as a
      // warning; here we just clean up.
      const survivingSpans = dropSeveredAndInteriorSpans(score, op.startMeasureIdx, op.endMeasureIdx)
      if (survivingSpans && survivingSpans.length > 0) {
        next = { ...next, spans: survivingSpans }
      } else {
        const { spans: _drop, ...rest } = next
        void _drop
        next = rest as Score
      }
      next = remapScoreReferences(next, (idx) =>
        remapIndexAfterRegionReplace(idx, op.startMeasureIdx, op.endMeasureIdx, newCount),
      )
      // D4: append carried spans, AFTER the interior/severed drop above
      // (these point at the replacement events' fresh ids).
      if (op.spansToAdd && op.spansToAdd.length > 0) {
        next = { ...next, spans: [...(next.spans ?? []), ...op.spansToAdd] }
      }
      break
    }
    case 'dragMeasureRange': {
      const measureCount = score.measures.length
      if (op.fromStart < 0 || op.fromEnd >= measureCount || op.fromStart > op.fromEnd) {
        throw new EditError(
          `dragMeasureRange range [${op.fromStart}..${op.fromEnd}] invalid; score has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      const rangeLen = op.fromEnd - op.fromStart + 1
      // Snapshot whether the score's last bar carried isFinalPartial
      // BEFORE the mutation — both delete + move call
      // normalizeFinalPartial below so the post-mutation last bar
      // ends up with the correct flag regardless of how the splice
      // reshuffled the bar identities. See normalizeFinalPartial.
      const hadFinalPartial =
        score.measures[measureCount - 1]?.isFinalPartial === true

      // NOTE: any new dragMeasureRange `mode` MUST add an `if (op.mode
      // === '<new>')` branch BEFORE the move fallthrough below.
      // TypeScript doesn't enforce mode-exhaustiveness inside the
      // shared case label (all modes share `case 'dragMeasureRange'`),
      // so a missing branch would silently fall into the move block.

      if (op.mode === 'duplicate') {
        // Validate toAfter range. Unlike 'move', duplicate has NO
        // overlap restriction — toAfter may sit anywhere in
        // [-1..measureCount-1], including INSIDE the source range,
        // because the source range stays in place and the copy
        // interleaves with the originals at the requested position.
        if (op.toAfter < -1 || op.toAfter >= measureCount) {
          throw new EditError(
            `dragMeasureRange duplicate toAfter ${op.toAfter} out of range; score has ${measureCount} measure${measureCount === 1 ? '' : 's'} (valid: -1..${measureCount - 1})`,
          )
        }
        // Capture, clone with fresh event ids, then insert. Score-
        // level entries (markers / voltas / jumpMarkers / etc.) in
        // the source range are NOT duplicated — they carry unique ids
        // and the user can add fresh ones at the duplicated range
        // via the popovers if desired.
        const captured = captureRangeContent(score, op.fromStart, op.fromEnd)
        const cloned = cloneCapturedRangeWithFreshIds(captured)
        next = applyStructuralAppendOrInsert(
          score,
          cloned.primaryMeasures,
          cloned.perVoiceContent,
          op.toAfter,
        )
        next = remapScoreReferences(next, (idx) =>
          remapIndexAfterInsert(idx, op.toAfter, rangeLen),
        )
        next = normalizeFinalPartial(next, hadFinalPartial)
        break
      }

      if (op.mode === 'delete') {
        if (measureCount - rangeLen <= 0) {
          throw new EditError('dragMeasureRange delete would empty the score')
        }
        // Equivalent to regionReplace [fromStart..fromEnd] with no
        // measures. Reuse the same primitives so spans + score-level
        // entries get the canonical drop behavior.
        next = applyRegionReplace(score, op.fromStart, op.fromEnd, [], undefined)
        const survivingSpans = dropSeveredAndInteriorSpans(score, op.fromStart, op.fromEnd)
        if (survivingSpans && survivingSpans.length > 0) {
          next = { ...next, spans: survivingSpans }
        } else if (next.spans !== undefined) {
          const { spans: _drop, ...rest } = next
          void _drop
          next = rest as Score
        }
        next = remapScoreReferences(next, (idx) =>
          remapIndexAfterRegionReplace(idx, op.fromStart, op.fromEnd, 0),
        )
        next = normalizeFinalPartial(next, hadFinalPartial)
        break
      }

      // mode === 'move'. Validate toAfter is outside [fromStart-1..fromEnd].
      // toAfter === fromStart - 1 is a no-op (range stays put).
      // toAfter inside [fromStart..fromEnd] is undefined (range can't
      // land on itself).
      if (op.toAfter < -1 || op.toAfter >= measureCount) {
        throw new EditError(
          `dragMeasureRange move toAfter ${op.toAfter} out of range; score has ${measureCount} measure${measureCount === 1 ? '' : 's'} (valid: -1..${measureCount - 1})`,
        )
      }
      if (op.toAfter >= op.fromStart - 1 && op.toAfter <= op.fromEnd) {
        throw new EditError(
          `dragMeasureRange move toAfter ${op.toAfter} overlaps source range [${op.fromStart}..${op.fromEnd}] — move would be a no-op or undefined`,
        )
      }

      // Capture source content per (staff, voice) before any
      // mutation. captureRangeContent yields the same shape
      // applyStructuralAppendOrInsert expects (primary measures +
      // perVoiceContent fanout).
      const captured = captureRangeContent(score, op.fromStart, op.fromEnd)

      // Extract score-level entries scoped to the source range so
      // we can re-anchor them at the destination after the splice.
      // Voltas + annotations STRADDLING the range get dropped via
      // stripRangeEntries. extractRangeEntries reports the straddler
      // drops via a warnings sink — we discard them here because the
      // edit-op layer has no warning channel of its own. TODO(M19-
      // PR-4+): when the orchestrator wires this op via the UI, feed
      // these warnings through the existing handler warning channel
      // (mirrors how regionReplace's severedSpans warnings reach the
      // user via runRegionReplace).
      const extracted = extractRangeEntries(score, op.fromStart, op.fromEnd)
      let after = stripRangeEntries(score, op.fromStart, op.fromEnd)

      // Remove the source range from every (staff, voice). Spans are
      // preserved (event ids unchanged across move). Score-level
      // entries are already stripped above so the remap below has
      // nothing to drop from the source range.
      after = applyRegionReplace(after, op.fromStart, op.fromEnd, [], undefined)
      after = remapScoreReferences(after, (idx) =>
        remapIndexAfterRegionReplace(idx, op.fromStart, op.fromEnd, 0),
      )

      // Compute the post-removal insertion position. toAfter in the
      // original layout: shift left by rangeLen when toAfter > fromEnd
      // (the removed range was before it); leave unchanged when
      // toAfter < fromStart (the removed range was after it).
      const remappedToAfter =
        op.toAfter > op.fromEnd ? op.toAfter - rangeLen : op.toAfter

      // Insert the captured measures back at the remapped position.
      after = applyStructuralAppendOrInsert(
        after,
        captured.primaryMeasures,
        captured.perVoiceContent,
        remappedToAfter,
      )
      // Shift score-level entries on the post-insertion side forward
      // by rangeLen. (Extracted entries are NOT in `after` yet — they
      // get added next with absolute destination positions.)
      after = remapScoreReferences(after, (idx) =>
        remapIndexAfterInsert(idx, remappedToAfter, rangeLen),
      )

      // Re-anchor the extracted entries at their destination. The
      // destination's first measure sits at remappedToAfter + 1.
      const destinationStart = remappedToAfter + 1
      after = reattachExtractedEntries(after, extracted, destinationStart)
      // Normalize isFinalPartial so it sits ONLY on the post-move
      // last bar (with the bit controlled by the pre-mutation flag).
      // Without this, moving the original final bar into the middle
      // would leave the flag stranded on a non-last measure AND the
      // actual new last bar would have no flag.
      after = normalizeFinalPartial(after, hadFinalPartial)

      next = after
      break
    }
    case 'removeTechniqueChange': {
      const states = score.techniqueStates ?? []
      const found = states.some((t) => t.id === op.id)
      if (!found) {
        throw new EditError(
          `removeTechniqueChange id "${op.id}" not found on techniqueStates`,
        )
      }
      const remaining = states.filter((t) => t.id !== op.id)
      // Drop the array entirely when empty so persisted JSON stays
      // lean — matches the convention used for other optional fields.
      if (remaining.length === 0) {
        const { techniqueStates: _drop, ...rest } = score
        void _drop
        next = rest
      } else {
        next = { ...score, techniqueStates: remaining }
      }
      break
    }
    case 'insertAnnotation': {
      const a = op.annotation
      const measureCount = score.measures.length
      if (a.measureIdx < 0 || a.measureIdx >= measureCount) {
        throw new EditError(
          `insertAnnotation measureIdx ${a.measureIdx} out of range; score has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      if (a.eventIdx !== undefined) {
        const events = score.measures[a.measureIdx].events
        if (a.eventIdx < 0 || a.eventIdx >= events.length) {
          throw new EditError(
            `insertAnnotation eventIdx ${a.eventIdx} out of range; measure ${a.measureIdx} has ${events.length} event${events.length === 1 ? '' : 's'}`,
          )
        }
      }
      // spanEnd bounds — bracket the same way so a typo doesn't
      // produce a dashed line into nothing.
      if (a.spanEnd !== undefined) {
        if (a.spanEnd.measureIdx < 0 || a.spanEnd.measureIdx >= measureCount) {
          throw new EditError(
            `insertAnnotation spanEnd.measureIdx ${a.spanEnd.measureIdx} out of range; score has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
          )
        }
        if (a.spanEnd.measureIdx < a.measureIdx) {
          throw new EditError(
            `insertAnnotation spanEnd.measureIdx (${a.spanEnd.measureIdx}) precedes target.measureIdx (${a.measureIdx}); spans must extend FORWARD`,
          )
        }
        if (a.spanEnd.eventIdx !== undefined) {
          const events = score.measures[a.spanEnd.measureIdx].events
          if (a.spanEnd.eventIdx < 0 || a.spanEnd.eventIdx >= events.length) {
            throw new EditError(
              `insertAnnotation spanEnd.eventIdx ${a.spanEnd.eventIdx} out of range; measure ${a.spanEnd.measureIdx} has ${events.length} event${events.length === 1 ? '' : 's'}`,
            )
          }
        }
      }
      // Reject LLM-supplied id collisions for the same reason as
      // insertTechniqueChange — duplicate ids let removeAnnotation
      // wipe both. The editor's createAnnotation mints unique ids;
      // collision path only fires on bad LLM output.
      const existing = score.annotations ?? []
      if (a.id !== undefined && existing.some((x) => x.id === a.id)) {
        throw new EditError(
          `insertAnnotation id "${a.id}" collides with an existing annotation; omit the id and let the system mint one`,
        )
      }
      const newAnnotation: Annotation = {
        id: a.id ?? createAnnotationId(),
        target: {
          measureIdx: a.measureIdx,
          ...(a.eventIdx !== undefined ? { eventIdx: a.eventIdx } : {}),
          position: a.position,
        },
        text: a.text,
        style: a.style,
        ...(a.spanEnd !== undefined ? { spanEnd: a.spanEnd } : {}),
      }
      next = { ...score, annotations: [...existing, newAnnotation] }
      break
    }
    case 'removeAnnotation': {
      const list = score.annotations ?? []
      const found = list.some((x) => x.id === op.id)
      if (!found) {
        throw new EditError(`removeAnnotation id "${op.id}" not found on annotations`)
      }
      const remaining = list.filter((x) => x.id !== op.id)
      if (remaining.length === 0) {
        const { annotations: _drop, ...rest } = score
        void _drop
        next = rest
      } else {
        next = { ...score, annotations: remaining }
      }
      break
    }
    case 'updateAnnotation': {
      const list = score.annotations ?? []
      const idx = list.findIndex((x) => x.id === op.id)
      if (idx < 0) {
        throw new EditError(`updateAnnotation id "${op.id}" not found on annotations`)
      }
      const prev = list[idx]
      // Re-validate target bounds if the patch re-anchors.
      const nextTarget = op.patch.target ?? prev.target
      const measureCount = score.measures.length
      if (nextTarget.measureIdx < 0 || nextTarget.measureIdx >= measureCount) {
        throw new EditError(
          `updateAnnotation target.measureIdx ${nextTarget.measureIdx} out of range; score has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      if (nextTarget.eventIdx !== undefined) {
        const events = score.measures[nextTarget.measureIdx].events
        if (nextTarget.eventIdx < 0 || nextTarget.eventIdx >= events.length) {
          throw new EditError(
            `updateAnnotation target.eventIdx ${nextTarget.eventIdx} out of range; measure ${nextTarget.measureIdx} has ${events.length} event${events.length === 1 ? '' : 's'}`,
          )
        }
      }
      // spanEnd patch: null clears, undefined preserves, object replaces.
      const nextSpanEnd =
        op.patch.spanEnd === null ? undefined : op.patch.spanEnd ?? prev.spanEnd
      if (nextSpanEnd !== undefined) {
        if (nextSpanEnd.measureIdx < 0 || nextSpanEnd.measureIdx >= measureCount) {
          throw new EditError(
            `updateAnnotation spanEnd.measureIdx ${nextSpanEnd.measureIdx} out of range`,
          )
        }
        if (nextSpanEnd.measureIdx < nextTarget.measureIdx) {
          throw new EditError(
            `updateAnnotation spanEnd.measureIdx (${nextSpanEnd.measureIdx}) precedes target.measureIdx (${nextTarget.measureIdx})`,
          )
        }
      }
      const updated: Annotation = {
        ...prev,
        target: nextTarget,
        ...(op.patch.text !== undefined ? { text: op.patch.text } : {}),
        ...(op.patch.style !== undefined ? { style: op.patch.style } : {}),
        ...(nextSpanEnd !== undefined ? { spanEnd: nextSpanEnd } : {}),
      }
      // If the patch cleared spanEnd explicitly (null) AND prev had
      // one, drop the field. The conditional spread above wouldn't
      // touch a previous spanEnd that's no longer in `updated`, but
      // the `...prev` carries it through. Explicit delete.
      if (op.patch.spanEnd === null) {
        const { spanEnd: _drop, ...rest } = updated
        void _drop
        const nextList = [...list]
        nextList[idx] = rest as Annotation
        next = { ...score, annotations: nextList }
      } else {
        const nextList = [...list]
        nextList[idx] = updated
        next = { ...score, annotations: nextList }
      }
      break
    }
    case 'setScoreMetadata': {
      // Field-by-field patch. null clears, undefined preserves, empty
      // string is rejected (matches user intent — setting to '' is
      // almost always a mistake; the LLM should pass null instead).
      const fields: Array<'title' | 'composer' | 'arranger' | 'lyricist' | 'copyright'> = [
        'title',
        'composer',
        'arranger',
        'lyricist',
        'copyright',
      ]
      let acc: Score = score
      for (const f of fields) {
        const val = op.patch[f]
        if (val === undefined) continue
        if (val === null) {
          const { [f]: _drop, ...rest } = acc
          void _drop
          acc = rest as Score
          continue
        }
        if (val === '') {
          throw new EditError(
            `setScoreMetadata ${f} cannot be an empty string; pass null to clear or a non-empty value to set`,
          )
        }
        acc = { ...acc, [f]: val }
      }
      next = acc
      break
    }
    case 'insertMarker': {
      const m = op.marker
      const measureCount = score.measures.length
      if (m.measureIdx < 0 || m.measureIdx >= measureCount) {
        throw new EditError(
          `insertMarker measureIdx ${m.measureIdx} out of range; score has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      // At least one field must change — mirrors the MarkerSchema
      // refine so the LLM gets a meaningful retry error rather than
      // a downstream schema explosion.
      const hasAnyField =
        m.key !== undefined ||
        m.meter !== undefined ||
        m.tempo_bpm !== undefined ||
        m.tempo_text !== undefined ||
        (m.clefs !== undefined && m.clefs.length > 0) ||
        m.metricModulation !== undefined
      if (!hasAnyField) {
        throw new EditError(
          'insertMarker requires at least one of key, meter, tempo_bpm, tempo_text, clefs, metricModulation',
        )
      }
      // Reject LLM-supplied id collisions — same precedent as
      // insertTechniqueChange / insertAnnotation.
      const existing = score.markers ?? []
      if (m.id !== undefined && existing.some((x) => x.id === m.id)) {
        throw new EditError(
          `insertMarker id "${m.id}" collides with an existing marker; omit the id and let the system mint one`,
        )
      }
      const newMarker: Marker = {
        id: m.id ?? createMarkerId(),
        measureIdx: m.measureIdx,
        ...(m.key !== undefined ? { key: m.key } : {}),
        ...(m.meter !== undefined ? { meter: m.meter } : {}),
        ...(m.tempo_bpm !== undefined ? { tempo_bpm: m.tempo_bpm } : {}),
        ...(m.tempo_text !== undefined ? { tempo_text: m.tempo_text } : {}),
        ...(m.clefs !== undefined ? { clefs: m.clefs } : {}),
        ...(m.metricModulation !== undefined ? { metricModulation: m.metricModulation } : {}),
      }
      next = { ...score, markers: [...existing, newMarker] }
      break
    }
    case 'removeMarker': {
      const list = score.markers ?? []
      const found = list.some((x) => x.id === op.id)
      if (!found) {
        throw new EditError(`removeMarker id "${op.id}" not found on markers`)
      }
      const remaining = list.filter((x) => x.id !== op.id)
      if (remaining.length === 0) {
        const { markers: _drop, ...rest } = score
        void _drop
        next = rest
      } else {
        next = { ...score, markers: remaining }
      }
      break
    }
    case 'updateMarker': {
      const list = score.markers ?? []
      const idx = list.findIndex((x) => x.id === op.id)
      if (idx < 0) {
        throw new EditError(`updateMarker id "${op.id}" not found on markers`)
      }
      const prev = list[idx]
      const measureCount = score.measures.length
      // measureIdx patch validates against current bounds.
      const nextMeasureIdx = op.patch.measureIdx ?? prev.measureIdx
      if (nextMeasureIdx < 0 || nextMeasureIdx >= measureCount) {
        throw new EditError(
          `updateMarker measureIdx ${nextMeasureIdx} out of range; score has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      // Field-by-field: undefined preserves, null clears, value sets.
      // Build a fresh marker so the null-clears semantic strips keys.
      const updated: Marker = {
        id: prev.id,
        measureIdx: nextMeasureIdx,
      }
      const carryOrPatch = <K extends 'key' | 'meter' | 'tempo_bpm' | 'tempo_text' | 'clefs' | 'metricModulation'>(
        key: K,
      ): void => {
        const patchVal = op.patch[key]
        if (patchVal === undefined) {
          // Preserve prev value if present.
          if (prev[key] !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(updated as any)[key] = prev[key]
          }
          return
        }
        if (patchVal === null) {
          // Cleared — skip.
          return
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(updated as any)[key] = patchVal
      }
      carryOrPatch('key')
      carryOrPatch('meter')
      carryOrPatch('tempo_bpm')
      carryOrPatch('tempo_text')
      carryOrPatch('clefs')
      carryOrPatch('metricModulation')
      // Refine guard — at least one field must remain. Downstream
      // validateScore would catch this too, but failing here gives
      // the user a more direct error message.
      const hasAnyField =
        updated.key !== undefined ||
        updated.meter !== undefined ||
        updated.tempo_bpm !== undefined ||
        updated.tempo_text !== undefined ||
        (updated.clefs !== undefined && updated.clefs.length > 0) ||
        updated.metricModulation !== undefined
      if (!hasAnyField) {
        throw new EditError(
          `updateMarker would leave the marker with no active fields; pass an additional non-null field or use removeMarker instead`,
        )
      }
      const nextList = [...list]
      nextList[idx] = updated
      next = { ...score, markers: nextList }
      break
    }
    case 'insertVolta': {
      // NOTE: M17-PR-1 lands the data layer only — the renderer
      // (scoreToAbcWithMap) does not yet consume score.voltas; the
      // glyph emission lands in M17-PR-2. Score JSON round-trips
      // correctly through save / load; visual rendering pending.
      const v = op.volta
      const measureCount = score.measures.length
      if (v.startMeasureIdx < 0 || v.startMeasureIdx >= measureCount) {
        throw new EditError(
          `insertVolta startMeasureIdx ${v.startMeasureIdx} out of range; score has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      if (v.endMeasureIdx < 0 || v.endMeasureIdx >= measureCount) {
        throw new EditError(
          `insertVolta endMeasureIdx ${v.endMeasureIdx} out of range; score has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      if (v.startMeasureIdx > v.endMeasureIdx) {
        throw new EditError(
          `insertVolta: startMeasureIdx (${v.startMeasureIdx}) is after endMeasureIdx (${v.endMeasureIdx})`,
        )
      }
      assertVoltaEndings(v.endings, 'insertVolta')
      const existing = score.voltas ?? []
      if (v.id !== undefined && existing.some((x) => x.id === v.id)) {
        throw new EditError(
          `insertVolta id "${v.id}" collides with an existing volta; omit the id and let the system mint one`,
        )
      }
      const newVolta: Volta = {
        id: v.id ?? createSpanId(),
        startMeasureIdx: v.startMeasureIdx,
        endMeasureIdx: v.endMeasureIdx,
        endings: [...v.endings],
        ...(v.endHook !== undefined ? { endHook: v.endHook } : {}),
        ...(v.text !== undefined ? { text: v.text } : {}),
      }
      next = { ...score, voltas: [...existing, newVolta] }
      break
    }
    case 'removeVolta': {
      const list = score.voltas ?? []
      const found = list.some((x) => x.id === op.id)
      if (!found) {
        throw new EditError(`removeVolta id "${op.id}" not found on voltas`)
      }
      const remaining = list.filter((x) => x.id !== op.id)
      if (remaining.length === 0) {
        const { voltas: _drop, ...rest } = score
        void _drop
        next = rest
      } else {
        next = { ...score, voltas: remaining }
      }
      break
    }
    case 'updateVolta': {
      const list = score.voltas ?? []
      const idx = list.findIndex((x) => x.id === op.id)
      if (idx < 0) {
        throw new EditError(`updateVolta id "${op.id}" not found on voltas`)
      }
      const prev = list[idx]
      const measureCount = score.measures.length
      const nextStart = op.patch.startMeasureIdx ?? prev.startMeasureIdx
      const nextEnd = op.patch.endMeasureIdx ?? prev.endMeasureIdx
      if (nextStart < 0 || nextStart >= measureCount) {
        throw new EditError(
          `updateVolta startMeasureIdx ${nextStart} out of range`,
        )
      }
      if (nextEnd < 0 || nextEnd >= measureCount) {
        throw new EditError(
          `updateVolta endMeasureIdx ${nextEnd} out of range`,
        )
      }
      if (nextStart > nextEnd) {
        throw new EditError(
          `updateVolta: startMeasureIdx (${nextStart}) is after endMeasureIdx (${nextEnd})`,
        )
      }
      const nextEndings = op.patch.endings ?? prev.endings
      assertVoltaEndings(nextEndings, 'updateVolta')
      const updated: Volta = {
        id: prev.id,
        startMeasureIdx: nextStart,
        endMeasureIdx: nextEnd,
        endings: [...nextEndings],
      }
      // endHook + text use carry-or-patch with null-clears semantic.
      const carryEndHook = op.patch.endHook
      if (carryEndHook === undefined) {
        if (prev.endHook !== undefined) updated.endHook = prev.endHook
      } else if (carryEndHook !== null) {
        updated.endHook = carryEndHook
      }
      const carryText = op.patch.text
      if (carryText === undefined) {
        if (prev.text !== undefined) updated.text = prev.text
      } else if (carryText !== null) {
        updated.text = carryText
      }
      const nextList = [...list]
      nextList[idx] = updated
      next = { ...score, voltas: nextList }
      break
    }
    case 'insertJumpMarker': {
      // NOTE: M18-PR-1 lands the data layer only — the renderer
      // (scoreToAbcWithMap) does not yet consume score.jumpMarkers;
      // the glyph emission lands in M18-PR-2. Score JSON round-trips
      // correctly through save / load; visual rendering pending.
      const j = op.jumpMarker
      const measureCount = score.measures.length
      if (j.measureIdx < 0 || j.measureIdx >= measureCount) {
        throw new EditError(
          `insertJumpMarker measureIdx ${j.measureIdx} out of range; score has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      if (!isJumpMarkerKindEnum(j.kind)) {
        throw new EditError(
          `insertJumpMarker kind "${j.kind}" is not a recognized JumpMarker kind`,
        )
      }
      const existing = score.jumpMarkers ?? []
      if (j.id !== undefined && existing.some((x) => x.id === j.id)) {
        throw new EditError(
          `insertJumpMarker id "${j.id}" collides with an existing jumpMarker; omit the id and let the system mint one`,
        )
      }
      // Ref existence checks against the snapshot Score. Partial
      // pairing (e.g. a D.S. al Coda missing toCodaRef) is permitted
      // at this layer so multi-step edits can stage refs in any
      // order; validateCrossRefs enforces the full pairing at save
      // time. We DO validate that any provided ref actually points
      // at something, so a typo surfaces immediately.
      const segnoIds = new Set((score.segnoMarkers ?? []).map((s) => s.id))
      const codaIds = new Set((score.codaMarkers ?? []).map((c) => c.id))
      const jumpIds = new Set(existing.map((x) => x.id))
      if (j.segnoRef !== undefined && !segnoIds.has(j.segnoRef)) {
        throw new EditError(
          `insertJumpMarker segnoRef "${j.segnoRef}" does not match any SegnoMarker in the score`,
        )
      }
      if (j.codaRef !== undefined && !codaIds.has(j.codaRef)) {
        throw new EditError(
          `insertJumpMarker codaRef "${j.codaRef}" does not match any CodaMarker in the score`,
        )
      }
      if (j.toCodaRef !== undefined && !jumpIds.has(j.toCodaRef)) {
        throw new EditError(
          `insertJumpMarker toCodaRef "${j.toCodaRef}" does not match any JumpMarker in the score`,
        )
      }
      // Note: pre-minted-id self-reference (id='X', toCodaRef='X')
      // is implicitly rejected by the existence check above, since
      // the new id is not yet in `jumpIds` at this point. The update
      // path has an explicit self-ref guard because by then the id
      // IS in the list. See test "rejects insert-time self-reference
      // via existence check" for the pin.
      const newJump: JumpMarker = {
        id: j.id ?? createSpanId(),
        measureIdx: j.measureIdx,
        side: j.side,
        kind: j.kind,
        ...(j.segnoRef !== undefined ? { segnoRef: j.segnoRef } : {}),
        ...(j.codaRef !== undefined ? { codaRef: j.codaRef } : {}),
        ...(j.toCodaRef !== undefined ? { toCodaRef: j.toCodaRef } : {}),
      }
      next = { ...score, jumpMarkers: [...existing, newJump] }
      break
    }
    case 'removeJumpMarker': {
      const list = score.jumpMarkers ?? []
      const found = list.some((x) => x.id === op.id)
      if (!found) {
        throw new EditError(
          `removeJumpMarker id "${op.id}" not found on jumpMarkers`,
        )
      }
      // Sever any inbound toCodaRef pointers on OTHER jumpMarkers
      // so the surviving array doesn't carry a dangling reference
      // (validateCrossRefs would otherwise reject the score after
      // a "To Coda" is deleted). Mirrors the same defensive sweep
      // in structuralOps.ts H3.
      const remaining = list
        .filter((x) => x.id !== op.id)
        .map((x) => {
          if (x.toCodaRef !== op.id) return x
          const { toCodaRef: _drop, ...rest } = x
          void _drop
          return rest as JumpMarker
        })
      if (remaining.length === 0) {
        const { jumpMarkers: _drop, ...rest } = score
        void _drop
        next = rest
      } else {
        next = { ...score, jumpMarkers: remaining }
      }
      break
    }
    case 'updateJumpMarker': {
      const list = score.jumpMarkers ?? []
      const idx = list.findIndex((x) => x.id === op.id)
      if (idx < 0) {
        throw new EditError(
          `updateJumpMarker id "${op.id}" not found on jumpMarkers`,
        )
      }
      const prev = list[idx]
      const measureCount = score.measures.length
      const nextMeasureIdx = op.patch.measureIdx ?? prev.measureIdx
      if (nextMeasureIdx < 0 || nextMeasureIdx >= measureCount) {
        throw new EditError(
          `updateJumpMarker measureIdx ${nextMeasureIdx} out of range; score has ${measureCount} measure${measureCount === 1 ? '' : 's'}`,
        )
      }
      const nextKind = op.patch.kind ?? prev.kind
      if (!isJumpMarkerKindEnum(nextKind)) {
        throw new EditError(
          `updateJumpMarker kind "${nextKind}" is not a recognized JumpMarker kind`,
        )
      }
      const nextSide = op.patch.side ?? prev.side
      // Ref validation — same surface as insertJumpMarker. Resolve
      // patched ref OR carried prev ref; null clears.
      const segnoIds = new Set((score.segnoMarkers ?? []).map((s) => s.id))
      const codaIds = new Set((score.codaMarkers ?? []).map((c) => c.id))
      const jumpIds = new Set(list.map((x) => x.id))
      const updated: JumpMarker = {
        id: prev.id,
        measureIdx: nextMeasureIdx,
        side: nextSide,
        kind: nextKind,
      }
      const carrySegnoRef = op.patch.segnoRef
      if (carrySegnoRef === undefined) {
        if (prev.segnoRef !== undefined) updated.segnoRef = prev.segnoRef
      } else if (carrySegnoRef !== null) {
        if (!segnoIds.has(carrySegnoRef)) {
          throw new EditError(
            `updateJumpMarker segnoRef "${carrySegnoRef}" does not match any SegnoMarker in the score`,
          )
        }
        updated.segnoRef = carrySegnoRef
      }
      const carryCodaRef = op.patch.codaRef
      if (carryCodaRef === undefined) {
        if (prev.codaRef !== undefined) updated.codaRef = prev.codaRef
      } else if (carryCodaRef !== null) {
        if (!codaIds.has(carryCodaRef)) {
          throw new EditError(
            `updateJumpMarker codaRef "${carryCodaRef}" does not match any CodaMarker in the score`,
          )
        }
        updated.codaRef = carryCodaRef
      }
      const carryToCodaRef = op.patch.toCodaRef
      if (carryToCodaRef === undefined) {
        if (prev.toCodaRef !== undefined) updated.toCodaRef = prev.toCodaRef
      } else if (carryToCodaRef !== null) {
        if (!jumpIds.has(carryToCodaRef)) {
          throw new EditError(
            `updateJumpMarker toCodaRef "${carryToCodaRef}" does not match any JumpMarker in the score`,
          )
        }
        if (carryToCodaRef === prev.id) {
          throw new EditError(
            `updateJumpMarker toCodaRef cannot point at the jumpMarker being updated (self-reference)`,
          )
        }
        updated.toCodaRef = carryToCodaRef
      }
      const nextList = [...list]
      nextList[idx] = updated
      next = { ...score, jumpMarkers: nextList }
      break
    }
    case 'insertHairpin': {
      const h = op.hairpin
      const startLoc = findEventLocationById(score, h.startEventId)
      if (!startLoc) {
        throw new EditError(
          `insertHairpin startEventId "${h.startEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, h.endEventId)
      if (!endLoc) {
        throw new EditError(
          `insertHairpin endEventId "${h.endEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `insertHairpin: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx}). Cross-voice / cross-staff hairpins are not supported.`,
        )
      }
      // Default staff/voice to the resolved location; reject mismatch
      // if the LLM explicitly passed a different one (catches
      // off-by-one targeting errors before they reach validateCrossRefs).
      // The schema's `.max(1)` / `.max(3)` bounds enforce the literal
      // shape — no cast needed here.
      const resolvedStaffIdx = h.staffIdx ?? startLoc.staffIdx
      const resolvedVoiceIdx = h.voiceIdx ?? startLoc.voiceIdx
      if (resolvedStaffIdx !== startLoc.staffIdx || resolvedVoiceIdx !== startLoc.voiceIdx) {
        throw new EditError(
          `insertHairpin: staffIdx/voiceIdx (${resolvedStaffIdx}/${resolvedVoiceIdx}) does not match the start event's location (${startLoc.staffIdx}/${startLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `insertHairpin: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1}); hairpins must extend FORWARD`,
        )
      }
      const existing = score.spans ?? []
      if (h.id !== undefined && existing.some((x) => x.id === h.id)) {
        throw new EditError(
          `insertHairpin id "${h.id}" collides with an existing span; omit the id and let the system mint one`,
        )
      }
      const newSpan: Span = {
        id: h.id ?? createSpanId(),
        kind: h.kind,
        startEventId: h.startEventId,
        endEventId: h.endEventId,
        staffIdx: resolvedStaffIdx,
        voiceIdx: resolvedVoiceIdx,
        ...(h.startDynamic !== undefined ? { startDynamic: h.startDynamic } : {}),
        ...(h.endDynamic !== undefined ? { endDynamic: h.endDynamic } : {}),
        ...(h.placement !== undefined ? { placement: h.placement } : {}),
      }
      next = { ...score, spans: [...existing, newSpan] }
      break
    }
    case 'removeHairpin': {
      const list = score.spans ?? []
      const target = list.find((x) => x.id === op.id)
      if (!target) {
        throw new EditError(`removeHairpin id "${op.id}" not found on spans`)
      }
      if (!isHairpin(target)) {
        throw new EditError(
          `removeHairpin id "${op.id}" is a ${target.kind} span, not a hairpin`,
        )
      }
      const remaining = list.filter((x) => x.id !== op.id)
      if (remaining.length === 0) {
        const { spans: _drop, ...rest } = score
        void _drop
        next = rest
      } else {
        next = { ...score, spans: remaining }
      }
      break
    }
    case 'updateHairpin': {
      const list = score.spans ?? []
      const idx = list.findIndex((x) => x.id === op.id)
      if (idx < 0) {
        throw new EditError(`updateHairpin id "${op.id}" not found on spans`)
      }
      const prev = list[idx]
      if (!isHairpin(prev)) {
        throw new EditError(
          `updateHairpin id "${op.id}" is a ${prev.kind} span, not a hairpin`,
        )
      }
      // Resolve target endpoints (patched or carried) and revalidate.
      const nextKind = op.patch.kind ?? prev.kind
      const nextStartEventId = op.patch.startEventId ?? prev.startEventId
      const nextEndEventId = op.patch.endEventId ?? prev.endEventId
      const startLoc = findEventLocationById(score, nextStartEventId)
      if (!startLoc) {
        throw new EditError(
          `updateHairpin startEventId "${nextStartEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, nextEndEventId)
      if (!endLoc) {
        throw new EditError(
          `updateHairpin endEventId "${nextEndEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `updateHairpin: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `updateHairpin: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1})`,
        )
      }
      // Carry-or-patch for optional fields: undefined preserves, null
      // clears, value sets. staffIdx/voiceIdx follow the (re-anchored)
      // start event so the span metadata stays consistent with the
      // endpoint location — they cannot be patched independently;
      // changing the voice is conceptually a delete+insert.
      const updated: Span = {
        id: prev.id,
        kind: nextKind,
        startEventId: nextStartEventId,
        endEventId: nextEndEventId,
        staffIdx: startLoc.staffIdx,
        voiceIdx: startLoc.voiceIdx,
      }
      const carryOrPatch = <K extends 'startDynamic' | 'endDynamic' | 'placement'>(
        key: K,
      ): void => {
        const patchVal = op.patch[key]
        if (patchVal === undefined) {
          if (prev[key] !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(updated as any)[key] = prev[key]
          }
          return
        }
        if (patchVal === null) return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(updated as any)[key] = patchVal
      }
      carryOrPatch('startDynamic')
      carryOrPatch('endDynamic')
      carryOrPatch('placement')
      const nextList = [...list]
      nextList[idx] = updated
      next = { ...score, spans: nextList }
      break
    }
    case 'insertSlur': {
      const sl = op.slur
      const startLoc = findEventLocationById(score, sl.startEventId)
      if (!startLoc) {
        throw new EditError(
          `insertSlur startEventId "${sl.startEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, sl.endEventId)
      if (!endLoc) {
        throw new EditError(
          `insertSlur endEventId "${sl.endEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `insertSlur: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx}). Cross-voice / cross-staff slurs are not supported in Phase 1.`,
        )
      }
      const resolvedStaffIdx = sl.staffIdx ?? startLoc.staffIdx
      const resolvedVoiceIdx = sl.voiceIdx ?? startLoc.voiceIdx
      if (resolvedStaffIdx !== startLoc.staffIdx || resolvedVoiceIdx !== startLoc.voiceIdx) {
        throw new EditError(
          `insertSlur: staffIdx/voiceIdx (${resolvedStaffIdx}/${resolvedVoiceIdx}) does not match the start event's location (${startLoc.staffIdx}/${startLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `insertSlur: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1}); slurs must extend FORWARD`,
        )
      }
      const existing = score.spans ?? []
      if (sl.id !== undefined && existing.some((x) => x.id === sl.id)) {
        throw new EditError(
          `insertSlur id "${sl.id}" collides with an existing span; omit the id and let the system mint one`,
        )
      }
      const newSpan: Span = {
        id: sl.id ?? createSpanId(),
        kind: sl.kind,
        startEventId: sl.startEventId,
        endEventId: sl.endEventId,
        staffIdx: resolvedStaffIdx,
        voiceIdx: resolvedVoiceIdx,
        ...(sl.placement !== undefined ? { placement: sl.placement } : {}),
      }
      next = { ...score, spans: [...existing, newSpan] }
      break
    }
    case 'removeSlur': {
      const list = score.spans ?? []
      const target = list.find((x) => x.id === op.id)
      if (!target) {
        throw new EditError(`removeSlur id "${op.id}" not found on spans`)
      }
      if (!isSlur(target)) {
        throw new EditError(
          `removeSlur id "${op.id}" is a ${target.kind} span, not a slur`,
        )
      }
      const remaining = list.filter((x) => x.id !== op.id)
      if (remaining.length === 0) {
        const { spans: _drop, ...rest } = score
        void _drop
        next = rest
      } else {
        next = { ...score, spans: remaining }
      }
      break
    }
    case 'updateSlur': {
      const list = score.spans ?? []
      const idx = list.findIndex((x) => x.id === op.id)
      if (idx < 0) {
        throw new EditError(`updateSlur id "${op.id}" not found on spans`)
      }
      const prev = list[idx]
      if (!isSlur(prev)) {
        throw new EditError(
          `updateSlur id "${op.id}" is a ${prev.kind} span, not a slur`,
        )
      }
      const nextKind = op.patch.kind ?? prev.kind
      const nextStartEventId = op.patch.startEventId ?? prev.startEventId
      const nextEndEventId = op.patch.endEventId ?? prev.endEventId
      const startLoc = findEventLocationById(score, nextStartEventId)
      if (!startLoc) {
        throw new EditError(
          `updateSlur startEventId "${nextStartEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, nextEndEventId)
      if (!endLoc) {
        throw new EditError(
          `updateSlur endEventId "${nextEndEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `updateSlur: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `updateSlur: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1})`,
        )
      }
      const updated: Span = {
        id: prev.id,
        kind: nextKind,
        startEventId: nextStartEventId,
        endEventId: nextEndEventId,
        staffIdx: startLoc.staffIdx,
        voiceIdx: startLoc.voiceIdx,
      }
      // Slurs only carry placement among the optional decorator fields
      // (no terminal dynamics, no gliss style/text). Same carry-or-patch
      // null-clear semantic as the hairpin update.
      const patchPlacement = op.patch.placement
      if (patchPlacement === undefined) {
        if (prev.placement !== undefined) updated.placement = prev.placement
      } else if (patchPlacement !== null) {
        updated.placement = patchPlacement
      }
      const nextList = [...list]
      nextList[idx] = updated
      next = { ...score, spans: nextList }
      break
    }
    case 'insertTempoSpan': {
      const t = op.tempoSpan
      const startLoc = findEventLocationById(score, t.startEventId)
      if (!startLoc) {
        throw new EditError(
          `insertTempoSpan startEventId "${t.startEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, t.endEventId)
      if (!endLoc) {
        throw new EditError(
          `insertTempoSpan endEventId "${t.endEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `insertTempoSpan: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx}). Cross-voice / cross-staff tempo spans are not supported in Phase 1.`,
        )
      }
      const resolvedStaffIdx = t.staffIdx ?? startLoc.staffIdx
      const resolvedVoiceIdx = t.voiceIdx ?? startLoc.voiceIdx
      if (resolvedStaffIdx !== startLoc.staffIdx || resolvedVoiceIdx !== startLoc.voiceIdx) {
        throw new EditError(
          `insertTempoSpan: staffIdx/voiceIdx (${resolvedStaffIdx}/${resolvedVoiceIdx}) does not match the start event's location (${startLoc.staffIdx}/${startLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `insertTempoSpan: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1}); tempo spans must extend FORWARD`,
        )
      }
      const existing = score.spans ?? []
      if (t.id !== undefined && existing.some((x) => x.id === t.id)) {
        throw new EditError(
          `insertTempoSpan id "${t.id}" collides with an existing span; omit the id and let the system mint one`,
        )
      }
      const newSpan: Span = {
        id: t.id ?? createSpanId(),
        kind: t.kind,
        startEventId: t.startEventId,
        endEventId: t.endEventId,
        staffIdx: resolvedStaffIdx,
        voiceIdx: resolvedVoiceIdx,
        ...(t.placement !== undefined ? { placement: t.placement } : {}),
        ...(t.endTempoBpm !== undefined ? { endTempoBpm: t.endTempoBpm } : {}),
        ...(t.endTempoText !== undefined ? { endTempoText: t.endTempoText } : {}),
      }
      next = { ...score, spans: [...existing, newSpan] }
      break
    }
    case 'removeTempoSpan': {
      const list = score.spans ?? []
      const target = list.find((x) => x.id === op.id)
      if (!target) {
        throw new EditError(`removeTempoSpan id "${op.id}" not found on spans`)
      }
      if (!isTempoSpan(target)) {
        throw new EditError(
          `removeTempoSpan id "${op.id}" is a ${target.kind} span, not a tempo span`,
        )
      }
      const remaining = list.filter((x) => x.id !== op.id)
      if (remaining.length === 0) {
        const { spans: _drop, ...rest } = score
        void _drop
        next = rest
      } else {
        next = { ...score, spans: remaining }
      }
      break
    }
    case 'updateTempoSpan': {
      const list = score.spans ?? []
      const idx = list.findIndex((x) => x.id === op.id)
      if (idx < 0) {
        throw new EditError(`updateTempoSpan id "${op.id}" not found on spans`)
      }
      const prev = list[idx]
      if (!isTempoSpan(prev)) {
        throw new EditError(
          `updateTempoSpan id "${op.id}" is a ${prev.kind} span, not a tempo span`,
        )
      }
      const nextKind = op.patch.kind ?? prev.kind
      const nextStartEventId = op.patch.startEventId ?? prev.startEventId
      const nextEndEventId = op.patch.endEventId ?? prev.endEventId
      const startLoc = findEventLocationById(score, nextStartEventId)
      if (!startLoc) {
        throw new EditError(
          `updateTempoSpan startEventId "${nextStartEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, nextEndEventId)
      if (!endLoc) {
        throw new EditError(
          `updateTempoSpan endEventId "${nextEndEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `updateTempoSpan: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `updateTempoSpan: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1})`,
        )
      }
      const updated: Span = {
        id: prev.id,
        kind: nextKind,
        startEventId: nextStartEventId,
        endEventId: nextEndEventId,
        staffIdx: startLoc.staffIdx,
        voiceIdx: startLoc.voiceIdx,
      }
      // Carry-or-patch for the three optional fields. null clears,
      // undefined preserves. Matches the slur/hairpin precedent so
      // the LLM and UI see consistent patch semantics across span
      // families.
      const carryOrPatchPlacement = op.patch.placement
      if (carryOrPatchPlacement === undefined) {
        if (prev.placement !== undefined) updated.placement = prev.placement
      } else if (carryOrPatchPlacement !== null) {
        updated.placement = carryOrPatchPlacement
      }
      const carryOrPatchEndBpm = op.patch.endTempoBpm
      if (carryOrPatchEndBpm === undefined) {
        if (prev.endTempoBpm !== undefined) updated.endTempoBpm = prev.endTempoBpm
      } else if (carryOrPatchEndBpm !== null) {
        updated.endTempoBpm = carryOrPatchEndBpm
      }
      const carryOrPatchEndText = op.patch.endTempoText
      if (carryOrPatchEndText === undefined) {
        if (prev.endTempoText !== undefined) updated.endTempoText = prev.endTempoText
      } else if (carryOrPatchEndText !== null) {
        updated.endTempoText = carryOrPatchEndText
      }
      const nextList = [...list]
      nextList[idx] = updated
      next = { ...score, spans: nextList }
      break
    }
    case 'insertOctaveSpan': {
      const o = op.octaveSpan
      const startLoc = findEventLocationById(score, o.startEventId)
      if (!startLoc) {
        throw new EditError(
          `insertOctaveSpan startEventId "${o.startEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, o.endEventId)
      if (!endLoc) {
        throw new EditError(
          `insertOctaveSpan endEventId "${o.endEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `insertOctaveSpan: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx}). Cross-voice / cross-staff octave spans are not supported in Phase 1.`,
        )
      }
      const resolvedStaffIdx = o.staffIdx ?? startLoc.staffIdx
      const resolvedVoiceIdx = o.voiceIdx ?? startLoc.voiceIdx
      if (resolvedStaffIdx !== startLoc.staffIdx || resolvedVoiceIdx !== startLoc.voiceIdx) {
        throw new EditError(
          `insertOctaveSpan: staffIdx/voiceIdx (${resolvedStaffIdx}/${resolvedVoiceIdx}) does not match the start event's location (${startLoc.staffIdx}/${startLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `insertOctaveSpan: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1}); octave spans must extend FORWARD`,
        )
      }
      const existing = score.spans ?? []
      if (o.id !== undefined && existing.some((x) => x.id === o.id)) {
        throw new EditError(
          `insertOctaveSpan id "${o.id}" collides with an existing span; omit the id and let the system mint one`,
        )
      }
      const newSpan: Span = {
        id: o.id ?? createSpanId(),
        kind: o.kind,
        startEventId: o.startEventId,
        endEventId: o.endEventId,
        staffIdx: resolvedStaffIdx,
        voiceIdx: resolvedVoiceIdx,
        ...(o.placement !== undefined ? { placement: o.placement } : {}),
      }
      next = { ...score, spans: [...existing, newSpan] }
      break
    }
    case 'removeOctaveSpan': {
      const list = score.spans ?? []
      const target = list.find((x) => x.id === op.id)
      if (!target) {
        throw new EditError(`removeOctaveSpan id "${op.id}" not found on spans`)
      }
      if (!isOctaveSpan(target)) {
        throw new EditError(
          `removeOctaveSpan id "${op.id}" is a ${target.kind} span, not an octave span`,
        )
      }
      const remaining = list.filter((x) => x.id !== op.id)
      if (remaining.length === 0) {
        const { spans: _drop, ...rest } = score
        void _drop
        next = rest
      } else {
        next = { ...score, spans: remaining }
      }
      break
    }
    case 'updateOctaveSpan': {
      const list = score.spans ?? []
      const idx = list.findIndex((x) => x.id === op.id)
      if (idx < 0) {
        throw new EditError(`updateOctaveSpan id "${op.id}" not found on spans`)
      }
      const prev = list[idx]
      if (!isOctaveSpan(prev)) {
        throw new EditError(
          `updateOctaveSpan id "${op.id}" is a ${prev.kind} span, not an octave span`,
        )
      }
      const nextKind = op.patch.kind ?? prev.kind
      const nextStartEventId = op.patch.startEventId ?? prev.startEventId
      const nextEndEventId = op.patch.endEventId ?? prev.endEventId
      const startLoc = findEventLocationById(score, nextStartEventId)
      if (!startLoc) {
        throw new EditError(
          `updateOctaveSpan startEventId "${nextStartEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, nextEndEventId)
      if (!endLoc) {
        throw new EditError(
          `updateOctaveSpan endEventId "${nextEndEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `updateOctaveSpan: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `updateOctaveSpan: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1})`,
        )
      }
      const updated: Span = {
        id: prev.id,
        kind: nextKind,
        startEventId: nextStartEventId,
        endEventId: nextEndEventId,
        staffIdx: startLoc.staffIdx,
        voiceIdx: startLoc.voiceIdx,
      }
      const placementPatch = op.patch.placement
      if (placementPatch === undefined) {
        if (prev.placement !== undefined) updated.placement = prev.placement
      } else if (placementPatch !== null) {
        updated.placement = placementPatch
      }
      const nextList = [...list]
      nextList[idx] = updated
      next = { ...score, spans: nextList }
      break
    }
    case 'insertGlissando': {
      const g = op.glissando
      const startLoc = findEventLocationById(score, g.startEventId)
      if (!startLoc) {
        throw new EditError(
          `insertGlissando startEventId "${g.startEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, g.endEventId)
      if (!endLoc) {
        throw new EditError(
          `insertGlissando endEventId "${g.endEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `insertGlissando: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx}). Cross-voice / cross-staff glissandos are not supported in Phase 1.`,
        )
      }
      const resolvedStaffIdx = g.staffIdx ?? startLoc.staffIdx
      const resolvedVoiceIdx = g.voiceIdx ?? startLoc.voiceIdx
      if (resolvedStaffIdx !== startLoc.staffIdx || resolvedVoiceIdx !== startLoc.voiceIdx) {
        throw new EditError(
          `insertGlissando: staffIdx/voiceIdx (${resolvedStaffIdx}/${resolvedVoiceIdx}) does not match the start event's location (${startLoc.staffIdx}/${startLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `insertGlissando: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1}); glissandos must extend FORWARD`,
        )
      }
      const existing = score.spans ?? []
      if (g.id !== undefined && existing.some((x) => x.id === g.id)) {
        throw new EditError(
          `insertGlissando id "${g.id}" collides with an existing span; omit the id and let the system mint one`,
        )
      }
      const newSpan: Span = {
        id: g.id ?? createSpanId(),
        kind: 'glissando',
        startEventId: g.startEventId,
        endEventId: g.endEventId,
        staffIdx: resolvedStaffIdx,
        voiceIdx: resolvedVoiceIdx,
        ...(g.placement !== undefined ? { placement: g.placement } : {}),
        ...(g.glissStyle !== undefined ? { glissStyle: g.glissStyle } : {}),
        ...(g.glissText !== undefined ? { glissText: g.glissText } : {}),
      }
      next = { ...score, spans: [...existing, newSpan] }
      break
    }
    case 'removeGlissando': {
      const list = score.spans ?? []
      const target = list.find((x) => x.id === op.id)
      if (!target) {
        throw new EditError(`removeGlissando id "${op.id}" not found on spans`)
      }
      if (!isGlissando(target)) {
        throw new EditError(
          `removeGlissando id "${op.id}" is a ${target.kind} span, not a glissando`,
        )
      }
      const remaining = list.filter((x) => x.id !== op.id)
      if (remaining.length === 0) {
        const { spans: _drop, ...rest } = score
        void _drop
        next = rest
      } else {
        next = { ...score, spans: remaining }
      }
      break
    }
    case 'updateGlissando': {
      const list = score.spans ?? []
      const idx = list.findIndex((x) => x.id === op.id)
      if (idx < 0) {
        throw new EditError(`updateGlissando id "${op.id}" not found on spans`)
      }
      const prev = list[idx]
      if (!isGlissando(prev)) {
        throw new EditError(
          `updateGlissando id "${op.id}" is a ${prev.kind} span, not a glissando`,
        )
      }
      const nextStartEventId = op.patch.startEventId ?? prev.startEventId
      const nextEndEventId = op.patch.endEventId ?? prev.endEventId
      const startLoc = findEventLocationById(score, nextStartEventId)
      if (!startLoc) {
        throw new EditError(
          `updateGlissando startEventId "${nextStartEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, nextEndEventId)
      if (!endLoc) {
        throw new EditError(
          `updateGlissando endEventId "${nextEndEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `updateGlissando: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `updateGlissando: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1})`,
        )
      }
      const updated: Span = {
        id: prev.id,
        kind: 'glissando',
        startEventId: nextStartEventId,
        endEventId: nextEndEventId,
        staffIdx: startLoc.staffIdx,
        voiceIdx: startLoc.voiceIdx,
      }
      const placementPatch = op.patch.placement
      if (placementPatch === undefined) {
        if (prev.placement !== undefined) updated.placement = prev.placement
      } else if (placementPatch !== null) {
        updated.placement = placementPatch
      }
      const stylePatch = op.patch.glissStyle
      if (stylePatch === undefined) {
        if (prev.glissStyle !== undefined) updated.glissStyle = prev.glissStyle
      } else if (stylePatch !== null) {
        updated.glissStyle = stylePatch
      }
      const textPatch = op.patch.glissText
      if (textPatch === undefined) {
        if (prev.glissText !== undefined) updated.glissText = prev.glissText
      } else if (textPatch !== null) {
        updated.glissText = textPatch
      }
      const nextList = [...list]
      nextList[idx] = updated
      next = { ...score, spans: nextList }
      break
    }
    case 'insertTrillLine': {
      const t = op.trillLine
      const startLoc = findEventLocationById(score, t.startEventId)
      if (!startLoc) {
        throw new EditError(
          `insertTrillLine startEventId "${t.startEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, t.endEventId)
      if (!endLoc) {
        throw new EditError(
          `insertTrillLine endEventId "${t.endEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `insertTrillLine: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx}). Cross-voice / cross-staff trill lines are not supported in Phase 1.`,
        )
      }
      const resolvedStaffIdx = t.staffIdx ?? startLoc.staffIdx
      const resolvedVoiceIdx = t.voiceIdx ?? startLoc.voiceIdx
      if (resolvedStaffIdx !== startLoc.staffIdx || resolvedVoiceIdx !== startLoc.voiceIdx) {
        throw new EditError(
          `insertTrillLine: staffIdx/voiceIdx (${resolvedStaffIdx}/${resolvedVoiceIdx}) does not match the start event's location (${startLoc.staffIdx}/${startLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `insertTrillLine: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1}); trill lines must extend FORWARD`,
        )
      }
      const existing = score.spans ?? []
      if (t.id !== undefined && existing.some((x) => x.id === t.id)) {
        throw new EditError(
          `insertTrillLine id "${t.id}" collides with an existing span; omit the id and let the system mint one`,
        )
      }
      const newSpan: Span = {
        id: t.id ?? createSpanId(),
        kind: 'trill-line',
        startEventId: t.startEventId,
        endEventId: t.endEventId,
        staffIdx: resolvedStaffIdx,
        voiceIdx: resolvedVoiceIdx,
        ...(t.placement !== undefined ? { placement: t.placement } : {}),
      }
      next = { ...score, spans: [...existing, newSpan] }
      break
    }
    case 'removeTrillLine': {
      const list = score.spans ?? []
      const target = list.find((x) => x.id === op.id)
      if (!target) {
        throw new EditError(`removeTrillLine id "${op.id}" not found on spans`)
      }
      if (!isTrillLine(target)) {
        throw new EditError(
          `removeTrillLine id "${op.id}" is a ${target.kind} span, not a trill line`,
        )
      }
      const remaining = list.filter((x) => x.id !== op.id)
      if (remaining.length === 0) {
        const { spans: _drop, ...rest } = score
        void _drop
        next = rest
      } else {
        next = { ...score, spans: remaining }
      }
      break
    }
    case 'updateTrillLine': {
      const list = score.spans ?? []
      const idx = list.findIndex((x) => x.id === op.id)
      if (idx < 0) {
        throw new EditError(`updateTrillLine id "${op.id}" not found on spans`)
      }
      const prev = list[idx]
      if (!isTrillLine(prev)) {
        throw new EditError(
          `updateTrillLine id "${op.id}" is a ${prev.kind} span, not a trill line`,
        )
      }
      const nextStartEventId = op.patch.startEventId ?? prev.startEventId
      const nextEndEventId = op.patch.endEventId ?? prev.endEventId
      const startLoc = findEventLocationById(score, nextStartEventId)
      if (!startLoc) {
        throw new EditError(
          `updateTrillLine startEventId "${nextStartEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, nextEndEventId)
      if (!endLoc) {
        throw new EditError(
          `updateTrillLine endEventId "${nextEndEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `updateTrillLine: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `updateTrillLine: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1})`,
        )
      }
      const updated: Span = {
        id: prev.id,
        kind: 'trill-line',
        startEventId: nextStartEventId,
        endEventId: nextEndEventId,
        staffIdx: startLoc.staffIdx,
        voiceIdx: startLoc.voiceIdx,
      }
      const placementPatch = op.patch.placement
      if (placementPatch === undefined) {
        if (prev.placement !== undefined) updated.placement = prev.placement
      } else if (placementPatch !== null) {
        updated.placement = placementPatch
      }
      const nextList = [...list]
      nextList[idx] = updated
      next = { ...score, spans: nextList }
      break
    }
    case 'insertTremoloBetween': {
      const t = op.tremoloBetween
      const startLoc = findEventLocationById(score, t.startEventId)
      if (!startLoc) {
        throw new EditError(
          `insertTremoloBetween startEventId "${t.startEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, t.endEventId)
      if (!endLoc) {
        throw new EditError(
          `insertTremoloBetween endEventId "${t.endEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `insertTremoloBetween: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx}). Cross-voice / cross-staff between-note tremolos are not supported in Phase 1.`,
        )
      }
      const resolvedStaffIdx = t.staffIdx ?? startLoc.staffIdx
      const resolvedVoiceIdx = t.voiceIdx ?? startLoc.voiceIdx
      if (resolvedStaffIdx !== startLoc.staffIdx || resolvedVoiceIdx !== startLoc.voiceIdx) {
        throw new EditError(
          `insertTremoloBetween: staffIdx/voiceIdx (${resolvedStaffIdx}/${resolvedVoiceIdx}) does not match the start event's location (${startLoc.staffIdx}/${startLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `insertTremoloBetween: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1}); tremolo-between spans must extend FORWARD`,
        )
      }
      const existing = score.spans ?? []
      if (t.id !== undefined && existing.some((x) => x.id === t.id)) {
        throw new EditError(
          `insertTremoloBetween id "${t.id}" collides with an existing span; omit the id and let the system mint one`,
        )
      }
      const newSpan: Span = {
        id: t.id ?? createSpanId(),
        kind: 'tremolo-between',
        startEventId: t.startEventId,
        endEventId: t.endEventId,
        staffIdx: resolvedStaffIdx,
        voiceIdx: resolvedVoiceIdx,
        ...(t.placement !== undefined ? { placement: t.placement } : {}),
      }
      next = { ...score, spans: [...existing, newSpan] }
      break
    }
    case 'removeTremoloBetween': {
      const list = score.spans ?? []
      const target = list.find((x) => x.id === op.id)
      if (!target) {
        throw new EditError(`removeTremoloBetween id "${op.id}" not found on spans`)
      }
      if (!isTremoloBetween(target)) {
        throw new EditError(
          `removeTremoloBetween id "${op.id}" is a ${target.kind} span, not a tremolo-between`,
        )
      }
      const remaining = list.filter((x) => x.id !== op.id)
      if (remaining.length === 0) {
        const { spans: _drop, ...rest } = score
        void _drop
        next = rest
      } else {
        next = { ...score, spans: remaining }
      }
      break
    }
    case 'updateTremoloBetween': {
      const list = score.spans ?? []
      const idx = list.findIndex((x) => x.id === op.id)
      if (idx < 0) {
        throw new EditError(`updateTremoloBetween id "${op.id}" not found on spans`)
      }
      const prev = list[idx]
      if (!isTremoloBetween(prev)) {
        throw new EditError(
          `updateTremoloBetween id "${op.id}" is a ${prev.kind} span, not a tremolo-between`,
        )
      }
      const nextStartEventId = op.patch.startEventId ?? prev.startEventId
      const nextEndEventId = op.patch.endEventId ?? prev.endEventId
      const startLoc = findEventLocationById(score, nextStartEventId)
      if (!startLoc) {
        throw new EditError(
          `updateTremoloBetween startEventId "${nextStartEventId}" does not match any event in the score`,
        )
      }
      const endLoc = findEventLocationById(score, nextEndEventId)
      if (!endLoc) {
        throw new EditError(
          `updateTremoloBetween endEventId "${nextEndEventId}" does not match any event in the score`,
        )
      }
      if (startLoc.staffIdx !== endLoc.staffIdx || startLoc.voiceIdx !== endLoc.voiceIdx) {
        throw new EditError(
          `updateTremoloBetween: endpoints are on different staves/voices (start s${startLoc.staffIdx}v${startLoc.voiceIdx}, end s${endLoc.staffIdx}v${endLoc.voiceIdx})`,
        )
      }
      if (
        startLoc.measureIdx > endLoc.measureIdx ||
        (startLoc.measureIdx === endLoc.measureIdx && startLoc.eventIdx > endLoc.eventIdx)
      ) {
        throw new EditError(
          `updateTremoloBetween: start (m${startLoc.measureIdx + 1}.${startLoc.eventIdx + 1}) is AFTER end (m${endLoc.measureIdx + 1}.${endLoc.eventIdx + 1})`,
        )
      }
      const updated: Span = {
        id: prev.id,
        kind: 'tremolo-between',
        startEventId: nextStartEventId,
        endEventId: nextEndEventId,
        staffIdx: startLoc.staffIdx,
        voiceIdx: startLoc.voiceIdx,
      }
      const placementPatch = op.patch.placement
      if (placementPatch === undefined) {
        if (prev.placement !== undefined) updated.placement = prev.placement
      } else if (placementPatch !== null) {
        updated.placement = placementPatch
      }
      const nextList = [...list]
      nextList[idx] = updated
      next = { ...score, spans: nextList }
      break
    }
  }
  // Silence the unused-import warning when the new accessor is only
  // referenced inside conditional branches (TS reads via type position).
  void getStaffCount
  return next
}

/**
 * Apply a mapper to every voice on every staff. Like
 * `withAllStaffMeasures` but the mapper operates on each voice
 * INDEPENDENTLY rather than once per staff — needed when the mutation
 * depends on per-voice state (e.g. "clear isFinalPartial on whatever
 * was the last measure of THIS voice").
 */
function withAllVoiceMeasures(
  score: Score,
  fn: (measures: Measure[]) => Measure[],
): Score {
  let next: Score = { ...score, measures: fn([...score.measures]) }
  if (score.extraVoices) {
    next = { ...next, extraVoices: score.extraVoices.map((v) => ({ measures: fn([...v.measures]) })) }
  }
  if (score.secondStaff) {
    const ss = score.secondStaff
    let nextSecond: Staff = { ...ss, measures: fn([...ss.measures]) }
    if (ss.extraVoices) {
      nextSecond = {
        ...nextSecond,
        extraVoices: ss.extraVoices.map((v) => ({ measures: fn([...v.measures]) })),
      }
    }
    next = { ...next, secondStaff: nextSecond }
  }
  return next
}

/**
 * Shared helper for appendMeasures and insertMeasuresAfter. Inserts
 * after `insertIdx`; pass `score.measures.length - 1` for append.
 *
 * Per-voice fanout: when `perVoiceContent` is provided we use the
 * supplied measures for each (staffIdx, voiceIdx). When absent or
 * missing for a given voice, that voice gets rests at meter capacity
 * for each new bar — so voices stay bar-aligned with the primary.
 */
function applyStructuralAppendOrInsert(
  score: Score,
  primaryMeasures: Measure[],
  perVoiceContent: Array<{ voices: Measure[][] }> | undefined,
  insertIdx: number,
): Score {
  const restMeasure = (): Measure => fillMeasureWithRests(score.meter)
  const count = primaryMeasures.length

  const inject = (
    base: Measure[],
    content: Measure[] | undefined,
  ): Measure[] => {
    const supplied = content && content.length === count ? content : null
    const insertion = supplied ?? Array.from({ length: count }, restMeasure)
    return [
      ...base.slice(0, insertIdx + 1),
      ...insertion,
      ...base.slice(insertIdx + 1),
    ]
  }

  // Primary staff voice 0 — uses the LLM-emitted measures directly.
  let nextScore: Score = {
    ...score,
    measures: [
      ...score.measures.slice(0, insertIdx + 1),
      ...primaryMeasures,
      ...score.measures.slice(insertIdx + 1),
    ],
  }

  // Primary staff extra voices (voice 1..N).
  if (score.extraVoices && score.extraVoices.length > 0) {
    const primaryExtras = perVoiceContent?.[0]?.voices
    const nextExtras = score.extraVoices.map((v, ei) => {
      const content = primaryExtras?.[ei + 1]
      return { ...v, measures: inject([...v.measures], content) }
    })
    nextScore = { ...nextScore, extraVoices: nextExtras }
  }

  // Second staff (voice 0 primary, then extras).
  if (score.secondStaff) {
    const ss = score.secondStaff
    const secondaryVoices = perVoiceContent?.[1]?.voices
    const secondaryPrimaryContent = secondaryVoices?.[0]
    const nextSecondary: Staff = {
      ...ss,
      measures: inject([...ss.measures], secondaryPrimaryContent),
    }
    if (ss.extraVoices && ss.extraVoices.length > 0) {
      nextSecondary.extraVoices = ss.extraVoices.map((v, ei) => {
        const content = secondaryVoices?.[ei + 1]
        return { ...v, measures: inject([...v.measures], content) }
      })
    }
    nextScore = { ...nextScore, secondStaff: nextSecondary }
  }

  return nextScore
}

/**
 * Shared helper for regionReplace. Removes measures in
 * [startMeasureIdx..endMeasureIdx] (inclusive) on every (staff, voice)
 * and replaces them with content from `perVoiceContent` (or rests at
 * meter capacity when absent).
 *
 * When the replaced range INCLUDES the score's final bar AND that
 * final bar carried `isFinalPartial: true`, the flag transfers to
 * the LAST measure of the replacement on every (staff, voice). The
 * "this is the END" semantic is preserved across the splice; without
 * this, an LLM rewriting the closing measure of a hymn would silently
 * drop the partial-bar signal. When the replacement ends BEFORE the
 * final bar, the score's actual last bar (untouched) keeps its flag
 * already — no action needed.
 */
function applyRegionReplace(
  score: Score,
  startMeasureIdx: number,
  endMeasureIdx: number,
  primaryMeasures: Measure[],
  perVoiceContent: Array<{ voices: Measure[][] }> | undefined,
): Score {
  const restMeasure = (): Measure => fillMeasureWithRests(score.meter)
  const newCount = primaryMeasures.length
  const replacingFinalBar = endMeasureIdx === score.measures.length - 1
  const originalLast = replacingFinalBar
    ? score.measures[score.measures.length - 1]
    : undefined
  const transferFinalPartial = !!(replacingFinalBar && originalLast?.isFinalPartial && newCount > 0)

  const tagLastWithFinalPartial = (ms: Measure[]): Measure[] => {
    if (!transferFinalPartial || ms.length === 0) return ms
    const out = [...ms]
    const li = out.length - 1
    if (!out[li].isFinalPartial) {
      out[li] = { ...out[li], isFinalPartial: true }
    }
    return out
  }

  const splice = (
    base: Measure[],
    content: Measure[] | undefined,
  ): Measure[] => {
    const supplied = content && content.length === newCount ? content : null
    const insertion = supplied ?? Array.from({ length: newCount }, restMeasure)
    const stamped = tagLastWithFinalPartial(insertion)
    return [
      ...base.slice(0, startMeasureIdx),
      ...stamped,
      ...base.slice(endMeasureIdx + 1),
    ]
  }

  const stampedPrimary = tagLastWithFinalPartial(primaryMeasures)
  let nextScore: Score = {
    ...score,
    measures: [
      ...score.measures.slice(0, startMeasureIdx),
      ...stampedPrimary,
      ...score.measures.slice(endMeasureIdx + 1),
    ],
  }

  if (score.extraVoices && score.extraVoices.length > 0) {
    const primaryExtras = perVoiceContent?.[0]?.voices
    nextScore = {
      ...nextScore,
      extraVoices: score.extraVoices.map((v, ei) => {
        const content = primaryExtras?.[ei + 1]
        return { ...v, measures: splice([...v.measures], content) }
      }),
    }
  }

  if (score.secondStaff) {
    const ss = score.secondStaff
    const secondaryVoices = perVoiceContent?.[1]?.voices
    const nextSecondary: Staff = {
      ...ss,
      measures: splice([...ss.measures], secondaryVoices?.[0]),
    }
    if (ss.extraVoices && ss.extraVoices.length > 0) {
      nextSecondary.extraVoices = ss.extraVoices.map((v, ei) => {
        const content = secondaryVoices?.[ei + 1]
        return { ...v, measures: splice([...v.measures], content) }
      })
    }
    nextScore = { ...nextScore, secondStaff: nextSecondary }
  }

  return nextScore
}

/**
 * Normalize the `isFinalPartial` flag across every (staff, voice)
 * measure list so it sits ONLY on the actual last bar, with the bit
 * controlled by whether the score's pre-mutation last bar had it.
 *
 * Used by the dragMeasureRange paths because both DELETE-of-the-final
 * bar AND MOVE-that-includes-the-final-bar leave the flag in a
 * structurally-wrong position:
 *   - DELETE: regionReplace-with-empty hits applyRegionReplace with
 *     newCount=0; its transferFinalPartial guard (`newCount > 0`)
 *     therefore skips, so the new last bar never inherits the flag.
 *   - MOVE: the original final bar's `isFinalPartial:true` flag rides
 *     along the move into the middle of the score, and the new last
 *     bar (which used to be somewhere in the middle) has no flag.
 *
 * The other structural ops (appendMeasures / insertMeasuresAfter /
 * regionReplace-with-nonempty) already handle this via their existing
 * dedicated logic and don't need to call this helper.
 *
 * `hadFinalPartial` is the snapshot of `score.measures[N-1].isFinalPartial`
 * read BEFORE the mutation. The normalizer applies the snapshot
 * across the post-mutation state: clears the flag on every bar that
 * isn't last, sets it on the last bar iff the snapshot was true.
 */
function normalizeFinalPartial(score: Score, hadFinalPartial: boolean): Score {
  return withAllVoiceMeasures(score, (ms) => {
    if (ms.length === 0) return ms
    return ms.map((m, i) => {
      const isLast = i === ms.length - 1
      const want = isLast && hadFinalPartial
      const have = m.isFinalPartial === true
      if (want === have) return m
      if (want) return { ...m, isFinalPartial: true }
      const { isFinalPartial: _drop, ...rest } = m
      void _drop
      return rest as Measure
    })
  })
}

/**
 * Capture a contiguous range of measures from every (staff, voice)
 * line as a primary-measures + perVoiceContent bundle suitable for
 * re-injection via applyStructuralAppendOrInsert. Used by the
 * dragMeasureRange move + duplicate paths.
 *
 * Returns immutable copies; the input score is not mutated. Event ids
 * inside the captured measures are PRESERVED — the move path requires
 * id stability so spans referencing events in the moved range survive
 * the splice. The duplicate path (M19-PR-3+) wraps the result through
 * an id-freshening pass before re-injecting.
 *
 * The perVoiceContent shape mirrors the appendMeasures input: outer
 * index 0 = primary staff, 1 = secondStaff; voices[0] = primary voice,
 * voices[1..] = extraVoices. Indices for which the source score has
 * no voice are omitted (the caller's injection helper then defaults
 * to rests at meter capacity — but here we always emit captured
 * content for every present voice, so the default never fires).
 */
export function captureRangeContent(
  score: Score,
  fromStart: number,
  fromEnd: number,
): { primaryMeasures: Measure[]; perVoiceContent: Array<{ voices: Measure[][] }> } {
  const slice = (ms: Measure[]) => ms.slice(fromStart, fromEnd + 1)
  const primaryMeasures = slice(score.measures)

  const staves: Array<{ voices: Measure[][] }> = []
  // Staff 0 (primary): voices[0] = primary measures, voices[1..] = extraVoices.
  const primaryVoices: Measure[][] = [primaryMeasures]
  for (const v of score.extraVoices ?? []) {
    primaryVoices.push(slice(v.measures))
  }
  staves.push({ voices: primaryVoices })

  if (score.secondStaff) {
    const ss = score.secondStaff
    const secondaryVoices: Measure[][] = [slice(ss.measures)]
    for (const v of ss.extraVoices ?? []) {
      secondaryVoices.push(slice(v.measures))
    }
    staves.push({ voices: secondaryVoices })
  }

  return { primaryMeasures, perVoiceContent: staves }
}

/**
 * Clone the captured bundle with fresh event ids, ALSO returning the
 * old→new event-id map so a caller can remap span endpoints onto the
 * inserted copies (D4 span-carry).
 *
 * Critically, `applyStructuralAppendOrInsert` uses `primaryMeasures`
 * (NOT `perVoiceContent[0].voices[0]`) for the destination's primary
 * voice 0. The capture invariant guarantees those two are the SAME
 * reference, so this reuses the primaryMeasures clone for
 * `perVoiceContent[0].voices[0]` — that keeps the id-map pointed at the
 * clones that actually land in the score (rather than a phantom second
 * clone of voice 0 that nothing reads).
 *
 * Fresh ids also matter for span resolution generally: with original
 * ids on both source AND copy, span endpoints would resolve ambiguously
 * (validateScore's indexEventsById is last-write-wins, not
 * throw-on-collision). Fresh ids keep the originals' spans pointed at
 * the originals; the copy's spans are supplied separately via the op.
 */
export function cloneCapturedRangeWithFreshIdsMapped(
  captured: ReturnType<typeof captureRangeContent>,
): {
  primaryMeasures: Measure[]
  perVoiceContent: Array<{ voices: Measure[][] }>
  idMap: Map<string, string>
} {
  const idMap = new Map<string, string>()
  const cloneEvent = (event: Event): Event => {
    const id = createEventId()
    if (event.id !== undefined) idMap.set(event.id, id)
    return { ...event, id }
  }
  const cloneMeasure = (measure: Measure): Measure => ({
    ...measure,
    events: measure.events.map(cloneEvent),
  })
  const primaryMeasures = captured.primaryMeasures.map(cloneMeasure)
  const perVoiceContent = captured.perVoiceContent.map((staff, si) => ({
    voices: staff.voices.map((voice, vi) =>
      // Reuse the primaryMeasures clone for staff 0 / voice 0 (shared ref).
      si === 0 && vi === 0 ? primaryMeasures : voice.map(cloneMeasure),
    ),
  }))
  return { primaryMeasures, perVoiceContent, idMap }
}

/**
 * Clone the entire (primaryMeasures + perVoiceContent) bundle returned
 * by `captureRangeContent`, minting fresh ids on every Event across
 * every (staff, voice) line. Used by the dragMeasureRange duplicate
 * path. Thin wrapper over `cloneCapturedRangeWithFreshIdsMapped` that
 * drops the id-map.
 */
export function cloneCapturedRangeWithFreshIds(
  captured: ReturnType<typeof captureRangeContent>,
): ReturnType<typeof captureRangeContent> {
  const { primaryMeasures, perVoiceContent } = cloneCapturedRangeWithFreshIdsMapped(captured)
  return { primaryMeasures, perVoiceContent }
}

/**
 * The spans FULLY inside a measure range — both endpoints reference
 * events that live within `[fromStart, fromEnd]` (across every staff /
 * voice). These are the spans a measure-range copy carries with it
 * (D4); spans straddling the range boundary are left behind. Returns
 * the original span objects (caller deep-clones / remaps).
 */
export function spansFullyInsideRange(score: Score, fromStart: number, fromEnd: number): Span[] {
  if (!score.spans || score.spans.length === 0) return []
  const ids = new Set<string>()
  const captured = captureRangeContent(score, fromStart, fromEnd)
  for (const staff of captured.perVoiceContent) {
    for (const voice of staff.voices) {
      for (const measure of voice) {
        for (const event of measure.events) {
          if (event.id !== undefined) ids.add(event.id)
        }
      }
    }
  }
  return score.spans.filter((s) => ids.has(s.startEventId) && ids.has(s.endEventId))
}

/**
 * Remap captured spans onto freshly-cloned events (D4 paste). Each span
 * gets a fresh span id and its `startEventId`/`endEventId` rewritten via
 * `idMap`. A span whose endpoints aren't BOTH in the map is dropped
 * (defensive — `spansFullyInsideRange` should have filtered those out).
 */
export function remapSpansToFreshIds(spans: Span[], idMap: Map<string, string>): Span[] {
  const out: Span[] = []
  for (const span of spans) {
    const start = idMap.get(span.startEventId)
    const end = idMap.get(span.endEventId)
    if (start === undefined || end === undefined) continue
    out.push({ ...span, id: createSpanId(), startEventId: start, endEventId: end })
  }
  return out
}

/**
 * Apply an Operation to a Score with full validation. Returns a new
 * immutable Score or throws EditError if the result violates the
 * schema or semantic invariants.
 */
export function applyOperation(score: Score, op: Operation): Score {
  const next = transformScore(score, op)
  try {
    validateScore(next)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new EditError(`Edit produced an invalid score: ${msg}`)
  }
  return next
}
