// Phase 0 spike: verify abcjs.parseOnly works server-side in Node.
// The MVP plan relies on this for server-side ABC validation. If this
// breaks on a Node upgrade, switch to a syntactic-only check or a
// sub-path import that avoids browser globals.

import abcjs from 'abcjs'

const fixture = 'X:1\nT:Spike\nM:4/4\nL:1/8\nK:C\nCDEF GABc|'
const tunes = abcjs.parseOnly(fixture)

if (!Array.isArray(tunes) || tunes.length === 0) {
  console.error('FAIL: abcjs.parseOnly returned an empty result')
  process.exit(1)
}

const tune = tunes[0]
const warnings = tune.warnings ?? []
console.log(`OK: abcjs.parseOnly produced ${tunes.length} tune(s) under Node ${process.version}`)
if (warnings.length) {
  console.log(`Warnings: ${warnings.length}`)
  for (const w of warnings) console.log(`  - ${w}`)
}
