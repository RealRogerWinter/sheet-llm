import type { Ornament } from './types'

/**
 * Ornaments that accept a `trillUpperPitch` accidental modifier
 * (Bach-style `tr♯` / `tr♭` / `tr♮`). The accidental is meaningful
 * only on these — attaching one to a mordent, turn, etc. would be
 * an engraving error, so editor UIs hide the picker and auto-clear
 * any stale value when the ornament leaves this family.
 */
export const TRILL_FAMILY_ORNAMENTS: ReadonlyArray<Ornament> = ['trill', 'pralltriller']

export function isTrillFamilyOrnament(o: Ornament | undefined): boolean {
  return o !== undefined && TRILL_FAMILY_ORNAMENTS.includes(o)
}
