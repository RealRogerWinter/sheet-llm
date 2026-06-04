import { z } from 'zod'
import type { Score } from '@/lib/music/types'
import { KeySchema, MeterSchema } from '@/lib/music/types'
import type { ChatMessage } from '@/lib/llm/wrapper'
import type { Classification } from './types'
import { CLASSIFIER_SYSTEM_PROMPT, classifyTool, CLASSIFY_TOOL_NAME } from './classifierPrompt'
import { selectProvider } from '@/lib/providers/select'
import { callWithFailover } from '@/lib/providers/callWithFailover'
import { ProviderSchemaError } from '@/lib/providers/types'

const MAX_TOKENS = 400

const ScoreLevelOp = z.union([
  z.object({ kind: z.literal('changeKey'), key: KeySchema }),
  z.object({ kind: z.literal('changeMeter'), meter: MeterSchema }),
  z.object({ kind: z.literal('changeTempo'), tempo_bpm: z.number().min(20).max(400) }),
  z.object({ kind: z.literal('changeTitle'), title: z.string().min(1).max(120) }),
  // M25-PR-6: changeClef was instructed in the prompt + allowed by
  // editScoreLevel, but absent here, so "switch to bass clef" failed the
  // parse and always fell through to the legacy path. staffIdx 0 = primary.
  z.object({
    kind: z.literal('changeClef'),
    clef: z.enum(['treble', 'bass']),
    staffIdx: z.number().int().min(0).max(1).optional(),
  }),
])

const ClassificationSchema = z.object({
  kind: z.enum([
    'edit_score_level',
    'edit_intra_measure',
    'generate_simple',
    'generate_complex',
    'compose',
    'converse',
    'refuse',
  ]),
  scope: z.enum(['snippet', 'short', 'long']),
  complexity: z.enum(['simple', 'complex']),
  confidence: z.number().min(0).max(1),
  score_level_ops: z.array(ScoreLevelOp).optional(),
  target_description: z.string().max(280).optional(),
  question: z.string().max(280).optional(),
  reason: z.string().max(280).optional(),
  notes: z.string().max(280).optional(),
})

export class ClassifierSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClassifierSchemaError'
  }
}

export interface ClassifyInput {
  userText: string
  editedScore?: Score
  history: ReadonlyArray<ChatMessage>
  /** Used for sticky-per-chat provider selection. */
  chatId?: string
  /** Debug-only model override (rare for the classifier path). */
  modelOverride?: string
}

export interface ClassifyOutput extends Classification {
  /** Raw token usage from the classifier call, for observability. */
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  /** Which model id actually served the call. */
  model?: string
}

/** Legacy compatibility shim — kept exported for any test still
 *  importing it. The provider-based implementation has no module-
 *  level state to reset. */
export function _resetClassifierClient(): void {
  // Tests that need to reset the underlying Anthropic client should
  // construct a fresh AnthropicProvider; this is a no-op.
}

function buildUserText(input: ClassifyInput): string {
  const lines: string[] = [
    `USER REQUEST: ${input.userText}`,
    `SCORE PRESENT: ${input.editedScore ? 'true' : 'false'}`,
  ]
  if (input.editedScore) {
    lines.push('', 'CURRENT SCORE (JSON):', JSON.stringify(input.editedScore, null, 2))
  }
  return lines.join('\n')
}

/**
 * Route the classifier call through the provider abstraction. PR B:
 * always lands on AnthropicProvider (small tier → Haiku 4.5). PR C+:
 * may land on Groq's gpt-oss-20b for the same tier.
 */
export async function classify(input: ClassifyInput): Promise<ClassifyOutput> {
  const selected = selectProvider('small', input.chatId)
  try {
    const result = await callWithFailover<Classification>(
      { ...selected, chatId: input.chatId },
      {
        name: CLASSIFY_TOOL_NAME,
        inputSchema: ClassificationSchema,
        inputSchemaJson: classifyTool.input_schema,
      },
      {
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        userText: buildUserText(input),
        toolChoice: 'required',
        maxTokens: MAX_TOKENS,
        temperature: 0,
        modelOverride: input.modelOverride ?? selected.model,
        providerOptions: { anthropic: { cacheControl: 'ephemeral' } },
      },
    )
    return {
      ...result.input,
      inputTokens: result.usage?.inputTokens,
      cachedInputTokens: result.usage?.cachedInputTokens,
      outputTokens: result.usage?.outputTokens,
      model: result.model,
    }
  } catch (e) {
    if (e instanceof ProviderSchemaError) {
      throw new ClassifierSchemaError(e.message)
    }
    throw e
  }
}
