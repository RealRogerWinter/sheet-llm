---
title: Score Import Pipeline
subsystem: import
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/app/api/import/route.ts
  - src/lib/music/import/index.ts
  - src/lib/music/import/detect.ts
  - src/lib/music/import/abcToScore.ts
  - src/lib/music/import/midiToScore.ts
  - src/lib/music/import/musicxmlToScore.ts
  - src/lib/music/import/jsonToScore.ts
  - src/lib/music/import/normalize.ts
  - src/lib/music/import/types.ts
  - src/components/import/useImport.ts
  - src/components/import/ImportModal.tsx
  - src/components/import/ImportPreview.tsx
  - src/components/import/ImportSummary.tsx
  - src/components/import/createBlankScore.ts
  - src/components/import/quickImport.ts
  - src/lib/shared/types.ts
  - src/lib/music/types.ts
related:
  - orchestrator
  - score-model
  - score-to-abc
  - export
---

# Score Import Pipeline

The import pipeline turns an external artifact — ABC text, a MIDI binary, an
(uncompressed) MusicXML document, a Score-JSON blob, or a "blank" seed
request — into a schema-valid `Score`,
applies a shared post-parse normalization stage (anacrusis padding + length
truncation), validates it through the *same* semantic + abcjs round-trip gates
the chat route runs after an LLM turn, and then seeds a fresh chat conversation
so subsequent `/api/chat` refinements have a synthetic `tool_use_id` to anchor
to. Every format converter returns the same `ImportResult` shape and **never
throws to its caller**: failures are demoted to `severity: 'block'` warnings, and
`hasBlockingWarnings()` gates the route to a `422`. The only non-format input,
`format:'blank'`, deliberately skips all parsers and seeds with the canonical
`BLANK_SCORE`.

## Entry points

| Entry | What it is |
| --- | --- |
| `src/app/api/import/route.ts:POST` | The HTTP endpoint. Same-origin check, multipart-vs-JSON branch, detect + dispatch, block gate, semantic+abcjs validation, conversation seed. |
| `src/lib/music/import/index.ts:importScore` | Format-dispatching wrapper: `importScore(format, {text?|bytes?}, options?)` switching `'abc'|'json'|'midi'|'musicxml'`. |
| `src/lib/music/import/detect.ts:detectFormat` | Sniffs `{filename,mime,bytes,text}` → `'abc'|'midi'|'json'|'musicxml'|'unknown'|'xml-unsupported'`. Uncompressed MusicXML (`.xml`/`.musicxml`, or leading `<` containing `score-partwise`/`score-timewise`) → `'musicxml'`; `.mxl`/`PK` zip stays `'xml-unsupported'`. |
| `src/components/import/ImportModal.tsx` | Modal shell (Dropzone / PasteBox / Samples → preview → commit). |
| `src/components/import/useImport.ts:useImport` | Client hook owning the `/api/import` I/O state machine. |
| `src/components/import/createBlankScore.ts:createBlankScore` | Modal-bypass: POSTs `{format:'blank'}` and lifts the response straight into the store. |

## Key files

