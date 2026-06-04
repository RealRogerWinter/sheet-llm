---
title: Music Data Model & Validation
subsystem: music-model
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/music/types.ts
  - src/lib/music/validateScore.ts
  - src/lib/music/validateCrossRefs.ts
  - src/lib/music/scoreAccessors.ts
  - src/lib/music/eventIds.ts
  - src/lib/music/eventKind.ts
  - src/lib/music/migrateScoreV1.ts
  - src/lib/music/meter.ts
  - src/lib/music/measureBalance.ts
  - src/lib/music/expand.ts
  - src/lib/music/spans.ts
  - src/lib/music/techniques.ts
  - src/lib/music/pitchTies.ts
  - src/lib/music/articulations.ts
  - src/lib/music/dynamics.ts
  - src/lib/music/errors.ts
related:
  - orchestrator
  - score-to-abc
  - edit-operations
  - import-export
---

The `Score` is the spine of the whole application: a deeply-nested Zod schema
(`src/lib/music/types.ts`) that every other subsystem reads and writes. Untyped
JSON — from an LLM tool-call, a DB row, or an importer — enters as `unknown`,
gets stable ids backfilled, is parsed-and-semantically-validated into a typed
`Score` by `validateScore`, persisted as a versioned row, and then read back
exclusively through `scoreAccessors` by the renderer, exporters, and edit-ops.
This subsystem owns the schema, the validation invariants, the optional-id
back-compat rollout, the integer-exact measure arithmetic, and a per-feature
set of read/write helper modules that hide legacy-vs-structured dual fields
behind a single read path.

## Entry points

Read in this order; the first three are the contract.

| File | Why first |
|------|-----------|
| `src/lib/music/types.ts` | The whole tree. Read `ScoreSchema` (bottom) then walk up through `EventSchema`, `MeasureSchema`, `PitchSchema`. Everything else is an accessor or invariant over these shapes. |
| `src/lib/music/validateScore.ts` | `validateScore(input)` — the single validation entry point. Schema parse + semantic checks, then delegates to cross-refs. |
| `src/lib/music/validateCrossRefs.ts` | The Phase-1 reference-integrity invariant set (spans / ties / jumps / markers / voltas / techniques). |
| `src/lib/music/scoreAccessors.ts` | The ONLY sanctioned measure-list access layer. Production code never indexes `score.measures` directly. |
| `src/lib/music/eventIds.ts` + `migrateScoreV1.ts` | The back-compat id rollout that lets the LLM emit id-less objects. |

## Key files

