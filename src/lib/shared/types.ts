import type { Score } from '@/lib/music/types'

/**
 * A deterministic measure-range hint (D5). Carries the EXACT 0-based,
 * inclusive measure range the user is acting on (e.g. a right-click "edit
 * with AI" on a selected bar / range), so the dispatcher gets the indices
 * directly instead of parsing them from the prompt prose. Optional + purely
 * additive — absent ⇒ identical to the prose-only behavior.
 */
export interface TargetRegion {
  /** 0-based first measure of the selection (inclusive). */
  startMeasureIdx: number
  /** 0-based last measure of the selection (inclusive). */
  endMeasureIdx: number
}

export interface ChatRequest {
  chatId?: string
  message: string
  /**
   * Optional deterministic measure-range the request is scoped to (D5).
   * Set by the right-click AI entries; threaded to the tool dispatcher as
   * a structured region hint.
   */
  targetRegion?: TargetRegion
  /**
   * Optional: the user's manually-edited score. When present and a
   * prior assistant turn exists, the server appends a synthetic
   * assistant turn carrying this score so Claude sees it as the
   * current state on the next refinement.
   */
  editedScore?: Score
  /**
   * Optional client-asserted hash of the score the client believes is
   * current (i.e. that editedScore was derived from). When present
   * AND a prior assistant score exists, the server compares against
   * its own hash and rejects mismatches with `stale_score`.
   */
  score_version?: string
  /**
   * Debug-panel overrides. Lets the dev UI force orchestrator mode
   * or a specific model id per-request without changing env vars.
   */
  debug?: ChatDebugOverrides
}

export interface ChatDebugOverrides {
  /** Override the orchestrator mode for this request only. */
  orchestrator?: 'on' | 'off' | 'shadow'
  /** Force a specific Anthropic model id for LLM-calling handlers. */
  modelOverride?: string
  /**
   * Dev-only: per-request Anthropic API key. When set, the server uses
   * this key instead of process.env.ANTHROPIC_API_KEY for the duration
   * of the request. Sent only by the debug panel.
   */
  apiKey?: string
  /**
   * Dev-only: force the product/paywall tier for this request. `free`
   * exercises the bounded ≤4-bar generation (paywall ON); `pro` restores
   * full sectional / whole-score generation (paywall OFF). Sent only by
   * the debug panel's paywall toggle. The operator `SL_FORCE_FREE_TIER`
   * kill switch still overrides this server-side.
   */
  generationTier?: 'free' | 'pro'
}

export type FallThroughReason =
  | 'classifier_schema_error'
  | 'classifier_threw'
  | 'low_confidence'
  | 'handler_error'
  | 'handler_returned_null'
  | 'deadline_exceeded'

export interface ChatDebugPayload {
  /** Classification the orchestrator emitted, if any. */
  classification?: {
    kind: string
    scope: string
    complexity: string
    confidence: number
    reason?: string
  }
  /** Which handler served the result, or 'legacy' if orchestrator fell through. */
  handler: string
  /** Anthropic model id used (null for no-LLM paths like edit_score_level). */
  model: string | null
  latencyMs: number
  /** True when the orchestrator ran but fell through to legacy. */
  fellThrough?: boolean
  /** Why the orchestrator bailed (only set when fellThrough is true). */
  fallThroughReason?: FallThroughReason
  /** Error message captured when fallThroughReason is *_error / *_threw. */
  fallThroughError?: string
  /** Effective mode this request ran under. */
  mode: 'off' | 'primary' | 'shadow'
  /**
   * Whether the server has ANTHROPIC_API_KEY in process.env. False
   * means every LLM call goes to the in-memory stubClient regardless
   * of mode — useful for diagnosing "why am I always getting the
   * stub C major scale?"
   */
  keyConfigured: boolean
  /** Which LLM client served the legacy path (or would have, if mode=off). */
  legacyClient: 'real' | 'stub'
  /**
   * Product/paywall tier this request actually resolved to (`free` =
   * bounded ≤4-bar generation; `pro` = full sectional / whole-score). Lets
   * the debug panel confirm the paywall toggle took effect. Optional so
   * pre-M26 payloads (and any path that doesn't compute it) stay valid.
   */
  generationTier?: 'free' | 'pro'
  /**
   * Per-tier API-key configuration. In PR A all tiers map to
   * Anthropic (no other provider exists yet); PR B+ introduces the
   * provider registry and this reflects each tier's active provider.
   */
  keyStatus: { small: boolean; medium: boolean; large: boolean }
}

