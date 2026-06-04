/**
 * Resolve a click Y on the rendered abcjs SVG to a LOGICAL staff index
 * (0..staffCount-1) on the Score model, together with the specific
 * `.abcjs-staff` SVG group whose geometry the caller should read.
 *
 * Why this exists: abcjs renders one `.abcjs-staff` group per
 * (system × logical-staff). A grand-staff score across 3 systems
 * therefore emits 6 `.abcjs-staff` groups in document order
 * [sys0/s0, sys0/s1, sys1/s0, sys1/s1, sys2/s0, sys2/s1]. The raw DOM
 * index is NOT a logical staff index. Earlier code used the DOM index
 * directly, which routed every click on system-2+ to a non-existent
 * staff slot. To recover the logical index we group `.abcjs-staff` by
 * their containing `.abcjs-staff-wrapper` (abcjs emits one wrapper per
 * system — see node_modules/abcjs/src/write/draw/draw.js: "abcjs-staff-
 * wrapper abcjs-l<N>") and read the WITHIN-SYSTEM position.
 */
export interface ResolvedStaff {
  /** Logical staff index, 0..staffCount-1. */
  staffIdx: number
  /** The `.abcjs-staff` SVG group inside the clicked system whose line
   *  geometry callers should read for clef-aware Y→pitch math. */
  staffEl: SVGGElement
  /** The `.abcjs-staff-wrapper` containing `staffEl` — exposed for
   *  callers that need to scope querySelectorAll to one system (e.g.
   *  bar-line discovery for measure-from-X). */
  systemEl: Element
}

interface BandPick<T> {
  el: T
  top: number
  bottom: number
}

/** Pick the element whose [top,bottom] vertical band contains clickY;
 *  if none, the one whose center is nearest. Returns undefined when the
 *  candidate list is empty. Pure function — testable without a DOM. */
export function pickBandByY<T>(
  bands: ReadonlyArray<BandPick<T>>,
  clickY: number,
): T | undefined {
  if (bands.length === 0) return undefined
  for (const b of bands) {
    if (clickY >= b.top && clickY <= b.bottom) return b.el
  }
  let best = bands[0]
  let bestDist = Math.abs(clickY - (best.top + best.bottom) / 2)
  for (let i = 1; i < bands.length; i++) {
    const b = bands[i]
    const d = Math.abs(clickY - (b.top + b.bottom) / 2)
    if (d < bestDist) {
      bestDist = d
      best = b
    }
  }
  return best.el
}

/**
 * Pick the system a click belongs to, gutter-aware. Containment wins
 * first (a click inside a system's band returns that system). For a
 * click in the empty gutter BETWEEN two systems, ownership is decided by
 * the gutter MIDLINE — the click goes to whichever system's near edge is
 * closer — not by nearest band-CENTER. Band centers are biased by
 * differing system heights, so nearest-center can hand a gutter click to
 * the farther (wrong) system; e.g. a click just above a high note that
 * sticks above its own system's top staff line would route to the system
 * above. (`.abcjs-staff` boxes are staff-lines-only — see
 * node_modules/abcjs/src/write/draw/staff.js — so high notes / ledger
 * lines fall OUTSIDE every band and land in a gutter.) Clicks above the
 * first system or below the last clamp to that extreme. A single-system
 * list returns its sole element unconditionally, so single-system scores
 * are a no-op. Pure — testable without a DOM.
 */
export function pickSystemByGutter<T>(
  bands: ReadonlyArray<BandPick<T>>,
  clickY: number,
): T | undefined {
  if (bands.length === 0) return undefined
  if (bands.length === 1) return bands[0].el
  // Never trust caller order; sort a copy top-to-bottom.
  const sorted = [...bands].sort((a, b) => a.top - b.top)
  // Containment first — also resolves overlapping bands deterministically
  // (first in top-order wins).
  for (const b of sorted) {
    if (clickY >= b.top && clickY <= b.bottom) return b.el
  }
  // Outside every band: clamp at the extremes, else split the gutter.
  if (clickY < sorted[0].top) return sorted[0].el
  const last = sorted[sorted.length - 1]
  if (clickY > last.bottom) return last.el
  for (let i = 0; i < sorted.length - 1; i++) {
    const upper = sorted[i]
    const lower = sorted[i + 1]
    if (clickY > upper.bottom && clickY < lower.top) {
      const midline = (upper.bottom + lower.top) / 2
      return clickY <= midline ? upper.el : lower.el
    }
  }
  // Unreachable for well-formed bands; default to the first.
  return sorted[0].el
}

