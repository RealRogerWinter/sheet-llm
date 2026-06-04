import type { Score } from '@/lib/music/types'
import type { Operation } from '@/lib/music/editOperations'
import type { ChatMessage } from '@/lib/llm/wrapper'
import type { TextStreamEvent } from '@/lib/providers/types'

/**
 * The subset of Operation kinds the classifier is allowed to author
 * directly. Anything that requires per-event index arithmetic is
 * out — those route via `target_description` to the intra-measure
 * handler in Phase 2.
 */
export type ScoreLevelOperation = Extract<
  Operation,
  | { kind: 'changeKey' }
  | { kind: 'changeMeter' }
  | { kind: 'changeTempo' }
  | { kind: 'changeTitle' }
  | { kind: 'changeClef' }
>

/**
 * What the classifier decides about an incoming request.
 *
 * - kind: which handler to dispatch to.
 * - scope/complexity: drives model-tier selection inside the handler.
 * - confidence: classifier's self-reported probability. Low confidence
 *   triggers fall-through to the legacy single-shot path.
 * - score_level_ops: present only when kind === 'edit_score_level'.
 *   Limited to score-level Operation variants (changeKey, changeMeter,
 *   changeTempo, changeTitle) that the classifier can safely author
 *   without per-request schema grounding.
 * - target_description: present when kind === 'edit_intra_measure'.
 *   Free-text instruction handed to the intra-measure handler, which
 *   makes a second LLM call against a score-grounded tool schema.
 * - reason: present when kind === 'refuse' (copyright or out-of-scope).
 */
export type TaskKind =
  | 'edit_score_level'
  | 'edit_intra_measure'
  | 'generate_simple'
  | 'generate_complex'
  | 'compose'
  | 'converse'
  | 'refuse'
  | 'fall_through'

export interface Classification {
  kind: TaskKind
  scope: 'snippet' | 'short' | 'long'
  complexity: 'simple' | 'complex'
  confidence: number
  score_level_ops?: ScoreLevelOperation[]
  target_description?: string
  /** Present when kind === 'converse'. Classifier's brief restatement of
   *  what the user is asking — the handler may use it as a hint but the
   *  full original userText is always passed through too. */
  question?: string
  reason?: string
  notes?: string
}

export type OrchestratorFinalStatus = 'ok' | 'refused' | 'fell_through' | 'error'

export interface OrchestratorInput {
  requestId: string
  /**
   * Conversation id — used for per-session budget tracking. Optional
   * in test fixtures; route.ts always supplies it.
   */
  chatId?: string
  userText: string
  editedScore?: Score
  history: ReadonlyArray<ChatMessage>
  /**
   * Debug-only: force a specific Anthropic model id for LLM-calling
   * handlers. Edit/refuse handlers ignore it.
   */
  modelOverride?: string
  /**
   * Debug-only: per-request API key (from the debug panel). Threaded
   * through to provider calls so we never mutate process.env mid-
   * request (which races with long-lived streams).
   */
  apiKeyOverride?: string
  /**
   * Absolute deadline (Date.now() epoch ms) by which the request
   * must complete. The orchestrator refuses to start a call that
   * won't plausibly finish, returning a `deadline_exceeded`
   * fall-through. Optional for backward compat; route.ts always
   * supplies it via `computeDeadlineAt()`.
   */
  deadlineAt?: number
  /**
   * Resolved product/paywall tier for this request. `'free'` (default) routes
   * a fresh from-scratch generation to the bounded <=4-bar single-call handler;
   * `'pro'` keeps the sectional / whole-score pipeline. Resolved in `route.ts`
   * (env + operator override now, per-user entitlement later) and threaded as
   * the RESOLVED value — not the userId — so the orchestrator stays DB-agnostic,
   * matching how `deadlineAt` is precomputed. Optional for back-compat with
   * test fixtures; the route always supplies it. Distinct from the provider
   * model-size `Tier` in `providers/*`.
   */
  generationTier?: import('./generationTier').GenerationTier
  /**
   * D5 — deterministic 0-based measure-range hint from the right-click AI
   * entries. Threaded to the tool dispatcher as structured region context
   * so it gets the indices directly rather than parsing them from prose.
   * Optional; absent ⇒ prose-only behavior.
   */
  targetRegion?: import('@/lib/shared/types').TargetRegion
}

