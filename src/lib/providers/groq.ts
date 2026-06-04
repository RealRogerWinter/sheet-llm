import { OpenAICompatibleProvider } from './openaiCompatible'
import type { ProviderCapabilities } from './types'

/** Default capabilities for Groq's gpt-oss models. */
export const GROQ_CAPABILITIES: ProviderCapabilities = {
  promptCaching: false, // Groq has prompt caching on gpt-oss but exposed differently; not wired in PR C.
  nativeToolUse: 'native',
  strictJsonSchema: true, // gpt-oss-20b / gpt-oss-120b support response_format: json_schema strict
  estimatedCallMs: 800,
}

/**
 * GroqProvider — extends the generic OpenAI-compatible base with
 * Groq's hosted endpoint. The base class does all the work; this
 * class exists so callers can `instanceof GroqProvider` and so the
 * default model id is set sanely if the registry forgets one.
 */
export class GroqProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      name: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKeyEnv: 'GROQ_API_KEY',
      defaultModel: 'openai/gpt-oss-20b',
      capabilities: GROQ_CAPABILITIES,
    })
  }
}
