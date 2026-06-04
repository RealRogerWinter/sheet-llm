---
title: abc-rendering — Context Card
subsystem: abc-rendering
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/music/scoreToAbcWithMap.ts
  - src/lib/music/scoreToAbc.ts
  - src/lib/abc/synth.ts
  - src/lib/abc/render.ts
  - src/lib/abc/useScoreReveal.ts
  - src/lib/abc/pitchAudioPing.ts
  - src/lib/chat/state.ts
  - src/components/editor/useNoteClickHandler.ts
  - src/components/editor/eventAtX.ts
related:
  - score-data-model
  - orchestrator
  - musicxml-export
  - editor-interactions
  - transport-playback
---

Score → ABC transpile + char-range SourceMap; abcjs renders to SVG; click reverses SVG→char→Score selection. Spine: Score event ↔ ABC char ↔ SVG element.

## Key files
- `src/lib/music/scoreToAbcWithMap.ts` — core (~2470 lines). `scoreToAbcWithMap`, `resolveClickPosition`; all feature→ABC mappings; emit pipeline + build-once maps.
- `src/lib/music/scoreToAbc.ts` — `scoreToAbc(s)=scoreToAbcWithMap(s).abc` (ABC-only).
- `src/lib/abc/synth.ts` — `renderScore` (the editor render: `add_classes:true`+`clickListener`); `attachSynth`/`renderAndAttachSynth`; `RenderScoreOptions`/`ClickListenerDrag`.
- `src/lib/abc/render.ts` — barebones `renderAbc` (NO classes/clicks). Not the editor path.
- `src/lib/abc/useScoreReveal.ts` — post-render "ink condensing" reveal hook.
- `src/lib/abc/pitchAudioPing.ts` — `pitchToFrequency`, `pitchAudioPing` (C4=MIDI60, A440).
- `src/lib/chat/state.ts` — owns map as `editMap`; `renderWithMap` re-derives `{abc,map}` on every mutation.
- `src/components/editor/useNoteClickHandler.ts` — `abcElem.startChar`→`resolveClickPosition`; refines chord pitchIdx by click-Y.
- `src/components/editor/eventAtX.ts` — reverse-maps `[data-startchar]` SVG nodes for X-band hit-test.

## Types / exports
- `scoreToAbcWithMap(score): { abc, map: SourceMap }`
- `resolveClickPosition(map, startChar): {staffIdx,voiceIdx,measureIdx,eventIdx,pitchIdx?} | undefined` (binary search; needs `events[]` char-ascending)
- `SourceMap = { events: EventRange[]; byEvent: Map<'s:v:m:e', EventRange> }`; `EventRange{startChar,endChar,pitchRanges}`; `NoteRange` (per-pitch span)
- `renderScore(target, abc, opts): Promise<visualObj>`; `useScoreReveal(ref,{trigger})`

## Env flags
- None. Reveal kill switch is the debug store (`revealAnimationEnabled`, default ON), not an env flag.

## Gotchas
- Octave hard-limited 2..6: `pitchToAbc` THROWS (`schema_error`), aborts whole transpile.
- breath/caesura stored on event N-1 but emitted as prefix on N (threaded via `pendingPrefix`) → UI must subtract 1; trailing one on last event dropped.
- Tremolo MUST be `!//!`; bare slashes parse as duration divisors. Clamped to 4.
- `escapeAnnotationText` STRIPS backslashes (abcjs has no `\\` decode), escapes `"`→`\"`, collapses whitespace.
- Inter-measure order load-bearing: endBarline→nextStart→voltaOpener→`\n` (volta digit at col 0 is dropped).
- `repeat-both`→`::` (not `:|:`); `dashed`→thin `|`. Many features persist-only/lossy (fermata variants, tremolo measured/unmeasured, arpeggio dir).
- Zoom = `staffwidth`, NOT `scale`: `renderScore` keeps `responsive:'resize'` always (abcjs nulls `scale` under responsive), so zoom varies `staffwidth` (`staffwidthForZoom(z)=round(740/z)`, prefsStore) → reflow, never h-overflow. No `scale` option. Wheel/pinch zoom via `useScoreWheelZoom`.
- `expandToWidest:true` is default-on in `renderScore` + `pdf.ts` → uniform measure widths (every system re-laid to the widest system's width; fixes dense-vs-sparse raggedness). Pass `false` to opt out. NOT `timeBasedLayout` (that diverges across systems).
- Renderer never throws on data-integrity (skips bad span/marker refs); throws only on rest-in-chord / incomplete-tuplet / bad-octave.

## When editing X, also update Y
- New prefix token in `emitEventWithRange` → recheck `startChar`/`endChar`/`pitchRanges` math AND `scoreToAbcWithMap.test.ts` (pins offsets).
- New span family → add `buildXMap` + `xAt` + slot in `emitMeasureWithRanges`; decide primary-voice-only vs per-voice + native vs `"^…"`; use `indexEventIdsForRender`.
- New `BarlineSchema`/enum value → add case to `barlineToAbc` (has `never` exhaustiveness check).
- New EngravingDefaults field → `buildEngravingDefaultsHeaders` (check its deferred-list docblock).
- Change emit order/layout → keep `events[]` globally char-ascending or `resolveClickPosition` breaks.

## Related cards
score-data-model · orchestrator · musicxml-export · editor-interactions · transport-playback
