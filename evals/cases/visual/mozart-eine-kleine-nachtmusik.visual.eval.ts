import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Score } from '@/lib/music/types'
import { renderScoreSvg } from '../../lib/renderScoreSvg'
import { pathDistance } from '../../lib/svgPathDistance'

const BASELINES_DIR = path.resolve(__dirname, '../../baselines/visual')
const NAME = 'mozart-eine-kleine-nachtmusik'
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
      console.warn(
        `[visual eval] ${NAME} metric=${metric.toFixed(4)} pathsBaseline=${pathsA} pathsRendered=${pathsB}`,
      )
    }
    expect(metric).toBeLessThan(THRESHOLD)
  })
})
