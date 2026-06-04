---
title: Transport & Playback — Context Card
subsystem: transport
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/components/transport/useTransport.ts
  - src/components/transport/TransportHost.tsx
  - src/components/transport/TransportContext.ts
  - src/components/transport/TransportBar.tsx
  - src/components/transport/Scrubber.tsx
  - src/components/transport/Readouts.tsx
  - src/components/transport/VolumeControl.tsx
  - src/components/transport/OverflowMenu.tsx
  - src/components/transport/transportCursor.ts
  - src/lib/music/buildEventTimeIndex.ts
  - src/components/editor/useVisualObjRegistry.ts
  - src/lib/abc/midi.ts
  - src/lib/abc/pitchAudioPing.ts
related:
  - score-model
  - abc-render
  - chat-orchestrator
  - export
---

**Purpose:** Transport bar UI + Web Audio engine that plays the rendered abcjs `visualObj`, syncing a note-highlight cursor and measure/time readouts back to the store.

**Files**
- `transport/useTransport.ts` — the engine hook. All audio state in refs (`AudioContext`/`GainNode`/`CreateSynth`/`TimingCallbacks`/`AudioBufferSourceNode[]`); exports `TransportState`, `useTransport`, `SCRUB_FADE_MS=30`.
- `transport/TransportHost.tsx` — `useCurrentVisualObj()` → `useTransport` → `TransportContext` → `TransportBar`. Mounted from `src/components/ScoreStage.tsx:109` only when `abc` truthy.
- `transport/TransportContext.ts` — context + `useTransportContext()` (throws outside host).
- `transport/TransportBar.tsx` — visible bar; owns global `Space`=play/pause; writes `:root --transport-height`.
- `transport/Scrubber.tsx` — `role=slider`; drag/Arrow/Home/End → `seekPercent`; reads/writes `--p` CSS var (no per-frame React).
- `transport/Readouts.tsx` — measure from `store.playbackPosition`; elapsed = `(measureIdx/totalMeasures)*totalMs` (estimate).
- `transport/VolumeControl.tsx` — persists `sheet-llm.transportVolume` / `sheet-llm.transportMuted`.
- `transport/OverflowMenu.tsx` — "Follow score" → `store.followPlayback`.
- `transport/transportCursor.ts` — **module-scoped** `handleEvent`/`handleFinished`/`clearHighlight`; toggles `.abcjs-note-playing`.
- `lib/music/buildEventTimeIndex.ts` — `buildEventTimeIndex(vo, sourceMap) → {msByPosition, totalMs}`; click/play-from-here seeking.
- `components/editor/useVisualObjRegistry.ts` — `publishVisualObj` (from `ScorePanel.tsx:139`, gated by the `publishVisual` prop) / `useCurrentVisualObj()`.
- `lib/abc/midi.ts` — `getMidiBytes`/`downloadMidi` (export path, NOT live transport).
- `lib/abc/pitchAudioPing.ts` — separate sine ping for pitch edits; own AudioContext.

**Key exports/types:** `TransportState { isReady,isPlaying,isRebinding,isSupported,ended,totalMs,totalMeasures,qpm,volume,muted,repeat + play/pause/restart(autoPlay?)/seekPercent(p,autoPlay?)/setVolume/setMuted/toggleRepeat/registerProgressFill/registerScrubberRoot }`; `EventTimeIndex`; `NoteTimingEvent`; pure `isNaturalEnd(elapsedSec,durationSec)`.

**Env flags:** none. (Constants: `SCRUB_FADE_MS=30`; default volume `0.85`; `SOUND_FONT_VOLUME_MULTIPLIER=1.5`; pitchAudioPing `COALESCE_MS=80`.)

