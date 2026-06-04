---
title: Import Pipeline — Context Card
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
  - src/lib/shared/types.ts
  - src/lib/music/types.ts
related:
  - orchestrator
  - score-model
  - score-to-abc
  - export
---

# Import Pipeline (quick ref)

External format (ABC / MIDI / uncompressed MusicXML / Score JSON) or a `blank`
seed → schema-valid `Score` → shared `normalize()` → seed a fresh chat
conversation. Converters NEVER throw: errors become `block` warnings;
`hasBlockingWarnings` → route `422`.

## Files
- `src/app/api/import/route.ts` — `POST`. Same-origin → multipart(256KB)/JSON(64KB) branch → `detectFormat` → `importScore` → block gate → `validateScore` + `scoreToAbc`+`validateAbc` → `seedConversation`. Holds `BLANK_SCORE` path, `JsonImportSchema`.
- `src/lib/music/import/index.ts` — `importScore(format,{text?,bytes?},opts?)` dispatcher; `hasBlockingWarnings`.
- `src/lib/music/import/detect.ts` — `detectFormat({filename,mime,bytes,text})` → `'abc'|'midi'|'json'|'musicxml'|'unknown'|'xml-unsupported'`. Uncompressed MusicXML → `musicxml`; `.mxl`/PK zip → `xml-unsupported`.
- `src/lib/music/import/abcToScore.ts` — lazy `require('abcjs').parseOnly`; tuplet/ octave/chord handling; grand-staff promotion heuristic.
- `src/lib/music/import/midiToScore.ts` — `@tonejs/midi`; 16th-grid snap, chord group (≤6), tie-split, duration decompose, layout cascade.
- `src/lib/music/import/musicxmlToScore.ts` — `fast-xml-parser`; inverse of `scoreToMusicXml` over the round-trip subset (key/meter/clef/staves, `<note>` pitch/rest/chord, `<type>`+`<dot>`/divisions duration, accidental, tie, tuplet, tempo, metadata). Unsupported → `unsupported_element` info warnings; bad XML → `parse_failed` block.
- `src/lib/music/import/jsonToScore.ts` — `ScoreSchema.safeParse` → `normalize`; schema fail → 1 block warning.
- `src/lib/music/import/normalize.ts` — `normalize()`: `padAnacrusis` + `truncate`; exports `MAX_MEASURES=10000`.
- `src/lib/music/import/types.ts` — parser-side types (`ImportFormat`=`abc|midi|json|musicxml`, NO `'blank'`; `ImportWarningCode` incl. `unsupported_element`).
- `src/components/import/useImport.ts` — `useImport()` hook; `{state,parse,reset,acceptTruncation,setLayoutOverride}`.
- `src/components/import/{ImportModal,ImportPreview,ImportSummary,createBlankScore,quickImport}.tsx/.ts` — UI; commit lifts preview via `resolveImport` (no 2nd round-trip).

## Key types / exports
- `ImportResult{score,warnings,format}`, `ImportWarning{severity:'block'|'choice'|'info',code,message,meta?}`, `ImportOptions{truncateIfLong,chooseVoice,layoutOverride}` — `import/types.ts`.
- `MAX_MEASURES=10000`; `BLANK_SCORE` (`music/types.ts`); wire `ImportFormat='abc'|'midi'|'json'|'musicxml'|'blank'`, `ImportResponse`, `ImportErrorResponse` (`shared/types.ts`).
- Route consumes `checkSameOrigin`/`errorResponse`/`synthToolUseId` from `src/app/api/chat/route.ts`.

## Env flags
None.

## Gotchas
- TWO `ImportFormat` types: `import/types.ts` excludes `'blank'`; `shared/types.ts` includes it. `'blank'` skips parsers, seeds `BLANK_SCORE`, reports `result.format='json'` (stub) — top-level `format` var is the truth.
- `emptyScore()` (dup in all 3 converters) is a placeholder returned WITH a block warning; never rendered. Differs from `BLANK_SCORE` (omits `kind:'rest'`).
- 3-stage validation: converter `ScoreSchema` → route `validateScore` (semantic) → `scoreToAbc`+`validateAbc` (abcjs round-trip, same as post-LLM chat check).
- Uncompressed MusicXML (.xml/.musicxml or `<`+score-partwise/timewise) → `musicxml`; `.mxl`/PK zip + generic XML → `xml-unsupported` (route maps it + `'unknown'` → 422; message: export uncompressed). Body caps raised to 1MB JSON / 2MB multipart for MusicXML.
- ABC drops un-mappable durations (tol 1e-4) + clamps octave[2..6]/chord≤6 — all reuse code `duration_rounded`. MIDI decomposes+ties, drops only remainder.
- ABC modes ≠ major/minor → hard block (`unsupported_mode`). MIDI drum ch9 filtered; mid-piece tempo/key/meter flattened to first w/ info warnings; tuplets skipped.
- `normalize` anacrusis pad computed from primary-staff voice 0, fanned to all voices; assumes all voices share the partial first bar.
- Body caps enforced twice (Content-Length header + actual read).

## When editing X, also update Y
- Add a format (see `musicxmlToScore.ts` as the reference) → `import/types.ts` union + `index.ts` re-export + `importScore` switch + `detect.ts` + route (`SYNTH_USER_PROMPT_BY_FORMAT`, `introTextFor`, `JsonImportSchema`/multipart, body caps) + `shared/types.ts` wire union + `ImportPreview.tsx` `FORMAT_LABEL` + `ImportDropzone.tsx` accepted exts.
- Add warning code → `import/types.ts` `ImportWarningCode`; surface choice UI in `ImportSummary.tsx`.
- New `ImportResponse` field → set in `route.ts`, read in `useImport.ts` + `resolveImport` (`src/lib/chat/state.ts`).
- Change layout heuristics → MIDI consts in `midiToScore.ts` / ABC consts in `abcToScore.ts`.

## Related cards
`orchestrator` · `score-model` · `score-to-abc` · `export`
