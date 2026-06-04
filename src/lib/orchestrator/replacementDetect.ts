import type { Score } from '@/lib/music/types'
import { hashMeasure } from '@/lib/music/scoreDiff'

/**
 * M3.5-PR-4 — replacement-as-confirmation gate.
 *
 * Pure detection: given a (beforeScore, afterScore, userText, dispatchTool)
 * tuple, return whether the orchestrator's proposed change looks like a
 * wholesale replacement that the user should explicitly confirm — vs. an
 * additive edit, region replace, or other low-risk modification we apply
 * silently.
 *
 * The gate fires when ALL hold:
 *   1. retainedIdentityRatio < 0.5 (fewer than half of the BEFORE
 *      measures survive byte-identical at the same index)
 *   2. at least one of (key, meter, title) changed
 *   3. the user did NOT explicitly ask for a rewrite (`from scratch`,
 *      `start over`, `scrap this`, etc.) — word-boundary matched to
 *      avoid `gateway` / `playbook` false positives. Bare verbs like
 *      `rewrite`/`replace`/`redo` are deliberately excluded because
 *      they false-positive on negated intent ("please don't replace
 *      what I have", "no rewrites needed").
 *
 * Special case: when `dispatchTool === 'regenerate_all'` AND the LLM
 * confirmed via the `confirmExplicitRewrite: true` schema flag, we
 * treat that as explicit-rewrite intent regardless of the user-text
 * keyword scan. The LLM has full prompt context and a schema gate it
 * had to set deliberately; trust that signal.
 */
export interface ReplacementDecision {
  /** True when this proposed change should require user confirmation. */
  isReplacement: boolean
  /**
   * Fraction of beforeScore's primary-staff voice-0 measures whose hash
   * matches the same-index measure in afterScore. Range [0, 1]. 1.0
   * means every original bar survived byte-identical; 0.0 means none
   * did. We compute the ratio against `min(beforeLen, afterLen)`
   * positions; trailing extra measures in either direction don't reduce
   * the ratio — only mis-matches inside the overlap do.
   *
   * Computed even when isReplacement is false so the route can include
   * the number in the confirmation payload or in telemetry.
   */
  retainedIdentityRatio: number
  /**
   * Short human-readable strings explaining the decision. e.g.
   *   "only 1 of 4 measures retained"
   *   "key C → Am"
   *   "meter 4/4 → 5/4"
   *   "title 'Triplet demo' → '5/4 ostinato'"
   * The UI renders these as a bullet list in the modal so the user
   * understands WHY we paused.
   */
  reasons: string[]
  /**
   * True when the user's prompt OR the dispatch decision explicitly
   * signaled "rewrite from scratch". When true the gate never fires
   * (the user asked for replacement; that's not surprising).
   */
  userExplicitRewrite: boolean
}

/**
 * Word-boundary-matched phrases that signal explicit rewrite intent.
 *
 * Bare verbs (`rewrite`, `replace`, `redo`) are INTENTIONALLY OMITTED:
 * they false-positive on negated user intent like "please don't replace
 * what I have", "no rewrites needed, just extend it", or "I don't want
 * to redo this". That negation pattern silently disables the gate at
 * exactly the moment the user wants protection. We only keep phrases
 * that don't read naturally in negated form ("I don't want to start
 * over" parses, but "start over" is far less common as a casual verb
 * than "rewrite"; in practice when these phrases appear they're
 * affirmative). When the LLM is more confident than the keyword scan
 * (e.g. the user said "redo this from scratch" and the dispatcher set
 * `confirmExplicitRewrite=true`), the regenerate_all + LLM-flag path
 * still catches the intent — see detectReplacement below.
 */
const REWRITE_KEYWORDS = [
  'from scratch',
  'start over',
  'scrap this',
  'scrap that',
  'recompose',
  'compose anew',
  'new piece',
] as const

/**
 * Tools the M3.5-PR-3 dispatch layer can pick. Mirrors the union in
 * `OrchestratorResult.dispatchTool` so call sites stay in sync.
 */
export type DispatchToolName =
  | 'extend_composition'
  | 'insert_measures'
  | 'region_replace'
  | 'edit_intra_measure'
  | 'regenerate_all'

export interface DetectReplacementInput {
  beforeScore: Score | undefined
  afterScore: Score
  userText: string
  dispatchTool?: DispatchToolName
  /**
   * For `regenerate_all` only: whether the tool's
   * `confirmExplicitRewrite` flag was true. When true (the schema
   * requires it before the tool is even usable), we trust the LLM's
   * signal that this WAS an explicit-rewrite request even if the user
   * didn't say `rewrite` / `replace` literally.
   */
  confirmExplicitRewrite?: boolean
}