export interface ChatResponse {
  chatId: string
  abc: string
  introText?: string
  /** Structured score useful for future client-side features (export, diff). */
  scoreJson?: Score
  /**
   * Anthropic-issued (or synthetic, for orchestrator paths) tool_use id
   * for the render_score call that produced `scoreJson`. The client
   * uses it to (a) anchor optimistic transcript appends to the same id
   * a subsequent GET /api/chat would emit, and (b) target a later
   * /api/chat/fork request to this exact assistant turn.
   */
  toolUseId?: string
  /**
   * Server-side id of the score_versions row just produced by this LLM
   * turn. The client uses it as `parentVersionId` on subsequent edit
   * POSTs to /api/sessions/:id/versions, so the CAS chain is correct.
   * Absent when the assistant turn produced no Score (converse handler).
   */
  headVersionId?: string
  /** Present only when the orchestrator was involved (any mode). */
  debug?: ChatDebugPayload
  /**
   * M3.5-PR-4 — replacement-as-confirmation gate. True when the
   * orchestrator detected that this turn would replace the user's
   * score wholesale (retainedIdentityRatio < 0.5 + metadata changed +
   * no explicit-rewrite intent). When true:
   *   - `scoreJson` IS still the candidate AI-proposed score (so the
   *     UI can render a side-by-side diff in the confirmation modal)
   *   - The server-side `sessions.head_version_id` was NOT advanced
   *     to the new score_versions row; the candidate row exists in DB
   *     as orphan-until-confirmed.
   *   - The client must POST /api/chat/confirm-replacement with the
   *     user's accept/reject choice; until then the editor should
   *     NOT swap to the candidate score.
   * Always undefined when the gate didn't fire.
   */
  requiresConfirmation?: boolean
  /**
   * M3.5-PR-4 — populated alongside `requiresConfirmation`. Carries
   * the data the modal needs to render reasons + identify the
   * candidate version for the confirm-replacement POST.
   */
  replacement?: {
    retainedIdentityRatio: number
    reasons: string[]
    /** score_versions.id of the candidate row. Used by
     *  /api/chat/confirm-replacement to advance the head. */
    candidateVersionId: string
  }
  /**
   * M24-PR-2 — AI ghost preview proposal. Populated alongside
   * `requiresConfirmation` when the orchestrator's ghost-preview hook
   * fires (gated by `SL_GHOST_PREVIEW`). When true:
   *   - `scoreJson` IS the candidate AI-proposed score
   *   - `sessions.head_version_id` was NOT advanced (the candidate row
   *     is orphan-until-promoted)
   *   - The client renders an inline warm-amber overlay (PR-3) when
   *     `affectedEventIds.length <= 4`, or a docked diff panel (PR-4)
   *     otherwise. Per-id positioning happens via the score's SourceMap.
   *   - On accept, the client POSTs to /api/chat/confirm-replacement
   *     with the candidateVersionId to promote the head (PR-2 reuses
   *     the existing replacement-confirm endpoint; PR-3+ may add a
   *     proposal-specific endpoint if the flows diverge).
   *
   * Mutually exclusive with `replacement`. Always undefined when the
   * ghost-preview hook didn't fire.
   */
  proposal?: {
    /** Event ids in `scoreJson` whose contents differ from the
     *  pre-proposal score, or which were inserted. Drives both the
     *  inline-vs-panel decision (via length) and PR-3's per-note
     *  highlight rendering. */
    affectedEventIds: string[]
    /** score_versions.id of the candidate row, parallel to
     *  `replacement.candidateVersionId`. */
    candidateVersionId: string
  }
}

/**
 * Body of POST /api/chat/confirm-replacement. Sent by the UI after the
 * user picks one of the three modal options.
 */
export interface ConfirmReplacementRequest {
  chatId: string
  candidateVersionId: string
  decision: 'accept' | 'reject' | 'dont_ask_again_this_session'
}

export interface ConfirmReplacementResponse {
  chatId: string
  /** Final head_version_id after the decision was applied. */
  headVersionId: string
  /** True when the session-scoped suppression flag is now on. */
  replacementGateSuppressed: boolean
}

/**
 * Compact summary of a Score block used in transcript turns. Keeps the
 * GET /api/chat response small (no full Score JSON per turn) while still
 * carrying enough to render a one-line card in the panel.
 */
export interface ScoreSummary {
  title?: string
  key: string
  meter: string
  tempo_bpm?: number
  measureCount: number
  /** Number of staves (1 = single, 2 = grand staff). Optional for
   *  back-compat with older transcript entries that predate
   *  multi-staff support. */
  staffCount?: number
  /** Per-staff voice count. Length matches staffCount. */
  voiceCountPerStaff?: number[]
}

/**
 * One turn in the panel-facing transcript. Derived server-side from the
 * stored ChatMessage[] in conversations.ts. Designed to be cheap to
 * render: no raw Score JSON, just the summary + the toolUseId so the
 * client can target /api/chat/fork.
 */
