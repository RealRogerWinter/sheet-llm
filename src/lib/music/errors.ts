export type ValidationErrorCode =
  | 'schema_error'
  | 'measure_duration_mismatch'
  | 'tuplet_incomplete'
  | 'rest_in_chord'
  | 'abc_parse_failed'
  | 'span_endpoint_missing'
  | 'span_cross_voice'
  | 'span_reversed'
  | 'jump_ref_missing'
  | 'pitch_tie_target_missing'
  | 'marker_duplicate'
  | 'volta_endings_invalid'
  | 'technique_state_invalid'
  | 'unknown'

export interface ValidationErrorLocation {
  measure?: number
  event?: number
}

export class ValidationError extends Error {
  readonly code: ValidationErrorCode
  readonly location?: ValidationErrorLocation

  constructor(message: string, code: ValidationErrorCode, location?: ValidationErrorLocation) {
    super(message)
    this.name = 'ValidationError'
    this.code = code
    this.location = location
  }

  /** Format for inclusion in an LLM retry prompt. */
  describe(): string {
    const loc = this.location
      ? `measure ${this.location.measure}${this.location.event !== undefined ? `, event ${this.location.event}` : ''}`
      : 'unknown location'
    return `${this.code} at ${loc}: ${this.message}`
  }
}
