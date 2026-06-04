/**
 * SVG path-distance visual-regression metric.
 *
 * Compares two abcjs-rendered SVG strings by:
 *   1. Extracting all `<path d="..." />` elements (preserving order).
 *   2. For each path-pair (matched by index), tokenize the `d`
 *      attribute and compute the running pen position for each
 *      drawing command (M, L, C, Q, A, Z, etc.) and their
 *      lowercase relative variants.
 *   3. Compute the euclidean distance between corresponding pen
 *      positions; sum and normalize by the longer path's total length.
 *   4. Return a metric in [0, 1] where 0 = identical paths,
 *      1 ≈ wildly different.
 *
 * Pure function — no DOM, no I/O. Safe to call from vitest / Node.
 *
 * Limitations (intentional for v1):
 * - Cubic/Quadratic control points are NOT compared in detail; we
 *   only walk the resulting pen positions. Two visually-distinct
 *   bezier curves with identical endpoints score as identical.
 *   That's fine for catching gross visual drift (a measure shifted
 *   right by 50px, an extra notehead appearing); subtler regressions
 *   would need a per-command bezier-flattening pass.
 * - Path-count mismatches contribute proportionally to the metric
 *   (added paths are treated as 100%-different).
 *
 * Tested by `tests/unit/eval-lib/svgPathDistance.test.ts`.
 */

export interface PathDistanceResult {
  /** Final metric ∈ [0, 1]. 0 = identical. */
  metric: number
  /** Path count in svgA. */
  pathsA: number
  /** Path count in svgB. */
  pathsB: number
  /** Sum of point-distances across all matched pairs. */
  totalDelta: number
  /** Total path length in the longer of the two svgs, used to normalize. */
  normalizer: number
}

/** Extract every `<path d="..."/>` and return the `d` string in document order. */
export function extractPathDs(svg: string): string[] {
  const out: string[] = []
  // Match `<path ... d="..." ... />` with single or double quotes.
  const re = /<path\b[^>]*?\bd\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) {
    out.push(m[1] ?? m[2] ?? '')
  }
  return out
}

/**
 * Extract the size of the root <svg> element so we can normalize path
 * coordinates to a unitless [0, 1] space before diffing. Prefers
 * viewBox (more reliable across abcjs versions); falls back to
 * width/height attrs. Returns null if neither is present — the metric
 * then degrades to raw-pixel diffing (the previous behaviour).
 *
 * Why normalize: small layout drift / jsdom shim drift across runs
 * can shift coords by tens of pixels. With raw pixels a 5% drift
 * collides with a 0.05 metric threshold. Normalizing to viewBox-
 * relative coords means the metric measures *shape* drift rather than
 * absolute-pixel drift, and a much tighter 0.02 threshold becomes
 * meaningful.
 */
export function extractSvgSize(svg: string): { width: number; height: number } | null {
  // viewBox="x y w h"
  const vb = /<svg\b[^>]*?\bviewBox\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(svg)
  if (vb) {
    const v = (vb[1] ?? vb[2] ?? '').trim().split(/[\s,]+/).map(Number)
    if (v.length === 4 && v.every((n) => Number.isFinite(n)) && v[2] > 0 && v[3] > 0) {
      return { width: v[2], height: v[3] }
    }
  }
  // Fallback to width / height attrs.
  const wM = /<svg\b[^>]*?\bwidth\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(svg)
  const hM = /<svg\b[^>]*?\bheight\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(svg)
  if (wM && hM) {
    const w = parseFloat(wM[1] ?? wM[2] ?? '')
    const h = parseFloat(hM[1] ?? hM[2] ?? '')
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h }
    }
  }
  return null
}

interface Point {
  x: number
  y: number
}

/**
 * Tokenize and walk an SVG `d` string, returning the sequence of
 * absolute pen positions encountered. Each drawing command (M, L, C,
 * Q, A, H, V, T, S, Z) and its lowercase relative variant moves the
 * pen; we record the resulting absolute position after the command.
 *
 * Unknown commands are skipped (the regex won't match them; their
 * numeric operands fall through to whatever follows). For our purpose
 * — abcjs-generated SVGs — only M/L/C/Q/Z appear in practice.
 */