| Path | Role |
|------|------|
| `src/lib/music/types.ts` | ~1295 lines of Zod schemas + inferred TS types for every node (`Step`, `Accidental`, `Duration`, `Key`, `Meter`, `Pitch`, `Event`, `Measure`, `Voice`, `Staff`, `Span`, `Marker`, `Volta`, `JumpMarker`, `Segno`/`CodaMarker`, `TechniqueChange`, `Annotation`, `EngravingDefaults`, `Score`). Defines `BLANK_SCORE` and `BARLINE_KINDS`. Heavily commented with engraving rationale. |
| `src/lib/music/validateScore.ts` | `validateScore(input: unknown): Score`. `ScoreSchema.safeParse` → bar-alignment, per-measure duration sum, tuplet completeness, rest-in-chord → `validateCrossRefs`. Also async `validateAbc(abc)` (server-only, via `abcjs.parseOnly`). |
| `src/lib/music/validateCrossRefs.ts` | Six reference invariants over a freshly-built `indexEventsById` map: spans, per-pitch ties, jump-marker refs, markers, voltas, technique states. |
| `src/lib/music/scoreAccessors.ts` | Schema-shape isolator. `getMeasures`/`getMeasureAt`/`getEventAt`, staff-aware `getStaffCount`/`getStaffClef`/`getStaffMeasures`, voice-aware `getVoiceCount`/`getVoiceMeasures`/`getVoiceEventAt`, `findEventLocationById`, and immutable mappers `withMeasures`/`withStaffMeasures`/`withAllStaffMeasures`/`withVoiceMeasures`. |
| `src/lib/music/eventIds.ts` | `createEventId()` = `nanoid(10)`; `deriveEventId(event, path)` = deterministic 32-bit FNV-1a hash → `'m'+hex+lenchar`; `ensureEventIds(input)` walks staff/voice/measure/event, mutates in place + returns. |
| `src/lib/music/eventKind.ts` | Rest/note discriminator over both `kind` and the legacy `pitches[0].step==='rest'` hack. `isRest`/`isPitched`/`createRest`/`createNote`. |
| `src/lib/music/migrateScoreV1.ts` | v0→v1 migration. `CURRENT_SCORE_SCHEMA_VERSION=1`; `migrateScoreToV1(raw)` clones + runs every `ensure*Ids`, returns `{migrated, original, changed}`. Idempotent. `scoreNeedsV1Migration`, `rollbackScoreFromSidecar`. |
| `src/lib/music/meter.ts` | Single source of truth for time signatures. `METER_PRESETS`, `ALLOWED_DENOMINATORS`, `MAX_NUMERATOR`, `isValidMeter`, `parseMeter`, `meterInEighths`, `meterCapacityIn32nds`, `isCompound`. |
| `src/lib/music/measureBalance.ts` | 32nd-note integer-exact measure arithmetic. `DURATION_32NDS`, `decompose32nds`, `fillWithRests`/`fillMeasureWithRests`, `tieSplitEvent`/`tieSplitOver`, `consumeForRoom`, `mergeAdjacentRests`, `BalanceError`, `MAX_CASCADE_DEPTH`. |
| `src/lib/music/expand.ts` | `expand(score)` linearizes the measure sequence honoring jumpMarkers (D.C./D.S./al-Coda/al-Fine), returning steps + non-fatal `ExpandWarning[]`. |
| `src/lib/music/spans.ts` | Spans + voltas + jump/segno/coda + annotations helpers, per-family KIND consts + guards, `create*`/`ensure*Ids`, `activeKeyAt`/`activeMeterAt`/`activeTempoAt`. |
| `src/lib/music/techniques.ts` | Performance-technique state (pizz/arco/etc.). `activeTechniqueAt`, `techniquesOnVoice`, `ensureTechniqueIds`. |
| `src/lib/music/pitchTies.ts`, `articulations.ts`, `dynamics.ts` | Unified read path over the three legacy-vs-structured dual fields. |
| `src/lib/music/errors.ts` | `ValidationError{message, code, location?}` with `.describe()` for LLM-retry prompts; `ValidationErrorCode` union. |

## Core concepts & data flow

### The tree shape

```
Score
├─ key, meter, tempo_bpm?, clef?, title?, composer?/arranger?/lyricist?/copyright?
├─ measures: Measure[]            (1..10000)   ← staff 0, voice 0
├─ extraVoices?: Voice[]          (max 3)      ← staff 0, voices 1..3
├─ secondStaff?: Staff            (clef, measures, extraVoices?) ← staff 1
├─ spans? / markers? / voltas? / jumpMarkers? / segnoMarkers? / codaMarkers?
├─ annotations? (max 100) / techniqueStates? / engravingDefaults?
│
Measure { events[1..32], barlineFermata?, startBarline?/endBarline?,
          isPickup?/isFinalPartial?, systemBreakAfter?/pageBreakAfter? }
Event   { id?, kind?, pitches[1..6], duration, tuplet?, + ~20 decoration fields }
Pitch   { step, octave(0..9), accidental?, tied_to_next?, lv?, enharmonicTie? }
```

Two staves max. Up to 3 extra voices per staff. SATB = 2 staves × 2 voices.
Voice 0 is always the staff's `measures`; voices 1..3 live in `extraVoices[]`.
`getVoiceMeasures(score, staffIdx, voiceIdx)` is the canonical resolver.

### Validation pipeline

