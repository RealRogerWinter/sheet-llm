import { nanoid } from 'nanoid'
import type {
  Annotation,
  AnnotationStyle,
  CodaMarker,
  Dynamic,
  JumpKind,
  JumpMarker,
  Key,
  Marker,
  Meter,
  Score,
  SegnoMarker,
  Span,
  SpanKind,
  Volta,
} from './types'

const ID_LENGTH = 10

/** Fresh ID for any Phase 1 schema object (span, marker, volta, annotation). */
export function createSpanId(): string {
  return nanoid(ID_LENGTH)
}

/**
 * Span kinds rendered as crescendo/diminuendo wedges. M11 wires only
 * these two through edit-ops, the LLM tool, the renderer, and the
 * editor UI; the remaining SpanKind values (8va, glissando, etc.)
 * are scheduled for later milestones.
 */
export const HAIRPIN_KINDS = ['hairpin-cresc', 'hairpin-dim'] as const
export type HairpinKind = (typeof HAIRPIN_KINDS)[number]

/** Type guard: does this span render as a hairpin wedge? */
export function isHairpin(span: Span): span is Span & { kind: HairpinKind } {
  return span.kind === 'hairpin-cresc' || span.kind === 'hairpin-dim'
}

/**
 * Span kinds rendered as slur curves. M12 wires both through edit-ops,
 * the LLM tool, the renderer, and the editor UI. `slur` is the generic
 * legato curve; `phrase-slur` is the broader/longer "phrase mark" with
 * higher visual prominence. Both use the same abcjs `(...)` syntax;
 * the renderer differentiates via the optional `phrase: true` decorator
 * where abcjs supports it.
 */
export const SLUR_KINDS = ['slur', 'phrase-slur'] as const
export type SlurKind = (typeof SLUR_KINDS)[number]

/** Type guard: does this span render as a slur curve? */
export function isSlur(span: Span): span is Span & { kind: SlurKind } {
  return span.kind === 'slur' || span.kind === 'phrase-slur'
}

/**
 * Span kinds rendered as tempo lines (M14). `accel` is the
 * accelerando "speeding up" line ("accel. ____"); `rit` is the
 * ritardando "slowing down" line ("rit. ____"). Both render as an
 * italic text label at the start event + (optionally) a terminal
 * tempo label at the end (endTempoBpm / endTempoText on the Span).
 *
 * Distinct from Annotation.spanEnd: annotations with spanEnd are
 * GENERIC text spans accepting any string; tempo spans are typed,
 * so the LLM and editor UI can emit them with a single op + the
 * renderer can paint a structured accel/rit symbol when abcjs
 * gains the vocabulary.
 */
export const TEMPO_SPAN_KINDS = ['accel', 'rit'] as const
export type TempoSpanKind = (typeof TEMPO_SPAN_KINDS)[number]

/** Type guard: does this span render as a tempo line? */
export function isTempoSpan(span: Span): span is Span & { kind: TempoSpanKind } {
  return span.kind === 'accel' || span.kind === 'rit'
}

/**
 * Octave-displacement span kinds (M20). `8va` (octave up above the
 * staff) and `8vb` (octave down below the staff) are the everyday
 * cases; `15ma` and `15mb` are two-octave variants used in extreme
 * registers (piccolo, contrabass, glockenspiel). All four emit the
 * same abcjs vocabulary at the moment — abcjs has no native ottava
 * tokens, so M20-PR-2's renderer emits annotation labels at the
 * start event ("^8va" / "^8vb" / "^15ma" / "^15mb") with a dashed
 * continuation line drawn by SVG post-processing in a future PR.
 *
 * Distinct from a transposition: an 8va line is a NOTATIONAL
 * convenience — the player reads notes one octave above what's
 * printed but the underlying pitch data stays at sounding-pitch.
 * The renderer + UI surface the visual delta; transposition is
 * NOT part of the schema (Phase 2 deferral per the plan).
 */
export const OCTAVE_SPAN_KINDS = ['8va', '8vb', '15ma', '15mb'] as const
export type OctaveSpanKind = (typeof OCTAVE_SPAN_KINDS)[number]

