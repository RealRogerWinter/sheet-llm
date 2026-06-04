import { abcToScore } from './abcToScore'
import { jsonToScore } from './jsonToScore'
import { midiToScore } from './midiToScore'
import { musicxmlToScore } from './musicxmlToScore'
import type { ImportFormat, ImportOptions, ImportResult } from './types'

export { detectFormat } from './detect'
export { abcToScore } from './abcToScore'
export { jsonToScore } from './jsonToScore'
export { midiToScore } from './midiToScore'
export { musicxmlToScore } from './musicxmlToScore'
export type {
  ImportFormat,
  ImportOptions,
  ImportResult,
  ImportWarning,
  ImportWarningCode,
  ImportWarningSeverity,
} from './types'

/**
 * Format-dispatching wrapper. Caller picks the format (typically via
 * `detectFormat`); we run the matching parser and bubble back the
 * uniform ImportResult shape.
 */
export function importScore(
  format: ImportFormat,
  payload: { text?: string; bytes?: Uint8Array },
  options: ImportOptions = {},
): ImportResult {
  switch (format) {
    case 'abc':
      return abcToScore(payload.text ?? '', options)
    case 'json':
      return jsonToScore(payload.text ?? '', options)
    case 'midi':
      return midiToScore(payload.bytes ?? new Uint8Array(), options)
    case 'musicxml':
      return musicxmlToScore(payload.text ?? '', options)
  }
}

/** True iff any warning is severity 'block'. */
export function hasBlockingWarnings(result: ImportResult): boolean {
  return result.warnings.some((w) => w.severity === 'block')
}
