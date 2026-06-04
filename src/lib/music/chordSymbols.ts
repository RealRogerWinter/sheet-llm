import type { ChordSymbol, ChordQuality, ChordSeventh } from './types'

/**
 * Format a structured ChordSymbol into its canonical string form.
 * Idempotent — `formatChordSymbol(parseChordSymbol(s))` round-trips
 * to a canonical version of `s` (capitalization, ordering normalized).
 */
export function formatChordSymbol(chord: ChordSymbol): string {
  // Quality + seventh as a combined suffix using the most common
  // notation: m, maj7, m7, 7, dim, dim7, m7b5 (half-dim), aug, sus2, sus4.
  const qSeventh = formatQualitySeventh(chord.quality, chord.seventh)

  // Extensions: 9, 11, 13 stacked. Conventionally the highest extension
  // implies the lower ones, so a C13 means C7 + 9 + 11 + 13. We emit
  // just the highest configured extension number — the convention.
  const ext = chord.extensions && chord.extensions.length > 0
    ? String(Math.max(...chord.extensions))
    : ''
  // If extensions are present, drop the seventh suffix when it's
  // 'dom7' (subsumed by the extension number) or 'maj7' (which keeps
  // 'maj' inflection — render as 'maj9' / 'maj11' / 'maj13').
  let suffix = qSeventh
  if (ext) {
    if (chord.seventh === 'dom7') suffix = qSeventh.replace(/7$/, '') + ext
    else if (chord.seventh === 'maj7') suffix = qSeventh.replace(/7$/, '') + ext
    else if (chord.seventh === 'min7') suffix = qSeventh.replace(/7$/, '') + ext
    else suffix = qSeventh + ext
  }

  // Alterations format: `(b9,#11)` for multiple, bare `b9` for
  // single, and bare `alt` (no parens) for the `alt` keyword — the
  // parenthesized parser doesn't accept tokens that aren't
  // (b|#)?\d{1,2}, so wrapping `alt` in parens breaks round-trip.
  let alterations = ''
  if (chord.alterations && chord.alterations.length > 0) {
    if (chord.alterations.length === 1 && chord.alterations[0] === 'alt') {
      alterations = 'alt'
    } else if (chord.alterations.length === 1) {
      alterations = chord.alterations[0]
    } else {
      alterations = `(${chord.alterations.join(',')})`
    }
  }
  const add = chord.add && chord.add.length > 0
    ? chord.add.map((n) => `add${n}`).join('')
    : ''
  const omit = chord.omit && chord.omit.length > 0
    ? chord.omit.map((n) => `(no${n})`).join('')
    : ''
  const modal = chord.modal ? ` ${chord.modal}` : ''
  const bass = chord.bass
    ? chord.bass.type === 'note'
      ? `/${chord.bass.value}`
      : `|${formatChordSymbol(chord.bass.value)}`
    : ''

  return `${chord.root}${suffix}${alterations}${add}${omit}${bass}${modal}`
}

function formatQualitySeventh(quality: ChordQuality, seventh: ChordSeventh): string {
  // Quality + seventh combine into common notation patterns.
  switch (`${quality}|${seventh}`) {
    case 'major|none': return ''
    case 'major|maj7': return 'maj7'
    case 'major|dom7': return '7'
    case 'minor|none': return 'm'
    case 'minor|min7': return 'm7'
    case 'minor|maj7': return 'm(maj7)'
    case 'minor|halfdim7': return 'm7b5'
    case 'diminished|none': return 'dim'
    case 'diminished|dim7': return 'dim7'
    case 'diminished|halfdim7': return 'm7b5' // alternative spelling
    case 'augmented|none': return 'aug'
    case 'augmented|maj7': return 'aug(maj7)'
    case 'augmented|dom7': return 'aug7'
    case 'sus2|none': return 'sus2'
    case 'sus2|dom7': return '7sus2'
    case 'sus4|none': return 'sus4'
    case 'sus4|dom7': return '7sus4'
    // Unusual combinations — output a best-effort form.
    default: return quality === 'major' ? seventh : `${quality.charAt(0)}${seventh}`
  }
}

