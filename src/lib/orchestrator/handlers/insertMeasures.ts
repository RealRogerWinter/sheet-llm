import { z } from 'zod'
import type { Score } from '@/lib/music/types'
import { MeasureSchema } from '@/lib/music/types'
import { transformScore, type Operation } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import { ValidationError } from '@/lib/music/errors'
import type { Classification, OrchestratorResult } from '../types'
import { selectProvider } from '@/lib/providers/select'
import { resolveModelClass } from '@/lib/providers/modelClass'
import { callWithFailover } from '@/lib/providers/callWithFailover'
import { ProviderSchemaError, type ProviderToolResult } from '@/lib/providers/types'

/**
 * insert_measures handler (M3.5-PR-3) — append's mid-score sibling.
 *
 * Inserts `count` new measures AFTER `afterMeasureIdx`. Same emit-tool
 * pattern as extend_composition: the LLM emits only the new measures
 * via `emit_inserted_bars` — no top-level metadata fields are exposed
 * so re-emission is structurally impossible.
 *
 * The transformScore('insertMeasuresAfter') op handles the per-staff
 * fanout AND the forward index remap of techniqueStates / voltas /
 * markers / annotations / jumpMarkers.
 */

const INSERT_TOOL_NAME = 'emit_inserted_bars'
const MAX_TOKENS = 8_000 // M25-PR-6: render_score emit floor (see tokenBudget.test.ts)

export class InsertMeasuresError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InsertMeasuresError'
  }
}

export interface RunInsertMeasuresInput {
  classification: Classification
  editedScore: Score
  userText: string
  afterMeasureIdx: number
  count: number
  hint?: string
  chatId?: string
  modelOverride?: string
  apiKeyOverride?: string
}

const EmitInsertedBarsSchema = z.object({
  measures: z.array(MeasureSchema).min(1).max(64),
  perVoiceContent: z
    .array(z.object({ voices: z.array(z.array(MeasureSchema)) }))
    .optional(),
})

export const INSERT_SYSTEM_PROMPT = `You are INSERTING new measures into an existing score AT A SPECIFIC POSITION. The user has supplied a Score and asks you to insert N bars after a given measure index.

CRITICAL RULES:
1. You do NOT emit a new Score. You emit only the NEW measures.
2. The score's key, meter, clef, title, and tempo are SET — you cannot change them.
3. The new measures inherit the score's key, meter, and clef. Sum to the meter capacity per measure.
4. Use the measures BEFORE and AFTER the insertion point as compositional context — voice-lead naturally into and out of the inserted material.
5. Single-staff scores emit only "measures"; grand-staff scores may supply "perVoiceContent" for each staff/voice. When omitted, secondary voices get rests.
6. Do NOT include text — the tool call IS your response.

OUTPUT:
- Emit a single "emit_inserted_bars" tool call with the new bars under "measures".
`

function buildInsertPrompt(
  input: RunInsertMeasuresInput,
  validationFeedback?: string,
): string {
  const score = input.editedScore
  const sliceStart = Math.max(0, input.afterMeasureIdx - 1)
  const sliceEnd = Math.min(score.measures.length, input.afterMeasureIdx + 3)
  const window = score.measures.slice(sliceStart, sliceEnd)
  const lines: string[] = [
    `USER REQUEST: ${input.userText}`,
    ...(validationFeedback
      ? [
          '',
          'YOUR PREVIOUS ATTEMPT FAILED VALIDATION:',
          validationFeedback,
          '',
          "Fix the issue and emit again. Pay close attention to per-measure duration sums matching the score's meter (e.g. 4/4 = 8 eighths per measure).",
        ]
      : []),
    `INSERT POSITION: after measure ${input.afterMeasureIdx} (0-based; -1 = before the first bar)`,
    `COUNT: ${input.count}`,
    ...(input.hint ? [`HINT: ${input.hint}`] : []),
    '',
    `SCORE METADATA (set; do NOT re-emit):`,
    `  title=${JSON.stringify(score.title ?? null)}`,
    `  key=${score.key}`,
    `  meter=${score.meter}`,
    `  measures total=${score.measures.length}`,
    '',
    `MEASURES NEAR THE INSERT POINT (indices ${sliceStart}..${sliceEnd - 1}):`,
    JSON.stringify(window, null, 2),
    '',
    'FULL EXISTING SCORE (do NOT re-emit; only the new measures):',
    JSON.stringify(score, null, 2),
  ]
  return lines.join('\n')
}

