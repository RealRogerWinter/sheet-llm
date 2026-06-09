---
title: The Score Data Model
subsystem: music-model
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-09
verified_against: 0499203
source_paths:
  - src/lib/music/types.ts
  - src/lib/music/validateScore.ts
  - src/lib/music/validateCrossRefs.ts
  - src/lib/music/scoreAccessors.ts
  - src/lib/music/eventIds.ts
  - src/lib/music/eventKind.ts
  - src/lib/music/pitchTies.ts
  - src/lib/music/migrateScoreV1.ts
  - src/lib/music/meter.ts
  - src/lib/db/schema.ts
related:
  - music-model
  - edit-operations
  - abc-rendering
  - orchestrator
  - persistence-db
---

# The Score Data Model

`Score` is the spine of sheet-llm. Every other subsystem either produces
a `Score` (orchestrator, import), consumes one (ABC render, MusicXML
export, transport), or transforms one (edit-ops). It is a single deeply
nested [Zod](https://zod.dev) schema defined in
`src/lib/music/types.ts`; the TypeScript types are *inferred* from the
schemas (`export type Score = z.infer<typeof ScoreSchema>` at the bottom
of the file), so the schema is the only source of truth — there is no
hand-written `interface` to drift from it.

This doc walks the tree top-down and then names the four recurring
design patterns that make the tree hard to read correctly: the
**optional-id + `ensure*Ids` backfill** rollout, the **legacy-vs-
structured dual field** convention, the **`kind` / `step:'rest'`
discriminator**, and **cross-reference-by-id** (spans, ties, jumps,
voltas, techniques).

> The schema *shape* is only half the contract. `ScoreSchema.parse`
> accepts many structurally-valid scores that are musically invalid (a
> 4/4 bar holding five quarter notes, a slur pointing at a deleted
> event). The full contract is `validateScore()`
> (`src/lib/music/validateScore.ts:validateScore`), which runs the Zod
> parse *then* the semantic + cross-reference checks. **Always go through
> `validateScore`, never raw `ScoreSchema.parse`, on any persistence
> boundary.** See [Validation](#validation-the-real-contract) below.

---

## The tree at a glance

```
Score                                    src/lib/music/types.ts:ScoreSchema (1162)
├── key, meter, tempo_bpm, clef, title…  score-level header
├── measures: Measure[]                  primary staff, voice 0 (REQUIRED, min 1)
├── extraVoices?: Voice[]  (max 3)       voices 1..3 on the primary staff (SATB)
├── secondStaff?: Staff                  grand-staff / piano LH (adds staffIdx 1)
│     ├── clef
│     ├── measures: Measure[]            secondStaff voice 0
│     └── extraVoices?: Voice[] (max 3)
│
├── Measure                             MeasureSchema (663)
│     ├── events: Event[]  (min 1, max 32)
│     ├── startBarline?, endBarline?, barlineFermata?
│     └── isPickup?, isFinalPartial?, systemBreakAfter?, pageBreakAfter?
│
├── Event                              EventSchema (519)
│     ├── id?            (8..16 chars; backfilled — see id pattern)
│     ├── kind?          'note' | 'rest'  (discriminator — see kind pattern)
│     ├── pitches: Pitch[]  (min 1, max 6)   chord = >1 pitch; rest = [{step:'rest'}]
│     ├── duration       enum (whole … 32nd + 3 dotted)
│     ├── tuplet?, articulation?/articulations?, ornament?, fermata?, …
│     ├── dynamic?/dynamic_structured?, lyrics?, chordSymbol?, fingerings?
│     ├── graceNotes?    structured grace (supersedes ornament:'grace')
│     └── tied_to_next?  (legacy event-wide tie; see ties pattern)
│
│     └── Pitch                        PitchSchema (276) [preprocess→PitchObjectSchema 187]
│           ├── step       'C'..'B' | 'rest'  (combined "Bb"/"F#" auto-split, see L4)
│           ├── octave     int 2..6
│           ├── accidental?
│           └── tied_to_next?, lv?, enharmonicTie?   (per-pitch tie state)
│
└── Cross-cutting collections (all OPTIONAL, all reference Event ids or measure indices)
      ├── spans?: Span[]               slurs, hairpins, 8va, gliss, pedal, accel/rit
      ├── markers?: Marker[]           mid-piece key/meter/tempo/clef changes
      ├── voltas?: Volta[]             1st/2nd/Nth endings
      ├── jumpMarkers? / segnoMarkers? / codaMarkers?   D.C./D.S./Coda navigation
      ├── annotations?: Annotation[]   (max 100) rehearsal marks, expression text
      ├── techniqueStates?: TechniqueChange[]  pizz./arco/sul pont. state changes
      └── engravingDefaults?: EngravingDefaults   per-score render preferences
```

The `(NNN)` numbers are line numbers in `types.ts` at SHA `150cb15` (they
drift on edit — the `XxxSchema` symbol name is the durable anchor).

---

## Level 1 — `Score`

`ScoreSchema` (`src/lib/music/types.ts:1162`). Only three fields are
required; everything else is optional.

| Field | Type | Constraint | Why |
|---|---|---|---|
| `key` | `Key` enum | **required** | 30 major/minor keys (`C`…`Cb`, `Am`…`Abm`). No "no key" sentinel — atonal pieces pick the closest. |
| `meter` | `Meter` (`string` refined) | **required** | `isValidMeter` (`meter.ts`): `"C"`, `"C\|"`, or `n/d` with `n∈[1,32]`, `d∈{1,2,4,8,16,32}`. The refinement, not an enum, is the gate. |
| `measures` | `Measure[]` | **required**, `min(1).max(10000)` | The primary staff, voice 0. A score is never empty — see `BLANK_SCORE` (`types.ts:1231`): one measure, one whole rest. |
| `tempo_bpm` | `int` | `30..240` opt | Playback pulse. |
| `clef` | `'treble'\|'bass'` | opt | **Absent ⇒ treble.** `BLANK_SCORE` deliberately omits it; `changeClef` drops the field when value is `'treble'`. Read via `getStaffClef` (`scoreAccessors.ts:52`), never `score.clef` directly. |
| `extraVoices` | `Voice[]` | `max(3)` opt | Voices 1..3 on the primary staff. Each voice's `measures.length` MUST equal the primary's (bar-alignment invariant, enforced in `validateScore`). |
| `secondStaff` | `Staff` | opt | Grand staff. Its presence is what makes `getStaffCount` return 2. |
| `title`/`composer`/`arranger`/`lyricist`/`copyright` | `string` | length caps | Metadata. |
| `spans`/`markers`/`voltas`/`jumpMarkers`/`segnoMarkers`/`codaMarkers`/`annotations`/`techniqueStates`/`engravingDefaults` | arrays/object | all opt | Cross-cutting layers, covered below. |

### Staves, voices, and the shape-isolation rule

A `Score` can hold up to **two staves × four voices = 8 voices**:

```
staffIdx 0 (primary)   voice 0 = score.measures
                       voice 1..3 = score.extraVoices[0..2].measures
staffIdx 1 (second)    voice 0 = score.secondStaff.measures
                       voice 1..3 = score.secondStaff.extraVoices[0..2].measures
```

This irregular shape (voice 0 lives in a bare `measures` field; voices
1+ live in an `extraVoices[]` wrapper; staff 1 is an entirely different
optional sub-object) is the single biggest footgun in the model.
**Never index the shape directly.** All production reads/writes go
through `src/lib/music/scoreAccessors.ts`, which isolates the shape so
future multi-staff work lands without touching every caller:

- `getStaffCount(score)` → 1 or 2 (presence of `secondStaff`).
- `getVoiceCount(score, staffIdx)` → `1 + extraVoices.length`.
- `getVoiceMeasures(score, staffIdx, voiceIdx)` → the measure array, with
  the voice-0-is-bare-vs-voice-N-is-wrapped detail hidden.
- `getStaffClef` / `getActiveStaffClef` → clef with the treble default applied.
- `withVoiceMeasures` / `withStaffMeasures` / `withAllStaffMeasures` →
  immutable mapper-based writes (return a new `Score`, never mutate).
- `findEventLocationById(score, id)` → first `(staffIdx, voiceIdx, measureIdx, eventIdx)` whose event matches.

`Voice` (`VoiceSchema:709`) is just `{ measures }`; `Staff`
(`StaffSchema:713`) is `{ clef, measures, extraVoices? }`. The primary
staff is *not* a `Staff` object — its clef/measures are inlined onto
`Score` directly, which is why `getVoiceMeasures` synthesizes a
`{measures, extraVoices}` shim for `staffIdx 0`.

---

## Level 2 — `Measure`

`MeasureSchema` (`src/lib/music/types.ts:663`).

| Field | Constraint | Why |
|---|---|---|
| `events` | `min(1).max(32)` | A measure is never empty; the 32-event cap mirrors `MAX_NUMERATOR` so a 32/x bar of 32nd-notes is the densest representable bar. |
| `startBarline` / `endBarline` | `Barline` enum opt | 8 glyphs (`BARLINE_KINDS = BarlineSchema.options`, `types.ts:661`). **Absent ⇒ `'thin'`.** `repeat-start`/`repeat-end` open/close `\|: … :\|`. |
| `barlineFermata` | `Fermata` opt | G.P. fermata on the *closing barline* — distinct from `Event.fermata` which sits on a note. |
| `isPickup` / `isFinalPartial` | `boolean` opt | Anacrusis / closing-partial flags. These let `validateMeasureDuration` permit a *short* (but never *long*) bar — the one place measure-duration validation is relaxed. |
| `systemBreakAfter` / `pageBreakAfter` | `boolean` opt | Engraver layout hints. |

### Duration arithmetic (the measure-balance invariant)

`validateMeasureDuration` (`validateScore.ts:36`) sums every event's
duration in **eighth-note units** and compares it to the meter's
capacity (`meterInEighths`, `meter.ts:71`), with a `0.001` epsilon for
tuplet fractions.

- Normal bar: sum must **equal** capacity.
- `isPickup` / `isFinalPartial` bar: sum must be **≤** capacity.

The unit map lives in `validateScore.ts:7` (`DURATION_VALUE_EIGHTHS`):
`whole=8, dotted-half=6, half=4, dotted-quarter=3, quarter=2,
dotted-eighth=1.5, eighth=1, sixteenth=0.5, 32nd=0.25`. Tuplets scale by
`TUPLET_RATIO` (3→2/3, 5→4/5, 6→4/6, 7→4/7).

> **Gotcha — cut time:** `meterInEighths('C\|')` returns **4**, not the
> musicologically-correct 8 (`meter.ts:71`). This is a deliberately
> preserved legacy quirk — every stored score, fixture, and test treats
> cut time as a half-capacity 2/4-like bar. Do not "fix" it without
> migrating all consumers.

`validateMeasureTuplets` (`validateScore.ts:64`) additionally enforces
that a tuplet group has exactly `n` consecutive same-`tuplet` events and
never spans a barline.

---

## Level 3 — `Event`

`EventSchema` (`src/lib/music/types.ts:519`). The richest node in the
tree; the table below is the load-bearing subset. An `Event` is a single
rhythmic moment in one voice: a note, a chord (multiple `pitches`), or a
rest.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` 8..16 opt | Stable identity. Backfilled — see [id pattern](#pattern-1--optional-id--ensureids-backfill). |
| `kind` | `'note'\|'rest'` opt | Discriminator — see [kind pattern](#pattern-3--the-kind--steprest-discriminator). |
| `pitches` | `Pitch[]` `min(1).max(6)` | `len>1` = chord (max 6-note). A rest is `[{step:'rest', …}]`. A rest may not appear *inside* a chord (`validateMeasureChords`). |
| `duration` | `Duration` enum | 9 values incl. 3 dotted. No 64th, no double-dotted. |
| `tuplet` | `3\|5\|6\|7` opt | Tuplet membership; validated for completeness. |
| `articulation` | single, opt | **Legacy.** `articulations: Articulation[]` (max 4) is the structured successor — see [dual-field pattern](#pattern-2--legacy-vs-structured-dual-fields). |
| `ornament` | `Ornament` enum opt | Includes legacy `'grace'`, superseded by `graceNotes`. |
| `graceNotes` | `GraceNote[]` max 8 opt | Structured before-grace. When present + non-empty, the renderer emits these and suppresses the `ornament:'grace'` fallback. Grace pitches may not be rests (`GraceNoteSchema.refine`, `types.ts:512`). |
| `dynamic` | `Dynamic` enum opt | **Legacy** single dynamic; `dynamic_structured` (`DynamicMarking`) wins for compounds like `sub. p espressivo`. |
| `fermata` | `Fermata` opt | 5-form duration distinction. |
| `tremolo` | `{slashes:1..5, measured?}` opt | Single-note (stem) tremolo. Between-note tremolo is a `Span` (`tremolo-between`). |
| `bowing` / `jazzInflection` | enums opt | Per-note bowing (up/down); jazz fall/doit/scoop/plop/ghost. |
| `lyrics` | `LyricSyllable[]` max 50 opt | One entry per verse; verse numbers unique within an event (`refine`, `types.ts:613`). Per-voice lyrics fall out of voice 0/1 being separate `Event` arrays. |
| `chordSymbol` | `ChordSymbol` opt | Recursive (lazy) structured harmony — `bass` can itself be a `chord`. |
| `fingerings` | `(Fingering\|null)[]` max 6 opt | Tagged union per instrument family (piano/string/guitar-lh/guitar-rh/organ). `fingerings[i]` ↔ `pitches[i]`; interior `null` = "no fingering at this pitch". |
| `tied_to_next` | `boolean` opt | **Legacy event-wide tie.** See [ties pattern](#pattern-4--cross-reference-by-id). |

### Level 4 — `Pitch`

`PitchSchema` (`src/lib/music/types.ts:276`) — a `z.preprocess(normalizePitchInput, …)`
wrapper over the object. The preprocess rescues the LLM's most common pitch
mistake: a COMBINED note name (`"Bb"`, `"F#"`, `"Ebb"`, `"Fx"`) emitted in `step`
is split into a bare `step` + the matching `accidental` before the enum check
(idempotent for canonical steps; `"H"` still rejected). Without it, one such
pitch fails the provider-layer `ScoreSchema` parse and aborts an entire
generation — see the music-model subsystem doc's gotchas.

| Field | Constraint | Why |
|---|---|---|
| `step` | `'C'..'B' \| 'rest'` | The `'rest'` member is the legacy rest sentinel — see kind pattern. Combined accidental forms (`"Bb"`) are auto-split by the schema preprocess. |
| `octave` | `int 2..6` | Scientific pitch notation, clamped to the renderable range. A rest still carries an octave (conventionally 4) but it is meaningless. |
| `accidental` | enum opt | `natural/sharp/flat/dblsharp/dblflat/none`. Note `'none'` ≠ absent for some helpers; `deriveEventId` normalizes `'none'`→absent so they hash identically. |
| `tied_to_next` | `boolean` opt | **Per-pitch** tie — the structured successor to event-wide `Event.tied_to_next`. In a chord `[CEG]` only the tied pitches set this. |
| `lv` | `boolean` opt | Laissez-vibrer (open-ended tie, no target required). |
| `enharmonicTie` | `boolean` opt | Escape hatch: relaxes the step+octave match a tie normally requires (C#→Db across a barline). |

---

## Validation: the real contract

`validateScore(input: unknown): Score` (`validateScore.ts:107`) is the
**single validation entry point**. It runs, in order:

1. `ScoreSchema.safeParse` — shape + per-field constraints.
2. **Bar-alignment invariant** — every voice on every staff has the same
   `measures.length` as the primary (`validateScore.ts:122`). This is
   *not* in the Zod schema; it's a cross-field check.
3. Per-measure semantic checks (`validateScore.ts:139`):
   `validateMeasureTuplets`, `validateMeasureChords` (no rest inside a
   chord), `validateMeasureDuration`.
4. `validateCrossRefs(score)` (`validateCrossRefs.ts:23`) — the Phase-1
   cross-reference invariant set (below).

All failures throw `ValidationError` (`src/lib/music/errors.ts`) with a
machine-readable `code` (`schema_error`, `measure_duration_mismatch`,
`tuplet_incomplete`, `rest_in_chord`, `span_endpoint_missing`,
`span_reversed`, `pitch_tie_target_missing`, `jump_ref_missing`,
`marker_duplicate`, `volta_endings_invalid`, `technique_state_invalid`).
The orchestrator surfaces these codes back to the LLM as actionable
repair feedback.

`validateAbc` (`validateScore.ts:161`) is a *separate*, server-only
post-render check that runs the transpiled ABC through `abcjs.parseOnly`
— it validates the rendered output, not the model.

---

## The four recurring patterns

Almost every non-obvious thing in `types.ts` is one of these four. Learn
them once and the schema reads cleanly.

### Pattern 1 — optional `id` + `ensure*Ids` backfill

Six entity families carry a stable string id (8..16 chars): events,
spans, markers, voltas, jump/segno/coda markers, annotations, technique
changes. The ids are how cross-references survive reorder/move ops (an
index would break the moment a measure is inserted).

The rollout is mid-flight (Phase 1, "PR-12" is the planned tighten
point), so **some id fields are still `.optional()`** on the wire while
others are already required:

| Entity | Schema field | Wire requirement | Backfill helper |
|---|---|---|---|
| Event | `EventIdSchema` (`types.ts:287`) | **optional** | `ensureEventIds` (`eventIds.ts:77`) |
| Span | `SpanIdSchema` (`733`) | **optional** | `ensureSpanIds` (`spans.ts`) |
| Marker | `MarkerIdSchema` (`830`) | **optional** | `ensureMarkerIds` (`markers.ts`) |
| Annotation | `AnnotationIdSchema` (`1025`) | **optional** | `ensureAnnotationIds` (`annotations.ts`) |
| TechniqueChange | `TechniqueIdSchema` (`986`) | **optional** | `ensureTechniqueIds` (`techniques.ts`) |
| Volta | `VoltaIdSchema` (`904`) | **REQUIRED** | `ensureVoltaIds` |
| JumpMarker / Segno / Coda | `id: MarkerIdSchema` (`946/967/973`) | **REQUIRED** | `ensureJumpMarkerIds` / `ensureSegnoMarkerIds` / `ensureCodaMarkerIds` |

Why two flavors: the optional ones predate the id rollout, so legacy
stored scores lack them and a hard requirement would reject those rows.
The required ones (volta/jump/segno/coda) were *introduced after* ids
existed, so no legacy data is missing them — but the `ensure*Ids`
helpers still run on the migrate path as a defensive net for
LLM-emitted entries that arrive id-less before validation.

**The single chokepoint is `migrateScoreToV1`**
(`src/lib/music/migrateScoreV1.ts:59`). It deep-clones the raw input
(keeping the original for a rollback sidecar), then runs *all* the
`ensure*Ids` helpers in sequence. The migration is intentionally minimal
— it only backfills ids, because every other Phase-1 field was added as
`.optional()` and there is nothing in legacy v0 data to derive them
from. It is idempotent (`changed` flag tracks whether the first run
altered anything, to skip a no-op DB write).

Event-id mechanics (`src/lib/music/eventIds.ts`):

- `createEventId()` — fresh `nanoid(10)`, for newly authored events.
- `deriveEventId(event, path)` — **deterministic** 32-bit FNV-1a hash of
  `(pitches | duration | staff.voice.measure.event-index)`, used by the
  migration so re-loading the same stored score yields the same ids.
  Derived ids usually start with `'m'` — but **do not branch on
  `id[0]==='m'`**: ~1.5% of fresh nanoids also start with `m`, so the
  prefix is not a reliable runtime discriminator.
- `ensureEventIds(input)` walks staves → voices → measures → events,
  *preserving* any existing id in bounds (8..16) and replacing
  out-of-bounds ids. It tolerates `unknown` (runs *before* the Zod
  parse) and mutates in place.

> **Invariant for new code:** when you mint an event, go through
> `createNote` / `createRest` (`eventKind.ts`) — they attach a fresh id
> *and* set `kind`. Hand-rolling `{pitches, duration}` produces an
> id-less, kind-less event that only survives because the schema fields
> are still optional.

### Pattern 2 — legacy vs structured dual fields

Several attributes exist in two forms: a flat legacy field and a richer
structured successor. **The structured field wins at render time when
present.** Helper modules unify the read path so callers don't branch.

| Attribute | Legacy field | Structured field | Read helper | Precedence rule |
|---|---|---|---|---|
| Articulation | `Event.articulation` (single) | `Event.articulations[]` (stack ≤4) | `articulations.ts:getArticulations` | structured returned as the array; staccato+tenuto auto-coerces to `portato`, marcato+accent rejected |
| Dynamic | `Event.dynamic` (enum) | `Event.dynamic_structured` (`DynamicMarking` base+prefix+suffix) | `dynamics.ts` | `dynamic_structured` wins when present |
| Grace | `Event.ornament === 'grace'` | `Event.graceNotes[]` | renderer | `graceNotes` present + non-empty suppresses the legacy fallback |
| Tie | `Event.tied_to_next` (whole event) | `Pitch.tied_to_next` (per-pitch) | `pitchTies.ts:isPitchTiedToNext` | per-pitch `true`/`false` overrides; only when absent does the event-wide flag apply |

`isPitchTiedToNext(pitch, event)` (`pitchTies.ts:20`) is the canonical
tie reader: per-pitch `true` ⇒ tied; per-pitch `false` ⇒ explicitly not
tied (even if the event-wide flag is on); otherwise fall back to
`event.tied_to_next`. Anything reading ties directly off one field is a
latent bug.

### Pattern 3 — the `kind` / `step:'rest'` discriminator

Whether an event is a note or a rest is encoded **two ways at once**:

1. The new explicit `Event.kind: 'note' | 'rest'` (`EventKindSchema`,
   `types.ts:300`).
2. The legacy hack `pitches[0].step === 'rest'`.

Both still exist because the `kind` rollout is mid-flight. The canonical
reader is `isRest(event)` (`src/lib/music/eventKind.ts:15`):

```
if (event.kind === 'rest') return true     // explicit kind wins
if (event.kind === 'note') return false
return event.pitches?.[0]?.step === 'rest' // legacy fallback
```

`createRest(duration)` mints a rest with *both* representations set
(`kind:'rest'` **and** the `{step:'rest', octave:4}` sentinel) so older
code that still pattern-matches on the sentinel keeps working until the
planned PR-12 migration drops the sentinel. `createNote` throws if handed
a `step:'rest'` pitch, to keep the discriminator from silently
corrupting. Use `isRest` / `isPitched` everywhere; never test
`pitches[0].step === 'rest'` by hand.

### Pattern 4 — cross-reference by id

The cross-cutting collections don't nest under the events they decorate;
they sit at the `Score` level and **reference events by id** (or measures
by index). This keeps the event tree clean and lets a span survive an
edit that moves its endpoints. `validateCrossRefs`
(`src/lib/music/validateCrossRefs.ts:23`) is where these references are
proven to resolve.

**Spans** (`SpanSchema:752`) — slurs, hairpins, `8va`/`8vb`/`15ma`/`15mb`,
glissando, trill-line, `tremolo-between`, pedal, accel/rit (full list in
`SpanKindSchema:735`). Each carries `startEventId` + `endEventId` plus
its own `staffIdx`/`voiceIdx`. `validateSpans` (`validateCrossRefs.ts:57`)
builds an `id → location` map and enforces: both endpoints exist;
endpoints share one staff+voice (cross-staff/cross-voice spans are a
Phase-2 deferral, rejected now); the span's declared `staffIdx`/`voiceIdx`
match the start event's actual location; start ≤ end in score order.
Hairpins may carry `startDynamic`/`endDynamic` for `p<f` shorthand;
accel/rit may carry `endTempoBpm`/`endTempoText` for the visual target
label (distinct from a sibling tempo `Marker` that carries the actual
playback transition).

**Per-pitch ties** — not an id reference but a *positional* cross-event
reference: a pitch with `tied_to_next` must find a matching `step+octave`
pitch in the **next event of the same voice**. `validatePerPitchTies`
(`validateCrossRefs.ts:118`) flattens each voice, honors both the
per-pitch and legacy event-wide flags via `isPitchTiedToNext`, skips
`lv` pitches (no target needed), and emits targeted diagnostics: tying
into a rest, tying off the last event, or a missing match (with an
"enharmonic equivalent present — set `enharmonicTie:true`?" hint when a
respelled pitch is found via MIDI-class comparison).

**Markers** (`MarkerSchema:861`) — mid-piece changes keyed by
`measureIdx`. A marker must change at least one of
key/meter/tempo_bpm/tempo_text/clefs/metricModulation (`refine`,
`types.ts:886`). `validateMarkers` (`validateCrossRefs.ts:316`) rejects
two markers at the same `measureIdx` that change the *same* field, but
allows disjoint-field co-location (one sets meter, another sets key).
Active value at a measure = score-level default plus the most recent
marker at-or-before that index (e.g. `activeKeyAt`).

**Voltas** (`VoltaSchema:906`) — 1st/2nd/Nth endings over a measure
range. `endings:[1]` = first time only, `[1,2]` = first and second pass.
`validateVoltas` enforces `startMeasureIdx ≤ endMeasureIdx` and no
duplicate endings.

**Jump navigation** — `jumpMarkers` / `segnoMarkers` / `codaMarkers`
(`types.ts:945`–`984`) express D.C./D.S./al Coda/Fine. The links are
*by id*: a `D.S.` `JumpMarker` carries `segnoRef` → a `SegnoMarker.id`; an
`al Coda` kind carries `codaRef` → a `CodaMarker.id` and `toCodaRef` → the
`To Coda` jump marker it lands on. `validateJumpMarkerRefs`
(`validateCrossRefs.ts:266`) proves every ref resolves — this is what lets
multi-coda pieces (Sousa marches, Brahms Hungarian Dances) express
"this D.S. → that Segno → that Coda".

**Technique states** (`TechniqueChangeSchema:1004`) — pizz./arco/sul
ponticello/etc. are *state changes* that persist on a voice from their
position forward until cancelled, fundamentally different from per-note
articulations. They target a `(staffIdx, voiceIdx, measureIdx,
eventIdx?)` position. The Zod schema bounds `staffIdx 0..1`/`voiceIdx
0..3` but can't know the score's actual counts, so
`validateTechniqueStates` (`validateCrossRefs.ts:378`) is what proves the
target position exists.

**Annotations** (`AnnotationSchema:1036`, max 100) — rehearsal marks,
expression text, tempo text. Anchored by `target.{measureIdx, eventIdx?,
position}` (index-based, not id-based) with an optional `spanEnd` for
line-extending marks (`rit. ____`).

---

## EngravingDefaults — per-score render preferences

`EngravingDefaultsSchema` (`types.ts:1074`) is a flat bag of ~35 optional
rendering preferences modeled on SMuFL/Dorico `engraving_defaults`,
trimmed to fields abcjs can plausibly honor. The only field with a
*default* is `dynamicsPosition` (`.default('auto-by-staff')`); everything
else is `.optional()`. Today the renderer accepts these additively and
ignores unrecognized fields — they are not yet fully gated on the render
path (the schema comment flags "PR-13 gates the renderer on these"). When
reading, treat absent as "engraver decides".

---

## The persisted data model (DB tables)

`Score` is the in-memory spine; the durable counterpart is the
SQLite/Drizzle schema in `src/lib/db/schema.ts`. A `Score` is never
stored as a column tree — it is serialized whole into
`score_versions.score_json` (an opaque, append-only checkpoint). The
tables below are the persistence model that wraps it. All timestamps are
Unix-epoch **seconds** (INTEGER), except `orchestrator_turns.created_at`,
which is **milliseconds** for sub-second turn ordering.

| Table | Role | Key columns |
|---|---|---|
| `users` | One identity row (anonymous, or a **claimed** account). | `id` (UUID PK), `external_id`, `created_at`, `last_seen_at`, `last_recovery_nonce` (last *consumed* recovery nonce) **+ accounts columns** (below) |
| `sessions` | One "chatId" — what the sidebar lists. `head_version_id` makes "current score?" O(1). | `head_version_id`→`score_versions`, `forked_from_session_id`/`forked_from_version_id` (fork provenance), `deleted_at` (soft delete), `replacement_gate_suppressed` |
| `messages` | Native Anthropic content blocks, verbatim in `content_json`. | `seq` (unique per session), `role`, `tool_use_id`, `score_version_id`, `is_synthetic`, `stream_status` (`complete`/`partial`/`errored`), `error_code` |
| `score_versions` | Append-only checkpoint chain — every LLM result AND every coalesced manual edit. | `score_json`, `score_hash`, `parent_version_id` (linear path to root), `source` (`llm`/`edit`/`import`/`fork-seed`/`revert`, CHECK-constrained), `idempotency_key` (unique), `schema_version` (0 = pre-Phase-1, 1 = post-migration), `pre_migration_score_json` (~90-day rollback sidecar) |
| `orchestrator_turns` | Forensic per-turn log for `npm run replay` — references only, no score JSON. | `final_status`, `classification_kind`, `handler`/`handler_model`, latency/token usage, measure/voice counts, `key_changed`/`meter_changed`/`title_changed`, `retained_event_ratio`, `replacement_blocked`, `after_score_version_id`→`score_versions` (the emitted score, back-filled by the responder), `outcome` (`accepted`/`reverted`/`superseded`, CHECK-constrained; NULL = no explicit decision = implicitly kept), `preservation_ok`/`preservation_mismatch_count`, `replacement_retained_identity_ratio`/`replacement_reasons` (JSON)/`replacement_user_explicit_rewrite` (quality detail; NULL when no before-score) |

### Accounts / auth tables (the accounts milestone, behind `SL_ACCOUNTS_ENABLED`)

The accounts milestone layered email+password+OAuth onto the anonymous
identity **without a table rebuild** — the new `users` columns are a pure
`ADD COLUMN` (all nullable/defaulted), and three new tables sit alongside.

- **`users` (added columns):** `email` (NULL for anon; stored lowercased,
  `users_email_unique` enforces case-insensitive uniqueness with NULLs
  distinct), `email_verified` (default 0), `password_hash` (argon2id; NULL
  for anon and OAuth-only), `tier` (default `'free'` — the paywall tier,
  plain TEXT/no CHECK, validated in app), `display_name`, and `claimed_at`
  (set when an anon identity is upgraded; **once set, the anonymous
  recovery-token path is refused** so a leaked 1-year recovery token /
  stale `sl_uid` cannot re-authenticate a password-protected account).
- **`auth_sessions`** — server-side **revocable** login sessions (distinct
  from the `sessions` *music-chat* table). The cookie carries an opaque
  32-byte token; only its `token_hash` (SHA-256) is stored, so a DB read
  can't replay a session. `expires_at` (absolute) + `idle_expires_at`
  (sliding) + `revoked_at` (logout/reset; kept for audit, GC'd later).
- **`oauth_accounts`** — links a user to an external OAuth identity (one
  per provider). `provider` (`google`/`github`, validated in app) +
  `provider_account_id`, unique on the pair.
- **`auth_tokens`** — single-use, hashed, short-TTL tokens for
  `email_verify` / `password_reset`. Only `token_hash` is stored (raw is
  emailed); `consumed_at` enforces single-use via an atomic CAS.

Deletion of a `users` row FK-cascades through `sessions → messages` and
`sessions → score_versions`, and through `auth_sessions` /
`oauth_accounts` / `auth_tokens` (all `ON DELETE CASCADE`). See
[persistence-db](../subsystems/persistence-db.md) and
[auth-gdpr](../subsystems/auth-gdpr.md) for the full lifecycle.

---

## Practical rules for working with `Score`

- **Persistence boundary ⇒ `validateScore`, never `ScoreSchema.parse`.**
  The schema alone passes musically-invalid scores.
- **Read measures via `scoreAccessors`, not by indexing the shape.** The
  voice-0-bare / voice-N-wrapped / staff-1-optional shape is a footgun.
- **Mint events via `createNote` / `createRest`** so id + kind are set.
- **Read ties via `isPitchTiedToNext`, dynamics/articulations via their
  unify helpers** — never one dual-field in isolation.
- **Test rest-ness via `isRest`**, not `pitches[0].step === 'rest'`.
- **The migration chokepoint is `migrateScoreToV1`** — add any new
  `ensure*Ids` there.
- **`'C\|'` capacity is 4 eighths, not 8** — a deliberate legacy quirk.

---

## See also

- `src/lib/music/types.ts` — the schema (source of truth).
- `src/lib/music/validateScore.ts` — `validateScore` (the only validation entry point).
- `src/lib/music/validateCrossRefs.ts` — the Phase-1 cross-reference invariant set.
- `src/lib/music/scoreAccessors.ts` — the sanctioned shape-isolating accessor layer.
- `src/lib/music/eventIds.ts`, `eventKind.ts`, `pitchTies.ts` — id, kind, and tie helpers.
- `src/lib/music/migrateScoreV1.ts` — the id-backfill migration chokepoint.
- `src/lib/music/meter.ts` — meter validation + capacity math.
- [Music model & validation subsystem](../subsystems/music-model.md) — fuller helper-module map.
- [Edit operations](../subsystems/edit-operations.md) — the pure Score-transform vocabulary.
- [ABC rendering](../subsystems/abc-rendering.md) — Score → ABC + SourceMap.
- [Orchestrator](../subsystems/orchestrator.md) — how a Score is produced and verified per turn.
- [Persistence (DB)](../subsystems/persistence-db.md) — how versioned Scores are stored.
