import type { Score } from '@/lib/music/types'
import type { SourceMap } from '@/lib/music/scoreToAbcWithMap'
import { getStaffCount } from '@/lib/music/scoreAccessors'
import { clickInsertSlot } from './clickInsertSlot'
import { resolveStaffFromY } from './staffResolver'

/**
 * Resolve the global (score-level) measure index under a viewport point, via
 * the same SourceMap walk used for click-to-insert and measure-range select:
 * resolve the logical staff from Y, then the measure from X. Returns undefined
 * when the point doesn't land on a resolvable bar.
 *
 * Shared by useMeasureRangeSelect (desktop Cmd/Ctrl+click) and the touch
 * range-extend path in useStaffInteractions.
 */
export function resolveMeasureAt(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  editedScore: Score,
  editMap: SourceMap,
): number | undefined {
  const resolved = resolveStaffFromY(svg, clientY, getStaffCount(editedScore))
  if (!resolved) return undefined
  const slot = clickInsertSlot(svg, clientX, editMap, resolved.staffIdx, resolved.systemEl)
  if (!slot || slot.measureIdx < 0) return undefined
  return slot.measureIdx
}