| Path | Role |
| --- | --- |
| `src/lib/music/import/index.ts` | Barrel + `importScore` dispatcher; re-exports `detectFormat` and the three converters; `hasBlockingWarnings(result)` helper. |
| `src/lib/music/import/detect.ts` | `detectFormat`. Order: extension → MIME → leading bytes (`MThd` magic, `PK` zip → `xml-unsupported`) → leading text (`<` + `score-partwise`/`score-timewise` → `musicxml`, else `xml-unsupported`; `{`; `X:`/`KMLT:` lines). |
| `src/lib/music/import/types.ts` | Parser-side `ImportFormat` (`'abc'\|'midi'\|'json'\|'musicxml'` — **no `'blank'`**), `ImportWarning{severity,code,message,meta}`, `ImportWarningSeverity`, `ImportWarningCode` (incl. `unsupported_element`), `ImportOptions{truncateIfLong,chooseVoice,layoutOverride}`, `ImportResult{score,warnings,format}`. |
| `src/lib/music/import/musicxmlToScore.ts` | `musicxmlToScore(xml, options?)` via `fast-xml-parser`. Inverse of `scoreToMusicXml` over the round-trip subset: `<score-partwise>` → per-(staff,voice) `<note>` streams (chord stack via `<chord/>`, duration from `<type>`+`<dot/>` else `<duration>`/divisions, accidental, `<tie>`, `<time-modification>` tuplet), first-measure `<attributes>` (key/meter/clef/`<staves>`→`secondStaff`), tempo from `<sound>`/`<metronome>`, metadata from `<work>`/`<identification>`. Unsupported features degrade with `unsupported_element` info warnings; malformed/non-MusicXML → one `parse_failed` block. `normalize()` + `ScoreSchema`. |
| `src/lib/music/import/abcToScore.ts` | `abcToScore(abc, options?)`. Lazy-`require('abcjs').parseOnly`, walks lines × staves × voices, maps abcjs pitch ints/decorations/tuplets to `Event`s, grand-staff promotion heuristic, `normalize()`, final `ScoreSchema` check. |
| `src/lib/music/import/midiToScore.ts` | `midiToScore(bytes, options?)` via `@tonejs/midi`. Snaps to 16th grid, groups chords (max 6), fills rests, splits at barlines with ties, decomposes durations, runs a multi-track layout cascade, `normalize()`. |
| `src/lib/music/import/jsonToScore.ts` | `jsonToScore(input, options?)`. `JSON.parse` if string → `ScoreSchema.safeParse` → `normalize()`. Schema failure → one `'block'` warning, never a throw. |
| `src/lib/music/import/normalize.ts` | `normalize(score, options)` shared post-parse: `padAnacrusis` + `truncate`. Exports `MAX_MEASURES = 10000`. |
| `src/app/api/import/route.ts` | The route. `MAX_JSON_BYTES = 1MB`, `MAX_MULTIPART_BYTES = 2MB` (raised for MusicXML), `JsonImportSchema` (paste path accepts `abc`/`json`/`musicxml`), `BLANK_SCORE` seed path, `seedConversation`. |
| `src/components/import/useImport.ts` | `useImport()` → `{state, parse, reset, acceptTruncation, setLayoutOverride}`. Status machine `idle/previewing/preview-ready/preview-blocked/error`. |
| `src/components/import/ImportModal.tsx` | Wires inputs → `parse`, renders `ImportSummary` + `ImportPreview`, `commit()` lifts the preview into the store via `resolveImport` (no second server round-trip). |
| `src/components/import/ImportPreview.tsx` | Read-only abcjs render + metadata + layout selector (single/grand-staff/satb). `currentLayout()` infers the active layout from staff/voice counts. |
| `src/components/import/ImportSummary.tsx` | Three-tier warning list; for the `too_long` block renders the "import first N bars" button wired to `onAcceptTruncation`. |
| `src/components/import/createBlankScore.ts` | Modal-bypass blank seed; soft-deletes the prior session, `resolveImport`, pre-selects measure 0 event 0. |
| `src/components/import/quickImport.ts` | Debug-panel `quickImportFromUrl` / `quickImportText` that POST + `resolveImport` with no preview/confirm. |

## Core concepts / data flow

