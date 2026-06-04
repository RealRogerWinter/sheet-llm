import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Score } from '@/lib/music/types'
import { renderScoreSvg } from '../../lib/renderScoreSvg'
import { pathDistance } from '../../lib/svgPathDistance'

/**
 * Visual-regression case: Bach Invention No. 1 first 4 bars.
 *
 * Test:
 *   1. Load the pinned Score JSON.
 *   2. Render to SVG via abcjs.
 *   3. Diff against the pinned baseline SVG using `pathDistance`
 *      (coords normalized to viewBox space — see svgPathDistance.ts).
 *   4. Assert the metric < 0.02 (jitter floor; identical-render = 0).
 *
 * Regenerate the baseline via `pnpm eval:baselines:capture` after a
 * legitimate renderer change.
 */

const BASELINES_DIR = path.resolve(__dirname, '../../baselines/visual')
const NAME = 'bach-invention-1'
const THRESHOLD = 0.02

describe(`eval:visual — ${NAME}`, () => {
  it(`renders within ${THRESHOLD} path-distance of baseline`, async () => {
    const score: Score = JSON.parse(
      readFileSync(path.join(BASELINES_DIR, `${NAME}.score.json`), 'utf8'),
    )
    const baselineSvg = readFileSync(
      path.join(BASELINES_DIR, `${NAME}.baseline.svg`),
      'utf8',
    )
    const renderedSvg = await renderScoreSvg(score)
    const { metric, pathsA, pathsB } = pathDistance(baselineSvg, renderedSvg)
    if (metric >= THRESHOLD) {
      // Verbose log to make CI debugging easier.
      console.warn(
        `[visual eval] ${NAME} metric=${metric.toFixed(4)} pathsBaseline=${pathsA} pathsRendered=${pathsB}`,
      )
    }
    expect(metric).toBeLessThan(THRESHOLD)
  })
})
