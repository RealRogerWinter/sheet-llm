---
title: Score-to-ABC, SourceMap & abcjs Rendering
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

## Purpose

This subsystem transpiles the `Score` data model (the Zod tree in
`src/lib/music/types.ts`) into an **abcjs ABC string** and, in the same pass,
builds a **character-range `SourceMap`** that links each Score event and pitch
to its exact char offsets in the ABC text. abcjs renders the ABC to SVG with
`add_classes: true`, stamping each note `<g>` with its source `startChar`; the
editor reverses that link — SVG click → `startChar` → binary-search the
`SourceMap` → `(staff, voice, measure, event, pitch)` selection. The result is a
three-way spine — **Score event ↔ ABC char ↔ SVG element** — that all editor
hit-testing relies on. A post-render hook (`useScoreReveal`) runs a staggered
"ink condensing" reveal animation, and `pitchAudioPing` gives audible feedback
on pitch edits.

## Entry points

| Start here | Why |
| --- | --- |
| `src/lib/music/scoreToAbcWithMap.ts:scoreToAbcWithMap` | The whole Score→ABC+map pipeline (~2470 lines; every feature's ABC mapping lives here). |
| `src/lib/music/scoreToAbcWithMap.ts:resolveClickPosition` | char → selection binary search. The reverse direction of the spine. |
| `src/lib/abc/synth.ts:renderScore` | The on-screen render the editor actually uses (`add_classes` + `clickListener`). |
| `src/lib/chat/state.ts:renderWithMap` + `editMap` field | Where the map is produced and stored on every score mutation. |
| `src/components/editor/useNoteClickHandler.ts` | How a click round-trips back to a Score selection. |

## Key files

| Path | Role |
| --- | --- |
| `src/lib/music/scoreToAbcWithMap.ts` | The core. Exports `scoreToAbcWithMap`, `resolveClickPosition`, and the `NoteRange` / `EventRange` / `SourceMap` types. Holds every Score-feature → ABC mapping plus the emit pipeline (`emitEventWithRange` → `emitMeasureWithRanges` → `emitVoiceBody`) and all build-once lookup-map builders. |
| `src/lib/music/scoreToAbc.ts` | Thin wrapper: `scoreToAbc(score) = scoreToAbcWithMap(score).abc`. For callers needing only the ABC string (diff preview, MusicXML export). |
| `src/lib/abc/synth.ts` | `renderScore()` lazy-imports abcjs and calls `renderAbc` with `add_classes: true` + `clickListener`. Also `attachSynth` / `renderAndAttachSynth` for audio, and the `RenderScoreOptions` / `ClickListenerDrag` types. |
| `src/lib/abc/render.ts` | Minimal alternate `renderAbc(target, abc, opts)` wrapper (staffwidth/responsive only; **no** `add_classes`/`clickListener`). A barebones helper distinct from `synth.ts`'s `renderScore`. |
| `src/lib/abc/useScoreReveal.ts` | React hook driving the post-render per-element "ink condensing" reveal via Web Animations API over `.abcjs-note` / `.abcjs-rest` / `.abcjs-bar`. Honors `reduceMotion` and a debug kill switch. |
| `src/lib/abc/pitchAudioPing.ts` | `pitchToFrequency(step, octave, accidental)` (scientific pitch, C4 = MIDI 60, A440) and `pitchAudioPing()` (50 ms sine ping, browser-only, 80 ms coalesce). |
| `src/lib/chat/state.ts` | Owns the `SourceMap` as the `editMap` field; `renderWithMap()` wraps `scoreToAbcWithMap`; every score mutation re-derives `{abc, map}`. |
| `src/components/editor/useNoteClickHandler.ts` | abcjs `clickListener` consumer: reads `abcElem.startChar`, calls `resolveClickPosition`, refines chord `pitchIdx` via click-Y nearest-notehead. |
| `src/components/editor/eventAtX.ts` | Consumes the map via `data-startchar` SVG attributes for X-band hit-testing (implicit chord-merge, insert-slot). |

## Core concepts / data flow

### The SourceMap

`scoreToAbcWithMap` returns `{ abc, map }` where `map: SourceMap`:

```ts
type NoteRange  = { staffIdx, voiceIdx, measureIdx, eventIdx, pitchIdx, startChar, endChar }
type EventRange = { staffIdx, voiceIdx, measureIdx, eventIdx, startChar, endChar, pitchRanges: NoteRange[] }
type SourceMap  = { events: EventRange[]; byEvent: Map<string, EventRange> }
//                                        key = `${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}`
```

`events[]` is emitted in **globally char-ascending** order in both layout forms
(see below), which is the invariant `resolveClickPosition` depends on — it
binary-searches `events` on `startChar`/`endChar`, then scans the matched
event's `pitchRanges` to pin the exact notehead.

### Pipeline

```
Score (zod) ─► scoreToAbcWithMap
   ├─ 1. headers: X:1, T:, M:, L:1/8, [Q:1/4=bpm], [C:composer],
   │       [%%footer copyright], %%annotationfont, buildEngravingDefaultsHeaders(),
   │       then K:key[/clef]  OR  %%score + V:N clef= block (planVoices)
   ├─ 2. build-once lookup maps (per call):
   │       indexEventIdsForRender (eventId → location, O(1) span resolution)
   │       buildTechniqueAnnotationMap / buildAnnotationMap / buildMarkerInsertsByMeasure
   │       buildHairpinDecorationMap / buildSlurParenMap / buildTempoSpanAnnotationMap
   │       buildVoltaOpenersByMeasure / buildJumpMarkerDecorationMap
   │       buildOctaveSpanAnnotationMap / buildGlissandoDecorationMap
   │       buildTrillLineDecorationMap / buildTremoloBetweenAnnotationMap
   └─ 3. emitVoiceBody(measures) per voice
            └─ emitMeasureWithRanges  (tuplet grouping `(N`, threads pendingPrefix,
                                       assembles each event's annotation+decoration prefix)
                 └─ emitEventWithRange (decoration prefix chain, pitches/chords + ties,
                                        duration, slur closes; records EventRange)
            barlines / volta-openers / marker inserts injected BETWEEN measures; `\n` every 4 bars
            lyric `w:` lines appended AFTER the body
                                            │
abc + editMap stored in chat state ─────────┘
   └─ ScoreStage/ScorePanel ─► renderScore ─► abcjs.renderAbc(add_classes, clickListener)
            └─ SVG note <g> carries startChar; useScoreReveal animates the reveal
   click ─► abcElem.startChar (or [data-startchar]) ─► resolveClickPosition ─► selection
   edit ──► renderWithMap re-derives abc+map ─► re-render
```

### Decoration prefix chain (load-bearing order)

`emitEventWithRange` concatenates a strict-ordered prefix before each pitch
token. The order matters for both abcjs parse correctness and the visual column
stack, and its **length is counted into the event's `startChar`** so click
resolution still lands on the notehead:

```
prependedDecorations (inherited breath/caesura from prior event)
  + chordSymbol
  + lvAnnotation ("^l.v.")
  + techniqueAnnotation
  + tremolo (!//!)
  + dynamic
  + fermata (!fermata!)
  + ornament
  + fingerings
  + bowing (!upbow!/!downbow!)
  + articulations
  + structured grace prefix
  + slurOpens   ← closest to the pitch (abcjs "open-slur within core-note")
─────────────
  pitch/chord token(s)  +  duration  +  outer tie (-)  +  slurCloses
```

The per-measure prefix assembled in `emitMeasureWithRanges` (annotation +
tempo-span + octave-span + tremolo-between + jump-marker + technique +
trill-line + glissando + hairpin) is passed in as `techniqueAnnotation` /
`annotation`; hairpin glyphs come **last** in that group so they sit closest to
the pitch in the visual column.

### Native vs annotation-fallback rendering

| Feature | Emission |
| --- | --- |
| Hairpins | native `!<(!`…`!<)!` (cresc) / `!>(!`…`!>)!` (dim) |
| Slurs | native `(` … `)` |
| Glissando | native `!glissando(!` |
| Trill-line | native `!trill(!` |
| Jump / Segno / Coda / Fine | native `!D.C.!` / `!segno!` / `!coda!` / `!fine!` |
| Octave span (8va/8vb) | `"^…"` italic text annotation (no abcjs vocabulary) |
| Tremolo-between (`trem.`) | `"^…"` text annotation |
| To Coda / metric modulation / tempo-span labels | `"^…"` text annotation |

Dashed continuation lines for the text-annotation fallbacks are deferred to a
future SVG post-pass.

### Two-pass span emission

Hairpins / slurs / tempo / gliss / trill builders emit **closes before opens**,
so an event that both ends one span and starts another renders close-before-open
(e.g. `)(` for slurs, `crescendo)` before `crescendo(`) — stable regardless of
`score.spans` array order.

### Primary-voice-only vs per-voice routing

Score-level **annotations, markers, voltas, and jump/segno/coda markers** emit
ONLY on staff 0 / voice 0 (other voices receive shared `EMPTY_*` maps) because
abcjs aligns them across the system; emitting per-voice would stack duplicates.
**Spans** (hairpin / slur / tempo / the M20 families) route per-voice via their
`staff:voice` key prefix.

### Two ABC layout forms (`planVoices`)

| Form | Trigger | Shape |
| --- | --- | --- |
| Compact legacy | exactly 1 voice on 1 staff | headers + body, **no** `%%score` |
| Multi-voice | grand-staff / SATB (`voices.length > 1`) | `%%score (groups)` + one `V:N clef=…` block per voice |

Char offsets stay globally ascending in both forms, so the binary search works
unchanged.

### Staggered reveal animation

`useScoreReveal(containerRef, { trigger })` animates `opacity` + `translateY` +
ink-color over `.abcjs-note` / `.abcjs-rest` / `.abcjs-bar`. Per-element stagger
is clamped so total ≤ `TOTAL_REVEAL_BUDGET_MS` (3200 ms); bars lead notes by
30 ms. The **caller (ScorePanel) must set `opacity: 0` synchronously** inside the
`renderScore().then` callback before bumping `trigger`. `reduceMotion` collapses
to a single 220 ms crossfade; the debug-store kill switch
(`revealAnimationEnabled === false`) skips animation entirely and clears any
leftover inline opacity.

## Invariants & gotchas

- **Octave range is hard-limited to 2..6.** `pitchToAbc` throws
  `ValidationError('Octave N out of supported range (2..6)', 'schema_error')` for
  anything outside, aborting the whole transpile rather than rendering a partial
  score.
- **breath/caesura semantics are off-by-one.** These fields are stored on the
  PREVIOUS event ("after this note") but ABC parses them as a PREFIX on the
  FOLLOWING note. `emitMeasureWithRanges` / `emitVoiceBody` thread a
  `pendingPrefix` (seeded from `trailingPrefixFromEvent`) to carry them forward,
  so the glyph chars land in event N's range though the data lives on N-1 — **UI
  click handlers must subtract one**. A trailing breath/caesura on the very last
  event is silently dropped (no valid ABC slot after the final barline).
- **Tremolo MUST be wrapped `!//!`.** Bare slashes after a note are parsed by
  abcjs's `getFraction` as DURATION divisors (`C2//` = 64th, not quarter +
  tremolo), silently corrupting both glyph and duration. The schema allows 5
  slashes; `tremoloToAbc` clamps to `Math.min(slashes, 4)` (abcjs caps at 4).
- **Annotation/lyric/tempo/chord escaping STRIPS backslashes** (it does not
  double them). `escapeAnnotationText` does `.replace(/\\/g, '')` then escapes
  `"` → `\"` and collapses `\r\n\t` runs to a single space, because abcjs's
  tokenizer `translateString` consumes `\X` for glyph lookups (`\b` → flat) and
  has no `\\` decode — a literal backslash would swallow the closing quote.
- **Inter-measure emit ORDER is load-bearing:** `endBarline → nextStartBarline →
  voltaOpener → \n`. A prior bug put `\n` before the volta opener, so abcjs saw
  a digit at column 0 and dropped voltas at bars 4/8/12 ("Unknown character
  ignored"). Volta digits must immediately follow a bar token on the same line.
- **`repeat-both` emits `::`** (the 2-char `bar_dbl_repeat`), NOT the
  natural-looking `:|:` which abcjs would mis-tokenize. `dashed` has no abcjs
  token and renders as a thin `|` (round-trips through JSON, visual lost).
- **Several features are persist-only / lossy through ABC:** all fermata
  duration variants render `!fermata!`; measured vs unmeasured tremolo identical;
  arpeggio direction & non-arpeggio bracket dropped; lyric syllables under rests
  force `*`. The Score JSON stays source of truth for downstream tools (MusicXML).
- **Metric modulation can't use `Q:`.** abcjs's tempo parser can't read `=3/8`
  ratios (drops the tempo). It renders as a `"^♩=♩."` annotation instead, while a
  sibling `tempo_bpm` `Q:` directive handles playback.
- **`render.ts` and `synth.ts` are different render entry points.** The editor's
  clickable on-screen render is `synth.ts:renderScore` (`add_classes: true` +
  `clickListener`); `render.ts:renderAbc` is a barebones wrapper without classes
  or clicks. Don't conflate them.
- **Zoom is reflow-based (`staffwidth`), never abcjs `scale`.** abcjs forces
  `scale` to `undefined` whenever `responsive === 'resize'`
  (engraver-controller.js:214), so a `scale`-based zoom only takes effect by
  dropping `responsive` — which renders the SVG at a fixed pixel width that
  overflows and scrolls horizontally (the old zoom's bug). `renderScore`
  therefore keeps `responsive: 'resize'` ALWAYS (there is no `scale` option) and
  the editor zooms by varying `staffwidth` via
  `staffwidthForZoom(zoom) = round(740/zoom)` (`lib/editor/prefsStore`, where 740
  is abcjs's native `staffwidthScreen`). A narrower staffwidth reflows to fewer
  measures per line, then the responsive scale-to-fit magnifies them — so zoom-in
  grows the score *downward* with zero horizontal overflow. The +/- buttons and
  Ctrl/⌘-wheel + trackpad-pinch (`useScoreWheelZoom`) both step the same
  `ZOOM_LEVELS` ladder.
- **Uniform measure widths via `expandToWidest` (default-on).** abcjs justifies
  each system independently to `staffwidth`, but a dense system (e.g. a bar of
  16ths) can't compress below its natural minimum width while a sparse system (a
  bar of quarters) justifies down to `staffwidth` — so systems render ragged
  (different per-measure widths, mismatched right margins). `renderScore` defaults
  `expandToWidest: true`, which re-lays every system to the widest system's width
  (`abcjs/src/write/layout/layout.js:26-30`), giving uniform measure widths and an
  aligned right margin; `responsive: 'resize'` then scales the widened layout to
  fit. `pdf.ts` passes it too so exports match the screen. Pass
  `expandToWidest: false` to restore per-system justification. (`timeBasedLayout`
  was rejected: it equalizes *within* a system but diverges 5× *across* systems
  because its `durationUnit` is per-line.)
- **Data-integrity issues never throw in the renderer.** Span/marker resolution
  silently skips unresolvable endpoint ids and out-of-range measure/event
  indices; `validateCrossRefs` upstream is the intended error site. The renderer
  throws only on structural impossibilities: rest-in-chord (`rest_in_chord`),
  incomplete tuplet (`tuplet_incomplete`), out-of-range octave (`schema_error`).
- **`EMPTY_*` shared maps are reused by reference** for non-primary voices to
  avoid per-voice allocation (`EMPTY_ANNOTATION_MAP`, `EMPTY_MARKER_MAP`,
  `EMPTY_VOLTA_OPENERS`, `EMPTY_JUMP_MARKER_MAP`, `EMPTY_SLUR_PARENS`).
  `EMPTY_SLUR_PARENS` is `Object.freeze`'d so accidental mutation throws.

## How to extend / common tasks

- **Add a new Score feature → ABC glyph.** Write a small `xToAbc` helper, then
  splice it into the prefix chain in `emitEventWithRange` at the correct column
  position (order is load-bearing). If it has no abcjs native token, fall back to
  a `"^…"` / `"_…"` text annotation routed through `escapeAnnotationText`. Add a
  case to the relevant exhaustiveness `switch` if one exists (`barlineToAbc` has
  a `never` check that fails the build on unhandled enum values).
- **Add a span family.** Mirror the M20 pattern: a `buildXMap(score)` builder
  keyed by `staff:voice:measure:event`, a `xAt(...)` lookup, and a slot in the
  per-measure annotation assembly in `emitMeasureWithRanges`. Decide native vs
  annotation fallback and whether it's primary-voice-only or per-voice. Use
  `indexEventIdsForRender` for O(spans+events) endpoint resolution; never resolve
  endpoints by linear scan.
- **Add an EngravingDefaults directive.** Add a case to
  `buildEngravingDefaultsHeaders` returning a `%%…` line. Check the deferred-field
  list in that function's docblock before assuming a field is unwired.
- **Tune the reveal animation.** Edit the constants at the top of
  `useScoreReveal.ts` (`TOTAL_REVEAL_BUDGET_MS`, `BASE_STAGGER_MS`,
  `NOTE_DURATION_MS`, `BAR_DURATION_MS`). The selector is `TARGET_SELECTOR`.
- **Touch the SourceMap shape.** Any change to char-offset accounting in
  `emitEventWithRange` (e.g. a new prefix token) must keep `startChar`/`endChar`
  and `pitchRanges` exact, or click resolution drifts off the notehead. The
  per-pitch chord cursor starts at `decorations.length + 1` (past the `[`).

## Testing

Core and per-feature coverage lives under `tests/unit/music/`:

- `scoreToAbcWithMap.test.ts` (core), `scoreToAbc.test.ts`,
  `scoreToAbc.property.test.ts`
- Feature suites: `…hairpins`, `…slurs`, `…perPitchTies`, `…lyrics`,
  `…barlines`, `…voltas`, `…jumpMarkers`, `…tempoSpans`, `…m20Spans`,
  `…engravingDefaults`
- Reveal hook: `tests/unit/useScoreReveal.test.ts`
- SourceMap consumers: `tests/unit/components/editor/eventAtX.test.ts`,
  `tests/unit/components/editor/clickInsertSlot.test.ts`

When changing emit order or adding a prefix token, run the feature suite for the
touched family **and** `scoreToAbcWithMap.test.ts` (it pins char-range offsets).

## Related files / See also

- `src/lib/music/types.ts` — the `Score` Zod schema this transpiles.
- `src/lib/music/spans.ts` — `isHairpin` / `isSlur` / `isOctaveSpan` / etc. span
  type guards used by the builders.
- `src/lib/music/scoreAccessors.ts` — `getStaffClef` / `getVoiceMeasures` /
  `getStaffCount` / `getVoiceCount` used by `planVoices` and the emit walk.
- `src/lib/music/pitchTies.ts:isPitchTiedToNext`, `src/lib/music/lyrics.ts`,
  `src/lib/music/articulations.ts`, `src/lib/music/dynamics.ts:getDynamicBase` —
  per-feature helpers.
- `src/components/editor/staffGeometry.ts` / `staffResolver.ts` — click-Y →
  staff pitch geometry used by `useNoteClickHandler` to refine chord `pitchIdx`.
- `src/lib/orchestrator/README.md` — upstream producer of the Score this renders.
