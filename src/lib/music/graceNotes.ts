import type { Accidental, GraceNote, Pitch, Step } from './types'

const STEPS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G'])

/**
 * Forgiving shorthand parser for the Dorico-style grace-notes popover.
 * Returns `GraceNote[]` on success or `undefined` on parse failure.
 *
 * Recognized shorthand (case-insensitive on pitch letter):
 *
 *   c            → single eighth grace, C5 (default octave)
 *   c5           → explicit octave
 *   ^c / _c / =c → accidental prefix (sharp / flat / natural)
 *   c/           → sixteenth duration
 *   c/4          → 32nd duration
 *   /c           → slashed (acciaccatura) — applies to LEADING grace
 *   c d e        → space-separated grace RUN (3 moments)
 *   [c e g]      → grace CHORD (one moment, multiple noteheads)
 *
 * Combinable: `/c d e` is a 3-note slashed run; `^d/` is a sharpened
 * sixteenth grace; `[ce]` is a 2-note grace chord.
 *
 * Octave default: 5 (treble grace; the most common case). Users with
 * grace pitches below octave 5 emit the explicit octave digit.
 */
const DEFAULT_GRACE_OCTAVE = 5

export function parseGraceNotes(text: string): GraceNote[] | undefined {
  const t = text.trim()
  if (t === '') return undefined

  // Strip leading slash (applies to the LEADING grace only — that's
  // the only one ABC honors; M7-PR-4 documents the limitation).
  const leadingSlashed = t.startsWith('/')
  const body = leadingSlashed ? t.slice(1).trim() : t
  if (body === '') return undefined

  // Tokenize by whitespace, but keep `[...]` chord tokens intact.
  const tokens: string[] = []
  let depth = 0
  let buf = ''
  for (const ch of body) {
    if (ch === '[') {
      depth++
      buf += ch
    } else if (ch === ']') {
      depth--
      buf += ch
    } else if (/\s/.test(ch) && depth === 0) {
      if (buf !== '') {
        tokens.push(buf)
        buf = ''
      }
    } else {
      buf += ch
    }
  }
  if (buf !== '') tokens.push(buf)
  if (tokens.length === 0) return undefined

  const out: GraceNote[] = []
  for (let i = 0; i < tokens.length; i++) {
    const parsed = parseGraceMoment(tokens[i])
    if (parsed === undefined) return undefined
    if (i === 0 && leadingSlashed) parsed.slashed = true
    out.push(parsed)
  }
  return out
}

function parseGraceMoment(tok: string): GraceNote | undefined {
  // Chord: [pitch pitch ...] — same accidental + octave shorthand per
  // pitch but no spaces inside (we already split on spaces outside
  // brackets).
  if (tok.startsWith('[') && tok.endsWith(']')) {
    const inner = tok.slice(1, -1).trim()
    if (inner === '') return undefined
    // Split chord pitches by single character runs — each pitch is
    // optional accidental prefix + letter + optional octave. We do a
    // greedy regex split.
    const pitchTokens = inner.match(/[\^_=]?[a-gA-G]\d?/g)
    if (!pitchTokens || pitchTokens.length === 0) return undefined
    // Concatenated length must equal inner length (no garbage between
    // pitches).
    const concat = pitchTokens.join('')
    const innerNoSpace = inner.replace(/\s+/g, '')
    if (concat !== innerNoSpace) return undefined
    const pitches: Pitch[] = []
    for (const pt of pitchTokens) {
      const p = parseGracePitch(pt)
      if (p === undefined) return undefined
      pitches.push(p)
    }
    // Chord duration suffix is not supported per-moment; chords
    // default to eighth. Run-level duration via space-separated
    // tokens covers the sixteenth/32nd cases.
    return { pitches, duration: 'eighth' }
  }

  // Single pitch: optional accidental + letter + optional octave +
  // optional duration suffix
  const m = tok.match(/^([\^_=]?)([a-gA-G])(\d?)(\/4|\/)?$/)
  if (!m) return undefined
  const accidentalChar = m[1]
  const letterChar = m[2]
  const octaveChar = m[3]
  const durationSuffix = m[4]
  const pitch = parseGracePitch(accidentalChar + letterChar + octaveChar)
  if (pitch === undefined) return undefined
  const duration: GraceNote['duration'] =
    durationSuffix === '/4' ? '32nd' : durationSuffix === '/' ? 'sixteenth' : 'eighth'
  return { pitches: [pitch], duration }
}

function parseGracePitch(tok: string): Pitch | undefined {
  const m = tok.match(/^([\^_=]?)([a-gA-G])(\d?)$/)
  if (!m) return undefined
  const acc = m[1]
  const letter = m[2].toUpperCase()
  const octaveDigit = m[3]
  if (!STEPS.has(letter)) return undefined
  const accidental: Accidental | undefined =
    acc === '^' ? 'sharp' : acc === '_' ? 'flat' : acc === '=' ? 'natural' : undefined
  const octave = octaveDigit === '' ? DEFAULT_GRACE_OCTAVE : Number(octaveDigit)
  if (octave < 2 || octave > 6) return undefined
  return {
    step: letter as Step,
    octave,
    ...(accidental !== undefined ? { accidental } : {}),
  }
}

/**
 * Inverse of parseGraceNotes — render a GraceNote[] back to the
 * canonical shorthand for popover re-open seeding.
 */
export function formatGraceNotes(graceNotes: GraceNote[]): string {
  if (graceNotes.length === 0) return ''
  const leadingSlash = graceNotes[0]?.slashed === true ? '/' : ''
  return leadingSlash + graceNotes.map(formatGraceMoment).join(' ')
}

function formatGraceMoment(g: GraceNote): string {
  const pitchTexts = g.pitches.map(formatGracePitch)
  const body = g.pitches.length > 1 ? `[${pitchTexts.join('')}]` : pitchTexts[0]
  // Duration suffix applies to single-pitch moments. Chords are
  // eighth-only in this shorthand (matches the parser's contract).
  if (g.pitches.length > 1) return body
  const suffix = g.duration === 'sixteenth' ? '/' : g.duration === '32nd' ? '/4' : ''
  return body + suffix
}

function formatGracePitch(p: Pitch): string {
  if (p.step === 'rest') return ''
  const acc =
    p.accidental === 'sharp'
      ? '^'
      : p.accidental === 'flat'
        ? '_'
        : p.accidental === 'natural'
          ? '='
          : ''
  const octave = p.octave === DEFAULT_GRACE_OCTAVE ? '' : String(p.octave)
  return acc + p.step.toLowerCase() + octave
}