```
unknown JSON ─▶ migrateScoreToV1(raw)            (optional; clone + ensure*Ids)
            ─▶ ensure*Ids backfill                (mutate-in-place, BEFORE Zod)
            ─▶ validateScore(input):
                 1. ScoreSchema.safeParse                 → schema_error
                 2. bar-alignment (every voice .length === primary)
                 3. per-measure duration sum === meterInEighths (±0.001)
                 4. tuplet completeness (no cross-barline tuplets)
                 5. rest-in-chord rejection
                 6. validateCrossRefs(score):
                      validateSpans / validatePerPitchTies /
                      validateJumpMarkerRefs / validateMarkers /
                      validateVoltas / validateTechniqueStates
            ─▶ Score (persisted as a versioned row)
            ─▶ read back through scoreAccessors by renderer / exporters / edit-ops
```

`ensure*Ids` MUST run before Zod because `Volta`/`JumpMarker`/`Segno`/`Coda` have
a **required** `id`; a backfill-less LLM emission of those hard-fails the parse.
`Event`/`Span`/`Marker`/`Technique`/`Annotation` ids are optional, so they
survive un-backfilled, but the cross-ref checks key spans by `event.id` — an
id-less event simply can't be a span endpoint.

### Three engines of "what a duration is worth"

Two intentionally-separate duration tables exist, plus the meter module:

| Where | Unit | Why |
|-------|------|-----|
| `validateScore.ts:DURATION_VALUE_EIGHTHS` + `TUPLET_RATIO` | eighths, float, ±0.001 | validator must compare fractional tuplet ratios (2/3, 4/5…). |
| `measureBalance.ts:DURATION_32NDS` | 32nds, integer-exact | edit-time arithmetic (smartInsertNote, tie-cascades) compares for equality WITHOUT epsilons. |
| `meter.ts:meterInEighths` / `meterCapacityIn32nds` | both | measure capacity; the validator uses eighths, balance uses 32nds. |

The two tables are deliberately NOT consolidated (see the comment block at the
top of `measureBalance.ts`).

### Unified read path over dual fields

Three back-compat seams pair a legacy singular field with a newer structured
field; one helper per seam decides precedence:

| Legacy field | Structured field | Helper (winner) |
|--------------|------------------|-----------------|
| `Event.articulation` (enum) | `Event.articulations[]` | `articulations.ts:getArticulations` — plural wins |
| `Event.dynamic` (enum) | `Event.dynamic_structured` | `dynamics.ts:getDynamicMarking` — structured wins |
| `Event.tied_to_next` (event-wide) | `Pitch.tied_to_next` (per-pitch) | `pitchTies.ts:isPitchTiedToNext` — per-pitch wins (explicit `true`/`false`), else event-wide |

Also `Event.kind` vs `pitches[0].step==='rest'` (`eventKind.isRest`, kind wins)
and `ornament:'grace'` vs `Event.graceNotes[]` (structured non-empty wins).

## Invariants & gotchas

- **`PitchSchema` auto-splits combined accidentals.** The LLM is told `step` is
  a bare letter (`C`..`B`/`rest`) with accidentals in a separate `accidental`
  field, but in flat/sharp-heavy keys it still emits a COMBINED note name
  (`"Bb"`, `"F#"`, `"Ebb"`, `"Fx"`) as the step. A `z.preprocess` on
  `PitchSchema` (`normalizePitchInput`) splits that back into `step` +
  `accidental` BEFORE the enum check, so a `render_score` tool input validated
  against `ScoreSchema` at the provider layer no longer throws
  `ProviderSchemaError` — which had no retry in `callWithScoreRetry` and killed
  whole generations (every note of a B♭m piece tripped it). Idempotent: a
  canonical step (and any existing `accidental`) passes through untouched; an
  unrecognizable step (`"H"`) is still rejected so genuine garbage surfaces.
