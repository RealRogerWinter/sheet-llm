---
title: Music Data Model & Validation — Context Card
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
related:
  - orchestrator
  - score-to-abc
  - edit-operations
  - import-export
---

The `Score` Zod tree + its validation, id rollout, accessors, and feature helpers.

## Key files
- `types.ts` — `ScoreSchema` + ~40 inferred types (`Event`/`Measure`/`Pitch`/`Span`/`Marker`/…); `BLANK_SCORE`, `BARLINE_KINDS`. Read `ScoreSchema` (bottom) first.
- `validateScore.ts` — `validateScore(input: unknown): Score`. Parse + bar-align + duration + tuplet + rest-in-chord → cross-refs. Throws `ValidationError`.
- `validateCrossRefs.ts` — spans/ties/jumps/markers/voltas/techniques refs (via `indexEventsById`).
- `scoreAccessors.ts` — ONLY sanctioned measure access. `getVoiceMeasures(score,s,v)`, `getStaffCount`, `findEventLocationById`, `withAllStaffMeasures`.
- `eventIds.ts` — `createEventId()=nanoid(10)`; `deriveEventId`; `ensureEventIds(input)` (mutate+return).
- `eventKind.ts` — `isRest`/`isPitched`/`createRest`/`createNote` (honors `kind` + legacy rest hack).
- `migrateScoreV1.ts` — `migrateScoreToV1(raw)→{migrated,original,changed}`; `CURRENT_SCORE_SCHEMA_VERSION=1`.
- `meter.ts` — `meterInEighths`/`meterCapacityIn32nds`/`isValidMeter`/`parseMeter`; `METER_PRESETS`.
- `measureBalance.ts` — 32nd integer math: `DURATION_32NDS`, `decompose32nds`, `tieSplitOver`, `consumeForRoom`, `BalanceError`.
- `expand.ts` — `expand(score)` jump linearization + non-fatal `ExpandWarning[]`.
- `pitchTies.ts`/`articulations.ts`/`dynamics.ts` — unified read over dual fields.
- `errors.ts` — `ValidationError{message,code,location?}`, `.describe()`, `ValidationErrorCode`.

## Key exports/types
`ScoreSchema`, `validateScore`, `validateCrossRefs`, `BLANK_SCORE`, `Score`/`Event`/`Measure`/`Pitch`/`Span`/`Marker`/`Volta`/`JumpMarker`/`TechniqueChange`/`EngravingDefaults`, `BARLINE_KINDS`, `ensure*Ids`, `create*Id`, `activeKeyAt`/`activeMeterAt`/`activeTempoAt`, `activeTechniqueAt`.

## Env flags
None in this subsystem.

## Top gotchas
1. `'C|'` = 4 eighths / 16 32nds (HALF capacity, 2/4-like), NOT 8. Do not "fix".
2. TWO `isRest`: `eventKind.isRest` honors `kind`; `measureBalance.isRest` is pitches-only. cross-refs uses eventKind's.
3. `deriveEventId` `'m'` prefix is NOT a migrated-vs-fresh signal (~1.5% of nanoid ids start `'m'`).
4. id asymmetry: Event/Span/Marker/Technique/Annotation ids OPTIONAL; Volta/Jump/Segno/Coda REQUIRED → must `ensure*Ids` before Zod.
5. Marker duplicate check is per-FIELD (disjoint fields at same measureIdx are legal).
6. Two duration tables (validator=eighths ±0.001; balance=32nds integer-exact) intentionally NOT merged.
7. `expand` is tolerant (warns, never throws) and bound-checks `jump.measureIdx`; cross-refs does NOT. Repeats/voltas not honored yet.

## When editing X, also update Y
- Add an `Event`/`Score` field → make it `.optional()`; if id-bearing ref, add `ensure*Ids` + call from `migrateScoreToV1`; mirror array caps into `render_score` wire tool.
- Add a barline/span/jump KIND → append to enum in `types.ts`/`spans.ts`; `.options` re-exports drive sync-pin tests across render schema + edit-ops + editor.
- Add a semantic check → per-measure in `validateScore.ts`, reference-integrity in `validateCrossRefs.ts`; add code to `ValidationErrorCode` in `errors.ts`.
- Mutate measures → use `scoreAccessors` (`withAllStaffMeasures` keeps staves/voices bar-aligned). Never index `score.measures` directly.

## Related cards
`orchestrator`, `score-to-abc`, `edit-operations`, `import-export`
