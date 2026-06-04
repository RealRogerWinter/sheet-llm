import { ScoreSchema } from '../types'
import { normalize } from './normalize'
import type { ImportOptions, ImportResult, ImportWarning } from './types'

/**
 * Parse a JSON payload as a Score and normalize. Accepts either an
 * already-parsed object or a raw JSON string.
 *
 * Schema violations become a single `block` warning rather than a
 * thrown error so the import endpoint can return all problems
 * uniformly through the warnings channel.
 */
export function jsonToScore(input: string | unknown, options: ImportOptions = {}): ImportResult {
  let parsed: unknown
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'JSON parse failed'
      return {
        score: emptyScore(),
        format: 'json',
        warnings: [
          { severity: 'block', code: 'parse_failed', message: `JSON parse error: ${msg}` },
        ],
      }
    }
  } else {
    parsed = input
  }

  const result = ScoreSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    return {
      score: emptyScore(),
      format: 'json',
      warnings: [
        {
          severity: 'block',
          code: 'schema_invalid',
          message: `Score JSON doesn't match our schema: ${issues}`,
        },
      ],
    }
  }

  const warnings: ImportWarning[] = []
  const { score, warnings: normWarnings } = normalize(result.data, options)
  warnings.push(...normWarnings)

  return { score, format: 'json', warnings }
}

/** Placeholder Score returned alongside block warnings — never used
 * by the route once a block warning is present. Defined separately
 * so we don't pretend to return real music after a parse failure. */
function emptyScore() {
  return {
    key: 'C' as const,
    meter: '4/4' as const,
    measures: [
      {
        events: [{ pitches: [{ step: 'rest' as const, octave: 4 }], duration: 'whole' as const }],
      },
    ],
  }
}