/**
 * Compute the retained-identity ratio: fraction of beforeScore's
 * measures whose primary-staff voice-0 hash equals the same-index
 * measure in afterScore. Uses `hashMeasure` from scoreDiff so the
 * canonical form is identical to the existing
 * `firstNMeasuresIdentical` eval invariant.
 *
 * When beforeScore has 0 measures, returns 1.0 — no measures to lose,
 * nothing to retain to fail at. (Also short-circuits a divide-by-zero.)
 * When beforeScore is undefined, returns 0 (caller treats as "no prior
 * score" and bypasses the gate via the explicit guard).
 */
function computeRetainedIdentityRatio(
  before: Score | undefined,
  after: Score,
): number {
  if (!before) return 0
  const beforeLen = before.measures.length
  if (beforeLen === 0) return 1
  const afterLen = after.measures.length
  const overlap = Math.min(beforeLen, afterLen)
  let retained = 0
  for (let i = 0; i < overlap; i++) {
    const b = before.measures[i]
    const a = after.measures[i]
    if (!b || !a) continue
    if (hashMeasure(b) === hashMeasure(a)) retained++
  }
  return retained / beforeLen
}

/**
 * Detect whether `userText` (case-insensitive, word-boundary matched)
 * contains any of the REWRITE_KEYWORDS phrases. We intentionally avoid
 * substring matching: "gateway" must not match "rewrite", "playbook"
 * must not match "redo"... etc.
 *
 * Multi-word phrases are matched as whole phrases — "start over"
 * must appear with a space; "startover" does not match. Word
 * boundaries are enforced on both ends using the regex \b.
 */
function userTextSignalsRewrite(userText: string): boolean {
  if (!userText) return false
  const lower = userText.toLowerCase()
  for (const kw of REWRITE_KEYWORDS) {
    // Build a word-boundary regex. Special-character-free phrases so
    // we don't need to escape anything, but use a function defensively.
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\b${escaped}\\b`)
    if (re.test(lower)) return true
  }
  return false
}

function formatTitle(t: string | undefined): string {
  return t === undefined ? '<unset>' : `'${t}'`
}

/**
 * The single export: pure decision function. No I/O, no LLM calls, no
 * DB. Safe to call inside the orchestrator hot path; tests exhaust the
 * boolean space.
 */
export function detectReplacement(
  input: DetectReplacementInput,
): ReplacementDecision {
  const { beforeScore, afterScore, userText, dispatchTool, confirmExplicitRewrite } = input

  // Explicit-rewrite resolution: user text OR dispatch-tool signal.
  const userExplicitRewrite =
    userTextSignalsRewrite(userText) ||
    (dispatchTool === 'regenerate_all' && confirmExplicitRewrite === true)

  // Bypass when no prior score — fresh generation, never a replacement.
  if (!beforeScore) {
    return {
      isReplacement: false,
      retainedIdentityRatio: 0,
      reasons: [],
      userExplicitRewrite,
    }
  }

  const retainedIdentityRatio = computeRetainedIdentityRatio(beforeScore, afterScore)
  const keyChanged = beforeScore.key !== afterScore.key
  const meterChanged = beforeScore.meter !== afterScore.meter
  const titleChanged = (beforeScore.title ?? null) !== (afterScore.title ?? null)
  const metadataChanged = keyChanged || meterChanged || titleChanged

  const reasons: string[] = []
  if (retainedIdentityRatio < 1) {
    const beforeLen = beforeScore.measures.length
    const retained = Math.round(retainedIdentityRatio * beforeLen)
    reasons.push(`only ${retained} of ${beforeLen} measures retained`)
  }
  if (keyChanged) {
    reasons.push(`key ${beforeScore.key} → ${afterScore.key}`)
  }
  if (meterChanged) {
    reasons.push(`meter ${beforeScore.meter} → ${afterScore.meter}`)
  }
  if (titleChanged) {
    reasons.push(`title ${formatTitle(beforeScore.title)} → ${formatTitle(afterScore.title)}`)
  }

  const isReplacement =
    retainedIdentityRatio < 0.5 && metadataChanged && !userExplicitRewrite

  return {
    isReplacement,
    retainedIdentityRatio,
    reasons,
    userExplicitRewrite,
  }
}