export function walkPath(d: string): Point[] {
  const out: Point[] = []
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0

  // Split into command tokens; each command letter followed by its
  // numeric operands (whitespace or comma separated, possibly with
  // implicit signs like `1.5-2` = `1.5 -2`).
  const cmdRe = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g
  let m: RegExpExecArray | null
  while ((m = cmdRe.exec(d)) !== null) {
    const cmd = m[1]
    const argsStr = m[2] ?? ''
    const nums = parseNumbers(argsStr)
    switch (cmd) {
      case 'M':
        // M can be followed by implicit L pairs.
        for (let i = 0; i + 1 < nums.length; i += 2) {
          x = nums[i]
          y = nums[i + 1]
          if (i === 0) {
            startX = x
            startY = y
          }
          out.push({ x, y })
        }
        break
      case 'm':
        for (let i = 0; i + 1 < nums.length; i += 2) {
          x += nums[i]
          y += nums[i + 1]
          if (i === 0) {
            startX = x
            startY = y
          }
          out.push({ x, y })
        }
        break
      case 'L':
        for (let i = 0; i + 1 < nums.length; i += 2) {
          x = nums[i]
          y = nums[i + 1]
          out.push({ x, y })
        }
        break
      case 'l':
        for (let i = 0; i + 1 < nums.length; i += 2) {
          x += nums[i]
          y += nums[i + 1]
          out.push({ x, y })
        }
        break
      case 'H':
        for (const n of nums) {
          x = n
          out.push({ x, y })
        }
        break
      case 'h':
        for (const n of nums) {
          x += n
          out.push({ x, y })
        }
        break
      case 'V':
        for (const n of nums) {
          y = n
          out.push({ x, y })
        }
        break
      case 'v':
        for (const n of nums) {
          y += n
          out.push({ x, y })
        }
        break
      case 'C':
        // 6 args per segment: cp1x cp1y cp2x cp2y x y
        for (let i = 0; i + 5 < nums.length; i += 6) {
          x = nums[i + 4]
          y = nums[i + 5]
          out.push({ x, y })
        }
        break
      case 'c':
        for (let i = 0; i + 5 < nums.length; i += 6) {
          x += nums[i + 4]
          y += nums[i + 5]
          out.push({ x, y })
        }
        break
      case 'S':
      case 'Q':
        // 4 args per segment: control + endpoint
        for (let i = 0; i + 3 < nums.length; i += 4) {
          x = nums[i + 2]
          y = nums[i + 3]
          out.push({ x, y })
        }
        break
      case 's':
      case 'q':
        for (let i = 0; i + 3 < nums.length; i += 4) {
          x += nums[i + 2]
          y += nums[i + 3]
          out.push({ x, y })
        }
        break
      case 'T':
        for (let i = 0; i + 1 < nums.length; i += 2) {
          x = nums[i]
          y = nums[i + 1]
          out.push({ x, y })
        }
        break
      case 't':
        for (let i = 0; i + 1 < nums.length; i += 2) {
          x += nums[i]
          y += nums[i + 1]
          out.push({ x, y })
        }
        break
      case 'A':
        // A rx ry x-axis-rotation large-arc sweep x y → endpoint at args[5..6]
        for (let i = 0; i + 6 < nums.length; i += 7) {
          x = nums[i + 5]
          y = nums[i + 6]
          out.push({ x, y })
        }
        break
      case 'a':
        for (let i = 0; i + 6 < nums.length; i += 7) {
          x += nums[i + 5]
          y += nums[i + 6]
          out.push({ x, y })
        }
        break
      case 'Z':
      case 'z':
        x = startX
        y = startY
        out.push({ x, y })
        break
      default:
        // unreachable per regex
        break
    }
  }
  return out
}

/** Parse a SVG-d numeric-arg string into numbers. */
function parseNumbers(s: string): number[] {
  const out: number[] = []
  // SVG path numbers: optional sign, digits, optional fraction, optional
  // exponent. They can be separated by whitespace, comma, or implicit
  // sign (`1.5-2` → 1.5, -2).
  const numRe = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g
  let m: RegExpExecArray | null
  while ((m = numRe.exec(s)) !== null) {
    out.push(parseFloat(m[0]))
  }
  return out
}

