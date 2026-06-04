import type { Event, Fingering } from './types'

type PianoDigit = '0' | '1' | '2' | '3' | '4' | '5'
type StringFinger = 0 | 1 | 2 | 3 | 4
type GuitarLHDigit = 1 | 2 | 3 | 4
type GuitarRHLetter = 'p' | 'i' | 'm' | 'a' | 'c'
type StringRoman = 'I' | 'II' | 'III' | 'IV'

const PIANO_DIGITS = new Set(['0', '1', '2', '3', '4', '5'])
const GUITAR_LH_DIGITS = new Set(['1', '2', '3', '4'])
const GUITAR_RH_LETTERS = new Set(['p', 'i', 'm', 'a', 'c'])
const STRING_ROMANS = new Set(['I', 'II', 'III', 'IV'])

/**
 * Forgiving shorthand parser for the Dorico-style Shift+F fingerings
 * popover. Returns a discriminated-union Fingering when the input maps
 * to a recognized form, or `undefined` when the text can't be reconciled
 * with any system. The parser is intentionally biased toward piano
 * defaults — the most common case in a notation editor.
 *
 * Recognized shorthand:
 * - `0..5`           → piano (e.g. "3")
 * - `N-M` / `N>M`    → piano with substitution (`{value:'N', substitution:'N-M'}`)
 * - `p`/`i`/`m`/`a`/`c` → guitar-rh
 * - `N.RR`           → string finger N + Roman string (e.g. "1.IV")
 * - `Nh` / `Nt`      → organ + heel/toe (case-insensitive H/T)
 * - `N(` / `N)`      → organ + thumb-direction glyph
 *
 * Guitar-lh requires an explicit `lh:N` prefix since unprefixed digits
 * default to piano. Explicit system prefixes (`piano:N`, `string:N.RR`,
 * `lh:N`, `rh:LETTER`, `organ:N`) are accepted for any system when the
 * user wants to disambiguate.
 */
export function parseFingering(text: string): Fingering | undefined {
  const t = text.trim()
  if (t === '') return undefined

  // Explicit system prefix: "system:rest"
  const prefixMatch = t.match(/^(piano|string|lh|rh|organ)\s*:\s*(.+)$/i)
  if (prefixMatch) {
    return parseWithSystem(prefixMatch[1].toLowerCase(), prefixMatch[2])
  }

  // guitar-rh: single Spanish letter
  if (GUITAR_RH_LETTERS.has(t)) {
    return { system: 'guitar-rh', value: t as GuitarRHLetter }
  }

  // string: N.RR (digit 0-4 + Roman I..IV)
  const stringMatch = t.match(/^([0-4])\s*\.\s*(I{1,3}|IV)$/)
  if (stringMatch && STRING_ROMANS.has(stringMatch[2])) {
    return {
      system: 'string',
      finger: Number(stringMatch[1]) as StringFinger,
      stringRoman: stringMatch[2] as StringRoman,
    }
  }

  // organ thumb direction: N( or N)
  const organThumb = t.match(/^([0-5])([()])$/)
  if (organThumb) {
    return {
      system: 'organ',
      value: organThumb[1] as PianoDigit,
      thumbDirection: organThumb[2] as '(' | ')',
    }
  }

  // organ heel/toe: Nh or Nt (case-insensitive)
  const organFoot = t.match(/^([0-5])\s*([htHT])$/)
  if (organFoot) {
    return {
      system: 'organ',
      value: organFoot[1] as PianoDigit,
      foot: organFoot[2].toLowerCase() === 'h' ? 'heel' : 'toe',
    }
  }

  // piano substitution: N-M or N>M
  const pianoSub = t.match(/^([0-5])\s*([->])\s*([0-5])$/)
  if (pianoSub) {
    return {
      system: 'piano',
      value: pianoSub[1] as PianoDigit,
      substitution: `${pianoSub[1]}${pianoSub[2]}${pianoSub[3]}`,
    }
  }

  // Bare digit 0-5 → piano (the default when ambiguous)
  if (/^[0-5]$/.test(t)) {
    return { system: 'piano', value: t as PianoDigit }
  }

  return undefined
}

