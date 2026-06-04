---
title: Transport & Playback
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

The Transport subsystem is the audio playback layer: a transport bar UI plus a
Web Audio engine that drives abcjs's `synth.CreateSynth` / `TimingCallbacks` to
play the currently-rendered score. It owns three concerns that are deliberately
kept separate: (1) **audio** — decoding the tune into `AudioBuffer`s and
scheduling them on an `AudioContext`; (2) **the cursor** — toggling a
`.abcjs-note-playing` highlight on DOM note elements and resolving the playing
note back to a `(measureIdx, eventIdx)` in the editor store; and (3) **the bar**
— scrubber, play/pause, readouts, tempo, volume, and the global Space shortcut.
The engine consumes the abcjs `visualObj` published by the render pipeline; it
never touches the `Score` data model directly, only the `SourceMap` (`editMap`)
to translate character offsets into score positions.

## Entry points

| What | Where |
| --- | --- |
| Mount point | `src/components/ScoreStage.tsx:109` — `{abc && <TransportHost />}` (rendered only when `abc` is truthy) |
| Top-level wrapper | `src/components/transport/TransportHost.tsx:TransportHost` |
| The engine | `src/components/transport/useTransport.ts:useTransport` |
| The cursor | `src/components/transport/transportCursor.ts` (`handleEvent` / `handleFinished` / `clearHighlight`) |

`TransportHost` reads the live visualObj from `useCurrentVisualObj()`
(`src/components/editor/useVisualObjRegistry.ts`), feeds it to
`useTransport(visualObj)`, and exposes the returned `TransportState` to its
children through `TransportContext`. Everything below `TransportBar` reaches the
engine via `useTransportContext()`, which throws if mounted outside a host.

## Key files

| Path | Role |
| --- | --- |
| `src/components/transport/useTransport.ts` | The engine. ~550-line hook holding all imperative playback state in refs (`AudioContext`, `GainNode`, `CreateSynth`, `TimingCallbacks`, `AudioBufferSourceNode[]`). Owns the rebuild-on-visualObj effect, `doPlay`/`pause`/`seekPercent`, natural-end detection, and the `playRequest` watcher. Exports `TransportState`, `useTransport`, `SCRUB_FADE_MS = 30`. |
| `src/components/transport/TransportHost.tsx` | Wires `useCurrentVisualObj()` → `useTransport` → `TransportContext.Provider` → `TransportBar`. |
| `src/components/transport/TransportContext.ts` | `TransportContext` (React context of `TransportState | null`) + `useTransportContext()` throwing accessor. |
| `src/components/transport/TransportBar.tsx` | The visible bar. Renders Scrubber + buttons (restart, play/pause, repeat) + Readouts + tempo + VolumeControl + OverflowMenu. Owns the global `Space`=play/pause keydown handler and publishes its height to `:root --transport-height` via `ResizeObserver`. Shows an "Audio not supported" state when `!t.isSupported`. |
| `src/components/transport/Scrubber.tsx` | `role="slider"` seek track. Pointer drag + Arrow/Home/End keys call `t.seekPercent`. Reads/writes live position purely through the `--p` CSS var (no React re-render per frame); ms hover tooltip. |
| `src/components/transport/Readouts.tsx` | Measure + time readout. Derives current measure from `store.playbackPosition` (per-note cadence) and *estimates* elapsed ms via `estimateMs = (measureIdx/totalMeasures)*totalMs`. |
| `src/components/transport/VolumeControl.tsx` | Volume slider + mute toggle; hydrates/persists `sheet-llm.transportVolume` / `sheet-llm.transportMuted` in `localStorage`. |
| `src/components/transport/OverflowMenu.tsx` | `⋯` popover with the "Follow score" checkbox, bound to `store.followPlayback` / `setFollowPlayback`. |
| `src/components/transport/transportCursor.ts` | **Module-scoped** abcjs eventCallback handlers (`clearHighlight`/`handleEvent`/`handleFinished`) + `NoteTimingEvent` interface. Reads `useChatStore.getState()` every call. |
| `src/lib/music/buildEventTimeIndex.ts` | `buildEventTimeIndex(visualObj, sourceMap) → EventTimeIndex {msByPosition, totalMs}`. Powers click / "Play from here" seeking. |
| `src/components/editor/useVisualObjRegistry.ts` | `useSyncExternalStore`-backed registry; `publishVisualObj` (called from `ScorePanel.tsx:139`, gated by the `publishVisual` prop) → `useCurrentVisualObj()`. |
| `src/lib/abc/midi.ts` | `getMidiBytes(abc)` / `downloadMidi(abc, filename='score.mid')` — MIDI **export** path (used by `ExportBar`), *not* the live transport. |
| `src/lib/abc/pitchAudioPing.ts` | Standalone sine-ping for pitch-edit feedback. Own private `AudioContext`, 80 ms coalesce. Independent of `useTransport`. |

