import { createEventId } from './eventIds'
import type { Duration, Event, Pitch } from './types'

/**
 * Is this event a rest? Handles both the new explicit `kind: 'rest'`
 * representation and the legacy `pitches: [{step: 'rest', ...}]` hack.
 *
 * `kind` takes precedence when present, so an explicit
 * `{kind: 'note', pitches: [{step: 'rest', ...}]}` would be treated
 * as a note. Such a state is invalid, but a future `validateScore`
 * tightening (PR-12 or earlier) will catch it; this helper is
 * permissive so it can be sprinkled across the codebase without
 * cascading rejections during the rollout.
 */
export function isRest(event: Pick<Event, 'kind' | 'pitches'>): boolean {
  if (event.kind === 'rest') return true
  if (event.kind === 'note') return false
  return event.pitches?.[0]?.step === 'rest'
}

/** Inverse of `isRest`. */
export function isPitched(event: Pick<Event, 'kind' | 'pitches'>): boolean {
  return !isRest(event)
}

/**
 * Mint a fresh rest event with a new stable id. Use this in any new
 * code path that creates a rest so the resulting event is consistent
 * with Phase 1's discriminator + UUID conventions.
 *
 * The pitches array carries the legacy `{step:'rest'}` sentinel for
 * backward compatibility with code that still pattern-matches on it.
 * That sentinel is removed entirely in the PR-12 migration once
 * downstream callsites have migrated to the `kind` discriminator.
 */
export function createRest(duration: Duration): Event {
  return {
    id: createEventId(),
    kind: 'rest',
    pitches: [{ step: 'rest', octave: 4 }],
    duration,
  }
}

/**
 * Mint a fresh pitched event with a new stable id. Validates that
 * the caller did not accidentally pass a rest pitch (step:'rest')
 * — that would silently corrupt the discriminator.
 */
export function createNote(pitches: Pitch[], duration: Duration): Event {
  if (pitches.length === 0) {
    throw new Error('createNote requires at least one pitch; use createRest for rests')
  }
  if (pitches.some((p) => p.step === 'rest')) {
    throw new Error("createNote cannot accept a pitch with step:'rest'; use createRest instead")
  }
  return {
    id: createEventId(),
    kind: 'note',
    pitches,
    duration,
  }
}