```
 UI (ImportModal→useImport.parse | createBlankScore | quickImport)
        │  POST /api/import
        ▼
 route.ts:POST
   checkSameOrigin ──fail──► 403
   getRequestUser
   ├─ multipart? (content-type)  ── content-length > 256KB ──► 413
   │    readMultipart (file ≤ 256KB) ──► runImportFromFile
   │       detectFormat(filename,mime,bytes,textHead)
   │         xml-unsupported / unknown ──► 422 block
   │       importScore(detected, {bytes|text}, options)
   │
   └─ JSON path ── content-length / body > 64KB ──► 413
        JsonImportSchema.parse  (── throws ──► 400 invalid_request)
        format==='blank' ? result = {score:BLANK_SCORE, warnings:[], format:'json'}
                         : importScore('abc'|'json', {text}, options)

 importScore ─► abcToScore | midiToScore | jsonToScore
        parse to partial Score → normalize() → ScoreSchema.safeParse
        returns ImportResult{score, warnings, format}
        (any error is a block warning, NEVER a throw)
        ▼
 hasBlockingWarnings(result) ──true──► 422 ImportErrorResponse{code,error,warnings}
        │ false
   validateScore(score)         (── ValidationError ──► 422 block schema_invalid)
   scoreToAbc + validateAbc     (── ValidationError ──► 422 block parse_failed)
        ▼
   seedConversation(userId, score, format, filename)
        createConversation → appendMessages([user text][assistant text + tool_use(render_score, input=score)], {scoreSource:'import'})
        ▼
   200 ImportResponse{chatId, abc, introText, scoreJson, toolUseId, warnings, importFormat, filename?}
        + header X-Import-Latency-Ms
        ▼
 client resolveImport(...) → zustand chat store
 (ImportModal.commit reuses the already-created chatId — no second round-trip)
```

### Two-stage validation

Validation is layered, with `block` severity reserved for hard failures:

1. **Structural** — every converter ends with `ScoreSchema.safeParse`.
   `abcToScore`/`midiToScore` demote a failure to a `schema_invalid` block
   warning and still return the (placeholder) score; `jsonToScore` returns the
   block warning directly. See `abcToScore.ts:abcToScore` (final `schemaCheck`),
   `midiToScore.ts:midiToScore`, `jsonToScore.ts:jsonToScore`.
2. **Semantic** — `route.ts:POST` then calls `validateScore(result.score)`
   (`src/lib/music/validateScore.ts`), which catches measure-duration
   consistency the Zod schema can't express (durations sum to the meter,
   tuplets complete, etc.). A `ValidationError` becomes a `schema_invalid` block.
3. **abcjs round-trip** — finally `scoreToAbc(score)` + `await validateAbc(abc)`.
   This is the **same post-LLM check the chat route runs**, so an imported score
   is held to the identical bar the orchestrator holds generated scores to. A
   `ValidationError` here becomes a `parse_failed` block.

### `ImportResult` uniform shape & warning severities

`ImportResult = {score, warnings, format}` (`types.ts`). `ImportWarning.severity`
is one of:

| severity | meaning | route behavior |
| --- | --- | --- |
| `block` | hard failure (parse, schema, unsupported, too-long-without-opt-in) | `hasBlockingWarnings` → `422` |
| `choice` | user must pick (declared in the union; in practice surfaces as a `too_long` block that resolves to `info`) | returned in body |
| `info` | FYI (anacrusis padded, voice picked, duration dropped, key/meter flattened) | returned in body, `200` |

`ImportWarningCode` is a closed union in `types.ts`: `parse_failed`,
`schema_invalid`, `too_long`, `multi_voice`, `multi_staff`, `unsupported_mode`,
`unsupported_meter`, `unsupported_key`, `mid_piece_key_change`,
`mid_piece_meter_change`, `anacrusis_padded`, `tempo_dropped`, `voice_picked`,
`duration_rounded`, `tuplet_dropped`. Note that several octave-clamp and
drop-note conditions reuse `duration_rounded` rather than minting a dedicated
code (see gotchas).

### `normalize()` — the shared chokepoint

All three real converters call `normalize(score, options)` (`normalize.ts`)
exactly once, just before their final `ScoreSchema` check. It does two things:

- **`padAnacrusis`** — pads a partial first measure (pickup) with leading rests
  so it sums to the meter; the schema forbids partial measures. The pad amount
  is computed from **voice 0 of the primary staff ONLY** via `synthesizeRests`
  (greedy largest-first decomposition into the `Duration` enum), then the *same*
  leading-rest sequence is fanned to every voice on every staff (via
  `withAllStaffMeasures` + `prependLeadingRests`) so bars stay aligned. If the
  first bar is already full or over-full it is left alone (over-full is a real
  validation error that should surface). Emits an `anacrusis_padded` info
  warning.