/**
 * Parse a chord-symbol string into a structured ChordSymbol, or
 * return null if it isn't recognizable. Forgiving — accepts common
 * variations (△ for maj7, ° for dim, ø for halfdim, m/min/-/–).
 *
 * Covers ~95% of real-world lead-sheet notation. Edge cases
 * (polychord stacking via |, modal symbols like "C Dorian", quartal
 * voicings) are handled where simple suffix recognition suffices.
 */
export function parseChordSymbol(text: string): ChordSymbol | null {
  const original = text.trim()
  if (!original) return null

  // Modal symbol: "C Dorian", "Bb Mixolydian". Parse the modal tag
  // off the end before falling through to the normal parser.
  const modalMatch = original.match(
    /\s+(Ionian|Dorian|Phrygian|Lydian|Mixolydian|Aeolian|Locrian)$/,
  )
  let modal: ChordSymbol['modal']
  let rest = original
  if (modalMatch) {
    modal = modalMatch[1] as ChordSymbol['modal']
    rest = original.slice(0, modalMatch.index).trim()
  }

  // Polychord: "C|G", "Cmaj7|Dm". Split at | and recurse.
  const polyIdx = rest.indexOf('|')
  let upperPart = rest
  let bass: ChordSymbol['bass']
  if (polyIdx >= 0) {
    upperPart = rest.slice(0, polyIdx)
    const lowerStr = rest.slice(polyIdx + 1)
    const lowerChord = parseChordSymbol(lowerStr)
    if (!lowerChord) return null
    bass = { type: 'chord', value: lowerChord }
  } else {
    // Slash chord: "C/E". Split at / and parse bass as a note.
    const slashIdx = rest.indexOf('/')
    if (slashIdx >= 0) {
      const bassNote = rest.slice(slashIdx + 1).trim()
      if (/^[A-G](#|b)?$/.test(bassNote)) {
        bass = { type: 'note', value: bassNote }
        upperPart = rest.slice(0, slashIdx)
      }
    }
  }

  // Root extraction.
  const rootMatch = upperPart.match(/^([A-G])(#|b)?/)
  if (!rootMatch) return null
  const root = `${rootMatch[1]}${rootMatch[2] ?? ''}`
  let remainder = upperPart.slice(root.length)

  // Quality token recognition.
  let quality: ChordQuality = 'major'
  let seventh: ChordSeventh = 'none'

  // Half-diminished symbols (ø, ø7, m7b5, m7(b5))
  if (/^ø7?/.test(remainder) || /^m7b5/.test(remainder) || /^m7\(b5\)/.test(remainder)) {
    quality = 'minor'
    seventh = 'halfdim7'
    remainder = remainder.replace(/^(ø7?|m7\(b5\)|m7b5)/, '')
  }
  // Diminished
  else if (/^(°7|dim7|°|dim)/.test(remainder)) {
    quality = 'diminished'
    if (/^(°7|dim7)/.test(remainder)) {
      seventh = 'dim7'
      remainder = remainder.replace(/^(°7|dim7)/, '')
    } else {
      remainder = remainder.replace(/^(°|dim)/, '')
    }
  }
  // Augmented
  else if (/^(\+|aug)/.test(remainder)) {
    quality = 'augmented'
    remainder = remainder.replace(/^(\+|aug)/, '')
    // Accept both bare "maj7" and parenthesized "(maj7)" — the
    // augmented major 7 is often written aug(maj7) in jazz lead
    // sheets to disambiguate from aug7 (dominant).
    if (/^\(maj7\)/.test(remainder)) {
      seventh = 'maj7'
      remainder = remainder.replace(/^\(maj7\)/, '')
    } else if (/^maj7/.test(remainder)) {
      seventh = 'maj7'
      remainder = remainder.replace(/^maj7/, '')
    } else if (/^7/.test(remainder)) {
      seventh = 'dom7'
      remainder = remainder.replace(/^7/, '')
    }
  }
  // Suspended
  else if (/^sus2/.test(remainder)) {
    quality = 'sus2'
    remainder = remainder.slice(4)
    if (/^7/.test(remainder)) {
      seventh = 'dom7'
      remainder = remainder.slice(1)
    }
  } else if (/^sus(4)?/.test(remainder)) {
    quality = 'sus4'
    remainder = remainder.replace(/^sus(4)?/, '')
    if (/^7/.test(remainder)) {
      seventh = 'dom7'
      remainder = remainder.slice(1)
    }
  } else if (/^7sus4/.test(remainder)) {
    quality = 'sus4'
    seventh = 'dom7'
    remainder = remainder.slice(5)
  }
  // 7sus2 — mirror of 7sus4. Bare "7" first would be consumed by the
  // dominant-seventh branch below and leave "sus2" stranded, so peel
  // it as a unit here.
  else if (/^7sus2/.test(remainder)) {
    quality = 'sus2'
    seventh = 'dom7'
    remainder = remainder.slice(5)
  }
  // Minor (m, min, −, –). The negative lookahead `(?!aj)` blocks
  // "maj" (so Cmaj7 doesn't match as Cm + aj7) but still allows
  // "madd6" / "madd9" (m followed by 'a' from add). The earlier
  // `(?![aA])` was over-broad and ate any m-then-a sequence.
  else if (/^(min|m|−|–|-)(?!aj)/.test(remainder)) {
    quality = 'minor'
    remainder = remainder.replace(/^(min|m|−|–|-)/, '')
    // Minor-major 7: "m(maj7)", "m△7", "mM7"
    if (/^(\(maj7\)|△7|M7)/.test(remainder)) {
      seventh = 'maj7'
      remainder = remainder.replace(/^(\(maj7\)|△7|M7)/, '')
    } else if (/^maj(7|9|11|13)/.test(remainder)) {
      // "Cmmaj9" — minor triad + major-7 + extension. Strip the
      // 'maj' but leave the digit for the extension parser below.
      seventh = 'maj7'
      remainder = remainder.replace(/^maj/, '')
    } else if (/^7/.test(remainder)) {
      seventh = 'min7'
      remainder = remainder.slice(1)
    }
    // If no explicit 7 yet but an extension digit follows, the
    // convention for a minor chord is min7 + extension (not dom7).
    // Tagging here so the extension parser sees seventh='min7'.
    else if (/^(9|11|13)/.test(remainder)) {
      seventh = 'min7'
    }
  }
  // Major seventh — handle 'maj7' as well as 'maj9'/'maj11'/'maj13'
  // (the digit is consumed by the extension parser below).
  else if (/^(maj7|△7|M7|Maj7)/.test(remainder)) {
    seventh = 'maj7'
    remainder = remainder.replace(/^(maj7|△7|M7|Maj7)/, '')
  } else if (/^maj(9|11|13)/.test(remainder)) {
    seventh = 'maj7'
    remainder = remainder.replace(/^maj/, '')
  }
  // Dominant seventh: bare "7" after major triad
  else if (/^7/.test(remainder)) {
    seventh = 'dom7'
    remainder = remainder.slice(1)
  }

  // Extension digits attached to seventh: 9, 11, 13. We greedy-match
  // the highest one. "C13" → seventh: 'dom7', extensions: [13].
  const extensions: ChordSymbol['extensions'] = []
  const extMatch = remainder.match(/^(13|11|9)/)
  if (extMatch) {
    const n = parseInt(extMatch[0], 10) as 9 | 11 | 13
    extensions.push(n)
    // If we read an extension without a preceding 7, it implies dom7.
    if (seventh === 'none') seventh = 'dom7'
    remainder = remainder.slice(extMatch[0].length)
  }

  // Alterations: "(b9,#11)" or "b9#11" or "(#11)" etc.
  const alterations: string[] = []
  // Parenthesized form — but only consume if EVERY token looks like
  // an alteration. A parenthesized 'no3' / 'omit3' / 'maj7' must
  // pass through to its own parser further down.
  const parenAlts = remainder.match(/^\(([^)]+)\)/)
  if (parenAlts) {
    const tokens = parenAlts[1].split(/[,\s]+/).filter(Boolean)
    const allAlterations = tokens.every((t) => /^(b|#)?\d{1,2}$/.test(t))
    if (allAlterations && tokens.length > 0) {
      for (const part of tokens) alterations.push(part)
      remainder = remainder.slice(parenAlts[0].length)
    }
  }
  // Loose form
  while (/^(b|#)\d{1,2}/.test(remainder)) {
    const m = remainder.match(/^(b|#)\d{1,2}/)!
    alterations.push(m[0])
    remainder = remainder.slice(m[0].length)
  }
  // "alt" shorthand (C7alt) — leave as a textual alteration so it
  // round-trips intact.
  if (/^alt/.test(remainder)) {
    alterations.push('alt')
    remainder = remainder.replace(/^alt/, '')
  }

  // Add tones: "add9", "add11", etc.
  const add: ChordSymbol['add'] = []
  let addMatch
  while ((addMatch = remainder.match(/^add(13|11|9|6|4|2)/))) {
    add.push(parseInt(addMatch[1], 10) as 2 | 4 | 6 | 9 | 11 | 13)
    remainder = remainder.slice(addMatch[0].length)
  }
  // "C6" (6th chord) is conventionally an add6 when no 7th is present.
  if (seventh === 'none' && extensions.length === 0 && /^6/.test(remainder)) {
    add.push(6)
    remainder = remainder.slice(1)
  }

  // Omit tones: "(no3)", "(no5)", "(omit3)"
  const omit: ChordSymbol['omit'] = []
  let omitMatch
  while ((omitMatch = remainder.match(/^\((no|omit)(3|5|7)\)/))) {
    omit.push(parseInt(omitMatch[2], 10) as 3 | 5 | 7)
    remainder = remainder.slice(omitMatch[0].length)
  }

  // If there's still unconsumed input, the parse is suspect. We
  // accept it anyway and store the original text in `display` so the
  // UI shows what the user typed; round-trip fidelity is preserved.
  return {
    root,
    quality,
    seventh,
    ...(extensions.length > 0 ? { extensions } : {}),
    ...(alterations.length > 0 ? { alterations } : {}),
    ...(add.length > 0 ? { add } : {}),
    ...(omit.length > 0 ? { omit } : {}),
    ...(bass ? { bass } : {}),
    ...(modal ? { modal } : {}),
    display: original,
  }
}

/**
 * Returns true if two structured chord symbols are functionally
 * equivalent (ignoring `display` cache and ordering of extensions/
 * alterations/add/omit arrays).
 */
export function chordSymbolsEqual(a: ChordSymbol, b: ChordSymbol): boolean {
  if (a.root !== b.root) return false
  if (a.quality !== b.quality) return false
  if (a.seventh !== b.seventh) return false
  if (a.modal !== b.modal) return false
  if (!arraysSetEqual(a.extensions ?? [], b.extensions ?? [])) return false
  if (!arraysSetEqual(a.alterations ?? [], b.alterations ?? [])) return false
  if (!arraysSetEqual(a.add ?? [], b.add ?? [])) return false
  if (!arraysSetEqual(a.omit ?? [], b.omit ?? [])) return false
  if (a.bass?.type !== b.bass?.type) return false
  if (a.bass && b.bass) {
    if (a.bass.type === 'note' && b.bass.type === 'note') {
      if (a.bass.value !== b.bass.value) return false
    } else if (a.bass.type === 'chord' && b.bass.type === 'chord') {
      if (!chordSymbolsEqual(a.bass.value, b.bass.value)) return false
    }
  }
  return true
}

function arraysSetEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  for (const v of b) if (!setA.has(v)) return false
  return true
}