- **`'C|'` reports half capacity.** `meterInEighths('C|') === 4` and
  `meterCapacityIn32nds('C|') === 16` — NOT the musicological 8/32. Cut time is
  treated as a 2/4-like bar. `parseMeter('C|')` still returns `{2, 2}`. Every
  test, fixture, and stored score depends on this; do not "fix" without
  migrating all consumers (`src/lib/music/meter.ts`).
- **Two different `isRest`.** `eventKind.isRest(event)` honors the `kind`
  discriminator (`kind:'rest'|'note'` wins, else `pitches[0].step==='rest'`).
  `measureBalance.isRest(ev)` is pitches-only (`length===1 && step==='rest'`)
  and ignores `kind`. `validateCrossRefs` uses the `eventKind` one. Pick
  deliberately.
- **`deriveEventId`'s `'m'` prefix is NOT a migrated-vs-fresh discriminator.**
  nanoid's alphabet includes `'m'`, so ~1.5% of `createEventId()` outputs also
  start with `'m'`. Never branch on `id[0]==='m'`.
- **`ensure*Ids` replace out-of-bounds ids, not just missing ones.** Any
  existing id whose length is outside 8..16 is replaced so a malformed stored id
  doesn't fail the subsequent Zod bounds check. They also tolerate fully-unknown
  input (no throw, no-op) so they can run before Zod.
- **Optional-id asymmetry.** `EventIdSchema`/`SpanIdSchema`/`MarkerIdSchema`/
  `TechniqueIdSchema`/`AnnotationIdSchema` are `.optional()`; but
  `VoltaSchema`/`JumpMarkerSchema`/`SegnoMarkerSchema`/`CodaMarkerSchema` have a
  **required** `id`. That is why `migrateScoreToV1` runs
  `ensureVolta/Jump/Segno/CodaMarkerIds` before `validateScore`.
- **Marker duplicate check is per-FIELD.** Two markers at the same `measureIdx`
  are legal if they change disjoint fields (one key, one meter) but rejected if
  both change the same field. `metricModulation` participates in this check
  (`validateCrossRefs.ts:validateMarkers`).
- **Per-pitch tie validation has three escape hatches:** `lv` (no target
  required), `enharmonicTie` (relaxes the step+octave match), and the event-wide
  `tied_to_next` fallback. The validator rejects tie-into-rest and
  tie-off-the-end-of-voice with actionable messages, and — when a 12-TET
  equivalent is present in the next event (via `pitchToMidi` mod-12) — suggests
  `enharmonicTie:true`.
- **`expand.ts` warnings are non-fatal and tolerant by design.** It surfaces
  (does not throw) `jump_out_of_range` and friends, and bound-checks
  `jump.measureIdx` itself because `validateCrossRefs` does NOT. Repeats and
  voltas are NOT honored by `expand` yet — it is a separate concern from
  save-time validation. `ITERATION_CAP = 100_000` guards cycles; each jump
  fires at most once.
- **Articulation normalization bakes in notational rules.** staccato+tenuto
  auto-coerces to the single `portato` glyph; marcato+accent THROWS
  `ArticulationStackingError`. `withArticulation` strips the legacy singular
  field so `getArticulations` doesn't double-count.
- **Schema bounds mirror the LLM wire-tool hints.** `annotations.max(100)`,
  `measures.max(10000)`, `events` 1..32, `pitches` 1..6, `extraVoices.max(3)`
  match the `render_score` tool's `maxItems`, so paths that bypass the tool
  (`generateSimple` raw JSON, direct DB insert) still hit the same cap.
- **`BLANK_SCORE` omits `clef`.** The renderer defaults to treble (matching
  `changeClef` dropping the field when `value==='treble'`). Its single event
  carries BOTH `kind:'rest'` and the legacy `{step:'rest'}` sentinel.
- **`meter.ts` deliberately does NOT import `Meter`** — that would be a circular
  ref (`Meter` is inferred from `MeterSchema`, which uses `meter.isValidMeter`
  as its refinement). Params are typed as `string`.

### ValidationError taxonomy

