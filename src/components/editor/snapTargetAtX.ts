import { resolveClickPosition, type SourceMap } from '@/lib/music/scoreToAbcWithMap'
import { DURATION_32NDS } from '@/lib/music/measureBalance'
import { meterCapacityIn32nds } from '@/lib/music/meter'
import { getVoiceMeasures } from '@/lib/music/scoreAccessors'
import type { Measure, Score } from '@/lib/music/types'

export interface SnapTarget {
  staffIdx: number
  measureIdx: number
  /** 32nd-unit offset from the start of the measure where the dropped
   *  event would land. Always falls on an existing event boundary. */
  position32nds: number
  /** Viewport client X coordinate of this snap point — for overlay
   *  rendering (vertical-line indicator). */
  clientX: number
  /** Viewport client Y center of the event row this snap point belongs
   *  to — used by the 2D-distance scoring path so a drag down to a
   *  later system snaps to a bar on that system's line, not the same-
   *  line bar closest by X. */
  clientY: number
}

/**
 * Resolve a pointer X coordinate to the nearest event-boundary on the
 * given staff, returning a balanced-reorder-compatible drop target
 * plus the boundary's viewport X for visual feedback.
 *
 * Algorithm: walk every `[data-startchar]` element in the SVG, group
 * by (staffIdx, voiceIdx, measureIdx), and emit one snap point at the
 * LEFT edge of the first event in each (staff, voice, measure) bucket
 * (position 0) plus one at the RIGHT edge of every event (cumulative
 * 32nds via DURATION_32NDS). The nearest point to `clickClientX` wins.
 *
 * IMPORTANT (voice grouping): events from different voices on the same
 * staff/measure share horizontal space in abcjs's rendering. Grouping
 * them together would double-count durations in the cumulative sum
 * (voice 0's quarter + voice 1's quarter at the same beat would emit
 * a snap at position 16 instead of two snaps at position 8). Each
 * voice maintains its own per-measure timeline, so the cumulative
 * reset must happen per (staffIdx, voiceIdx, measureIdx).
 *
 * IMPORTANT (rest tagging): both notes AND rests must carry
 * `data-startchar` (see ScorePanel.tagNoteheadsWithStartChar) or the
 * cumulative-32nds total skips rest durations, producing wrong drop
 * positions whenever a measure contains rests.
 *
 * Returns undefined when no `data-startchar`-tagged elements exist
 * (e.g. the score hasn't been engraved yet or interactive=false).
 *
 * `staffFilter` is optional; when set, snap candidates are restricted
 * to that staff so a drag on the primary staff doesn't snap to a
 * point on secondStaff.
 */