## Core concepts / data flow

The render pipeline owns the abcjs `visualObj`; the engine subscribes to it. The
visualObj is **not** routed through React state (too large to diff), so the
registry uses `useSyncExternalStore`:

```
ScorePanel (publishVisual prop) ──publishVisualObj(visualObj)──▶ useVisualObjRegistry (module var)
                                                          │  useSyncExternalStore
                                                          ▼
                                         TransportHost: useCurrentVisualObj()
                                                          │
                                                          ▼
                                            useTransport(visualObj)
                  ┌───────────────────────────────────────┴───────────────────────────┐
        [visualObj] effect: rebuild                                           imperative actions
        ─ loadAbcjs() (dynamic import)                                        play / pause /
        ─ synth.supportsAudio()  ──false──▶ isSupported=false                 seekPercent / restart
        ─ ctx = ensureAudioCtx()                                              setVolume / setMuted
        ─ synth = new CreateSynth(); init({visualObj, ctx}); prime()
        ─ tc = new TimingCallbacks(visualObj, {qpm, eventCallback, beatCallback})
        ─ totalMs   = synth.duration*1000 || tc.lastMoment
        ─ totalMeasures = countMeasures(visualObj)   (counts el_type==='bar')
        ─ timeIndex = buildEventTimeIndex(visualObj, editMap)
```

### Two clocks, started together

Playback runs on **two independent clocks** that are started together but never
continuously resynced:

| Clock | Drives | Source of truth |
| --- | --- | --- |
| `AudioContext.currentTime` (audio) | the actual sound | `startedAtSecRef`, `pausedAtSecRef` |
| abcjs `TimingCallbacks` | cursor highlight + progress bar | `tc.currentTime` / `tc.lastMoment` |

`doPlay()` (`useTransport.ts:doPlay`):

1. `ensureAudioCtx()` (lazy — first call only, to satisfy autoplay policy);
   `resume()` if suspended.
2. `stopSources()`, then create a fresh per-play envelope `GainNode` and one
   `AudioBufferSourceNode` per `synth.audioBuffers` entry connected to it. The
   full output chain is `source → env GainNode → master GainNode →
   DynamicsCompressorNode (brick-wall limiter) → ctx.destination` (the master
   gain + limiter are created once in `ensureAudioCtx`; the env is per-play). The
   env ramps `0 → 1` over `SCRUB_FADE_MS` for a click-free start; see the
   anti-clipping and click-free-fade gotchas.
3. `startedAtSecRef = now - offset`; `src.start(now, offset)` for every source
   (offset = `pausedAtSecRef`).
4. Set `sources[0].onended` (natural-end probe, below).
5. `tc.start(offset/duration, 'percent')`.

As the timing clock advances:

- `beatCallback(_b, _tb, totalTime)` writes `tc.currentTime / totalTime` to the
  `--p` CSS var on the registered progress-fill element (`writeProgressFraction`).
- `eventCallback → handleEvent(ev)` clears + re-adds `.abcjs-note-playing` on the
  event's DOM elements, optionally `scrollIntoView` when `followPlayback`, and
  resolves `ev.startCharArray[0]` → position via `resolveClickPosition(editMap, …)`
  to set `store.playbackPosition`. `Readouts` reads that to show the measure/time.