export interface OrchestratorResult {
  /** The new (or unchanged) Score to return to the client. */
  score: Score
  /** Optional intro/explanation text. */
  introText?: string
  /** The classification that drove dispatch. */
  classification: Classification
  /** Which LLM model produced the result; null for no-LLM paths (edits, refuse). */
  model: string | null
  /** End-to-end latency of the orchestrator path in ms. */
  latencyMs: number
  /** The tool_use_id to persist on the assistant turn (when an LLM call ran). */
  toolUseId?: string
  /** The ops applied by an intra-measure edit handler. Carried up so the
   *  centralized confirmation-text fallback in `respondWithOrchestratorResult`
   *  can summarize what changed without re-running classification. */
  appliedOps?: Operation[]
  /** Lever B — set by `runCompose` when the sub-classifier dispatch flag
   *  is on. The orchestrator's success-path `logTurn` reads this and
   *  emits it as the `composePatchDispatch` field so production can
   *  measure how often compose ended up patching vs. regenerating.
   *
   *  M3.5-PR-3 broadened the type to include the new structural-tool
   *  names so the same column can record either the legacy Lever-B
   *  patch/regen outcome OR the picked tool from the new dispatcher. */
  composePatchDispatch?:
    | 'patch'
    | 'regen'
    | 'skipped'
    | 'extend_composition'
    | 'insert_measures'
    | 'region_replace'
    | 'edit_intra_measure'
    | 'regenerate_all'
  /**
   * M3.5-PR-3 — soft warnings emitted by extend/insert/region handlers
   * (tie-at-boundary auto-downgrade, V-I cadence at boundary,
   * span severance, preservation-verify hash mismatch fall-back).
   * The route surfaces these to the chat UI as inline notices; nothing
   * blocking.
   */
  warnings?: string[]
  /**
   * M3.5-PR-3 — detected by extend_composition when the original
   * score's last two events look like a V-I (or v-i) cadence at the
   * final barline. Warn-only; surfaced for future UI affordance.
   */
  cadenceAtBoundary?: boolean
  /**
   * M3.5-PR-3 — the low-confidence preview path. When set, the route
   * MUST NOT auto-apply the score — it surfaces a "here's what I'd do,
   * confirm to apply" affordance instead. PR-4 wires the UI.
   */
  requiresConfirmation?: boolean
  /**
   * M3.5-PR-3 — alias of requiresConfirmation; future replacement-as-
   * confirmation gate will distinguish the two. For now they're set
   * together when the dispatch picks `regenerate_all` without an
   * explicit rewrite signal.
   */
  previewMode?: boolean
  /**
   * M3.5-PR-3 — the tool the new dispatch layer picked. Persisted to
   * orchestrator_turns via the broadened semantics of
   * `composePatchDispatch` (or via a new column added in this PR).
   */
  dispatchTool?:
    | 'extend_composition'
    | 'insert_measures'
    | 'region_replace'
    | 'edit_intra_measure'
    | 'regenerate_all'
  /**
   * M3.5-PR-4 — populated by the replacement-as-confirmation gate.
   * When present AND `requiresConfirmation === true`, the chat route
   * MUST NOT update sessions.headVersionId to point at this score;
   * instead it surfaces a modal asking the user to confirm. On
   * `accept` the head moves to this score; on `reject` a revert row
   * lands so the prior head stays current.
   *
   * `retainedIdentityRatio` is in [0,1]; `reasons` is the small list
   * of human-readable strings the modal renders as bullets.
   */
  replacement?: {
    retainedIdentityRatio: number
    reasons: string[]
  }
  /**
   * M24-PR-2 — AI ghost preview proposal payload. When present AND
   * `requiresConfirmation === true`, the chat route MUST NOT update
   * sessions.headVersionId; instead it surfaces a proposal-mode
   * response carrying `affectedEventIds`. The client renders an
   * inline warm-amber overlay (<=4 ids) or a right-docked diff panel
   * (>=5 ids) per `computeProposalPresentation`.
   *
   * Mutually exclusive with `replacement`: the replacement gate runs
   * first; when it fires, the ghost-preview hook is a no-op (the
   * existing modal owns the wholesale-rewrite UX). Both can set
   * `requiresConfirmation`, so the route distinguishes by which field
   * is populated.
   *
   * Gated behind `SL_GHOST_PREVIEW` (off by default in PR-2; PR-6
   * flips on).
   */
  proposal?: {
    affectedEventIds: string[]
  }
  /**
   * M3.5-PR-5 review fix (H2) — usage telemetry surfaced for the live-
   * eval runner so the cost summary and cache-hit warning fire on real
   * data. Populated by handlers that drove an LLM call (compose,
   * generateComplex, edit handlers via toolDispatch); undefined for
   * no-LLM paths (refuse, score-level edits). Different fields may
   * be absent depending on the provider response.
   */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
  }
}

export type RefusalCode = 'copyright' | 'out_of_scope' | 'pro_only'

/**
 * Refusal carries no Score. The route translates this into a 422 with
 * a structured error body.
 */