/** Type guard: does this span render as an octave-displacement line? */
export function isOctaveSpan(span: Span): span is Span & { kind: OctaveSpanKind } {
  return (
    span.kind === '8va' ||
    span.kind === '8vb' ||
    span.kind === '15ma' ||
    span.kind === '15mb'
  )
}

/**
 * Glissando span (M20). Single-kind family; the `glissStyle` field
 * on SpanSchema picks straight (default) vs wavy ("port." / portamento)
 * visual variants, and `glissText` toggles the "gliss." text label.
 * The renderer (M20-PR-2) emits abcjs's native `!glissando(!` /
 * `!glissando)!` tokens — verified against
 * node_modules/abcjs/src/parse/abc_parse_settings.js lines 89-90.
 */
export const GLISSANDO_KIND = 'glissando' as const
export type GlissandoKind = typeof GLISSANDO_KIND

/** Type guard: does this span render as a glissando line? */
export function isGlissando(span: Span): span is Span & { kind: GlissandoKind } {
  return span.kind === GLISSANDO_KIND
}

/**
 * Trill-line span (M20). Single-kind family extending a `tr` ornament
 * with a wavy continuation line — "tr~~~~~~" in printed notation. The
 * trill ornament itself lives on `Event.ornament: 'trill'` (M2-PR-3);
 * this span is the EXTENSION line that signals "hold the trill across
 * these N notes". The renderer (M20-PR-2) emits abcjs's native
 * `!trill(!` / `!trill)!` tokens — verified against
 * node_modules/abcjs/src/parse/abc_parse_settings.js lines 51-52.
 */
export const TRILL_LINE_KIND = 'trill-line' as const
export type TrillLineKind = typeof TRILL_LINE_KIND

/** Type guard: does this span render as a trill extension line? */
export function isTrillLine(span: Span): span is Span & { kind: TrillLineKind } {
  return span.kind === TRILL_LINE_KIND
}

/**
 * Tremolo-between span (M20). "Fingered tremolo" — fast alternation
 * BETWEEN two notes (as opposed to Event.tremolo which is the
 * single-note repeated-tremolo with N slashes through the stem).
 * The renderer (M20-PR-2) emits a `"^trem."` annotation at the
 * start event since abcjs has no native between-note tremolo
 * vocabulary; the player reads the annotation and the visual
 * paired-beam-and-slashes between the two notes is a future PR.
 */
export const TREMOLO_BETWEEN_KIND = 'tremolo-between' as const
export type TremoloBetweenKind = typeof TREMOLO_BETWEEN_KIND

/** Type guard: does this span render as a tremolo-between line? */
export function isTremoloBetween(
  span: Span,
): span is Span & { kind: TremoloBetweenKind } {
  return span.kind === TREMOLO_BETWEEN_KIND
}

// ───────── Spans ─────────

export function createSpan(
  kind: SpanKind,
  startEventId: string,
  endEventId: string,
  opts?: {
    staffIdx?: number
    voiceIdx?: number
    startDynamic?: Dynamic
    endDynamic?: Dynamic
    placement?: 'above' | 'below' | 'default'
    glissStyle?: 'straight' | 'wavy'
    glissText?: boolean
  },
): Span {
  return {
    id: createSpanId(),
    kind,
    startEventId,
    endEventId,
    staffIdx: opts?.staffIdx ?? 0,
    voiceIdx: opts?.voiceIdx ?? 0,
    ...(opts?.startDynamic ? { startDynamic: opts.startDynamic } : {}),
    ...(opts?.endDynamic ? { endDynamic: opts.endDynamic } : {}),
    ...(opts?.placement ? { placement: opts.placement } : {}),
    ...(opts?.glissStyle ? { glissStyle: opts.glissStyle } : {}),
    ...(opts?.glissText !== undefined ? { glissText: opts.glissText } : {}),
  }
}