`pause()` records `currentSec()` into `pausedAtSecRef`, `stopSources()`, and
`tc.pause()`. `seekPercent(p, autoPlay)` sets `pausedAtSecRef = duration*p`,
writes `--p`, calls `tc.setProgress(p, 'percent')`, and re-`doPlay()` if it was
playing or `autoPlay`. `restart` is `seekPercent(0, autoPlay)`.

### Natural-end detection

There is no "ended" event from abcjs synth, so the engine probes
`sources[0].onended` and discriminates a real end from a manual `stop()` via the
pure, exported `isNaturalEnd(elapsedSec, durationSec)` (`elapsed + 0.05 >= duration`):

```
onended → elapsed = ctx.currentTime - startedAtSecRef
          if (!isNaturalEnd(elapsed, synth.duration)) return
          if (repeatRef.current)                   // repeat on → loop
              pausedAtSec=0; --p=0; doPlay()        // seamless restart from the top
          else                                     // natural end
              setPlaying(false); ended=true; --p=1; handleFinished(); tc.stop()
```

`stopSources()` nulls `s.onended` *before* `s.stop()` precisely so manual
stops/seeks never trip this branch.

### Repeat / loop

The repeat toggle (a monochrome loop SVG using `currentColor`, stable
`aria-label="Repeat"` + `aria-pressed`) in `TransportBar` flips `t.toggleRepeat`.
State lives **only in the hook** (`repeatRef` + `repeatState`), not the store —
the sole reader is the `onended` closure, which reads `repeatRef.current` at
fire-time so a mid-playback toggle takes effect on the *next* natural end. When
on, natural end loops by resetting `pausedAtSec=0`, writing `--p=0`, and
recursively calling `doPlay()` (which tears down the just-ended sources, rebuilds
from offset 0, and restarts the timing clock). The `onended` handler first bails
if `synthRef.current !== synth` (a superseded source from a visualObj swap), so a
stale queued callback never loops a dead synth. The preference persists to `localStorage`
`sheet-llm.transportRepeat`, hydrated in a mount effect (read-on-render would
risk an SSR hydration mismatch). The toggle stays enabled even when `!isReady`,
like volume — it's a preference, not a transport action.

### Click / "Play from here"

`buildEventTimeIndex` walks `visualObj.setupEvents(0, 1, bpm)` and maps each
event's `startChar` (via `resolveClickPosition`) to a position key
`${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}` → milliseconds, keeping the
earliest ms per position (chords emit duplicate events). The store's
`playRequest` (bumped by `playFromSelection`) is watched in the `playRequest` effect in `useTransport.ts`;
on a new `playRequest.id` it looks up the selection's ms, divides by
`idx.totalMs`, and calls `seekPercent(percent, true)`.

### Edit-during-play restore

The `[visualObj]` effect is the rebuild path. When the tune changes mid-play it
records `resumeAtSec = currentSec()`, tears down sources + timing, rebuilds
synth + timing against the new visualObj, and resumes via `doPlay()` **only if**
`0 < resumeAtSec < synth.duration` of the *new* synth — otherwise it resets to 0.

## Invariants & gotchas

- **The two clocks can drift.** Audio time and the cursor/progress clock are
  started together but never resynced; the highlight can lag/lead the audio,
  especially after seeks. There is no continuous correction loop by design.
- **Live position has no React source of truth.** Progress is written outside
  React to the `--p` CSS var on the progress-fill element. Scrubber keyboard nav
  reads the current pct back by parsing that same var off the DOM
  (`fill.style.getPropertyValue('--p')`). `aria-valuenow` is hardcoded `0` — the
  accessible "now" comes from `Readouts`' measure text, not the slider value.
- **`transportCursor` handlers MUST stay module-scoped** and call
  `useChatStore.getState()` on every invocation. abcjs binds the
  `eventCallback` object once inside `TimingCallbacks` and never re-reads it;
  closing over hook state would silently capture stale `followPlayback` /
  `editMap`.
- **Natural-end is heuristic.** It keys off `sources[0].onended` AND
  `elapsed + 0.05 >= synth.duration`. A buffer-duration mismatch (multi-buffer
  tunes) could mis-fire or fail to fire.
