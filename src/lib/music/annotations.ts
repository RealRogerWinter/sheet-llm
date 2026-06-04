import { nanoid } from 'nanoid'
import type { Annotation, AnnotationStyle } from './types'

const ID_LENGTH = 10

/** Fresh ID for a new annotation. */
export function createAnnotationId(): string {
  return nanoid(ID_LENGTH)
}

export interface CreateAnnotationInput {
  measureIdx: number
  eventIdx?: number
  position: Annotation['target']['position']
  text: string
  style: AnnotationStyle
  spanEnd?: { measureIdx: number; eventIdx?: number }
}

/**
 * Construct a new Annotation with a fresh id. Optional keys (eventIdx,
 * spanEnd) are only included when defined so the persisted JSON stays
 * minimal — avoids explicit-undefined keys that surprise callers
 * reading Object.keys.
 */
export function createAnnotation(input: CreateAnnotationInput): Annotation {
  return {
    id: createAnnotationId(),
    target: {
      measureIdx: input.measureIdx,
      ...(input.eventIdx !== undefined ? { eventIdx: input.eventIdx } : {}),
      position: input.position,
    },
    text: input.text,
    style: input.style,
    ...(input.spanEnd !== undefined ? { spanEnd: input.spanEnd } : {}),
  }
}

/**
 * Backfill ids on any annotations the LLM emitted without one. Same
 * pattern as ensureTechniqueIds — the render_score tool exposes
 * annotations and the model can omit `id` for convenience; this
 * mints stable ids so downstream remove/update ops have something
 * to address.
 *
 * Mutates in place AND returns the input reference, matching
 * ensureTechniqueIds (callers like migrateScoreV1 invoke this on a
 * cloned `unknown` and rely on the in-place semantic). Generic over
 * T so it can be called on a parsed-JSON `unknown` before the Zod
 * pass — the defensive type-narrowing lets it no-op safely on
 * non-Score inputs.
 */
export function ensureAnnotationIds<T>(input: T): T {
  if (!input || typeof input !== 'object') return input
  const score = input as Record<string, unknown>
  const annotations = score.annotations
  if (!Array.isArray(annotations)) return input
  for (const ann of annotations) {
    if (!ann || typeof ann !== 'object') continue
    const a = ann as Record<string, unknown>
    if (typeof a.id === 'string' && a.id.length >= 8 && a.id.length <= 16) {
      continue
    }
    a.id = createAnnotationId()
  }
  return input
}
