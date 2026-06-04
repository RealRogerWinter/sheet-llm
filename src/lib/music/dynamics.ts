import type { Dynamic, DynamicMarking, DynamicPrefix, Event } from './types'

/**
 * Returns the effective dynamic for an event as a structured
 * DynamicMarking. Honors `dynamic_structured` first; falls back
 * to the legacy `dynamic` enum wrapped as `{base: dynamic}`.
 * Returns undefined when no dynamic is set.
 */
export function getDynamicMarking(
  event: Pick<Event, 'dynamic' | 'dynamic_structured'>,
): DynamicMarking | undefined {
  if (event.dynamic_structured) return event.dynamic_structured
  if (event.dynamic && event.dynamic !== 'none') return { base: event.dynamic }
  return undefined
}

/**
 * Returns the base dynamic value (without prefix/suffix), or
 * undefined when no dynamic is set. Convenience for code that
 * just needs the loudness category.
 */
export function getDynamicBase(event: Pick<Event, 'dynamic' | 'dynamic_structured'>): Dynamic | undefined {
  return getDynamicMarking(event)?.base
}

/**
 * Format a structured DynamicMarking into its canonical text form.
 * "sub. p espressivo" for {base: 'p', prefix: 'sub.', suffix: 'espressivo'}.
 */
export function formatDynamic(d: DynamicMarking): string {
  const parts: string[] = []
  if (d.prefix) parts.push(d.prefix)
  parts.push(d.base)
  if (d.suffix) parts.push(d.suffix)
  return parts.join(' ')
}

/**
 * Parse a text dynamic ("sub. p espressivo", "ff", "poco mf marcato")
 * into a structured DynamicMarking, or return null if unparseable.
 */
export function parseDynamic(text: string): DynamicMarking | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 0) return null

  let prefix: DynamicPrefix | undefined
  let cursor = 0

  // Optional leading prefix.
  if (tokens[cursor] === 'sub.' || tokens[cursor] === 'sub') {
    prefix = 'sub.'
    cursor++
  } else if (
    tokens[cursor] === 'poco' ||
    tokens[cursor] === 'meno' ||
    tokens[cursor] === 'più'
  ) {
    prefix = tokens[cursor] as DynamicPrefix
    cursor++
  }

  if (cursor >= tokens.length) return null

  const base = tokens[cursor++] as Dynamic
  if (!isValidDynamicBase(base)) return null

  const suffix = tokens.slice(cursor).join(' ')

  return {
    base,
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
  }
}

function isValidDynamicBase(value: string): value is Dynamic {
  return [
    'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff',
    'n',
    'fp', 'fz', 'sfz', 'sffz', 'sfp', 'sfpp', 'rfz', 'rfp', 'fzp',
    'none',
  ].includes(value)
}