function rectBand<T extends Element>(el: T): BandPick<T> {
  const r = el.getBoundingClientRect()
  return { el, top: r.top, bottom: r.bottom }
}

/**
 * Resolve which logical staff (and which physical SVG group) a click
 * landed on. `staffCount` is the score's staff count (1 or 2 in the
 * current model; the algorithm is correct for N).
 *
 * Algorithm:
 *   1. Enumerate `.abcjs-staff-wrapper` (one per system). If absent —
 *      e.g. legacy abcjs or a single-line render where `add_classes`
 *      was disabled — fall back to grouping `.abcjs-staff` by their
 *      direct parent element so we still get system-major buckets.
 *   2. Pick the system whose vertical band contains the click. For a
 *      click in the empty gutter between systems, ownership is decided
 *      by the gutter midline (a Voronoi split between adjacent systems),
 *      with clicks above the first / below the last system clamped to
 *      that extreme; single-system scores are unaffected. See
 *      `pickSystemByGutter`.
 *   3. Within that system, pick the `.abcjs-staff` whose band contains
 *      the click (or nearest center). The position of that staff in
 *      its system's sorted-by-top order IS the logical staff index,
 *      clamped to [0, staffCount-1].
 *
 * Returns undefined when no `.abcjs-staff` elements are present (e.g.
 * before the first render).
 */
export function resolveStaffFromY(
  svg: SVGSVGElement,
  clickClientY: number,
  staffCount: number,
): ResolvedStaff | undefined {
  const wrappers = Array.from(svg.querySelectorAll<Element>('.abcjs-staff-wrapper'))
  let systems: Array<{ systemEl: Element; staves: SVGGElement[] }> = []

  if (wrappers.length > 0) {
    for (const w of wrappers) {
      const staves = Array.from(w.querySelectorAll<SVGGElement>('.abcjs-staff'))
      if (staves.length > 0) systems.push({ systemEl: w, staves })
    }
  }

  if (systems.length === 0) {
    // Legacy fallback: group `.abcjs-staff` by direct parent.
    const byParent = new Map<Element, SVGGElement[]>()
    const all = svg.querySelectorAll<SVGGElement>('.abcjs-staff')
    for (const s of all) {
      const parent = s.parentElement
      if (!parent) continue
      const arr = byParent.get(parent)
      if (arr) arr.push(s)
      else byParent.set(parent, [s])
    }
    systems = Array.from(byParent.entries()).map(([systemEl, staves]) => ({
      systemEl,
      staves,
    }))
  }

  if (systems.length === 0) return undefined

  // Sort staves within each system top-to-bottom so within-system index
  // = logical staff index. The DOM order should already match but
  // sorting defends against any abcjs draw-order surprises.
  for (const sys of systems) {
    sys.staves.sort(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
    )
  }

  const systemBands = systems.map((sys) => {
    // The system's effective vertical band is the union of its staves'
    // bands — wrappers can include lyric/dynamic regions above and
    // below, which we don't want to "own" for clef resolution.
    let top = Infinity
    let bottom = -Infinity
    for (const s of sys.staves) {
      const r = s.getBoundingClientRect()
      if (r.top < top) top = r.top
      if (r.bottom > bottom) bottom = r.bottom
    }
    return { el: sys, top, bottom }
  })

  const pickedSystem = pickSystemByGutter(systemBands, clickClientY)
  if (!pickedSystem) return undefined

  const staveBands = pickedSystem.staves.map(rectBand)
  const pickedStaff = pickBandByY(staveBands, clickClientY) ?? pickedSystem.staves[0]
  const rawIdx = pickedSystem.staves.indexOf(pickedStaff)
  const clampedIdx = Math.max(0, Math.min(staffCount - 1, rawIdx))

  return {
    staffIdx: clampedIdx,
    staffEl: pickedStaff,
    systemEl: pickedSystem.systemEl,
  }
}
