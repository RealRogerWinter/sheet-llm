---
title: Export (MusicXML / MIDI / PDF) — context card
subsystem: export
audience: [ai-agent, contributor]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/music/export/musicxml.ts
  - src/lib/abc/midi.ts
  - src/lib/abc/pdf.ts
  - src/components/ExportBar.tsx
related:
  - score-model
  - abc-roundtrip
  - import
  - engraving-defaults
---

Purpose: export a `Score` as MusicXML 4.0 (full-fidelity, built directly from the Score model) or MIDI/PDF (both derived from the rendered ABC string via abcjs).

Files:
- `src/lib/music/export/musicxml.ts` — ~2835-line pure `Score`→MusicXML 4.0 `score-partwise` emitter + browser download wrapper. No abcjs, no DOM (except the wrapper).
- `src/lib/abc/midi.ts` — MIDI from ABC: `getMidiFile(abc,{midiOutputType:'binary',chordsOff:true})[0]` (`chordsOff` drops abcjs's auto bass+chord accompaniment so MIDI matches notation).
- `src/lib/abc/pdf.ts` — vector PDF: `abcjs.renderAbc(...,{staffwidth,expandToWidest:true})`→hidden SVG→`jsPDF`+`svg2pdf.js` (`expandToWidest` matches on-screen measure widths).
- `src/components/ExportBar.tsx` — `'use client'`, 3 buttons; MusicXML button hidden unless `score` prop present.
- `src/components/ExportBar.module.css` — bar/button/error classes.
- `tests/unit/music/export/musicxml.test.ts` (~5723 lines, primary coverage); `tests/unit/abc/{midi,pdf}.test.ts`; `tests/unit/components/ExportBar.test.tsx`.

Key exports:
- `scoreToMusicXml(score: Score): string` (`musicxml.ts:198`) — pure, server-safe.
- `downloadMusicXml(score, filename='score.musicxml'): void` (`musicxml.ts:2821`).
- `getMidiBytes(abc): Promise<Uint8Array>` (`midi.ts:15`); `downloadMidi(abc, filename='score.mid')` (`midi.ts:39`).
- `generatePdf(abc, opts?): Promise<Uint8Array>` (`pdf.ts:22`); `downloadPdf(abc, filename='score.pdf', opts?)` (`pdf.ts:65`).
- `ExportBar` default — `{abc, title?, score?}` (`ExportBar.tsx:26`).
- Internal: `buildVoicePlan` / `buildSpanMarkers` / `buildRepeatStructure` / `computeDivisionsMultiplier` / `emitNotations` / `emitDefaults`.

Env flags: none.

Gotchas:
- MIDI/PDF fidelity is capped by the ABC string — they do NOT see Score-only constructs. Only MusicXML is full-fidelity.
- `scoreToMusicXml` bypasses `validateScore` and HARD-THROWS at the boundary on: 0 measures, bar-misaligned voice, mixed rest+pitch event, marker clef on `staffIdx=1` of a single-staff score (throws at `musicxml.ts:204,271,649,998,1753`).
- All download fns are browser-only (touch `document`/`Blob`/`URL`); abcjs is `await import()`'d to stay out of the server bundle. `scoreToMusicXml` itself is pure/server-safe.
- MIDI takes `result[0]` — assumes exactly ONE tune; multi-tune ABC silently exports only the first.
- Span `number=` cycles mod 6 (MusicXML cap); >6 overlapping same-family spans collide intentionally.
- Divisions: `DIVISIONS_BASE=8` × LCM of tuplet factors (3/6→3, 5→5, 7→7); multiplier=1 when no tuplets (keeps historical `divisions=8` shape).
- `<notations>` child order is strict (tied→slur→tuplet→glissando→ornaments→technical→articulations→fermata) — misorder silently drops content in some readers.
- Anchor-only attach (chord i===0): articulations/fermata/breath/caesura/slurs/ornaments/lyrics/tuplet. Per-pitch: ties + fingerings.
- Intentional drops: organ thumbDirection, polychord bass, `'alt'` chord alt (stub), tremolo-between slash count (hard `3`). lv pitches emit no tie. `dynamicsPosition='hidden'` suppresses the whole `<direction>`. `clefToSignLine` only knows bass-vs-treble.
- `<part-name>` is literal `Music`; title goes in `<work-title>`. Uncompressed `.musicxml` only (no `.mxl`).

Cross-file coupling (when editing X, also update Y):
- New `SpanKind` → classify in `isSlurKind`/`isDirectionSpanKind`/`isOrnamentSpanKind` + `familyOf` (`buildSpanMarkers`) + the matching emitter (`emitSlur`/`emitSpanDirection`/`emitNotations`).
- New `Duration` → `DURATION_DIVISIONS` + `DURATION_TYPE` + `isDottedDuration` (recheck golden files).
- New tuplet → `Tuplet` alias + `tupletNormalCount` + `computeDivisionsMultiplier`.
- New `EngravingDefaults` projection → add mapper + wire into `emitDefaults` (keep the empty-`<defaults>` guard).
- Changing the `Score` schema (`src/lib/music/types.ts`) → re-audit `scoreToMusicXml` field walk + `musicxml.test.ts`.

Related cards: score-model, abc-roundtrip, import, engraving-defaults.
