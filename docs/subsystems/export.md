---
title: Export — MusicXML, MIDI, PDF
subsystem: export
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/music/export/musicxml.ts
  - src/lib/abc/midi.ts
  - src/lib/abc/pdf.ts
  - src/components/ExportBar.tsx
  - src/components/ExportBar.module.css
related:
  - score-model
  - abc-roundtrip
  - import
  - engraving-defaults
---

## Purpose

This subsystem serializes a `Score` out of sheet-llm in three formats. **MusicXML** is built directly from the `Score` Zod model (`src/lib/music/export/musicxml.ts:scoreToMusicXml`) and is the only full-fidelity path — it walks every schema field. **MIDI** and **PDF** are both derived from the already-rendered **ABC string** (`src/lib/abc/midi.ts`, `src/lib/abc/pdf.ts`): whatever the ABC encodes is the ceiling for their fidelity. All three are wired into the UI by `src/components/ExportBar.tsx`, which receives both the `abc` string and an optional parsed `score`.

## Entry points

| Entry | What it does |
| --- | --- |
| `src/components/ExportBar.tsx:ExportBar` | Client component (`'use client'`); three download buttons + busy/error state. |
| `scoreToMusicXml(score)` (`src/lib/music/export/musicxml.ts:198`) | Pure `Score` → MusicXML 4.0 string serializer. No abcjs, no DOM. |
| `downloadMusicXml(score, filename?)` (`musicxml.ts:2821`) | Browser download wrapper around `scoreToMusicXml`. |
| `downloadMidi(abc, filename?)` (`src/lib/abc/midi.ts:39`) | Browser MIDI download (input is **ABC**, not `Score`). |
| `downloadPdf(abc, filename?, opts?)` (`src/lib/abc/pdf.ts:65`) | Browser vector-PDF download (input is **ABC**). |

## Key files

| Path | Role |
| --- | --- |
| `src/lib/music/export/musicxml.ts` | MusicXML 4.0 `score-partwise` emitter (~2835 lines). Pure `Score`-to-string serializer plus a browser download wrapper. Covers every `SpanKind`, tuplets, grace notes, lyrics, fingerings, voltas, repeats, jumps, segno/coda, metric modulation, multi-voice/multi-staff, dynamics, articulations, chord symbols, and an `EngravingDefaults` `<defaults>` projection. |
| `src/lib/abc/midi.ts` | MIDI export (53 lines). Lazily imports abcjs, calls `abcjs.synth.getMidiFile(abc, {midiOutputType:'binary', chordsOff:true})`, takes `result[0]`. `chordsOff` suppresses abcjs's auto-generated bass+chord accompaniment so the MIDI matches the notation. |
| `src/lib/abc/pdf.ts` | PDF export (79 lines). Renders ABC to a hidden off-screen SVG via `abcjs.renderAbc` (with `expandToWidest:true` so measure widths match the on-screen score), then vector-converts that SVG to PDF with `jsPDF` + `svg2pdf.js`. |
| `src/components/ExportBar.tsx` | Client React component with MIDI/PDF/MusicXML buttons. Per-button busy state + error `<span role="alert">`. MusicXML button renders only when `score` is present. |
| `src/components/ExportBar.module.css` | CSS module (`bar` / `button` / `error` classes). |

## Public API

| Symbol | Signature | Source |
| --- | --- | --- |
| `scoreToMusicXml` | `(score: Score) => string` | `musicxml.ts:198` |
| `downloadMusicXml` | `(score: Score, filename = 'score.musicxml') => void` | `musicxml.ts:2821` |
| `getMidiBytes` | `(abc: string) => Promise<Uint8Array>` | `midi.ts:15` |
| `downloadMidi` | `(abc: string, filename = 'score.mid') => Promise<void>` | `midi.ts:39` |
| `generatePdf` | `(abc: string, opts?: {title?, staffwidth?}) => Promise<Uint8Array>` | `pdf.ts:22` |
| `downloadPdf` | `(abc: string, filename = 'score.pdf', opts?) => Promise<void>` | `pdf.ts:65` |
| `ExportBar` (default) | React component `{abc, title?, score?}` | `ExportBar.tsx:26` |