export async function runInsertMeasures(
  input: RunInsertMeasuresInput,
): Promise<OrchestratorResult> {
  const t0 = Date.now()
  if (!input.editedScore) {
    throw new InsertMeasuresError('insert_measures requires a current score')
  }
  const measureCount = input.editedScore.measures.length
  if (input.afterMeasureIdx < -1 || input.afterMeasureIdx >= measureCount) {
    throw new InsertMeasuresError(
      `afterMeasureIdx ${input.afterMeasureIdx} out of range (valid: -1..${measureCount - 1})`,
    )
  }
  if (input.count < 1 || input.count > 64) {
    throw new InsertMeasuresError(`count must be in [1..64] (got ${input.count})`)
  }

  // SHE-19: edit handlers default to Haiku; complexity escalates to Sonnet.
  const selected = selectProvider(
    resolveModelClass({ callType: 'edit', complexity: input.classification.complexity }),
    input.chatId,
  )

  // Validation-retry loop (M3.5-PR-5b): re-prompt once on ValidationError
  // with the failure message threaded back into the user text. Only
  // retries ValidationError; ProviderSchemaError (malformed tool input)
  // and UpstreamError (already handled by callWithFailover) fall through.
  let toolResult!: ProviderToolResult<z.infer<typeof EmitInsertedBarsSchema>>
  let nextScore!: Score
  const warnings: string[] = []
  let op!: Operation
  let lastValidationError: string | undefined
  let attempt = 0
  while (true) {
    attempt++
    try {
      toolResult = await callWithFailover<z.infer<typeof EmitInsertedBarsSchema>>(
        { ...selected, chatId: input.chatId },
        {
          name: INSERT_TOOL_NAME,
          description:
            'Emit ONLY the new measures to insert at the given position. Do not emit key, meter, clef, title, or tempo.',
          inputSchema: EmitInsertedBarsSchema,
          inputSchemaJson: {
            type: 'object',
            additionalProperties: false,
            required: ['measures'],
            properties: {
              measures: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['events'],
                  properties: {
                    events: { type: 'array', minItems: 1, items: { type: 'object' } },
                  },
                },
              },
              perVoiceContent: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['voices'],
                  properties: {
                    voices: {
                      type: 'array',
                      items: { type: 'array', items: { type: 'object' } },
                    },
                  },
                },
              },
            },
          },
        },
        {
          systemPrompt: INSERT_SYSTEM_PROMPT,
          userText: buildInsertPrompt(input, lastValidationError),
          toolChoice: 'required',
          maxTokens: MAX_TOKENS,
          temperature: 0,
          modelOverride: input.modelOverride ?? selected.model,
          ...(input.apiKeyOverride !== undefined ? { apiKeyOverride: input.apiKeyOverride } : {}),
          providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
        },
      )
    } catch (e) {
      if (e instanceof ProviderSchemaError) {
        throw new InsertMeasuresError(`insert_measures: ${e.message}`)
      }
      throw e
    }

    const emittedMeasures = toolResult.input.measures
    const perVoiceContent = toolResult.input.perVoiceContent

    // H4 — warn if the LLM emitted a different count than requested.
    // Warn-and-keep: accept what came back and surface the mismatch.
    warnings.length = 0
    if (emittedMeasures.length !== input.count) {
      warnings.push(
        `LLM emitted ${emittedMeasures.length} measure${emittedMeasures.length === 1 ? '' : 's'}; requested ${input.count}. Using all emitted measures.`,
      )
    }

    op = {
      kind: 'insertMeasuresAfter',
      afterMeasureIdx: input.afterMeasureIdx,
      measures: emittedMeasures,
      ...(perVoiceContent !== undefined ? { perVoiceContent } : {}),
    }

    try {
      nextScore = transformScore(input.editedScore, op)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      throw new InsertMeasuresError(`insert_measures apply failed: ${msg}`)
    }

    try {
      validateScore(nextScore)
      if (attempt > 1 && process.env.ORCHESTRATOR_LOG_SILENT !== '1') {
        console.warn(
          `[handler retry attempt=${attempt} succeeded] insert_measures recovered after validation feedback`,
        )
      }
      break
    } catch (e) {
      if (e instanceof ValidationError && attempt < 2) {
        lastValidationError = e.message
        if (process.env.ORCHESTRATOR_LOG_SILENT !== '1') {
          console.warn(
            `[handler retry] insert_measures attempt=${attempt} validation failed: ${e.message.slice(0, 200)} — retrying with feedback`,
          )
        }
        continue
      }
      if (e instanceof ValidationError) {
        throw new InsertMeasuresError(
          `insert_measures produced an invalid score: ${e.message}`,
        )
      }
      throw e
    }
  }

  return {
    score: nextScore,
    classification: input.classification,
    model: toolResult.model,
    latencyMs: Date.now() - t0,
    toolUseId: toolResult.toolUseId,
    introText: toolResult.introText,
    appliedOps: [op],
    ...(warnings.length > 0 ? { warnings } : {}),
    dispatchTool: 'insert_measures' as const,
    ...(toolResult.usage
      ? {
          usage: {
            inputTokens: toolResult.usage.inputTokens,
            outputTokens: toolResult.usage.outputTokens,
            cachedInputTokens: toolResult.usage.cachedInputTokens,
          },
        }
      : {}),
  }
}

