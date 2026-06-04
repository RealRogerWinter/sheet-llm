// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * M25-PR-6 drift guard. Every handler that emits a full or large Score
 * via render_score must keep its per-call output ceiling at or above the
 * multi-staff floor, so a dense grand-staff generation/edit never
 * truncates — and can never silently regress to a sub-multi-staff
 * ceiling (the original blocker was a 4000/2000/1500 floor far below the
 * ~15-25k a 16-bar grand-staff render needs). Greps the source so a
 * future edit that lowers the number fails here.
 */
const SCORE_EMIT_FLOOR = 8_000

const root = process.cwd()

const RENDER_SCORE_EMITTERS = [
  'src/lib/orchestrator/handlers/generateComplex.ts',
  'src/lib/orchestrator/handlers/compose.ts',
  'src/lib/orchestrator/handlers/extendComposition.ts',
  'src/lib/orchestrator/handlers/insertMeasures.ts',
  'src/lib/orchestrator/handlers/regionReplace.ts',
  'src/lib/orchestrator/handlers/editIntraMeasure.ts',
  'src/lib/orchestrator/handlers/generateSectional.ts',
  'src/lib/llm/client.ts',
]

/** Read the (SECTION_)MAX_TOKENS numeric literal out of a handler file. */
function maxTokensOf(file: string): number {
  const src = readFileSync(path.join(root, file), 'utf8')
  const m = src.match(/const\s+(?:SECTION_)?MAX_TOKENS\s*=\s*([\d_]+)/)
  if (!m) throw new Error(`no MAX_TOKENS const found in ${file}`)
  return Number(m[1].replace(/_/g, ''))
}

describe('token budget — render_score emit floor (M25-PR-6)', () => {
  for (const file of RENDER_SCORE_EMITTERS) {
    it(`${file} keeps its output ceiling >= ${SCORE_EMIT_FLOOR}`, () => {
      expect(maxTokensOf(file)).toBeGreaterThanOrEqual(SCORE_EMIT_FLOOR)
    })
  }

  it('the converse (text) handler ceiling is raised above the old 1500 floor', () => {
    // Converse emits prose, not render_score, so it has its own (lower)
    // ceiling — but it must clear the cramped 1500 that cut answers short.
    expect(maxTokensOf('src/lib/orchestrator/handlers/converse.ts')).toBeGreaterThanOrEqual(4_000)
  })
})