export type TranscriptTurn =
  | { role: 'user'; kind: 'text'; text: string; ts?: number }
  | {
      role: 'user'
      kind: 'refinement'
      text: string
      /** True when the user manually edited the score before this turn. */
      hadEdit: boolean
      /** The prior assistant tool_use_id this refinement was anchored to. */
      toolUseId: string
      ts?: number
    }
  | {
      role: 'assistant'
      kind: 'render_score'
      introText?: string
      scoreSummary: ScoreSummary
      /** Anthropic-issued (or synthetic) id for the render_score tool_use. */
      toolUseId: string
      /**
       * Stable canonical hash of the produced Score. Always present
       * on server-emitted turns; absent on client-optimistic appends
       * (the Node-crypto-based hash is server-only). The panel only
       * uses this for metadata — the "Current" badge is positional
       * (last assistant turn), not hash-based.
       */
      scoreHash?: string
    }
  | {
      role: 'assistant'
      kind: 'text'
      /** Markdown answer body (rendered with react-markdown on the client). */
      text: string
      /** Synthetic toolUseId so optimistic + server-mapped turns can be
       *  matched on subsequent GET /api/chat refreshes. */
      toolUseId: string
      /** True while the stream is still in flight (client-only). */
      streaming?: boolean
      /**
       * Server-emitted only — true when the persisted message is in a
       * non-`complete` stream_status (`partial` reaped → `errored`, or
       * the stream errored mid-flight, or the user cancelled). Client
       * renders these turns with an "[interrupted]" indicator instead
       * of as a normal answer.
       */
      errored?: boolean
      /** Populated alongside `errored` — e.g. `stale_partial` (reaped),
       *  `upstream_error` (LLM threw), `client_abort` (user closed tab). */
      errorCode?: string
      /** Human-readable failure message (client-only). Set by
       *  `failStreamingTurn` when a converse stream errors or drops, so
       *  the chat can render the actual reason rather than a generic
       *  "[interrupted]". Server-hydrated errored turns carry only
       *  `errorCode`; the panel maps that to a message when this is absent. */
      errorText?: string
      ts?: number
    }
  | {
      role: 'assistant'
      kind: 'cta'
      /** Structured limit-reached call-to-action (quota / login gate). A
       *  CLIENT-ONLY synthetic turn — never POSTed or persisted, so a
       *  GET /api/chat refresh never replays a stale card. */
      cta: ChatCta
      toolUseId: string
      ts?: number
    }

export interface TranscriptResponse {
  chatId: string
  turns: TranscriptTurn[]
  /**
   * The score at the session's current head, returned alongside the
   * transcript so a sidebar switch can fully hydrate the editor in one
   * roundtrip (transcript + score + ABC) rather than chaining two fetches.
   * Absent when the session has no LLM-generated score yet (just created,
   * or all turns are converse-only).
   */
  currentScore?: Score
  /** ABC string for `currentScore`, transpiled server-side. */
  currentAbc?: string
  /** Server-side id of the score_versions row at head; client uses this
   *  as parentVersionId when persisting subsequent edits. */
  headVersionId?: string
  /** toolUseId of the assistant turn that produced the head score —
   *  lets the client target /api/chat/fork against the right turn. */
  currentToolUseId?: string
  /** Intro text of the assistant turn that produced the head score. */
  currentIntroText?: string
  /**
   * The current head's parent chain, oldest→head, capped at 50 entries.
   * Used by the client to seed its undo stack so Ctrl+Z works across
   * page reloads, not just within a session. Absent when there's no
   * head; an empty array means head with no parents.
   */
  versions?: VersionEntry[]
}

/**
 * One entry in the linear undo chain for a session, walked back via
 * `parent_version_id` from head. Source distinguishes LLM checkpoints
 * from manual edits in case the client wants to render markers.
 */
export interface VersionEntry {
  id: string
  parentVersionId: string | null
  scoreJson: Score
  source: 'llm' | 'edit' | 'import' | 'fork-seed' | 'revert'
  createdAt: number
}

/**
 * One row in the sidebar's session list. Server returns these sorted by
 * `lastMessageAt DESC`. Designed to be self-sufficient — the sidebar
 * should never need a follow-up fetch per row.
 */
export interface SessionSummary {
  id: string
  /** User-editable; null until first prompt or explicit rename. */
  title: string | null
  /** Unix epoch seconds; sidebar sort key. */
  lastMessageAt: number
  createdAt: number
  /** Total message rows for the session. Lets the sidebar hide empty drafts. */
  messageCount: number
  /** Current score head; null when the session has no Score yet (just created). */
  headVersionId: string | null
  /** Provenance for forked sessions; null for top-level sessions. */
  forkedFromSessionId: string | null
  /** Best-effort: first ~80 chars of the latest user message. Null when empty. */
  preview: string | null
}

export interface SessionListResponse {
  sessions: SessionSummary[]
}

export interface SessionCreateResponse {
  session: SessionSummary
}

