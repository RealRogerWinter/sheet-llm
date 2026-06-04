import { resolveClickPosition, type SourceMap } from '@/lib/music/scoreToAbcWithMap'

/**
 * Resolve a click X-coordinate to the (measureIdx, eventIdx) of the
 * rendered note whose horizontal extent contains it, or undefined when
 * the click falls in a gap between notes.
 *
 * Relies on `tagNoteheadsWithStartChar` (ScorePanel.tsx) having stamped
 * each note SVG group with data-startchar. Each candidate's startChar
 * is reverse-mapped through the SourceMap to its (measureIdx, eventIdx).
 *
 * Multi-pitch events (chords) render as a single SVG group, so a chord
 * occupies one X-band — exactly what implicit-merge wants.
 *
 * `staffFilter` restricts candidates to a logical staff index. Without
 * it, a click on a grand-staff bass note at X=N would match the X-band
 * of a treble note at the same X (DOM order picks treble first),
 * implicit-merging the bass click into the wrong staff's chord. Mirror
 * of the `staffFilter` parameter on `snapTargetAtX`.
 *
 * `systemEl` scopes the scan to ONE rendered system/line and should be
 * `resolveStaffFromY(...).systemEl`. abcjs draws each system inside its
 * own `.abcjs-staff-wrapper`, so every `[data-startchar]` node is a
 * descendant of exactly one wrapper (mirror of `clickInsertSlot`). Were
 * the scan SVG-wide instead, a click in an upper system at an X with no
 * notehead there but overlapping a same-clef chord in a LOWER system
 * would implicit-merge into that other system's chord — the multi-system
 * "wrong line" bug. There is deliberately NO svg-wide fallback when
 * `systemEl` yields no match: returning undefined lets the caller fall
 * through to the system-scoped insert path, whereas a fallback would
 * silently reintroduce cross-system merges. (`svg` is retained for
 * signature parity with the sibling finders and is unused here.)
 */
export function eventAtX(
  svg: SVGSVGElement,
  clickClientX: number,
  editMap: SourceMap,
  systemEl: ParentNode,
  staffFilter?: number,
): { staffIdx: number; measureIdx: number; eventIdx: number } | undefined {
  const nodes = systemEl.querySelectorAll<SVGGraphicsElement>('[data-startchar]')
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    if (rect.width === 0) continue
    if (clickClientX < rect.left || clickClientX > rect.right) continue
    const raw = node.getAttribute('data-startchar')
    if (raw === null) continue
    const sc = Number(raw)
    if (!Number.isFinite(sc)) continue
    const resolved = resolveClickPosition(editMap, sc)
    if (!resolved) continue
    if (staffFilter !== undefined && resolved.staffIdx !== staffFilter) continue
    return {
      staffIdx: resolved.staffIdx,
      measureIdx: resolved.measureIdx,
      eventIdx: resolved.eventIdx,
    }
  }
  return undefined
}