`scoreToMusicXml`, `downloadMusicXml`, `getMidiBytes`, `generatePdf` are the exported surface; everything else inside `musicxml.ts` is module-private.

## Core concepts / data flow

### Two export lineages

```
                      ┌──────────────────────────────────────────┐
   Score (Zod model) ─┤  scoreToMusicXml(score)   FULL FIDELITY   ├─→ MusicXML 4.0 string
                      └──────────────────────────────────────────┘
                                  (direct walk, no abcjs)

   Score ─→ Score→ABC ─→ ABC string ─┬─ getMidiFile(abc)  ──→ MIDI bytes   } fidelity capped
                                      └─ renderAbc → SVG → PDF ──→ PDF bytes  } by what ABC encodes
```

`ExportBar` always passes `abc`; it passes `score` only when the parsed model is in hand. The MusicXML button is hidden when `score` is `undefined` (`ExportBar.tsx:78`) — MusicXML needs the model, MIDI/PDF need only the ABC.

### MusicXML document shape

`scoreToMusicXml` emits a string-array-joined `<score-partwise version="4.0">` with the Recordare 4.0 partwise DTD `DOCTYPE` (`musicxml.ts:208`). Header order is fixed by the partwise content model: `<work>` (the piece title goes in `<work-title>`) → `<identification>` (composer/arranger/lyricist/copyright) → `<defaults>` (EngravingDefaults projection, see below) → `<part-list>`. There is a single `<part id="P1">` whose `<part-name>` is the literal `Music` — the title is deliberately NOT piped here (`musicxml.ts:244`), so MuseScore's instruments panel doesn't show the piece name as a fake instrument. MIME is `application/vnd.recordare.musicxml+xml` (`musicxml.ts:2814`); uncompressed only (no `.mxl` zip).

### Precompute pass

Before the measure loop, `scoreToMusicXml` computes (all module-private):

| Helper | Produces |
| --- | --- |
| `buildVoicePlan(score)` (`musicxml.ts:833`) | Ordered `(staffIdx, voiceIdx, mxlVoice)` entries: primary + `extraVoices` on staff 0, then `secondStaff` primary + its `extraVoices`. |
| `groupMarkersByMeasure(score.markers)` (`musicxml.ts:583`) | `Map<measureIdx, Marker[]>` for mid-piece key/meter/clef/tempo/metric-modulation. |
| `buildSpanMarkers(score)` (`musicxml.ts:1599`) | `Map<eventId, SpanMarker[]>` resolving each `Span`'s endpoints to start/stop entries with a `number=`. |
| `buildRepeatStructure(score)` (`musicxml.ts:1881`) | Pre-bucketed voltas, jump markers, segno/coda, plus `forwardRepeatBeforeMeasure` / `backwardRepeatAfterMeasure` boolean arrays. |
| `computeDivisionsMultiplier(score)` (`musicxml.ts:2528`) | LCM-based divisions scale for tuplets (1 when none). |

### Adaptive divisions for tuplets

`DIVISIONS_BASE = 8` (`musicxml.ts:2461`) covers every plain `Duration` as an integer (`DURATION_DIVISIONS`: `32nd`→1 … `whole`→32, dotted forms 6/12/24). `computeDivisionsMultiplier` scans every voice/staff and multiplies divisions by the LCM of present tuplet factors: triplet (3) or sextuplet (6) → factor 3, quintuplet (5) → 5, septuplet (7) → 7. So a 3+5 mix gives 15, a 3+5+7 mix gives 105. The multiplier is **1** when no tuplets are present, which preserves the historical `divisions=8` emit shape (and keeps golden-file tests stable). For a tuplet event, `<duration>` is the tuplet-adjusted value `(base * normal) / actual` (`tupletAdjustedDivisions`, `musicxml.ts:2492`), which is always integer given the multiplier. `tupletNormalCount` (`musicxml.ts:2503`): triplet is 3-in-2; quintuplet/sextuplet/septuplet are all in-4 (MuseScore/Sibelius default).

