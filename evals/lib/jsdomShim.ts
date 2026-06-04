/**
 * Shared jsdom polyfills for SVG layout that abcjs / svg2pdf require.
 *
 * jsdom doesn't implement SVG layout — `getBBox` is missing on every
 * element subclass at runtime. We stub it to a stable non-zero size so
 * structural unit tests and the visual-baseline capture script don't
 * crash.
 *
 * svg2pdf clones/recreates elements internally so the polyfill must
 * reach all DOM elements, not just the SVG prototype chain. We patch
 * `Element.prototype` as the universal fallback plus the SVG-specific
 * classes for completeness.
 *
 * Two callers consume this:
 *   - `tests/setup.ts` calls `installGetBBoxPolyfill()` against the
 *     globals jsdom (the vitest environment) already set up.
 *   - `scripts/capture-visual-baselines.ts` builds its own jsdom and
 *     calls `installGetBBoxPolyfillOn(domWindow)` to patch the
 *     window-local prototypes BEFORE importing abcjs.
 *
 * Keep the impl in ONE place so the two callers can't drift — a stale
 * baseline-capture polyfill would silently invalidate visual evals.
 */

export interface BBoxLike {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
  toJSON: () => Record<string, unknown>
}

/** The stub BBox returned to every caller. Stable so diffs are deterministic. */
export function makeBBox(): BBoxLike {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    top: 0,
    right: 100,
    bottom: 20,
    left: 0,
    toJSON: () => ({}),
  }
}

const bboxImpl = function () {
  return makeBBox() as unknown as DOMRect
}

/**
 * Patch the ambient globals (vitest jsdom env). Safe to call multiple
 * times; later calls overwrite. No-op for prototypes that aren't
 * available in the current runtime.
 */
export function installGetBBoxPolyfill(): void {
  if (typeof Element !== 'undefined') {
    ;(Element.prototype as unknown as { getBBox: () => DOMRect }).getBBox = bboxImpl
  }
  if (typeof SVGElement !== 'undefined') {
    ;(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = bboxImpl
  }
  if (typeof SVGGraphicsElement !== 'undefined') {
    SVGGraphicsElement.prototype.getBBox = bboxImpl
  }
}

/**
 * Patch a specific jsdom window (used by the capture script which
 * builds its own JSDOM and would otherwise not see ambient mutations
 * because it imports this BEFORE assigning the window to globalThis).
 */
export function installGetBBoxPolyfillOn(win: {
  Element?: { prototype: object }
  SVGElement?: { prototype: object }
  SVGGraphicsElement?: { prototype: object }
}): void {
  if (win.Element) {
    ;(win.Element.prototype as unknown as { getBBox: () => DOMRect }).getBBox = bboxImpl
  }
  if (win.SVGElement) {
    ;(win.SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = bboxImpl
  }
  if (win.SVGGraphicsElement) {
    ;(win.SVGGraphicsElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = bboxImpl
  }
}