/** Returns spans whose start or end is the given event id. */
export function spansTouchingEvent(score: Score, eventId: string): Span[] {
  return (score.spans ?? []).filter(
    (s) => s.startEventId === eventId || s.endEventId === eventId,
  )
}

/**
 * Backfill ids on any spans the LLM emitted without one. Same pattern
 * as ensureTechniqueIds (M3-PR-1), ensureAnnotationIds (M8-PR-1),
 * ensureMarkerIds (M9-PR-1) — the render_score tool exposes spans and
 * the model can omit `id` for convenience; this mints stable ids so
 * downstream removeSpan / updateSpan ops have something to address.
 *
 * Mutates in place AND returns the input reference. Generic over T so
 * it can be called on a parsed-JSON `unknown` before the Zod pass —
 * defensive type-narrowing lets it no-op safely on non-Score inputs.
 */
export function ensureSpanIds<T>(input: T): T {
  if (!input || typeof input !== 'object') return input
  const score = input as Record<string, unknown>
  const spans = score.spans
  if (!Array.isArray(spans)) return input
  for (const s of spans) {
    if (!s || typeof s !== 'object') continue
    const span = s as Record<string, unknown>
    if (
      typeof span.id === 'string' &&
      span.id.length >= 8 &&
      span.id.length <= 16
    ) {
      continue
    }
    span.id = createSpanId()
  }
  return input
}

// ───────── Markers (mid-piece changes) ─────────

/**
 * Returns the key in effect at the start of `measureIdx`. Walks
 * markers in order; the most recent key marker at or before
 * `measureIdx` wins. Falls back to score.key when no marker applies.
 */
export function activeKeyAt(score: Score, measureIdx: number): Key {
  let active: Key = score.key
  if (!score.markers) return active
  // Markers may be unsorted; iterate all and track the latest <= idx.
  // Tie-break with >=: when two markers share a measureIdx, the LAST
  // in array order wins. This matches typical mutation semantics
  // (most-recently-pushed overrides).
  let bestIdx = -1
  for (const m of score.markers) {
    if (m.measureIdx <= measureIdx && m.measureIdx >= bestIdx && m.key) {
      active = m.key
      bestIdx = m.measureIdx
    }
  }
  return active
}

/**
 * Returns the meter in effect at the start of `measureIdx`.
 */
export function activeMeterAt(score: Score, measureIdx: number): Meter {
  let active: Meter = score.meter
  if (!score.markers) return active
  let bestIdx = -1
  for (const m of score.markers) {
    if (m.measureIdx <= measureIdx && m.measureIdx >= bestIdx && m.meter) {
      active = m.meter
      bestIdx = m.measureIdx
    }
  }
  return active
}

/**
 * Returns the tempo (BPM) in effect at the start of `measureIdx`, or
 * undefined if no tempo has been set up to that point.
 */
export function activeTempoAt(score: Score, measureIdx: number): number | undefined {
  let active = score.tempo_bpm
  if (!score.markers) return active
  let bestIdx = -1
  for (const m of score.markers) {
    if (m.measureIdx <= measureIdx && m.measureIdx >= bestIdx && m.tempo_bpm !== undefined) {
      active = m.tempo_bpm
      bestIdx = m.measureIdx
    }
  }
  return active
}

export function createMarker(measureIdx: number, fields: Omit<Marker, 'measureIdx'>): Marker {
  // Spread fields FIRST so a malformed JS-only callsite that includes
  // measureIdx in `fields` cannot silently override the explicit
  // argument.
  return { ...fields, measureIdx }
}

// ───────── Voltas ─────────

export function createVolta(
  startMeasureIdx: number,
  endMeasureIdx: number,
  endings: number[],
  opts?: { endHook?: 'closed' | 'open'; text?: string },
): Volta {
  return {
    id: createSpanId(),
    startMeasureIdx,
    endMeasureIdx,
    endings,
    ...(opts?.endHook ? { endHook: opts.endHook } : {}),
    ...(opts?.text ? { text: opts.text } : {}),
  }
}

