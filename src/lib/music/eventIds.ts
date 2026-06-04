import { nanoid } from 'nanoid'

const ID_LENGTH = 10

/**
 * Generate a fresh event ID for newly created events. 10 chars from
 * nanoid's URL-safe alphabet gives ~60 bits of entropy, sufficient
 * for any single-score collision profile.
 */
export function createEventId(): string {
  return nanoid(ID_LENGTH)
}

/**
 * Derive a stable, deterministic 10-char ID from an event's content
 * and its position in the score. Used to backfill IDs on pre-UUID
 * scores so that re-loading the same stored score yields the same
 * IDs (idempotent migration).
 *
 * Positional context distinguishes two identical events at different
 * positions. Once assigned, the ID travels with the event under
 * reorder / move operations — derivation is migration-time only.
 *
 * Derived IDs typically begin with 'm', a soft visual signal that
 * the ID was migrated rather than created via createEventId. Because
 * nanoid's alphabet includes 'm', ~1.5% of fresh IDs may also start
 * with 'm', so the prefix is NOT a reliable runtime discriminator —
 * do not branch on `id[0] === 'm'`.
 *
 * Entropy: 32-bit FNV-1a hash. Single-score collision probability is
 * negligible (~1 in 8500 for 1000-event scores). For cross-score id
 * spaces in future features (clipboard, library), prefer to mint
 * fresh IDs via createEventId on import.
 *
 * Tolerates malformed events: non-array `pitches`, null pitch entries,
 * and missing fields all produce a deterministic ID without throwing.
 */
export function deriveEventId(
  event: { pitches?: unknown; duration?: string },
  path: { staffIdx: number; voiceIdx: number; measureIdx: number; eventIdx: number },
): string {
  const pitchesArr = Array.isArray(event.pitches) ? event.pitches : []
  const pitchesStr = pitchesArr
    .map((p) => {
      if (!p || typeof p !== 'object') return '?'
      const pitch = p as { step?: string; octave?: number; accidental?: string }
      // Normalize 'none' to '' so explicit `accidental: 'none'` and
      // missing `accidental` produce the same content string. Same
      // musical event → same derived ID, independent of representation.
      const acc = pitch.accidental && pitch.accidental !== 'none' ? pitch.accidental : ''
      return `${pitch.step ?? '?'}${pitch.octave ?? '?'}${acc}`
    })
    .join(',')
  const content = `${pitchesStr}|${event.duration ?? '?'}|${path.staffIdx}.${path.voiceIdx}.${path.measureIdx}.${path.eventIdx}`
  // 32-bit FNV-1a hash — deterministic, no Node crypto dependency.
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const hex = hash.toString(16).padStart(8, '0')
  // 'm' prefix + 8 hex chars + 1 base36 length char = 10 chars total,
  // matching createEventId. The tail adds no entropy — it just pads
  // to the canonical length so all event IDs share a width.
  const tail = (content.length % 36).toString(36)
  return `m${hex}${tail}`
}

/**
 * Walk a Score-shaped input and assign IDs to every Event that lacks
 * one. Existing IDs (length >= 8) are preserved. Mutates the input
 * in place AND returns it for chaining.
 *
 * Tolerates `unknown` so it can be called before zod parsing. Silently
 * skips non-conforming shapes (returns the input unchanged for them).
 */
export function ensureEventIds<T>(input: T): T {
  if (!input || typeof input !== 'object') return input
  const score = input as Record<string, unknown>
  walkStaff(score.measures, score.extraVoices, 0)
  if (score.secondStaff && typeof score.secondStaff === 'object') {
    const s2 = score.secondStaff as Record<string, unknown>
    walkStaff(s2.measures, s2.extraVoices, 1)
  }
  return input
}

function walkStaff(
  measuresUnknown: unknown,
  extraVoicesUnknown: unknown,
  staffIdx: number,
): void {
  walkVoice(measuresUnknown, staffIdx, 0)
  if (Array.isArray(extraVoicesUnknown)) {
    extraVoicesUnknown.forEach((voice, vIdx) => {
      if (voice && typeof voice === 'object') {
        walkVoice((voice as Record<string, unknown>).measures, staffIdx, vIdx + 1)
      }
    })
  }
}

function walkVoice(measuresUnknown: unknown, staffIdx: number, voiceIdx: number): void {
  if (!Array.isArray(measuresUnknown)) return
  measuresUnknown.forEach((measure, measureIdx) => {
    if (!measure || typeof measure !== 'object') return
    const events = (measure as Record<string, unknown>).events
    if (!Array.isArray(events)) return
    events.forEach((event, eventIdx) => {
      if (!event || typeof event !== 'object') return
      const ev = event as Record<string, unknown>
      // Only preserve IDs that satisfy the EventIdSchema bounds
      // (length 8..16). An out-of-bounds existing ID gets replaced
      // by a freshly-derived one, so the subsequent Zod parse will
      // accept the score rather than rejecting it on schema bounds.
      if (
        typeof ev.id === 'string' &&
        ev.id.length >= 8 &&
        ev.id.length <= 16
      ) {
        return
      }
      ev.id = deriveEventId(
        ev as Parameters<typeof deriveEventId>[0],
        { staffIdx, voiceIdx, measureIdx, eventIdx },
      )
    })
  })
}
