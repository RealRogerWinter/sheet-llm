import {
  HIGH_RISK_ARTISTS,
  HIGH_RISK_SONGS,
  INFRINGEMENT_VERBS,
  PD_COMPOSERS,
} from './names'

export interface CopyrightResult {
  blocked: boolean
  refusalCode?: 'copyright'
  reason?: string
  /** The matched verb + name (or PD composer) that drove the decision. */
  matched?: { verb?: string; name?: string }
}

const PD_RE = new RegExp(`\\b(?:${PD_COMPOSERS.join('|')})\\b`, 'i')

/**
 * Returns true if the prompt mentions any public-domain composer.
 * A PD match short-circuits the filter to "not blocked" regardless
 * of co-occurrence: "a chorale by Bach" passes.
 */
function mentionsPdComposer(text: string): boolean {
  return PD_RE.test(text)
}

const ALL_NAMES = [...HIGH_RISK_ARTISTS, ...HIGH_RISK_SONGS]
// Sort longest-first so multi-word names beat their substrings.
ALL_NAMES.sort((a, b) => b.length - a.length)
const COOCCURRENCE_RE = new RegExp(
  `\\b(?:${INFRINGEMENT_VERBS.map(escapeRegex).join('|')})\\b\\s+(?:the\\s+)?["']?(${ALL_NAMES.map(escapeRegex).join('|')})\\b`,
  'i',
)

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Checks the user's free-text prompt for copyright infringement
 * intent. Narrow by design:
 *
 *   - Looks ONLY for `<verb> <name>` co-occurrence patterns.
 *   - Bare standalone names ("yesterday", "happy") never block.
 *   - PD-composer mentions short-circuit to pass.
 *
 * Returns { blocked: false } when no concern; otherwise a structured
 * refusal with code 'copyright'.
 */
export function checkCopyright(rawText: string): CopyrightResult {
  const text = rawText.toLowerCase()

  if (mentionsPdComposer(text)) {
    return { blocked: false }
  }

  const m = text.match(COOCCURRENCE_RE)
  if (m) {
    return {
      blocked: true,
      refusalCode: 'copyright',
      reason: `Request appears to ask for a copyrighted work (matched: "${m[0].trim()}"). Try requesting a piece in the style of a genre or a public-domain composer instead.`,
      matched: { name: m[1] },
    }
  }

  return { blocked: false }
}