/**
 * Backfill ids on any voltas the LLM emitted without one. Same
 * pattern as ensureMarkerIds / ensureAnnotationIds / ensureSpanIds —
 * render_score may expose voltas (M17-PR-3) and the model can omit
 * `id` for convenience; this mints stable ids so downstream
 * removeVolta / updateVolta ops have something to address.
 *
 * Mutates in place AND returns the input reference. Generic over T
 * so it can be called on a parsed-JSON `unknown` before the Zod
 * pass — defensive type-narrowing lets it no-op safely on non-Score
 * inputs.
 */
export function ensureVoltaIds<T>(input: T): T {
  if (!input || typeof input !== 'object') return input
  const score = input as Record<string, unknown>
  const voltas = score.voltas
  if (!Array.isArray(voltas)) return input
  for (const v of voltas) {
    if (!v || typeof v !== 'object') continue
    const volta = v as Record<string, unknown>
    if (
      typeof volta.id === 'string' &&
      volta.id.length >= 8 &&
      volta.id.length <= 16
    ) {
      continue
    }
    volta.id = createSpanId()
  }
  return input
}

/**
 * Returns the volta (or undefined) that contains the given measure
 * for a given playback pass. If a measure is inside multiple voltas
 * with different `endings` arrays, returns the FIRST that includes
 * `passNumber` in its `endings` (caller order matters).
 */
export function voltaForMeasureOnPass(
  score: Score,
  measureIdx: number,
  passNumber: number,
): Volta | undefined {
  if (!score.voltas) return undefined
  for (const v of score.voltas) {
    if (
      measureIdx >= v.startMeasureIdx &&
      measureIdx <= v.endMeasureIdx &&
      v.endings.includes(passNumber)
    ) {
      return v
    }
  }
  return undefined
}

// ───────── Jump markers + Segno + Coda ─────────

/**
 * Jump-marker kinds rendered as repeat instructions (D.C., D.S., Fine,
 * To Coda, *.al Coda, *.al Fine). M18 wires the JumpMarker family
 * through edit-ops, the LLM tool, the renderer, and the editor UI;
 * Segno + Coda landmark markers stay in their own helper surface
 * (createSegno / createCoda) because they have no "kind" axis.
 *
 * Mirrors HAIRPIN_KINDS (M11) / SLUR_KINDS (M12) / TEMPO_SPAN_KINDS
 * (M14) / BARLINE_KINDS (M16) pattern. The strict-union pin test in
 * tests/unit/music/spans.test.ts (M18-PR-1) asserts parity with the
 * Zod JumpKindSchema.options so the runtime const, the type alias,
 * the LLM JSON-schema enum, and the renderer's exhaustive switch
 * stay synchronized.
 */
export const JUMP_KINDS = [
  'D.C.',
  'D.S.',
  'D.C. al Coda',
  'D.S. al Coda',
  'D.C. al Fine',
  'D.S. al Fine',
  'To Coda',
  'Fine',
] as const
export type JumpMarkerKind = (typeof JUMP_KINDS)[number]

export function createSegno(measureIdx: number, side: 'start' | 'end' = 'start'): SegnoMarker {
  return { id: createSpanId(), measureIdx, side }
}

export function createCoda(measureIdx: number, side: 'start' | 'end' = 'start'): CodaMarker {
  return { id: createSpanId(), measureIdx, side }
}

export function createJump(
  kind: JumpKind,
  measureIdx: number,
  side: 'start' | 'end' = 'end',
  refs?: { segnoRef?: string; codaRef?: string; toCodaRef?: string },
): JumpMarker {
  return {
    id: createSpanId(),
    measureIdx,
    side,
    kind,
    ...(refs?.segnoRef ? { segnoRef: refs.segnoRef } : {}),
    ...(refs?.codaRef ? { codaRef: refs.codaRef } : {}),
    ...(refs?.toCodaRef ? { toCodaRef: refs.toCodaRef } : {}),
  }
}

