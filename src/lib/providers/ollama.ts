import { OpenAICompatibleProvider } from './openaiCompatible'
import type { ProviderCapabilities, ProviderTool } from './types'

const OLLAMA_CAPABILITIES: ProviderCapabilities = {
  promptCaching: false,
  // Native tool-use through Ollama's OpenAI-compat endpoint works on
  // Qwen2.5 / Llama 3.x but is fragile under 14B (community reports
  // ~10–15% schema violations even on tool-capable models).
  nativeToolUse: 'fragile',
  // Ollama's /v1 accepts response_format json_object but not strict
  // schema. The reliable path is the `format: <jsonSchema>` parameter
  // (grammar-constrained sampling) which lives OUTSIDE the OpenAI
  // shape — wired via extendRequestBody below.
  strictJsonSchema: false,
  estimatedCallMs: 10_000,
}

/**
 * OllamaProvider — extends the OpenAI-compatible base with Ollama's
 * grammar-constrained `format` parameter (passed alongside the tool
 * definition for stronger schema adherence on smaller local models).
 */
export class OllamaProvider extends OpenAICompatibleProvider {
  constructor(baseUrl?: string) {
    super({
      name: 'ollama',
      baseUrl: baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
      apiKeyEnv: '', // keyless — local
      defaultModel: 'qwen2.5:14b-instruct',
      capabilities: OLLAMA_CAPABILITIES,
      extendRequestBody: (body: Record<string, unknown>, tool: ProviderTool<unknown>) => {
        // Ollama's grammar-constrained sampling. Constrains generation
        // to JSON that matches the schema even when the model's native
        // tool-use is unreliable.
        body.format = tool.inputSchemaJson
      },
    })
  }
}
