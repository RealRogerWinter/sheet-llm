import type { Score } from '@/lib/music/types'
import { scoreToAbc } from '@/lib/music/scoreToAbc'

/**
 * Render a Score to an SVG string via abcjs. Visual-regression evals
 * use this + `pathDistance` against pinned baselines.
 *
 * Requires a DOM (works under vitest's jsdom environment). For pure
 * Node scripts (`scripts/capture-visual-baselines.ts`) we build a
 * jsdom shim ourselves before importing this module.
 */
export async function renderScoreSvg(score: Score): Promise<string> {
  const abc = scoreToAbc(score)
  return renderAbcSvg(abc)
}

/**
 * Render raw ABC to an SVG string via abcjs. Returns the outerHTML
 * of the first child of the target element (i.e. the `<svg>` itself).
 */
export async function renderAbcSvg(abc: string): Promise<string> {
  const mod = await import('abcjs')
  const abcjs = (mod as unknown as { default?: typeof mod }).default ?? mod
  const target = document.createElement('div')
  abcjs.renderAbc(target, abc, { responsive: 'resize' })
  // abcjs inserts an <svg> as the first child of the target. We
  // serialize it (with attributes intact) so the result is stable
  // across runs.
  const svg = target.querySelector('svg')
  if (!svg) {
    throw new Error('renderScoreSvg: abcjs did not produce an <svg> element')
  }
  return svg.outerHTML
}
