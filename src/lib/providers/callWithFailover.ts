import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderName,
  ProviderTool,
  ProviderToolResult,
  Tier,
} from './types'
import { ProviderSchemaError } from './types'
import { reportProviderFailure } from './degradation'

/**
 * Single-attempt wrapper: invokes provider.toolCall, and on
 * ProviderSchemaError reports the failure to the degradation tracker
 * (so a subsequent selectProvider returns the fallback). Re-throws.
 *
 * Callers that want active fallback-on-failure should re-invoke
 * selectProvider after catching and try again. This keeps the wrapper
 * tiny while still wiring the per-chat degradation telemetry.
 */
export async function callWithFailover<T>(
  args: {
    provider: LLMProvider
    providerName: ProviderName
    tier: Tier
    chatId: string | undefined
  },
  tool: ProviderTool<T>,
  options: ProviderCallOptions,
): Promise<ProviderToolResult<T>> {
  try {
    return await args.provider.toolCall(tool, options)
  } catch (e) {
    if (e instanceof ProviderSchemaError && args.chatId) {
      reportProviderFailure(args.chatId, args.tier, args.providerName)
    }
    throw e
  }
}