function parseWithSystem(system: string, rest: string): Fingering | undefined {
  const r = rest.trim()
  switch (system) {
    case 'piano': {
      const sub = r.match(/^([0-5])\s*([->])\s*([0-5])$/)
      if (sub) {
        return {
          system: 'piano',
          value: sub[1] as PianoDigit,
          substitution: `${sub[1]}${sub[2]}${sub[3]}`,
        }
      }
      return PIANO_DIGITS.has(r) ? { system: 'piano', value: r as PianoDigit } : undefined
    }
    case 'string': {
      const withRoman = r.match(/^([0-4])\s*\.\s*(I{1,3}|IV)$/)
      if (withRoman && STRING_ROMANS.has(withRoman[2])) {
        return {
          system: 'string',
          finger: Number(withRoman[1]) as StringFinger,
          stringRoman: withRoman[2] as StringRoman,
        }
      }
      if (/^[0-4]$/.test(r)) {
        return { system: 'string', finger: Number(r) as StringFinger }
      }
      return undefined
    }
    case 'lh': {
      // Optional stringNum in parens and/or Roman fret after slash.
      // Examples: "1", "1(6)", "1/V", "1(6)/V". Fret is capped at 5
      // chars to match GuitarLHFingeringSchema.fret.max(5) so the
      // parser rejects oversized input up-front rather than letting
      // applyEdit pass an over-cap value into the store (which routes
      // through transformScore, not the Zod-validating applyOperation).
      const full = r.match(/^([1-4])(?:\((\d)\))?(?:\s*\/\s*([IVX]{1,5}))?$/)
      if (full) {
        const value = Number(full[1]) as GuitarLHDigit
        const stringNum = full[2] !== undefined ? (Number(full[2]) as 1 | 2 | 3 | 4 | 5 | 6) : undefined
        const fret = full[3]
        if (stringNum !== undefined && (stringNum < 1 || stringNum > 6)) return undefined
        return {
          system: 'guitar-lh',
          value,
          ...(stringNum !== undefined ? { stringNum } : {}),
          ...(fret !== undefined ? { fret } : {}),
        }
      }
      return undefined
    }
    case 'rh': {
      return GUITAR_RH_LETTERS.has(r) ? { system: 'guitar-rh', value: r as GuitarRHLetter } : undefined
    }
    case 'organ': {
      const thumb = r.match(/^([0-5])([()])$/)
      if (thumb) {
        return {
          system: 'organ',
          value: thumb[1] as PianoDigit,
          thumbDirection: thumb[2] as '(' | ')',
        }
      }
      const foot = r.match(/^([0-5])\s*([htHT])$/)
      if (foot) {
        return {
          system: 'organ',
          value: foot[1] as PianoDigit,
          foot: foot[2].toLowerCase() === 'h' ? 'heel' : 'toe',
        }
      }
      if (PIANO_DIGITS.has(r)) {
        return { system: 'organ', value: r as PianoDigit }
      }
      return undefined
    }
  }
  return undefined
}

/**
 * Render a Fingering as the canonical shorthand. The output of
 * `formatFingering` is intended for the popover preview line and the
 * pre-fill seed when editing an existing fingering. Round-trip with
 * `parseFingering` for systems that have a unique shorthand: piano,
 * string, guitar-rh, organ. Guitar-lh requires an `lh:` prefix on
 * input but is formatted without it because the popover header
 * already names the system; users who paste the formatted output
 * back must re-add the prefix manually.
 */
export function formatFingering(f: Fingering): string {
  switch (f.system) {
    case 'piano':
      return f.substitution !== undefined && f.substitution !== ''
        ? f.substitution
        : f.value
    case 'string':
      return f.stringRoman !== undefined ? `${f.finger}.${f.stringRoman}` : String(f.finger)
    case 'guitar-lh': {
      let s = String(f.value)
      if (f.stringNum !== undefined) s += `(${f.stringNum})`
      if (f.fret !== undefined) s += `/${f.fret}`
      return s
    }
    case 'guitar-rh':
      return f.value
    case 'organ': {
      let s = f.value
      if (f.foot === 'heel') s += 'h'
      else if (f.foot === 'toe') s += 't'
      if (f.thumbDirection !== undefined) s += f.thumbDirection
      return s
    }
  }
}

/**
 * Return the fingering attached to `pitches[pitchIdx]`, or undefined
 * when no fingering is set. Trailing pitches without an entry in
 * `event.fingerings` and interior null slots both surface as undefined,
 * so callers don't need to distinguish "array shorter than chord" from
 * "explicit null slot".
 */
export function getFingering(event: Event, pitchIdx: number): Fingering | undefined {
  if (!event.fingerings) return undefined
  if (pitchIdx < 0 || pitchIdx >= event.fingerings.length) return undefined
  return event.fingerings[pitchIdx] ?? undefined
}

/**
 * Set the fingering at `pitchIdx` on the event, returning a new Event.
 * Pads the array with null for any missing earlier slots so the index
 * stays aligned with `pitches`. Out-of-range pitchIdx (< 0 or beyond
 * the chord) is the caller's responsibility — editOperations.ts guards
 * with the existing pitch-bounds check before invoking.
 */
export function setFingeringAt(event: Event, pitchIdx: number, fingering: Fingering): Event {
  const existing = event.fingerings ?? []
  const next: Array<Fingering | null> = []
  for (let i = 0; i <= pitchIdx; i++) {
    if (i === pitchIdx) next.push(fingering)
    else next.push(i < existing.length ? existing[i] : null)
  }
  // Preserve any later slots beyond pitchIdx so adjacent fingerings
  // aren't truncated when overwriting the middle of a chord.
  for (let i = pitchIdx + 1; i < existing.length; i++) {
    next.push(existing[i])
  }
  return { ...event, fingerings: next }
}

/**
 * Clear the fingering at `pitchIdx`. Sets the slot to null, then trims
 * trailing nulls so the persisted JSON stays compact. When the
 * resulting array is empty the field is dropped from the event entirely
 * — matching the convention used for other optional fields.
 */
export function removeFingeringAt(event: Event, pitchIdx: number): Event {
  const existing = event.fingerings
  if (!existing || existing.length === 0) return event
  if (pitchIdx < 0 || pitchIdx >= existing.length) return event
  const next: Array<Fingering | null> = existing.slice()
  next[pitchIdx] = null
  while (next.length > 0 && next[next.length - 1] === null) {
    next.pop()
  }
  if (next.length === 0) {
    const { fingerings: _drop, ...rest } = event
    void _drop
    return rest
  }
  return { ...event, fingerings: next }
}