/**
 * Backfill ids on any jumpMarkers the LLM emitted without one. Same
 * pattern as ensureMarkerIds / ensureAnnotationIds / ensureSpanIds /
 * ensureVoltaIds — render_score may expose jumpMarkers (M18-PR-3) and
 * the model can omit `id` for convenience; this mints stable ids so
 * downstream removeJumpMarker / updateJumpMarker ops have something
 * to address.
 *
 * JumpMarkerSchema.id is REQUIRED (same as VoltaSchema.id, unlike
 * SpanIdSchema which is optional), so backfilling here means an
 * LLM-emitted jumpMarker missing an id survives the post-migrate
 * validateScore pass instead of hard-failing.
 *
 * Mutates in place AND returns the input reference. Generic over T
 * so it can be called on a parsed-JSON `unknown` before the Zod
 * pass — defensive type-narrowing lets it no-op safely on non-Score
 * inputs.
 */
export function ensureJumpMarkerIds<T>(input: T): T {
  if (!input || typeof input !== 'object') return input
  const score = input as Record<string, unknown>
  const jumpMarkers = score.jumpMarkers
  if (!Array.isArray(jumpMarkers)) return input
  for (const j of jumpMarkers) {
    if (!j || typeof j !== 'object') continue
    const jump = j as Record<string, unknown>
    if (
      typeof jump.id === 'string' &&
      jump.id.length >= 8 &&
      jump.id.length <= 16
    ) {
      continue
    }
    jump.id = createSpanId()
  }
  return input
}

/**
 * Backfill ids on any segnoMarkers the LLM emitted without one
 * (M18-PR-4). SegnoMarkerSchema.id is REQUIRED; the wire JSON
 * schema also requires it (renderScoreTool.ts) and the prompt
 * instructs the LLM to mint ids. This helper is a defensive
 * safety net for the migrate path: if a buggy or fragile LLM
 * emits a Segno without id, the backfill keeps the post-migrate
 * validateScore from hard-failing. Mirrors ensureJumpMarkerIds.
 */
export function ensureSegnoMarkerIds<T>(input: T): T {
  if (!input || typeof input !== 'object') return input
  const score = input as Record<string, unknown>
  const segnoMarkers = score.segnoMarkers
  if (!Array.isArray(segnoMarkers)) return input
  for (const s of segnoMarkers) {
    if (!s || typeof s !== 'object') continue
    const segno = s as Record<string, unknown>
    if (
      typeof segno.id === 'string' &&
      segno.id.length >= 8 &&
      segno.id.length <= 16
    ) {
      continue
    }
    segno.id = createSpanId()
  }
  return input
}

/** Same defensive backfill for codaMarkers. See ensureSegnoMarkerIds. */
export function ensureCodaMarkerIds<T>(input: T): T {
  if (!input || typeof input !== 'object') return input
  const score = input as Record<string, unknown>
  const codaMarkers = score.codaMarkers
  if (!Array.isArray(codaMarkers)) return input
  for (const c of codaMarkers) {
    if (!c || typeof c !== 'object') continue
    const coda = c as Record<string, unknown>
    if (
      typeof coda.id === 'string' &&
      coda.id.length >= 8 &&
      coda.id.length <= 16
    ) {
      continue
    }
    coda.id = createSpanId()
  }
  return input
}

// ───────── Annotations ─────────

export function createAnnotation(
  measureIdx: number,
  text: string,
  style: AnnotationStyle = 'plain',
  opts?: {
    eventIdx?: number
    position?: 'above' | 'below' | 'left' | 'right'
    spanEnd?: { measureIdx: number; eventIdx?: number }
  },
): Annotation {
  return {
    id: createSpanId(),
    target: {
      measureIdx,
      ...(opts?.eventIdx !== undefined ? { eventIdx: opts.eventIdx } : {}),
      position: opts?.position ?? 'above',
    },
    text,
    style,
    ...(opts?.spanEnd ? { spanEnd: opts.spanEnd } : {}),
  }
}

/** Returns annotations attached to a specific measure. */
export function annotationsForMeasure(score: Score, measureIdx: number): Annotation[] {
  return (score.annotations ?? []).filter((a) => a.target.measureIdx === measureIdx)
}
