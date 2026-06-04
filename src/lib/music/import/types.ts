import type { Score } from '../types'

export type ImportFormat = 'abc' | 'midi' | 'json' | 'musicxml'

export type ImportWarningSeverity = 'block' | 'choice' | 'info'

export type ImportWarningCode =
  | 'parse_failed'
  | 'schema_invalid'
  | 'too_long'
  | 'multi_voice'
  | 'multi_staff'
  | 'unsupported_mode'
  | 'unsupported_meter'
  | 'unsupported_key'
  | 'mid_piece_key_change'
  | 'mid_piece_meter_change'
  | 'anacrusis_padded'
  | 'tempo_dropped'
  | 'voice_picked'
  | 'duration_rounded'
  | 'tuplet_dropped'
  | 'unsupported_element'

export interface ImportWarning {
  severity: ImportWarningSeverity
  code: ImportWarningCode
  message: string
  /** Optional structured payload for UI choice rendering. */
  meta?: Record<string, unknown>
}

export interface ImportOptions {
  /** Accept truncation to MAX_MEASURES rather than rejecting. */
  truncateIfLong?: boolean
  /** Voice index to keep when the source is multi-voice. Default 0. */
  chooseVoice?: number
  /**
   * User-driven layout choice that overrides the importer's auto-
   * detected layout. Useful when MIDI/ABC heuristics misclassify
   * (e.g. user wants single-staff but importer detected SATB).
   *
   * - 'single': flatten to one staff, one voice (busiest source).
   * - 'grand-staff': force two staves, one voice each.
   * - 'satb': force two staves, two voices each.
   *
   * When unset, importers apply their own cascade.
   */
  layoutOverride?: 'single' | 'grand-staff' | 'satb'
}

export interface ImportResult {
  score: Score
  warnings: ImportWarning[]
  format: ImportFormat
}