`errors.ts:ValidationError{message, code, location?{measure, event}}` with
`.describe()` formatting for LLM-retry prompts. Codes:

```
schema_error · measure_duration_mismatch · tuplet_incomplete · rest_in_chord
abc_parse_failed · span_endpoint_missing · span_cross_voice · span_reversed
jump_ref_missing · pitch_tie_target_missing · marker_duplicate
volta_endings_invalid · technique_state_invalid · unknown
```

Separate error classes elsewhere: `BalanceError` (`measureBalance.ts`, codes
`tuplet_unsplittable`/`tuplet_blocked`/`cascade_overflow`/`would_empty_measure`/
`unrepresentable`), `ChordBuildError` (`chords.ts`), and
`ArticulationStackingError` (`articulations.ts`).

## How to extend / common tasks

**Add a field to `Event`/`Measure`/`Score`.** Make it `.optional()` (the LLM
emits partial objects; un-migrated stored scores must still parse). If it is an
id-bearing reference object, add an `ensure*Ids` helper in its feature module
AND call it from `migrateScoreToV1` before `validateScore`. If LLM-facing, mirror
any array `maxItems` cap into the `render_score` wire tool (see the
`annotations.max(100)` comment in `types.ts`).

**Add a new barline / span / jump kind.** Append to the enum in `types.ts`; the
`BARLINE_KINDS = BarlineSchema.options` (and the per-family KIND consts in
`spans.ts`) re-export `.options` so sync-pin tests catch any surface — render
schema, edit-op op-bag, editor selectors — that forgot the new kind.

**Add a semantic invariant.** Put per-measure checks in `validateScore.ts`;
put reference-integrity (anything that needs `indexEventsById` or cross-voice
lookups) in `validateCrossRefs.ts` as its own function added to the
`validateCrossRefs` body. Add a code to `ValidationErrorCode` in `errors.ts`.
Note `validateCrossRefs` runs each check first-fail (the comment documents how
to switch to all-errors mode).

**Read or mutate measures.** Never index `score.measures` directly in
production code — use `scoreAccessors`. For structural ops that add/remove/
reorder measures, use `withAllStaffMeasures` so every staff and voice stays
bar-aligned in one pass (the bar-alignment invariant is enforced at save time).

**Create events/ids.** `eventKind.createNote`/`createRest` (they mint ids and
set `kind`); `spans.createSpan`/`createVolta`/`createSegno`/`createCoda`/
`createJump`, `markers.createMarker`, `annotations.createAnnotation`,
`techniques.createTechniqueChange`. Direct-construction sites always mint via
`create*Id`; only the LLM/migration paths rely on `ensure*Ids` backfill.

## Testing

Unit tests live under `tests/unit/music/`. The load-bearing ones for this
subsystem:

- `validateScore.test.ts`, `validateCrossRefs.test.ts` — the invariant set.
- `eventIds.test.ts`, `eventKind.test.ts`, `migrateScoreV1.test.ts` — id rollout.
- `meter.test.ts`, `measureBalance.test.ts`, `fillMeasureWithRests.test.ts`,
  `smartInsertNote.test.ts`, `smartInsertNote.voice.test.ts` — duration math.
- `expand.test.ts` — jump linearization + warnings.
- Feature helpers: `articulations`, `dynamics`, `pitchTies`, `spans`, `markers`,
  `techniques`, `ornaments`, `fingerings`, `lyrics`, `graceNotes`(+`.parser`),
  `chords`, `chordSymbols`(+`.fixtures`), `annotations`, `perNoteExtras`,
  `engravingDefaults`.

## Related files / See also

- `src/lib/orchestrator/README.md` — consumes `validateScore` + `ValidationError.describe()` for the retry loop.
- `src/lib/music/scoreToAbc*` — the read side (Score → ABC + SourceMap).
- `src/lib/music/editOperations.ts`, `smartInsertNote.ts`, `transformScoreBalanced` — the write side.
- Related context-cards / subsystems: `score-to-abc`, `edit-operations`, `import-export`, `orchestrator`.