export function snapTargetAtX(
  svg: SVGSVGElement,
  clickClientX: number,
  editMap: SourceMap,
  score: Score,
  staffFilter?: number,
  clickClientY?: number,
): SnapTarget | undefined {
  type EventBox = {
    staffIdx: number
    voiceIdx: number
    measureIdx: number
    eventIdx: number
    left: number
    right: number
    centerY: number
  }
  const boxes: EventBox[] = []
  const nodes = svg.querySelectorAll<SVGGraphicsElement>('[data-startchar]')
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    if (rect.width === 0) continue
    const raw = node.getAttribute('data-startchar')
    if (raw === null) continue
    const sc = Number(raw)
    if (!Number.isFinite(sc)) continue
    const resolved = resolveClickPosition(editMap, sc)
    if (!resolved) continue
    if (staffFilter !== undefined && resolved.staffIdx !== staffFilter) continue
    boxes.push({
      staffIdx: resolved.staffIdx,
      voiceIdx: resolved.voiceIdx,
      measureIdx: resolved.measureIdx,
      eventIdx: resolved.eventIdx,
      left: rect.left,
      right: rect.right,
      centerY: (rect.top + rect.bottom) / 2,
    })
  }
  if (boxes.length === 0) return undefined

  const points: SnapTarget[] = []
  const byVoiceMeasure = new Map<string, EventBox[]>()
  for (const b of boxes) {
    const key = `${b.staffIdx}:${b.voiceIdx}:${b.measureIdx}`
    const arr = byVoiceMeasure.get(key)
    if (arr) arr.push(b)
    else byVoiceMeasure.set(key, [b])
  }

  // For whole-measure-rest geometry: abcjs centers the whole-rest glyph
  // within the measure, so bs[0].right of a single whole-rest sits in
  // the middle of the visual measure. Without an override, clicks past
  // the glyph snap to the wrong clientX. When the NEXT measure's first
  // event exists, its left edge approximates the barline; use that as
  // the right snap clientX for an all-whole-rest measure. Falls back to
  // bs[0].right when there's no next measure.
  for (const bs of byVoiceMeasure.values()) {
    bs.sort((a, b) => a.eventIdx - b.eventIdx)
  }
  function nextMeasureFirstLeft(staffIdx: number, voiceIdx: number, measureIdx: number): number | undefined {
    const nextKey = `${staffIdx}:${voiceIdx}:${measureIdx + 1}`
    const next = byVoiceMeasure.get(nextKey)
    return next?.[0]?.left
  }
  function isWholeMeasureRest(measure: Measure): boolean {
    if (measure.events.length !== 1) return false
    const ev = measure.events[0]
    if (ev.pitches[0]?.step !== 'rest') return false
    return DURATION_32NDS[ev.duration] === meterCapacityIn32nds(score.meter)
  }

  for (const [key, bs] of byVoiceMeasure) {
    const [staffStr, voiceStr, measureStr] = key.split(':')
    const staffIdx = Number(staffStr)
    const voiceIdx = Number(voiceStr)
    const measureIdx = Number(measureStr)
    const measures = getVoiceMeasures(score, staffIdx, voiceIdx)
    const measure = measures[measureIdx]
    if (!measure) continue
    // Use the first event in this (staff, voice, measure) bucket as the
    // y reference — every event in a single rendered system shares the
    // same Y band, so any pick is equally good. The y is what makes
    // cross-system snapping work (line 2's snap points get line 2's Y).
    const centerY = bs[0].centerY
    // Front of measure (position 0).
    points.push({
      staffIdx,
      measureIdx,
      position32nds: 0,
      clientX: bs[0].left,
      clientY: centerY,
    })
    const wholeRest = isWholeMeasureRest(measure)
    const wholeRestRightX = wholeRest
      ? nextMeasureFirstLeft(staffIdx, voiceIdx, measureIdx)
      : undefined
    // After each event (cumulative 32nds).
    let cumulative = 0
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i]
      const ev = measure.events[b.eventIdx]
      if (!ev) continue
      cumulative += DURATION_32NDS[ev.duration]
      const isLast = i === bs.length - 1
      const clientX = (isLast && wholeRest && wholeRestRightX !== undefined)
        ? wholeRestRightX
        : b.right
      points.push({
        staffIdx,
        measureIdx,
        position32nds: cumulative,
        clientX,
        clientY: b.centerY,
      })
    }
  }

  if (points.length === 0) return undefined

  // Scoring: 2D euclidean when a Y is provided, X-only otherwise (kept
  // for back-compat with call sites that don't yet pass Y).
  const useY = clickClientY !== undefined
  let best = points[0]
  let bestDiff = useY
    ? Math.hypot(points[0].clientX - clickClientX, points[0].clientY - (clickClientY as number))
    : Math.abs(points[0].clientX - clickClientX)
  for (const p of points) {
    const d = useY
      ? Math.hypot(p.clientX - clickClientX, p.clientY - (clickClientY as number))
      : Math.abs(p.clientX - clickClientX)
    if (d < bestDiff) {
      bestDiff = d
      best = p
    }
  }
  return best
}

/**
 * Classify a completed notehead drag from its live snap target: is it a
 * horizontal REORDER (true) or a vertical PITCH CHANGE (false)?
 *
 * A dragged event occupies the half-open span `[leadingPos32nds,
 * trailingPos32nds)`. The drag is a reorder only when the drop snapped
 * OUTSIDE that span — a different staff is ignored (snap is staff-
 * filtered upstream, so a foreign staff means "no usable target" →
 * pitch), a different measure is always a reorder (covers cross-system
 * drops to a later line), and within the source measure only a boundary
 * that is neither the leading nor the trailing edge counts.
 *
 * Why BOTH own-boundaries map to "stayed put": a straight-down pitch
 * drag keeps the pointer over the notehead's CENTER, and
 * {@link snapTargetAtX} scores candidates by 2D distance, so it returns
 * whichever of the event's two boundaries is nearer the center. The
 * leading boundary sits at the PREVIOUS note's right edge (farther from
 * center), so the nearer one is almost always the TRAILING boundary.
 * The original code matched only the leading boundary, so every
 * vertical drag looked like a reorder and shoved the note sideways
 * instead of retuning it — the bug behind "can't reliably drag a note
 * up/down to change pitch". Treating both edges as the source slot
 * removes that off-by-one-boundary coin flip. Snapping to one's own
 * boundary is a no-op reorder anyway, so no real reorder is lost.
 */
export function dragSnapIsReorder(
  snap: SnapTarget | undefined,
  source: {
    staffIdx: number
    measureIdx: number
    leadingPos32nds: number
    trailingPos32nds: number
  },
): boolean {
  if (!snap || snap.staffIdx !== source.staffIdx) return false
  if (snap.measureIdx !== source.measureIdx) return true
  return (
    snap.position32nds !== source.leadingPos32nds &&
    snap.position32nds !== source.trailingPos32nds
  )
}
