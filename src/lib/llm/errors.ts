/** HTTP 429 from the Anthropic API. */
export class RateLimitedError extends Error {
  constructor(message = 'Claude is rate-limited; try again in a minute') {
    super(message)
    this.name = 'RateLimitedError'
  }
}

/** Any other upstream failure (5xx, network, malformed response). */
export class UpstreamError extends Error {
  readonly status: number
  constructor(message: string, status = 502) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
  }
}

/**
 * No API key is configured for the active provider AND no per-request override
 * (BYOK) was supplied. SHE-8 BYOK correctness: the chat route maps this to a
 * friendly onboarding CTA ("add your API key in Settings") instead of letting
 * the raw `<ENV_VAR> is not set` message escape as a generic 5xx. Subclasses
 * `UpstreamError` so existing `instanceof UpstreamError` handlers still catch it
 * as a fallback; the route checks for this subclass FIRST.
 */
export class ProviderNotConfiguredError extends UpstreamError {
  readonly provider: string
  constructor(provider: string, envVar: string) {
    super(`${provider} provider is not configured (${envVar} is not set)`, 503)
    this.name = 'ProviderNotConfiguredError'
    this.provider = provider
  }
}
