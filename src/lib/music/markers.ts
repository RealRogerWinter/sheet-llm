import { nanoid } from 'nanoid'
import type { Marker, MetricModulation } from './types'

const ID_LENGTH = 10

/** Fresh ID for a new mid-piece marker. */
export function createMarkerId(): string {
  return nanoid(ID_LENGTH)
}

export interface CreateMarkerInput {
  measureIdx: number
  key?: Marker['key']
  meter?: Marker['meter']
  tempo_bpm?: number
  tempo_text?: string
  clefs?: Marker['clefs']
  metricModulation?: MetricModulation
}

/**
 * Construct a new Marker with a fresh id. Optional fields are only
 * included when defined so the persisted JSON stays minimal — avoids
 * explicit-undefined keys that surprise callers reading Object.keys.
 *
 * At least one of key / meter / tempo_bpm / tempo_text / clefs /
 * metricModulation must be defined — the MarkerSchema refine catches
 * the empty case at validation time.
 */
export function createMarker(input: CreateMarkerInput): Marker {
  return {
    id: createMarkerId(),
    measureIdx: input.measureIdx,
    ...(input.key !== undefined ? { key: input.key } : {}),
    ...(input.meter !== undefined ? { meter: input.meter } : {}),
    ...(input.tempo_bpm !== undefined ? { tempo_bpm: input.tempo_bpm } : {}),
    ...(input.tempo_text !== undefined ? { tempo_text: input.tempo_text } : {}),
    ...(input.clefs !== undefined ? { clefs: input.clefs } : {}),
    ...(input.metricModulation !== undefined
      ? { metricModulation: input.metricModulation }
      : {}),
  }
}

/**
 * Backfill ids on any markers the LLM emitted without one. Same
 * pattern as ensureTechniqueIds (M3-PR-1) and ensureAnnotationIds
 * (M8-PR-1) — the render_score tool exposes markers and the model
 * can omit `id` for convenience; this mints stable ids so downstream
 * removeMarker / updateMarker ops have something to address.
 *
 * Mutates in place AND returns the input reference. Generic over T
 * so it can be called on a parsed-JSON `unknown` before the Zod
 * pass — defensive type-narrowing lets it no-op safely on non-Score
 * inputs.
 */
export function ensureMarkerIds<T>(input: T): T {
  if (!input || typeof input !== 'object') return input
  const score = input as Record<string, unknown>
  const markers = score.markers
  if (!Array.isArray(markers)) return input
  for (const m of markers) {
    if (!m || typeof m !== 'object') continue
    const marker = m as Record<string, unknown>
    if (
      typeof marker.id === 'string' &&
      marker.id.length >= 8 &&
      marker.id.length <= 16
    ) {
      continue
    }
    marker.id = createMarkerId()
  }
  return input
}