- **`truncate`** — caps at `MAX_MEASURES = 10000`. Over the cap with
  `truncateIfLong` false → a `too_long` **block** warning (the UI offers a
  choice). With `truncateIfLong` true → slice to the cap + an `info` warning.
  Truncation is global: every voice is clipped to the same measure count.

`MAX_MEASURES` is a runaway-input ceiling, not a real-music limit; the comment
notes the real resource defenses live at the request boundary (the per-score
JSON byte cap) and the renderer.

### Layout cascade (MIDI)

`midiToScore.ts:resolveLayoutFromPipes` picks a `Score` layout from per-track
pipeline results (`TrackPipe{track, measures, medianMidi}`):

| condition | result |
| --- | --- |
| `layoutOverride='single'` | busiest track → one staff, clef from median register |
| `layoutOverride='grand-staff'` | top + bottom by median → treble primary + bass `secondStaff` (scaffolds a whole-rest bass staff if only 1 track) |
| `layoutOverride='satb'` | top 4 by median → S/A primary (voice 0 + extraVoice), T/B `secondStaff`; pads missing voices with whole-rest scaffolding |
| auto: 4 tracks, strictly-decreasing median, both pairs gap ≤ 18 st (`SATB_PAIR_MAX_GAP_SEMITONES`) | SATB |
| auto: 2 tracks, median gap > 12 st (`SPLIT_HAND_MIN_GAP_SEMITONES`) | grand-staff piano |
| auto: anything else | busiest single track + an actionable `voice_picked` info warning telling the user to use the Layout selector |

### Grand-staff promotion (ABC)

`abcToScore.ts:promoteLowVoicesToSecondStaff` handles ABC files that come back
as one staff with multiple voices but really meant grand staff. A staff-0 voice
is promoted to a synthetic bass `secondStaff` **only if** its median MIDI gap
from voice 0 > 18 semitones (`PROMOTE_MIDI_GAP_SEMITONES`) **AND** its median
sits below middle C (`MIDDLE_C_MIDI = 60`). Skipped entirely when abcjs already
produced a second staff — we honor abcjs's structural verdict. The narrow
thresholds keep Bach two-part inventions as same-staff polyphony while promoting
clear RH/LH piano layouts.

### Blank seed path

`format:'blank'` is a **wire-only** `ImportFormat` (declared in
`src/lib/shared/types.ts` and `JsonImportSchema`, but *excluded* from the
parser-side `src/lib/music/import/types.ts` union). The route short-circuits all
parsers and fabricates `result = {score: BLANK_SCORE, warnings: [], format: 'json'}`
— `result.format` is a stub here; the top-level `format` variable (set from the
request) is the source of truth reported back and used by `seedConversation`.
`BLANK_SCORE` lives in `src/lib/music/types.ts`.

### Conversation seeding

`route.ts:seedConversation` writes a synthetic transcript shaped like a
successful LLM turn: `[user text][assistant text + tool_use(render_score,
input=score)]`, with a `synthToolUseId()` from `src/app/api/chat/route.ts`. The
synthetic **user** prompt (`SYNTH_USER_PROMPT_BY_FORMAT`) exists purely to
satisfy the Anthropic Messages API's strict user-first alternation rule — a bare
`[assistant]` transcript would be rejected the moment a refinement turn is
appended. Messages are written with `{scoreSource: 'import'}`. The route never
calls the LLM and works identically with or without `ANTHROPIC_API_KEY`.

## Invariants & gotchas

- **TWO `ImportFormat` types diverge on purpose.**
  `src/lib/music/import/types.ts` excludes `'blank'` (no parser ever emits it);
  `src/lib/shared/types.ts` includes `'blank'` (wire/route level). When you add
  a format, update the one that matters for your layer — they are not meant to
  be kept identical.
- **`emptyScore()` is a placeholder, duplicated three times.** It is defined
  locally in `abcToScore.ts`, `midiToScore.ts`, and `jsonToScore.ts` and is only
  ever returned *alongside* a block warning. The route never renders it because
  `hasBlockingWarnings` short-circuits to `422` first. It also differs from
  `BLANK_SCORE`: the converter `emptyScore()` omits the `kind:'rest'` field that
  `BLANK_SCORE` carries on its rest event.