export interface OrchestratorRefusal {
  refused: true
  classification: Classification
  reason: string
  refusalCode: RefusalCode
  latencyMs: number
}

export type FallThroughReason =
  | 'classifier_schema_error'
  | 'classifier_threw'
  | 'low_confidence'
  | 'handler_error'
  | 'handler_returned_null'
  | 'deadline_exceeded'

/**
 * Returned when the orchestrator ran but bailed (and the route
 * should serve the request via the legacy single-shot path). Carries
 * enough diagnostic info to power the debug panel.
 */
export interface OrchestratorFallThrough {
  fellThrough: true
  reason: FallThroughReason
  /** The classification (if one was produced before bailing). */
  classification?: Classification
  /** Human-readable error message when reason is *_error / *_threw. */
  errorMessage?: string
  latencyMs: number
}

/**
 * Streaming text answer outcome from the converse handler. Unlike
 * OrchestratorResult, this does NOT carry a Score — the handler hands
 * back a hot AsyncIterable that the route owns and consumes, writing
 * SSE frames to the client. Persistence (transcript + usage) happens
 * in the route on stream completion, error, or cancellation.
 */
export interface OrchestratorConverseStream {
  outcomeKind: 'converse_stream'
  classification: Classification
  /** Effective model id used. */
  model: string
  /** Hot iterator from provider.textStream. Must be consumed exactly once. */
  events: AsyncIterable<TextStreamEvent>
  /** Chat id this stream is for — passed through for persistence. */
  chatId: string
  /** Latency to first-byte / handler return (not stream completion). */
  latencyMs: number
}

/** Type predicate: is this outcome the streaming-text converse variant? */
export function isOrchestratorConverseStream(
  o: OrchestratorRunOutcome,
): o is OrchestratorConverseStream {
  return (
    o !== null &&
    typeof o === 'object' &&
    'outcomeKind' in o &&
    (o as { outcomeKind: unknown }).outcomeKind === 'converse_stream'
  )
}

/**
 * M25-PR-4 — one event from a streaming SECTIONAL score generation. The
 * generator emits a `section` after each bounded section completes (so
 * the client can render the score growing), then a terminal `done`
 * (clean finish OR a partial that stopped early, carrying warnings) or
 * `error` (a fatal failure before any score exists — e.g. the seed
 * section truncated). Coarser than converse's per-token deltas: one
 * frame per completed section.
 */
export type ScoreStreamEvent =
  | {
      type: 'section'
      /** Cumulative score after this section (renders progressively). */
      score: Score
      /** 0-based index of the section just completed. */
      sectionIndex: number
      /** Total sections the generator plans to emit. */
      totalSections: number
      /** Section label ("A", "Turnaround", ...) for progress display. */
      label: string
    }
  | {
      type: 'done'
      /** Final (or partial-but-valid) assembled score. */
      score: Score
      toolUseId?: string
      introText: string
      model: string
      /** Soft notices (seam downgrades, "stopped after N of M sections"). */
      warnings?: string[]
      usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
    }
  | {
      type: 'error'
      /** Fatal failure before any usable score (no partial to keep). */
      error: Error
    }

/**
 * Streaming SECTIONAL score-generation outcome. Like
 * OrchestratorConverseStream, the handler hands back a hot AsyncIterable
 * the route owns and consumes, writing SSE frames; persistence (the
 * final assistant turn + score_versions row + head bump) happens in the
 * route on the `done` event.
 */
export interface OrchestratorScoreStream {
  outcomeKind: 'score_stream'
  classification: Classification
  /** Best-effort model id for the header (the real per-section model is
   *  carried on the `done` event). */
  model: string
  events: AsyncIterable<ScoreStreamEvent>
  chatId: string
  latencyMs: number
}

/** Type predicate: is this outcome the streaming-score variant? */
export function isOrchestratorScoreStream(
  o: OrchestratorRunOutcome,
): o is OrchestratorScoreStream {
  return (
    o !== null &&
    typeof o === 'object' &&
    'outcomeKind' in o &&
    (o as { outcomeKind: unknown }).outcomeKind === 'score_stream'
  )
}

/**
 * Phase 0 contract: orchestrator.run returns null when it has nothing
 * to add (flag off, kill switch on, or — until later phases land —
 * always). The route then takes the legacy path unchanged.
 *
 * Phase 5+: null is no longer used in normal operation — the route is
 * the sole mode gate. Fall-through cases return OrchestratorFallThrough
 * with diagnostic context so the debug panel can show *why*.
 */
export type OrchestratorRunOutcome =
  | OrchestratorResult
  | OrchestratorRefusal
  | OrchestratorFallThrough
  | OrchestratorConverseStream
  | OrchestratorScoreStream
  | null