- **`countMeasures` only counts `el_type === 'bar'`** in the *first voice* of
  each staff and returns `max(1, bars)`. A score with no explicit barlines
  reports 1 measure, which skews the Readouts measure count and the Scrubber
  keyboard step (`step = 1/totalMeasures`).
- **`Readouts` elapsed time is an estimate**, not real audio time:
  `estimateMs = (measureIdx/totalMeasures)*totalMs`, interpolated from the
  per-note `playbackPosition`. It intentionally does **not** subscribe to rAF, so
  it ticks coarsely (per note) and is inaccurate for non-uniform measure lengths.
- **AudioContext is `suspend()`ed, never `close()`d**, on unmount — `close()` is
  permanent and abcjs may share the context with future mounts. The context and
  gain node persist across mounts.
- **Volume/mute apply mid-playback without restart** *only if the gain node
  already exists*: `setVolume`/`setMuted` write `gainRef.current.gain.value`
  directly. Before the first `ensureAudioCtx()`, `userVolumeRef` (default `0.85`)
  and `mutedState` are captured into the initial gain value. Pitch pings and MIDI
  export do **not** route through this gain node and ignore the user's
  volume/mute.
- **`getMidiBytes` assumes a single tune** and silently takes `result[0]` from
  `synth.getMidiFile`. It is the export path, unrelated to the live engine.
- **Anti-clipping: soundfont multiplier + master limiter.** abcjs pre-renders the
  whole tune into a *single* Float32 buffer (`create-synth.js` `prime()`), summing
  every note additively with **no clamp** (`place-note.js` `copyToChannel` does
  `toData[n+start] += fromData[n]`) at a per-note gain of
  `(velocity/96) * soundFontVolumeMultiplier`. The default FluidR3_GM multiplier is
  `3.0`, so a single forte note already renders past ±1.0 and a dense chord voicing
  sums to ~12–18×. Those out-of-range peaks survive un-clipped in the Float32
  buffer and hard-clip only at `ctx.destination`'s Float32→PCM stage → continuous
  **static** plus onset **pops** (aligned chord-onset transients). The 0.85 master
  gain is purely multiplicative and cannot rescue >1.0 floats. Two-part fix in
  `useTransport.ts`: (1) `synth.init` passes `soundFontVolumeMultiplier: 1.5`
  (`SOUND_FONT_VOLUME_MULTIPLIER`, inside the same inner `options` object as
  `chordsOff`) to halve the boost at the source; (2) `ensureAudioCtx` inserts a
  `DynamicsCompressorNode` configured as a brick-wall limiter (threshold −1.5 dBFS,
  knee 0, ratio 20, attack 1 ms, release 100 ms) between `gainRef` and
  `ctx.destination`. Because `gainRef` sits *before* the limiter, volume/mute still
  control how hard it drives; the limiter is `disconnect()`ed on unmount alongside
  the gain. The un-clipped buffer floats mean the limiter fully rescues the signal.
