'use client'

import { useChatStore, type ContextTarget } from '@/lib/chat/state'
import type { TargetRegion } from '@/lib/shared/types'

/** True when `id` is an AI-entry verb (`ai:*`). */
export function isAiItem(id: string): boolean {
  return id.startsWith('ai:')
}

function measureOf(target: ContextTarget): number | undefined {
  if (target.kind === 'note' || target.kind === 'rest' || target.kind === 'chordNote') {
    return target.selection.measureIdx
  }
  if (target.kind === 'measure' || target.kind === 'barline') return target.measureIdx
  return undefined
}

/**
 * The deterministic 0-based measure region for the target (D5). A single
 * bar / note → that bar; a measure-range → its bounds. Attached to the AI
 * seed so the dispatcher gets exact indices, not just the prose bar number.
 */
function regionOf(target: ContextTarget): TargetRegion | undefined {
  const mi = measureOf(target)
  if (mi !== undefined) return { startMeasureIdx: mi, endMeasureIdx: mi }
  if (target.kind === 'range') {
    return { startMeasureIdx: target.range.fromStart, endMeasureIdx: target.range.fromEnd }
  }
  return undefined
}

/**
 * Dispatch an AI-entry item (M29). Pre-fills the prompt input
 * (`seedAiInput`) with a 1-based, target-scoped prompt the user completes
 * and sends; the orchestrator's dispatcher parses the bar number
 * server-side (→ `edit_intra_measure` / `region_replace` / `answer_question`).
 *
 * Seed-only (no headless send) so the user always reviews/augments intent
 * before any AI call, and the request flows through the existing pipeline
 * — including the M24 ghost-preview confirm — unchanged.
 */
export function runAiItem(id: string, target: ContextTarget): void {
  const store = useChatStore.getState()
  const mi = measureOf(target)
  const region = regionOf(target)
  if (id === 'ai:edit') {
    if (mi !== undefined) store.seedAiInput(`In measure ${mi + 1}, `, region)
  } else if (id === 'ai:regenerate') {
    if (mi !== undefined) store.seedAiInput(`Rewrite measure ${mi + 1} entirely: `, region)
  } else if (id === 'ai:regenerate-range' && target.kind === 'range') {
    store.seedAiInput(`Rewrite measures ${target.range.fromStart + 1}–${target.range.fromEnd + 1}: `, region)
  } else if (id === 'ai:explain') {
    if (mi !== undefined) store.seedAiInput(`Explain measure ${mi + 1}`, region)
    else if (target.kind === 'range') {
      store.seedAiInput(`Explain measures ${target.range.fromStart + 1}–${target.range.fromEnd + 1}`, region)
    }
  }
}
