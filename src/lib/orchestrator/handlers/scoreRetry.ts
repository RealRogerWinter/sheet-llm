import type { Score } from '@/lib/music/types'
import { ScoreSchema } from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'
import { ValidationError } from '@/lib/music/errors'
import { renderScoreTool, RENDER_SCORE_TOOL_NAME } from '@/lib/llm/renderScoreTool'
import { ensureAnnotationIds } from '@/lib/music/annotations'
import { ensureMarkerIds } from '@/lib/music/markers'
import {
  ensureCodaMarkerIds,
  ensureJumpMarkerIds,
  ensureSegnoMarkerIds,
  ensureSpanIds,
  ensureVoltaIds,
} from '@/lib/music/spans'
import { ensureTechniqueIds } from '@/lib/music/techniques'
import { callWithFailover } from '@/lib/providers/callWithFailover'
import type {
  Effort,
  LLMProvider,
  ProviderCallOptions,
  ProviderName,
  ProviderToolResult,
  SystemBlock,
  Tier,
} from '@/lib/providers/types'
import type { NeutralMessage } from '@/lib/providers/conversation'

export interface ScoreCallTarget {
  provider: LLMProvider
  providerName: ProviderName
  tier: Tier
  chatId: string | undefined
}

export interface ScoreCallOptions {
  systemPrompt: string | SystemBlock[]
  /** Single-shot prompt. Provide this OR `history` (history wins). */
  userText?: string
  /**
   * Multi-turn neutral history to seed the FIRST call with (e.g. a replayed
   * transcript). The validation-retry loop appends to it. When omitted, the
   * loop seeds from `userText` on the first failure (the original behavior).
   */
  history?: NeutralMessage[]
  /**
   * Optional tool description forwarded to the render_score tool definition.
   * Set it to keep a migrated legacy call byte-identical to the path it
   * replaces (the registry's SCORE_TOOL omits the description by default).
   */
  toolDescription?: string
  maxTokens?: number
  temperature?: number
  /** Reasoning effort — forwarded to ProviderCallOptions.effort (dropped on
   *  models that don't support it). Set 'low' on bounded structured emits. */
  effort?: Effort
  /** Extended-thinking mode — forwarded to ProviderCallOptions.thinking.
   *  'disabled' is right for forced single-tool emission. */
  thinking?: 'disabled' | 'adaptive'
  modelOverride?: string
  apiKeyOverride?: string
  providerOptions?: ProviderCallOptions['providerOptions']
  /** Total attempts = 1 + maxRetries. Default 2. */
  maxRetries?: number
}

const SCORE_TOOL = {
  name: RENDER_SCORE_TOOL_NAME,
  inputSchema: ScoreSchema,
  inputSchemaJson: renderScoreTool.input_schema as unknown as Record<string, unknown>,
}

/**
 * Provider-call wrapper that mirrors `completeWithRetry`'s
 * validation-retry loop for the orchestrator handlers. On a semantic
 * ValidationError (e.g. measure-duration mismatch), it appends the
 * failed assistant turn + a `tool_result(is_error: true)` referencing
 * the failed tool_use id, then retries — Claude can see what it
 * produced and correct it.
 *
 * Without this, a single model arithmetic slip in `runGenerateComplex`
 * / `runCompose` would surface as an unrecoverable 422 even though the
 * legacy single-shot path has been self-correcting for the same class
 * of errors all along.
 */