- **Uncompressed MusicXML imports; compressed `.mxl` does not.** `detectFormat`
  routes `.xml`/`.musicxml` (and a leading `<` containing
  `score-partwise`/`score-timewise`) to `'musicxml'`, but still returns
  `'xml-unsupported'` for a `PK` zip header / `.mxl` extension (compressed
  MusicXML — we only emit uncompressed, so import parity needs uncompressed
  only) and for generic non-MusicXML XML. The route maps `'xml-unsupported'`
  (message: export an uncompressed `.musicxml`) and `'unknown'` to `422` block
  warnings.
- **Anacrusis padding assumes all voices share the same partial first measure.**
  The code in `normalize.ts` flags (in comments) that a voice whose first bar was
  already full would over-fill after the prepend — acknowledged but not handled.
  The common anacrusis case (all voices start partial) is safe.
- **ABC drops, MIDI decomposes.** `abcToScore` drops a note entirely (with a
  `duration_rounded` info warning) when its whole-note fraction doesn't land on
  the closed `Duration` enum within tolerance `1e-4` — it does **not** round.
  `midiToScore` greedily *decomposes* a duration into enum pieces (chained with
  ties) and drops only the unrepresentable remainder.
- **Octave clamps reuse `duration_rounded`.** `abcToScore` clamps pitches to
  octave `[2..6]` and chord size to 6, emitting a `duration_rounded`-coded
  warning (the code is reused, not octave-specific). `midiToPitch` also hard-
  clamps octave to `[2,6]`.
- **Tuplet state is carried forward (ABC).** abcjs marks only the first tuplet
  event (`startTriplet`) and the last (`endTriplet`); the voice walker carries
  `state.openTuplet` forward to stamp `tuplet:N` on every event in between,
  because the schema requires it on each. Only `3/5/6/7` are recognized.
- **MIDI tuplet detection is intentionally skipped (MVP).** Mid-piece tempo /
  key / meter changes are flattened to the first value with info warnings
  (`tempo_dropped`, `mid_piece_key_change`, `mid_piece_meter_change`).
- **Drum channel is filtered.** 0-indexed channel 9 (MIDI channel 10) notes are
  removed before grouping. A track that is all-drums can yield no usable notes →
  `parse_failed` block.
- **abcjs is lazy-`require`d** inside `parseTunes` to keep client bundles lean;
  it handles both the default and named `parseOnly` export shapes.
- **ABC modes other than major/minor are hard BLOCK errors.** Dorian,
  Mixolydian, etc. → `unsupported_mode`; out-of-range meters/keys →
  `unsupported_meter`. These return `emptyScore()` rather than silently coercing.
- **Body-size caps are enforced twice.** The route checks the `Content-Length`
  header first (early `413`) and again on the actual read, because Content-Length
  can be absent or lie.
- **Layout override re-runs the FULL server round-trip.**
  `useImport.setLayoutOverride` calls `parse(lastSource, {layoutOverride})`. The
  preview's layout selector is hidden for JSON imports (JSON already encodes the
  authored layout).
- **`getStaffCount`/`getVoiceCount` are imported into `normalize.ts` but unused**
  — they are referenced only via `void` to suppress the unused-import lint. Don't
  assume `normalize` consults staff/voice counts.

## How to extend / common tasks

- **Add a new import format.** `musicxmlToScore.ts` is the reference
  implementation (added 2026-06-02 for export/import parity); follow its shape:
  1. Write `xToScore(input, options) → ImportResult` that ends in `normalize()`
     + a final `ScoreSchema.safeParse`, returning block warnings instead of
     throwing.
  2. Add the format to the parser-side `ImportFormat` in
     `src/lib/music/import/types.ts`, re-export from `index.ts`, and wire it into
     `importScore`'s switch.
  3. Have `detect.ts` return the new format for that extension/magic/sniff;
     adjust the route's `xml-unsupported` branch as appropriate.
  4. Add `JsonImportSchema`/multipart handling if the source is text vs binary
     (raise `MAX_JSON_BYTES`/`MAX_MULTIPART_BYTES` if the format is verbose), and
     extend `SYNTH_USER_PROMPT_BY_FORMAT` + `introTextFor` in `route.ts`.
  5. Add the format to the **wire** `ImportFormat` in `src/lib/shared/types.ts`
     and the `FORMAT_LABEL` record in `ImportPreview.tsx`, and the accepted
     extensions in `ImportDropzone.tsx`.
