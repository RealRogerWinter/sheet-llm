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
