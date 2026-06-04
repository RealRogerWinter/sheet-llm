import type { ModelEntry, ProviderCapabilities, ProviderName, Tier } from './types'

const ANTHROPIC_CAPS: ProviderCapabilities = {
  promptCaching: true,
  nativeToolUse: 'native',
  strictJsonSchema: false,
  estimatedCallMs: 2_000,
}

const GROQ_CAPS: ProviderCapabilities = {
  promptCaching: false,
  nativeToolUse: 'native',
  strictJsonSchema: true,
  estimatedCallMs: 800,
}

const OLLAMA_CAPS: ProviderCapabilities = {
  promptCaching: false,
  nativeToolUse: 'fragile',
  strictJsonSchema: false,
  estimatedCallMs: 10_000,
}

/**
 * Declarative model registry. PR B has Anthropic entries only.
 * PR C adds Groq, PR D adds Ollama.
 */
export const REGISTRY: Record<ProviderName, Partial<Record<Tier, ModelEntry>>> = {
  anthropic: {
    small: {
      modelId: 'claude-haiku-4-5-20251001',
      capabilities: { ...ANTHROPIC_CAPS, estimatedCallMs: 1_500 },
    },
    medium: {
      modelId: 'claude-sonnet-4-6',
      capabilities: { ...ANTHROPIC_CAPS, estimatedCallMs: 3_000 },
    },
    large: {
      modelId: 'claude-opus-4-7',
      capabilities: { ...ANTHROPIC_CAPS, estimatedCallMs: 6_000 },
    },
  },
  groq: {
    small: {
      modelId: 'openai/gpt-oss-20b',
      capabilities: { ...GROQ_CAPS, estimatedCallMs: 600 },
    },
    medium: {
      modelId: 'openai/gpt-oss-120b',
      capabilities: { ...GROQ_CAPS, estimatedCallMs: 1_200 },
    },
    large: {
      modelId: 'openai/gpt-oss-120b',
      capabilities: { ...GROQ_CAPS, estimatedCallMs: 1_500 },
    },
  },
  ollama: {
    small: {
      modelId: 'qwen2.5:7b-instruct',
      capabilities: { ...OLLAMA_CAPS, estimatedCallMs: 6_000 },
    },
    medium: {
      modelId: 'qwen2.5:14b-instruct',
      capabilities: { ...OLLAMA_CAPS, estimatedCallMs: 12_000 },
    },
    large: {
      modelId: 'qwen2.5:14b-instruct',
      capabilities: { ...OLLAMA_CAPS, estimatedCallMs: 15_000 },
    },
  },
}

export function getModelEntry(provider: ProviderName, tier: Tier): ModelEntry | undefined {
  return REGISTRY[provider]?.[tier]
}

export const PROVIDER_API_KEY_ENV: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  ollama: '', // local, no key
}

export function isProviderConfigured(provider: ProviderName): boolean {
  if (provider === 'ollama') return true // local; assumed reachable when chosen
  const envVar = PROVIDER_API_KEY_ENV[provider]
  return envVar.length > 0 && !!process.env[envVar]
}