- **Add a new warning code.** Extend `ImportWarningCode` in
  `src/lib/music/import/types.ts`. If the UI needs to surface a choice/button,
  handle it in `ImportSummary.tsx` (currently only `too_long`).
- **Change the length ceiling.** Edit `MAX_MEASURES` in `normalize.ts`; it is
  exported so tests reference it without hardcoding.
- **Tune the layout heuristics.** MIDI: `SPLIT_HAND_MIN_GAP_SEMITONES`,
  `SATB_PAIR_MAX_GAP_SEMITONES`, and `resolveLayoutFromPipes` in
  `midiToScore.ts`. ABC: `PROMOTE_MIDI_GAP_SEMITONES`, `MIDDLE_C_MIDI`, and
  `promoteLowVoicesToSecondStaff` in `abcToScore.ts`.
- **Change body caps.** `MAX_JSON_BYTES` / `MAX_MULTIPART_BYTES` in `route.ts`
  (mirror the JSON cap in `JsonImportSchema`'s `.max()`).

## Testing

| Test | Covers |
| --- | --- |
| `tests/unit/music/import/detect.test.ts` | extension/MIME/byte/text sniffing incl. `xml-unsupported` + `unknown` |
| `tests/unit/music/import/abcToScore.test.ts` | abcjs walk, octave/chord clamps, tuplet propagation, grand-staff promotion, unsupported-mode blocks |
| `tests/unit/music/import/midiToScore.test.ts` | grid snap, chord grouping, tie splitting, duration decomposition, layout cascade |
| `tests/unit/music/import/musicxmlToScore.test.ts` | `scoreToMusicXml`→`musicxmlToScore` round-trips (single-staff w/ accidentals/ties/rests/chords, grand-staff, dotted+triplet, minor key + cut time); malformed/non-MusicXML → block warning |
| `tests/unit/music/import/jsonToScore.test.ts` | string vs object input, schema-invalid → block warning (no throw) |
| `tests/unit/music/import/normalize.test.ts` | anacrusis padding (multi-voice fan-out), truncation block↔info, `MAX_MEASURES` |
| `tests/integration/api-import.test.ts` | route: same-origin, multipart/JSON branches, 413/422 gates, seed conversation |
| `tests/integration/api-import-blank.test.ts` | `format:'blank'` seed path → `BLANK_SCORE` |

## Related files / See also

- `src/lib/music/validateScore.ts` — `validateScore` / `validateAbc` (the
  semantic + abcjs round-trip the route reuses).
- `src/lib/music/scoreToAbc.ts` — `scoreToAbc` used for the round-trip and the
  `abc` field of the response.
- `src/app/api/chat/route.ts` — exports `checkSameOrigin`, `errorResponse`,
  `synthToolUseId` consumed by the import route; the orchestrator the seeded
  conversation hands off to.
- `src/lib/llm/conversations.ts` — `createConversation` / `appendMessages` used
  by `seedConversation`.
- `src/lib/llm/renderScoreTool.ts` — `RENDER_SCORE_TOOL_NAME` used in the
  synthetic tool_use block.
- `src/lib/music/types.ts` — `ScoreSchema`, `KeySchema`, `MeterSchema`,
  `BLANK_SCORE`.
- `src/lib/shared/types.ts` — wire `ImportFormat`, `ImportResponse`,
  `ImportErrorResponse`, `ImportWarningWire`.
- `src/lib/chat/state.ts` — `resolveImport` store action the client lifts the
  response into.
