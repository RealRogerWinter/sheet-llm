import type { LLMProvider, ProviderName, Tier } from './types'
import { getModelEntry, isProviderConfigured } from './registry'
import { getSticky, setSticky } from './sticky'
import { isProviderDegraded } from './degradation'
import { AnthropicProvider } from './anthropic'
import { GroqProvider } from './groq'
import { OllamaProvider } from './ollama'

const ENV_BY_TIER: Record<Tier, string> = {
  small: 'PROVIDER_SMALL',
  medium: 'PROVIDER_MEDIUM',
  large: 'PROVIDER_LARGE',
}

const VALID_PROVIDERS: ReadonlyArray<ProviderName> = ['anthropic', 'groq', 'ollama']

function isProviderName(s: string): s is ProviderName {
  return (VALID_PROVIDERS as readonly string[]).includes(s)
}

function readEnvProvider(tier: Tier): ProviderName {
  const v = process.env[ENV_BY_TIER[tier]]
  if (v && isProviderName(v)) return v
  return 'anthropic'
}

function readFallbackProvider(): ProviderName {
  const v = process.env.PROVIDER_FALLBACK
  if (v && isProviderName(v)) return v
  return 'anthropic'
}

const instances: Partial<Record<ProviderName, LLMProvider>> = {}

function instantiate(name: ProviderName): LLMProvider {
  if (instances[name]) return instances[name]!
  switch (name) {
    case 'anthropic': {
      const p = new AnthropicProvider()
      instances.anthropic = p
      return p
    }
    case 'groq': {
      const p = new GroqProvider()
      instances.groq = p
      return p
    }
    case 'ollama': {
      const p = new OllamaProvider()
      instances.ollama = p
      return p
    }
  }
}

export interface SelectedProvider {
  provider: LLMProvider
  providerName: ProviderName
  model: string
  tier: Tier
}

/**
 * Resolve a provider + model for the given tier in the given chat.
 *
 * Order of preference:
 *   1. Sticky selection from a prior turn in the same chat.
 *   2. PROVIDER_<TIER> env var.
 *   3. PROVIDER_FALLBACK env var.
 *   4. 'anthropic' built-in default.
 *
 * If the resolved provider isn't configured (e.g. PROVIDER_SMALL=groq
 * but GROQ_API_KEY missing) AND a fallback is available + configured,
 * the fallback wins and the sticky record is updated.
 */
export function selectProvider(tier: Tier, chatId: string | undefined): SelectedProvider {
  const stickyName = chatId ? getSticky(chatId, tier) : undefined
  const desired: ProviderName = stickyName ?? readEnvProvider(tier)

  let chosen: ProviderName = desired

  // Degradation auto-failover: if the chosen provider has been
  // reported failing on this chat+tier ≥ DEGRADATION_THRESHOLD times,
  // route to the configured fallback for the rest of the conversation.
  if (chatId && isProviderDegraded(chatId, tier, chosen)) {
    const fb = readFallbackProvider()
    if (fb !== chosen && isProviderConfigured(fb)) chosen = fb
  }

  if (!isProviderConfigured(chosen)) {
    const fallback = readFallbackProvider()
    if (isProviderConfigured(fallback)) chosen = fallback
  }

  const entry = getModelEntry(chosen, tier)
  if (!entry) {
    chosen = 'anthropic'
  }
  const finalEntry = getModelEntry(chosen, tier)
  if (!finalEntry) {
    throw new Error(`No model registered for ${chosen}:${tier}`)
  }

  if (chatId && !stickyName) setSticky(chatId, tier, chosen)
  return {
    provider: instantiate(chosen),
    providerName: chosen,
    model: finalEntry.modelId,
    tier,
  }
}