export interface ForkRequest {
  /** The source chat to fork from. */
  fromChatId: string
  /** The assistant tool_use id within fromChatId to seed the new chat with. */
  toolUseId: string
}

export interface ForkResponse {
  chatId: string
  abc: string
  scoreJson: Score
  introText?: string
  toolUseId: string
}

export interface RevertRequest {
  /** The chat whose head should move back. Stays the same after revert. */
  chatId: string
  /** Assistant render_score tool_use id within chatId to revert to. */
  toolUseId: string
}

export interface RevertResponse {
  /** Echo of the request chatId — unchanged (same session). */
  chatId: string
  abc: string
  scoreJson: Score
  introText: string
  /** Newly-minted synthetic toolUseId for the appended assistant turn. */
  toolUseId: string
  /** New score_versions row id (becomes the session head). */
  headVersionId: string
  /** Assistant render_score turn to append to the client's turns[]. */
  newTurn: Extract<TranscriptTurn, { role: 'assistant'; kind: 'render_score' }>
}

export type ChatErrorCode =
  | 'invalid_request'
  | 'chat_not_found'
  | 'chat_full'
  | 'rate_limited'
  | 'bot_check_required'
  | 'upstream_error'
  | 'validation_failed'
  | 'refused'
  | 'internal_error'
  | 'stale_score'
  | 'import_failed'
  | 'output_too_large'
  | 'deadline_exceeded'
  // Daily request-quota gate (hosted abuse-gating layer; off by default).
  // 'quota_exceeded' = the anon/free daily cap was hit (429; carries a `cta` +
  // reset hint). 'login_required' = a risky-IP anonymous request that must sign
  // in to continue (403; carries a `cta`). Both also populate the plain `error`.
  | 'quota_exceeded'
  | 'login_required'
  // Recovery against an identity that has been upgraded to a real account.
  // The anonymous recovery path is closed for claimed accounts; the client
  // branches on this to prompt a sign-in instead of clearing its backup.
  | 'account_claimed'

/**
 * A structured call-to-action attached to a quota/login error so the chat UI can
 * render a button (sign up / log in / Pro waitlist) instead of only plain text.
 * `primaryAction:'openLogin'` opens the in-app auth modal; otherwise `primaryHref`
 * is a link. The plain `error` string is ALWAYS populated alongside this, so an
 * older client that ignores `cta` still shows a message. (Client rendering of the
 * card/modal lands in a later PR; the server emits this now.)
 */
export interface ChatCta {
  kind: 'signup' | 'waitlist' | 'login' | 'busy'
  title: string
  body: string
  primaryLabel: string
  primaryHref?: string
  primaryAction?: 'openLogin'
  secondaryLabel?: string
  secondaryHref?: string
  secondaryAction?: 'openLogin'
  /** Whole hours until the quota window resets; omitted for the login gate. */
  resetsInHours?: number
}

export interface ChatErrorResponse {
  error: string
  code: ChatErrorCode
  /** Structured CTA for quota_exceeded / login_required (see ChatCta). */
  cta?: ChatCta
  /**
   * Set when the failure happens after the server has resolved a
   * session id (i.e. the user turn may already be persisted as an
   * orphan — see the early `appendMessages([userTurn])` in
   * `src/app/api/chat/route.ts`). The client keeps this in chat state
   * so the user can retry against the same session and the orphan
   * user row gets collapsed into the next attempt by
   * `prepareMessagesForLLM`. Absent for errors that fired before
   * chatId resolution (parse / size / origin / unknown-chat).
   */
  chatId?: string
}

/**
 * Import-feature wire types. Mirrors ImportWarning in
 * `@/lib/music/import/types` so the client doesn't import the
 * parser module just to render warnings.
 */
export type ImportWarningSeverity = 'block' | 'choice' | 'info'

export interface ImportWarningWire {
  severity: ImportWarningSeverity
  code: string
  message: string
  meta?: Record<string, unknown>
}

export type ImportFormat = 'abc' | 'midi' | 'json' | 'musicxml' | 'blank'

export interface ImportResponse extends ChatResponse {
  /** Warnings produced during parsing (severity 'choice'/'info' only —
   *  'block' warnings cause a 422 instead of a 200). */
  warnings: ImportWarningWire[]
  importFormat: ImportFormat
  /** Filename the import was created from, if any. Drives the post-import toast. */
  filename?: string
}

/**
 * Body of POST /api/import in JSON mode. Multipart form-data is the
 * file/binary path and isn't typed here — see the route schema.
 */
export interface ImportJsonRequest {
  format: 'abc' | 'json'
  /** Raw ABC text or stringified Score JSON. */
  text: string
  filename?: string
  truncateIfLong?: boolean
}

export interface ImportErrorResponse {
  error: string
  code: 'import_failed' | 'invalid_request'
  warnings?: ImportWarningWire[]
}