**Gotchas**
- Two clocks (audio `ctx.currentTime` vs abcjs `TimingCallbacks`) start together, never resync → cursor drift after seeks.
- No React source of truth for live position; `--p` CSS var only; `aria-valuenow` hardcoded 0.
- `transportCursor` handlers must stay module-scoped + read `getState()` each call (abcjs binds callback once → stale closures otherwise).
- Natural-end is heuristic: `onended` AND `isNaturalEnd(elapsed, synth.duration)` (`elapsed+0.05 >= duration`); `stopSources()` nulls `onended` before `stop()`.
- **Repeat/loop:** `repeatRef` (read at `onended` fire-time, so mid-play toggles apply) → on natural end, instead of stopping, `pausedAtSec=0` + `writeProgressFraction(0)` + recursive `doPlay()` (seamless loop). `repeat` state is hook-local (not the store), persisted to `localStorage` `sheet-llm.transportRepeat`, hydrated in a mount effect. The repeat toggle (monochrome loop SVG, `currentColor`) in `TransportBar` has a stable `aria-label="Repeat"` + `aria-pressed`, and stays enabled even when `!isReady` (it's a preference, like volume).
- `countMeasures` counts only `el_type==='bar'` in first voice → no-barline scores report 1 measure (skews readout + scrubber step).
- AudioContext is `suspend()`ed, never `close()`d, on unmount (may be shared).
- Volume/mute apply mid-play via `gainRef` directly, only if gain node exists; pitch ping + MIDI ignore it.
- **Anti-clipping chain:** abcjs pre-mixes the whole tune into one Float32 buffer, summing notes additively with no clamp (`place-note.js` `copyToChannel +=`) at per-note gain `(vel/96)*soundFontVolumeMultiplier` (3.0 default for FluidR3_GM). Dense voicings overshoot ±1.0 (~12-18x) and hard-clip at the DAC → static + onset pops. Mitigated two ways: (1) `synth.init` passes `soundFontVolumeMultiplier: 1.5` (inside the inner `options`, where `chordsOff` lives) to halve the boost; (2) `ensureAudioCtx` wires a `DynamicsCompressorNode` brick-wall limiter (threshold -1.5 dBFS, knee 0, ratio 20, attack 1 ms, release 100 ms) as `gain → limiter → ctx.destination`. `gainRef` stays before the limiter so volume still controls drive; limiter is `disconnect()`ed on unmount. The un-clipped buffer floats mean the limiter can fully rescue the signal.
- **Click-free fades:** each `doPlay()` routes sources through a fresh per-play envelope `GainNode` (`source → env → gain → limiter → dest`, `envGainRef`) that ramps 0→1 over `SCRUB_FADE_MS` on start. `stopSources({fade:true})` (used by pause/seek/edit-during-play) ramps env→0 then `stop()`s at the ramp end; the fresh-node-per-play design lets a fading-out play crossfade with the next play's fade-in without collision. Unmount/teardown paths use the immediate `stopSources()` (no fade). Without this, starting/stopping the buffer at a non-zero sample stepped to/from silence = a click.
- Live synth (`synth.init`) + MIDI export (`getMidiFile`) both pass `chordsOff: true` → abcjs's auto bass+chord "boom-chick" track (synthesized from chord-symbol annotations, never drawn on staff) is suppressed so audio/export match the notation. Nests under `options` for `CreateSynth`; flat for `getMidiFile`.

**When editing X also update Y**
- Add to `TransportState` (useTransport.ts) → render in `TransportBar.tsx`.
- Change position-key format `staff:voice:measure:event` → keep `buildEventTimeIndex.ts`, `transportCursor.ts`, `scoreToAbcWithMap.ts:resolveClickPosition`, store `playRequest` in sync.
- Touch visualObj publish → `useVisualObjRegistry.ts` + `ScorePanel.tsx` (`publishVisual` prop) + `ScoreStage.tsx`.
- Store fields used: `playbackPosition`, `playRequest`, `followPlayback`, `editMap`, `isPlaying` (`src/lib/chat/state.ts`).

**Related cards:** score-model, abc-render, chat-orchestrator, export
