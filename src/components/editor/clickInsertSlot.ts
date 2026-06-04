import { resolveClickPosition, type SourceMap } from '@/lib/music/scoreToAbcWithMap'

/**
 * Where should a click-to-insert land?
 *
 *   measureIdx     — global score measure index (NOT system-local).
 *   insertAfterIdx — the eventIdx whose RIGHT edge the click sits past.
 *                    -1 means the click is before every event in the
 *                    measure → insert at the front.
 *
 * `smartInsertNote` treats `target.eventIdx` as the anchor whose
 * absorbable rest region (rest-anchor or following rests) is replaced
 * by the new note. insertAfterIdx=-1 is valid: smartInsertNote sees no
 * anchor and absorbs leading rests from measure index 0.
 */
export interface ClickInsertSlot {
  measureIdx: number
  insertAfterIdx: number
}

/**
 * Resolve a click X (within a previously-resolved system) to the
 * insertion slot the user pointed at.
 *
 * Why this exists: the previous logic counted `.abcjs-bar` lines within
 * a system to derive a *system-local* measure index, then compared it
 * to the *score-global* measure count — every click in system 1+ on a
 * multi-system score routed to the wrong measure. And once a measure
 * was picked, the insertion always anchored on `measure.events.length-1`
 * regardless of click X, so the new note always appeared at the END of
 * that measure (or, when the measure was already full of notes,
 * spilled into a brand-new measure at the end of the score). Hence the
 * two-part bug: "click anywhere → note appears at the end of the
 * score".
 *
 * Algorithm: walk every `[data-startchar]` element inside `systemEl`,
 * map each one's startChar through `editMap` to (staffIdx, measureIdx,
 * eventIdx), filter to the clicked staff, group by measureIdx, and
 * collect each event's horizontal extent. Then:
 *
 *   1. Choose the measure whose X-band [min(left), max(right)] either
 *      contains clickX, or is closest to it. The measureIdx returned is
 *      the GLOBAL score index — the SourceMap is the source of truth,
 *      not DOM ordering — so this is correct across systems.
 *   2. Within that measure, set `insertAfterIdx` to the largest
 *      eventIdx whose right edge is ≤ clickX. If no event satisfies
 *      that, the click is before every event → -1 (insert at front).
 *
 * Returns undefined when the system contains no tagged events for the
 * clicked staff — caller should fall back to its empty-system default.
 *
 * `systemEl` should be `resolveStaffFromY(...).systemEl` so the scan is
 * scoped to one system; without that scoping, a click in system 1 would
 * still find events on system 0 / 2 and pick whichever measure had the
 * nearest X-band, ignoring the user's vertical intent.
 */
export function clickInsertSlot(
  svg: SVGSVGElement,
  clickClientX: number,
  editMap: SourceMap,
  staffIdx: number,
  systemEl: ParentNode,
): ClickInsertSlot | undefined {
  type EventBox = { eventIdx: number; left: number; right: number }
  const byMeasure = new Map<number, EventBox[]>()
  const nodes = systemEl.querySelectorAll<SVGGraphicsElement>('[data-startchar]')
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    if (rect.width === 0) continue
    const raw = node.getAttribute('data-startchar')
    if (raw === null) continue
    const sc = Number(raw)
    if (!Number.isFinite(sc)) continue
    const resolved = resolveClickPosition(editMap, sc)
    if (!resolved) continue
    if (resolved.staffIdx !== staffIdx) continue
    const entry: EventBox = { eventIdx: resolved.eventIdx, left: rect.left, right: rect.right }
    const arr = byMeasure.get(resolved.measureIdx)
    if (arr) arr.push(entry)
    else byMeasure.set(resolved.measureIdx, [entry])
  }
  if (byMeasure.size === 0) return undefined

  // Pick the measure whose X-band contains clickX (distance 0), else
  // the closest by edge-distance. Ties favor the first-iterated, which
  // is the first one inserted — DOM order, which is left-to-right on a
  // single system. Good enough; ties only occur for clicks landing
  // exactly on a barline gap.
  let bestIdx: number | undefined
  let bestDist = Infinity
  let bestEvents: EventBox[] | undefined
  for (const [idx, events] of byMeasure) {
    let left = Infinity
    let right = -Infinity
    for (const e of events) {
      if (e.left < left) left = e.left
      if (e.right > right) right = e.right
    }
    let dist: number
    if (clickClientX < left) dist = left - clickClientX
    else if (clickClientX > right) dist = clickClientX - right
    else dist = 0
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = idx
      bestEvents = events
    }
  }
  if (bestIdx === undefined || !bestEvents) return undefined

  // Within the chosen measure, find the rightmost event whose right
  // edge sits at or before clickX. That index is the "insert after"
  // anchor passed to smartInsertNote. If no event qualifies, the click
  // is left of every notehead → insertAfterIdx = -1 means "insert at
  // the front of the measure". smartInsertNote sees `anchor=undefined`
  // and absorbs the leading rests from index 0.
  let insertAfterIdx = -1
  let bestRight = -Infinity
  for (const ev of bestEvents) {
    if (ev.right <= clickClientX && ev.right > bestRight) {
      bestRight = ev.right
      insertAfterIdx = ev.eventIdx
    }
  }
  return { measureIdx: bestIdx, insertAfterIdx }
}