- **Click-free start/stop fades.** Each `doPlay()` creates a *fresh* per-play
  envelope `GainNode` (`envGainRef`) so the chain is
  `source → env → master gain → limiter → ctx.destination`. The env ramps `0 → 1`
  over `SCRUB_FADE_MS` (30 ms) on start, so beginning the buffer at a non-zero
  sample (any offset on play/seek/loop-restart) no longer steps from silence into
  a click. `stopSources({ fade: true })` — used by `pause`, `seekPercent` (when
  playing), and the edit-during-play rebuild — ramps the env `→ 0` then schedules
  `s.stop(end)` at the ramp end, so cutting at a non-zero sample no longer clicks.
  Because each play owns its own env node, a fading-out play and the next play's
  fade-in live on separate nodes and crossfade cleanly instead of fighting. The
  immediate `stopSources()` (no fade) is kept for teardown paths (visualObj
  removed, doPlay's pre-roll, unmount). `stopSources` still nulls `s.onended`
  *before* stopping so neither variant trips the natural-end probe.
- **abcjs auto-accompaniment is suppressed via `chordsOff: true`.** Both the live
  synth (`useTransport.ts` → `synth.init({ …, options: { chordsOff: true } })`,
  nested under `options` per abcjs `create-synth.js`) and the MIDI export
  (`midi.ts` → `getMidiFile(abc, { …, chordsOff: true })`, flat) turn off abcjs's
  built-in bass+chord rhythm track. Otherwise abcjs synthesizes a hidden
  "boom-chick" accompaniment from every chord-symbol annotation (`"Bb7"`, `"Eb"`…)
  in the ABC — audible but never drawn on the staff (it lives on a separate MIDI
  channel). Playback and export must match the notation, so it stays off.
- **Space-to-play** lives in `TransportBar`; it bails when `e.target` or
  `document.activeElement` is `INPUT`/`TEXTAREA`/`SELECT`/contentEditable, ignores
  meta/ctrl/alt modifiers, and is gated on `t.isReady`.

## How to extend / common tasks

- **Add a transport control:** add a field + action to `TransportState` in
  `useTransport.ts`, implement it in the hook (prefer a ref for imperative audio
  state read inside abcjs callbacks, surface only what React must render via
  `useState`), then render it in `TransportBar.tsx` via `useTransportContext()`.
  The `repeat` toggle is the worked example: `repeatRef` + `repeatState`,
  `toggleRepeat`, `localStorage` persistence, and the `onended` loop branch.
- **Smoother / continuous progress bar:** the limiting factor is the
  `beatCallback` cadence and `--p` write. A rAF loop reading `currentSec()` could
  drive `--p` independently — but mind the two-clock drift; you'd be choosing the
  audio clock over the timing clock.
- **Per-note time readout in `Readouts`:** today it interpolates by measure.
  Replace `estimateMs` with a lookup against `buildEventTimeIndex`'s
  `msByPosition` keyed by `playbackPosition` for exact per-note ms.
- **Change cursor behavior (highlight class, scroll):** edit
  `transportCursor.ts`. Keep handlers module-scoped and continue reading store
  state via `getState()`.
- **Pitch-edit audio feedback:** that is `pitchAudioPing.ts`, a fully separate
  Web Audio path. Do not route it through the transport gain node unless you
  intentionally want it to honor the playback volume/mute.

## Testing

- `tests/unit/transport/transportCursor.test.ts` — cursor highlight + store
  position resolution.
- `tests/unit/transport/transportRepeat.test.tsx` — `isNaturalEnd` threshold,
  the repeat button wiring (`aria-pressed`, stable name, `toggleRepeat` click),
  and hook-level `localStorage` persistence/hydration (via `useTransport(undefined)`,
  which skips the abcjs/Web-Audio path).
- `tests/unit/music/buildEventTimeIndex.test.ts` — position→ms index.
- `tests/unit/abc/midi.test.ts` — MIDI byte export.
- `tests/unit/abc/pitchAudioPing.test.ts` — pitch→frequency + ping.
- `tests/unit/components/ExportBar.test.tsx` — exercises the `downloadMidi` path.

The engine hook itself (`useTransport`) is exercised indirectly; Web Audio is
hard to unit-test under jsdom, so the unit suite focuses on the pure
helpers (cursor resolution, time index, MIDI, ping).

## Related files / See also

- `src/components/editor/useVisualObjRegistry.ts` — the visualObj publish/subscribe seam.
- `src/components/ScorePanel.tsx` — calls `publishVisualObj(visualObj)` after render when the `publishVisual` prop is set (`ScoreStage` passes it on the interactive layer).
- `src/lib/music/scoreToAbcWithMap.ts` — `SourceMap` + `resolveClickPosition` (startChar → position).
- `src/lib/chat/state.ts` — store fields: `playbackPosition`, `playRequest`, `followPlayback`, `editMap`, `isPlaying`; actions `setPlaying` / `setPlaybackPosition` / `setFollowPlayback`.
- `src/components/ExportBar.tsx` — consumer of `downloadMidi`.
- `src/lib/orchestrator/README.md` — the chat/edit pipeline that produces the Scores this engine plays.
