import { describe, it, expect } from 'vitest'
import { OllamaProvider } from '@/lib/providers/ollama'
import { classifyTool, CLASSIFY_TOOL_NAME } from '@/lib/orchestrator/classifierPrompt'
import { CLASSIFIER_SYSTEM_PROMPT } from '@/lib/orchestrator/classifierPrompt'
import { z } from 'zod'

/**
 * Live Ollama eval. Hits a real local Ollama daemon — gated by
 * RUN_LOCAL_EVALS=1 (+ OLLAMA_BASE_URL or the default localhost:11434).
 *
 * To run:
 *   1. Install Ollama (https://ollama.com/download)
 *   2. ollama pull qwen2.5:14b-instruct
 *   3. RUN_LOCAL_EVALS=1 pnpm test:eval
 *
 * Asserts a minimum classifier accuracy on a small labeled set.
 * Quality threshold is intentionally low (>= 60%) because qwen2.5:14b
 * is a small local model — the goal is "is it usable as a Phase-D
 * provider?" not "does it match Sonnet?".
 */

const RUN = process.env.RUN_LOCAL_EVALS === '1'

interface Case {
  text: string
  expectedKind:
    | 'edit_score_level'
    | 'edit_intra_measure'
    | 'generate_simple'
    | 'generate_complex'
    | 'compose'
    | 'refuse'
}

const CASES: Case[] = [
  { text: 'a c major scale', expectedKind: 'generate_simple' },
  { text: 'a simple arpeggio in G', expectedKind: 'generate_simple' },
  { text: 'change the key to D major', expectedKind: 'edit_score_level' },
  { text: 'change the meter to 3/4', expectedKind: 'edit_score_level' },
  { text: 'set the tempo to 120', expectedKind: 'edit_score_level' },
  { text: 'raise the third note an octave', expectedKind: 'edit_intra_measure' },
  { text: 'add a fermata to the last note', expectedKind: 'edit_intra_measure' },
  { text: 'write a counterpoint to this line', expectedKind: 'compose' },
  { text: 'harmonize this melody with thirds', expectedKind: 'compose' },
  { text: 'compose a full sonata-form first movement', expectedKind: 'generate_complex' },
]

// Minimal ClassificationSchema duplicated locally so the eval doesn't
// import the full classifier (which routes through selectProvider).
const ClassificationSchema = z.object({
  kind: z.enum([
    'edit_score_level',
    'edit_intra_measure',
    'generate_simple',
    'generate_complex',
    'compose',
    'refuse',
  ]),
  scope: z.enum(['snippet', 'short', 'long']),
  complexity: z.enum(['simple', 'complex']),
  confidence: z.number().min(0).max(1),
  score_level_ops: z.array(z.unknown()).optional(),
  target_description: z.string().max(280).optional(),
  reason: z.string().max(280).optional(),
  notes: z.string().max(280).optional(),
})

describe.skipIf(!RUN)('Ollama live classifier eval (RUN_LOCAL_EVALS=1)', () => {
  it(
    `qwen2.5:7b-instruct classifier matches >=60% of ${CASES.length} labeled cases`,
    async () => {
      const provider = new OllamaProvider()
      const results: Array<{ text: string; expected: string; actual: string | 'ERROR' }> = []
      for (const c of CASES) {
        try {
          const r = await provider.toolCall(
            {
              name: CLASSIFY_TOOL_NAME,
              inputSchema: ClassificationSchema,
              inputSchemaJson: classifyTool.input_schema,
            },
            {
              systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
              userText: `USER REQUEST: ${c.text}`,
              toolChoice: 'required',
              maxTokens: 400,
              temperature: 0,
              modelOverride: 'qwen2.5:7b-instruct',
            },
          )
          results.push({ text: c.text, expected: c.expectedKind, actual: r.input.kind })
        } catch (e) {
          results.push({
            text: c.text,
            expected: c.expectedKind,
            actual: `ERROR: ${e instanceof Error ? e.message.slice(0, 80) : 'unknown'}`,
          })
        }
      }
      const correct = results.filter((r) => r.actual === r.expected).length
      const accuracy = correct / results.length
      console.log('Ollama classifier eval results:')
      for (const r of results) {
        const ok = r.actual === r.expected ? '✓' : '✗'
        console.log(`  ${ok} ${r.text}: expected=${r.expected} actual=${r.actual}`)
      }
      console.log(`  Accuracy: ${(accuracy * 100).toFixed(0)}%`)
      expect(accuracy).toBeGreaterThanOrEqual(0.6)
    },
    120_000,
  )
})

describe.skipIf(RUN)('Ollama live eval — skipped (set RUN_LOCAL_EVALS=1 to run)', () => {
  it('is intentionally skipped to avoid requiring a running Ollama daemon', () => {
    expect(true).toBe(true)
  })
})