/** Sum of consecutive point-to-point distances in a polyline. */
function pathLength(pts: Point[]): number {
  let sum = 0
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x
    const dy = pts[i].y - pts[i - 1].y
    sum += Math.sqrt(dx * dx + dy * dy)
  }
  return sum
}

/** Sum of per-vertex distances between two polylines (up to shorter length). */
function vertexDelta(a: Point[], b: Point[]): number {
  const n = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const dx = a[i].x - b[i].x
    const dy = a[i].y - b[i].y
    sum += Math.sqrt(dx * dx + dy * dy)
  }
  // Penalize length mismatch: pretend missing vertices were at the
  // origin (max-disparity surrogate).
  if (a.length !== b.length) {
    const longer = a.length > b.length ? a : b
    for (let i = n; i < longer.length; i++) {
      const dx = longer[i].x
      const dy = longer[i].y
      sum += Math.sqrt(dx * dx + dy * dy)
    }
  }
  return sum
}

/** Scale every Point in-place by 1/width on X and 1/height on Y. */
function normalizePoints(pts: Point[], width: number, height: number): Point[] {
  return pts.map((p) => ({ x: p.x / width, y: p.y / height }))
}

/**
 * Compute the visual-regression metric. See module-level docstring.
 *
 * Coordinates from each SVG are normalized to [0, 1] using that SVG's
 * own viewBox (or width/height attrs as fallback). This means a
 * baseline rendered at a slightly different overall size than the
 * current render still produces a small metric — the metric measures
 * *shape* drift, not absolute-pixel drift. With normalization, the
 * visual-eval threshold is 0.02 (raw-pixel mode was 0.05).
 */
export function pathDistance(svgA: string, svgB: string): PathDistanceResult {
  const dsA = extractPathDs(svgA)
  const dsB = extractPathDs(svgB)
  const pathsA = dsA.length
  const pathsB = dsB.length
  const pairCount = Math.min(pathsA, pathsB)

  // Determine per-svg normalizers. If a side lacks viewBox/width
  // (e.g. an SVG fragment in a test fixture), fall through to 1.0 so
  // the metric stays in raw-pixel space for that side — backwards-
  // compatible with the previous behaviour for synthetic fixtures.
  const sizeA = extractSvgSize(svgA) ?? { width: 1, height: 1 }
  const sizeB = extractSvgSize(svgB) ?? { width: 1, height: 1 }

  // Walk both sides up-front (cheap; the SVGs we compare are small),
  // then normalize the points to each SVG's own [0, 1] coord space.
  const ptsA = dsA.map((d) => normalizePoints(walkPath(d), sizeA.width, sizeA.height))
  const ptsB = dsB.map((d) => normalizePoints(walkPath(d), sizeB.width, sizeB.height))

  let totalDelta = 0
  let normalizer = 0

  for (let i = 0; i < pairCount; i++) {
    totalDelta += vertexDelta(ptsA[i], ptsB[i])
    normalizer += Math.max(pathLength(ptsA[i]), pathLength(ptsB[i]))
  }

  // Unmatched paths count fully as drift — their full length adds to
  // both delta and normalizer (so the metric goes to 1.0 in the limit
  // where one side has zero paths).
  if (pathsA !== pathsB) {
    const longer = pathsA > pathsB ? ptsA : ptsB
    for (let i = pairCount; i < longer.length; i++) {
      const len = pathLength(longer[i])
      totalDelta += len
      normalizer += len
    }
  }

  // No paths at all on either side → metrically identical (zero).
  if (normalizer === 0) {
    return {
      metric: pathsA === pathsB ? 0 : 1,
      pathsA,
      pathsB,
      totalDelta: 0,
      normalizer: 0,
    }
  }

  // The metric is delta/normalizer, clamped to [0, 1]. Two SVGs with
  // identical paths produce delta=0 → 0. SVGs that share no spatial
  // overlap saturate to ~1.
  const raw = totalDelta / normalizer
  return {
    metric: Math.min(1, Math.max(0, raw)),
    pathsA,
    pathsB,
    totalDelta,
    normalizer,
  }
}
