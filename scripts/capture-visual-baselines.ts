#!/usr/bin/env tsx
/**
 * Regenerate the visual-regression baseline SVGs from the pinned
 * `<name>.score.json` files under `evals/baselines/visual/`.
 *
 * Run via `pnpm eval:baselines:capture`. The result must be reviewed
 * (eyeball-check that the SVG looks musically right) and committed
 * alongside whatever renderer change motivated the regeneration.
 *
 * Implementation: bootstrap a jsdom shim (since abcjs reaches for
 * `document` / `window`), then call `renderScoreSvg` from
 * `evals/lib/renderScoreSvg.ts`. Each baseline writes to
 * `evals/baselines/visual/<name>.baseline.svg`.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
// @ts-expect-error jsdom ships without types in this repo's dev set;
// we don't add @types/jsdom for one script.
import { JSDOM } from 'jsdom'
import { installGetBBoxPolyfillOn } from '../evals/lib/jsdomShim'

async function main() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.window.document
  // navigator may be a non-writable getter on modern Node — skip it
  // if assignment fails; abcjs doesn't strictly require it.
  try {
    g.navigator = dom.window.navigator
  } catch {
    /* node-22+ exposes a read-only navigator; ignore */
  }
  g.HTMLElement = dom.window.HTMLElement
  g.Element = dom.window.Element
  g.SVGElement = dom.window.SVGElement

  // Install the shared getBBox polyfill against the jsdom window
  // prototypes. Shared with tests/setup.ts so the two callers can't
  // drift — a stale baseline polyfill would silently invalidate
  // visual evals.
  installGetBBoxPolyfillOn(dom.window)

  // Dynamic import AFTER the DOM shim is in place.
  const { renderScoreSvg } = await import('../evals/lib/renderScoreSvg')

  const dir = path.resolve('evals/baselines/visual')
  const entries = readdirSync(dir).filter((n) => n.endsWith('.score.json'))
  if (entries.length === 0) {
    console.error('No .score.json baselines found in', dir)
    process.exit(1)
  }

  for (const entry of entries) {
    const name = entry.replace(/\.score\.json$/, '')
    const scorePath = path.join(dir, entry)
    const score = JSON.parse(readFileSync(scorePath, 'utf8'))
    const svg = await renderScoreSvg(score)
    const out = path.join(dir, `${name}.baseline.svg`)
    writeFileSync(out, svg, 'utf8')
    console.log(`captured ${name} → ${out} (${svg.length} bytes)`)
  }
}

main().catch((e) => {
  console.error('capture-visual-baselines failed:', e)
  process.exit(1)
})