export async function callWithScoreRetry(
  target: ScoreCallTarget,
  opts: ScoreCallOptions,
): Promise<ProviderToolResult<Score>> {
  const maxRetries = opts.maxRetries ?? 2
  const baseCall: Omit<ProviderCallOptions, 'userText' | 'history'> = {
    systemPrompt: opts.systemPrompt,
    toolChoice: 'required',
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    ...(opts.modelOverride !== undefined ? { modelOverride: opts.modelOverride } : {}),
    ...(opts.apiKeyOverride !== undefined ? { apiKeyOverride: opts.apiKeyOverride } : {}),
    ...(opts.providerOptions !== undefined ? { providerOptions: opts.providerOptions } : {}),
  }

  // ProviderCallOptions.history is the neutral IR — every block built here
  // must be neutral-modelable (text / tool_use / tool_result), since the
  // Anthropic adapter (toAnthropicMessages), not the API, is now the shape
  // gate. Built from scratch from app strings + the current call's parsed
  // output; no stored/DB history flows in.
  // Seed from a caller-provided transcript when present; otherwise the loop
  // seeds from userText on the first validation failure (original behavior).
  let history: NeutralMessage[] | undefined = opts.history ? [...opts.history] : undefined
  let lastError: ValidationError | undefined

  // Keep a migrated legacy call byte-identical by forwarding the tool
  // description; default registry calls leave it off (description: '').
  const tool =
    opts.toolDescription !== undefined
      ? { ...SCORE_TOOL, description: opts.toolDescription }
      : SCORE_TOOL

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const callOpts: ProviderCallOptions = history
      ? { ...baseCall, history }
      : { ...baseCall, userText: opts.userText }

    const result = await callWithFailover<Score>(target, tool, callOpts)

    try {
      validateScore(result.input)
      // Backfill technique ids — the LLM emits techniqueStates without
      // ids and downstream edit-op handlers resolve changes by id.
      // Mutating result.input directly is safe: it's the freshly-parsed
      // value, not shared with any other caller.
      ensureTechniqueIds(result.input)
      // Same pattern for annotations (M8-PR-1): the LLM emits
      // annotations[] without ids and update/remove ops resolve by id.
      // Mutates in place like ensureTechniqueIds.
      ensureAnnotationIds(result.input)
      // Same again for mid-piece markers (M9-PR-1) — the LLM emits
      // markers[] without ids and update/remove ops resolve by id.
      ensureMarkerIds(result.input)
      // And for spans (M11-PR-1) — hairpins (and later slurs / 8va /
      // glissando) are addressed by id in remove/update ops.
      ensureSpanIds(result.input)
      // And for voltas (M17-PR-1) — VoltaSchema.id is REQUIRED, so
      // backfilling missing ids here avoids a hard validateScore
      // failure when the LLM emits voltas without ids.
      ensureVoltaIds(result.input)
      // And for jumpMarkers (M18-PR-1) — JumpMarkerSchema.id is
      // REQUIRED. M18-PR-3 will expose jumpMarkers via render_score;
      // wiring the backfill here ahead of the exposure lets the LLM
      // path stay consistent across PRs in this milestone.
      ensureJumpMarkerIds(result.input)
      // Segno + Coda landmarks (M18-PR-4). Both REQUIRED-id; the
      // wire schema and prompt instruct the LLM to mint ids, so
      // these helpers are defensive safety nets.
      ensureSegnoMarkerIds(result.input)
      ensureCodaMarkerIds(result.input)
      return result
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e
      lastError = e

      // Seed conversation history on the first failure so the model
      // sees its own bad output (assistant turn) and the validator's
      // complaint (user tool_result) on the retry.
      if (!history) {
        history = [{ role: 'user', content: [{ type: 'text', text: opts.userText ?? '' }] }]
      }
      history.push({
        role: 'assistant',
        content: [
          ...(result.introText ? [{ type: 'text' as const, text: result.introText }] : []),
          {
            type: 'tool_use' as const,
            id: result.toolUseId,
            name: RENDER_SCORE_TOOL_NAME,
            input: result.input as unknown as Record<string, unknown>,
          },
        ],
      })
      history.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: result.toolUseId,
            isError: true,
            content: `Score failed validation: ${e.describe()}. Call render_score again with the fix; keep everything else unchanged.`,
          },
        ],
      })
    }
  }

  throw lastError ?? new ValidationError('Retry loop exhausted with no captured error', 'unknown')
}