### Voice plan + `<backup>` rewind

`mxlVoice` is `1..4` **per staff** (MuseScore convention), disambiguated by `<staff>1|2</staff>` — staff 2's primary voice is also `<voice>1</voice>`. Within a measure the loop emits each plan voice's event stream in order; between adjacent *emitting* voices it pushes a `<backup>` whose `<duration>` equals the previous voice's total divisions (`prevEmittedDivisions`, `musicxml.ts:352`), resetting the time cursor to beat 1. The same `<backup>` separates staff 1 from staff 2.

### Per-event emission and the notations content model

`emitEvent` (`musicxml.ts:917`) emits, in order: grace notes (separate `<note>` blocks, no `<duration>`) → the chord-anchor note (with notations/dynamics/harmony/lyrics) → chord-tail notes (each carrying `<chord/>`). `emitNotations` (`musicxml.ts:1157`) enforces the strict MusicXML 4.0 `<notations>` child order, because misordering silently drops content in some readers:

```
tied → slur → tuplet → glissando → ornaments(trill-mark/wavy-line, tremolo)
     → technical(fingering) → articulations(+breath-mark/caesura) → fermata
```

The note-element order is likewise enforced: `pitch|rest < tie < duration < voice < type/dot < accidental < time-modification < staff < notations < lyric`.

### Chord-anchor vs per-pitch attachment

A chord stack emits one `<note>` per pitch; pitches after the first carry `<chord/>`. Two attachment rules:

- **Anchor-only (i === 0):** articulations, fermata, breath-mark, caesura, slurs, ornament spans, lyrics, tuplet brackets.
- **Per-pitch:** ties and fingerings — different fingers on different chord tones, and per-pitch tie matching, are the whole point.

### Spans: three emit shapes

`buildSpanMarkers` keys each resolved `Span` by start/stop event id. `number=` cycles `1..6` per `(staffIdx:voiceIdx:family)`, where `familyOf` (`musicxml.ts:1611`) folds `8va`/`8vb`/`15ma`/`15mb` into one `octave` pool, hairpins into `wedge`, accel/rit into `dashes`, etc. Dispatch by kind:

| Kind | Emit |
| --- | --- |
| slur / phrase-slur (`isSlurKind`) | `<slur>` inside `<notations>` |
| hairpin / octave / pedal / accel / rit (`isDirectionSpanKind`) | `<direction>` siblings of `<note>` |
| glissando / trill-line / tremolo-between (`isOrnamentSpanKind`) | ornament-class `<notations>` children |

### Repeat structure + repeat-both spreading

A `repeat-both` barline means "close the prior block AND open the next" at one boundary. `buildRepeatStructure` spreads it into a **backward**-repeat on the prior measure's right edge AND a **forward**-repeat on the next measure's left edge via the boolean arrays (`musicxml.ts:1920`). Without this pass one half of the `:|:` silently drops. `barlineToBarStyle` (`musicxml.ts:1967`) maps the glyph: `final`→`light-heavy`, `double`→`light-light`, `repeat-start`→`heavy-light`, `repeat-both` side-dependent.

### Jump / segno / coda playback semantics

Jump markers (`emitJumpMarkerDirection`, `musicxml.ts:2118`) emit a `<words>` label + `<sound>` with `dacapo`/`dalsegno`/`tocoda`/`fine`. Segno/coda emit `<segno id=>` / `<coda id=>` glyphs with matching `<sound segno= />` / `<sound coda= />`; ids are prefixed (`segno_<id>`, `coda_<id>` via `segnoRefId`/`codaRefId`, `musicxml.ts:2101`) so a D.S. al Coda's `dalsegno=` resolves to the right target. Falls back to the literal `segno`/`coda` when no ref is set.

### EngravingDefaults `<defaults>` projection (M22-PR-J)

`emitDefaults` (`musicxml.ts:2703`) projects only the subset of `EngravingDefaults` with clean MusicXML mappings:

| ED field | MusicXML | Mapping |
| --- | --- | --- |
| `tempoTextFont` | `<word-font font-style font-weight>` | `tempoTextFontToWordFontAttrs` (`musicxml.ts:2739`); `plain-roman` → omitted |
| `lyricFontScale` (50–200%) | `<lyric-font font-size>` | `Math.round((scale/100) * 10)` around a 10pt baseline |
| `slurThickness` / `tieThickness` (0.5–3) | `<appearance><line-width type="slur middle"\|"tie middle">` | `Math.round(value * 10)` tenths |

The whole `<defaults>` block is omitted when nothing projects (an empty `<defaults>` is DTD-illegal). Other ED fields project via per-element paths (e.g. `dynamicsPosition` via `<direction placement>`) or are dropped — readers infer their own styling. See `docs/subsystems/engraving-defaults.md`.

### MIDI / PDF derivation

- **MIDI** (`getMidiBytes`, `midi.ts:15`): `await import('abcjs')`, `synth.getMidiFile(abc, {midiOutputType:'binary', chordsOff:true})` returns `Array<Uint8Array>` (one entry per X-indexed tune); take `[0]`. `chordsOff:true` stops abcjs from baking its auto-generated bass+chord accompaniment (a hidden rhythm track derived from chord symbols) into the MIDI, so the export matches the printed notation. Throws `abcjs failed to produce MIDI bytes` on a non-array / empty result. `downloadMidi` wraps it in a `Blob` (`audio/midi`) and clicks a synthetic `<a download>`.
- **PDF** (`generatePdf`, `pdf.ts:22`): create a hidden `-99999px` `<div>`, `abcjs.renderAbc(div, abc, {staffwidth, expandToWidest:true})`, `querySelector('svg')`, size the `jsPDF` page from the SVG `width`/`height` (+40pt margins), `svg2pdf` the SVG in at `{x:20, y:20}`, `doc.output('arraybuffer')`. `expandToWidest:true` equalizes measure widths across systems so the PDF matches the on-screen score. Vector (not rasterized) is intentional — html2canvas rasterization was rejected so notation stays crisp at any zoom. `staffwidth` defaults to 760.

Both wrap bytes in a `Blob` and click a synthetic `<a download>` with object-URL cleanup in `finally`.

## Invariants & gotchas

