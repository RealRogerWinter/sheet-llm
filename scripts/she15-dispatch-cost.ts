/**
 * SHE-15 dispatch-call cost measurement.
 *
 * Calls the orchestrator DISPATCHER in isolation (toolDispatch.run) across
 * models + representative prompts, warming the Anthropic prompt cache, and
 * reports the per-dispatch token usage + USD cost (cold first call vs warm
 * steady-state). This isolates the classifier/dispatch round-trip that the
 * SHE-15 matrix $/case figures excluded — to validate the cost-per-1000 model.
 *
 * Usage:  ANTHROPIC_API_KEY=... tsx scripts/she15-dispatch-cost.ts
 * Spends real money (a handful of cheap dispatch calls).
 */
import type { Score } from '@/lib/music/types'
import { run as dispatchRun } from '@/lib/orchestrator/toolDispatch'
import { estimateCostUsd } from '@/lib/metering/pricing'
import type { ProviderUsage } from '@/lib/providers/types'

const SCORE: Score = {
  title: 'Cost probe',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'half' },
      ],
    },
  ],
}

const PROMPTS = [
  { label: 'edit', userText: 'make the second note of bar 1 staccato' },
  { label: 'generate', userText: 'add a new 4-bar B section in G major' },
  { label: 'question', userText: 'what key and time signature is this piece in?' },
]

const MODELS = [
  { label: 'Sonnet 4.6', id: 'claude-sonnet-4-6' },
  { label: 'Haiku 4.5', id: 'claude-haiku-4-5-20251001' },
]

function costOf(model: string, u: ProviderUsage | undefined): number {
  return estimateCostUsd(model, u?.inputTokens ?? 0, u?.outputTokens ?? 0, u?.cachedInputTokens ?? 0)
}

async function main(): Promise<void> {
  for (const m of MODELS) {
    console.log(`\n===== DISPATCH cost on ${m.label} (${m.id}) =====`)
    let warmSum = 0
    for (const p of PROMPTS) {
      const runs: Array<{ tool: string; u: ProviderUsage | undefined }> = []
      for (let i = 0; i < 3; i++) {
        const d = await dispatchRun({
          userText: p.userText,
          editedScore: SCORE,
          modelOverride: m.id,
          chatId: `dispatch-cost-${m.label}-${p.label}-${i}`,
        })
        runs.push({ tool: d.tool, u: d.usage })
      }
      const cold = runs[0]
      const warm = runs[2]
      const warmCost = costOf(m.id, warm.u)
      warmSum += warmCost
      console.log(`  [${p.label}] -> tool=${warm.tool}`)
      console.log(
        `    cold: in=${cold.u?.inputTokens} cached=${cold.u?.cachedInputTokens ?? 0} out=${cold.u?.outputTokens}  $${costOf(m.id, cold.u).toFixed(5)}`,
      )
      console.log(
        `    warm: in=${warm.u?.inputTokens} cached=${warm.u?.cachedInputTokens ?? 0} out=${warm.u?.outputTokens}  $${warmCost.toFixed(5)}`,
      )
    }
    console.log(`  >> avg WARM dispatch cost (${m.label}): $${(warmSum / PROMPTS.length).toFixed(5)}/call`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
