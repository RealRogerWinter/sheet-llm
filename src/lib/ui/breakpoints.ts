/**
 * Canonical responsive breakpoint scale for the whole app.
 *
 * CSS `@media` queries cannot read CSS custom properties, so this module is
 * the single source of truth that JS (matchMedia call-sites) consumes, and
 * every `@media` px literal in a `.module.css` MUST mirror one of these
 * values. The matching CSS mirror lives in `globals.css` as `--bp-*` (for
 * `clamp()`/`calc()` inputs and documentation only — not usable in @media).
 *
 * Values (px), mobile-first:
 *   xs  360  large phones
 *   sm  480  phablets / small tablets portrait
 *   md  768  tablets
 *   lg  1024 small laptops / sidebar docks
 *   xl  1280 desktops / side panels dock
 *   xxl 1536 large desktops
 */
export const BREAKPOINTS = {
  xs: 360,
  sm: 480,
  md: 768,
  lg: 1024,
  xl: 1280,
  xxl: 1536,
} as const

export type Breakpoint = keyof typeof BREAKPOINTS

/**
 * Media-query string builders. Use with `window.matchMedia(mq.up('lg'))`.
 * `down` subtracts 0.02px so `up(b)` and `down(b)` never both match at exactly
 * `b` px (the standard off-by-a-hair guard for max-width queries).
 */
export const mq = {
  up: (b: Breakpoint): string => `(min-width: ${BREAKPOINTS[b]}px)`,
  down: (b: Breakpoint): string => `(max-width: ${BREAKPOINTS[b] - 0.02}px)`,
  between: (min: Breakpoint, max: Breakpoint): string =>
    `(min-width: ${BREAKPOINTS[min]}px) and (max-width: ${BREAKPOINTS[max] - 0.02}px)`,
} as const