- **`scoreToMusicXml` can be called directly, bypassing `validateScore`.** It is defense-in-depth and hard-throws at the boundary on: zero measures (`musicxml.ts:204`, DTD requires `measure+`); a voice whose `measures.length` ≠ primary's (bar-alignment, `musicxml.ts:271`); a mixed rest + pitched-note event (`musicxml.ts:998`); and a marker clef targeting `staffIdx=1` on a single-staff score (`musicxml.ts:649`). One more throw at `musicxml.ts:1753`. These are not normal control flow — `validateScore` normally rejects these upstream.
- **MIDI/PDF fidelity is capped by the ABC string.** They do NOT see Score-only constructs that ABC can't express. Only the MusicXML path is full-fidelity. Do not assume MIDI/PDF reflect every Score field.
- **`midi.ts` takes `result[0]`** from `getMidiFile`'s `Array<Uint8Array>` — one entry per X-indexed tune. The system assumes exactly ONE tune; multi-tune ABC would silently export only the first.
- **All three download functions are browser-only** (touch `document`/`URL`/`Blob`); they cannot run server-side. abcjs is dynamically imported (`await import('abcjs')` with a default-vs-namespace unwrap, `midi.ts:1`, `pdf.ts:4`) to keep it out of the server bundle. `scoreToMusicXml` itself is pure and *can* run server-side; only its `downloadMusicXml` wrapper is browser-only.
- **Tie matching is positional and intra-(staff,voice).** `pitches[i]` → `pitches[i]` in the next event of the SAME voice. `laissez-vibrer` (lv) pitches deliberately do NOT emit a tie glyph. Relies on `validateScore`'s upstream step+octave / enharmonic-tie invariants (`isPitchTiedToNext`).
- **Span `number=` cycles modulo 6** (MusicXML caps at 6). >6 overlapping spans of one family in one voice intentionally collide — treated as vanishingly rare.
- **Intentional drops on MusicXML export** (no clean mapping): organ `thumbDirection` (still round-trips via JSON); polychord chord-symbol bass (`bass.type='chord'`); `'alt'` chord alteration (emitted as a `degree-value=5` alter stub); and the tremolo-between slash count, hard-defaulted to `3` (`musicxml.ts:1253` — the `Span` schema carries no per-span slashes value).
- **Dynamics:** `dynamicsPosition='hidden'` suppresses the whole `<direction>` emit; `'auto-by-staff'`/undefined fall back to `'below'`. `rfp`/`fzp` aren't in MusicXML's dynamics group → emitted as `<other-dynamics>`.
- **Upstream-trusted refinements:** `meterToTime` (`musicxml.ts:2627`) defaults to 4/4 only as a typecheck fallthrough (MeterSchema's `refine` catches malformed values upstream); same-field marker collisions at one measure idx are assumed already rejected (last-writer-wins in the fold).
- **`clefToSignLine` (`musicxml.ts:2637`) only distinguishes bass (F4) vs everything-else (G2/treble).** Alto/tenor/other clef nuances are not mapped to their true sign/line.

## How to extend / common tasks

- **Add a new `SpanKind` emit:** classify it in `isSlurKind` / `isDirectionSpanKind` / `isOrnamentSpanKind` (`musicxml.ts:1549`–`1579`), add a `family` bucket in `familyOf` inside `buildSpanMarkers` (`musicxml.ts:1611`) if it needs an independent `number=` pool, then add the emit in `emitSlur` / `emitSpanDirection` / `emitNotations`. Respect the `<notations>` child order if it's notation-class.
- **Add a new `Duration`:** extend `DURATION_DIVISIONS` (`musicxml.ts:2463`), `DURATION_TYPE`, and `isDottedDuration`. Keep `DIVISIONS_BASE=8` integer-clean or bump it (and re-check golden files).
- **Add a new tuplet factor:** extend the `Tuplet` alias (`musicxml.ts:36`), `tupletNormalCount` (`musicxml.ts:2503`), and `computeDivisionsMultiplier`'s LCM branch (`musicxml.ts:2528`).
- **Project a new EngravingDefaults field:** add a mapper next to `tempoTextFontToWordFontAttrs` / `lyricFontScaleToLyricFontAttrs` / `collectAppearanceLineWidths` and wire it into `emitDefaults` (`musicxml.ts:2703`) — and remember to leave the `<defaults>`-omitted-when-empty guard intact.
- **Change MIDI/PDF behavior:** these are thin abcjs wrappers; richer output generally means richer *ABC*, not changes here. PDF page sizing and margins live in `generatePdf` (`pdf.ts:44`).

## Testing

| Test | Scope |
| --- | --- |
| `tests/unit/music/export/musicxml.test.ts` (~5723 lines) | Primary coverage: every `SpanKind`, tuplets, graces, lyrics, fingerings, voltas, repeats, jumps, metric modulation, multi-voice/multi-staff, `<defaults>`, and the boundary throws. |
| `tests/unit/abc/midi.test.ts` | MIDI wrapper (mocks `abcjs.synth.getMidiFile`). |
| `tests/unit/abc/pdf.test.ts` | PDF wrapper. |
| `tests/unit/components/ExportBar.test.tsx` | Button rendering, busy state, error `role="alert"`, MusicXML-button-hidden-without-score. |
| `tests/unit/music/import/midiToScore.test.ts` | MIDI round-trip / import side (see `import` subsystem). |

## Related files / See also

- `src/lib/music/types.ts` — the `Score` Zod model the MusicXML emit walks.
- `src/lib/music/scoreAccessors.ts` — `findEventLocationById` (span endpoint resolution).
- `src/lib/music/pitchTies.ts` — `isPitchTiedToNext` (tie matching).
- `src/lib/music/articulations.ts`, `src/lib/music/dynamics.ts` — articulation/dynamic lookups.
- `docs/subsystems/engraving-defaults.md`, `docs/subsystems/abc-roundtrip.md`, `docs/subsystems/import.md`.
