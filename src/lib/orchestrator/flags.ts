function readBool(name: string): boolean {
  const v = process.env[name]
  if (!v) return false
  return v === '1' || v.toLowerCase() === 'true'
}

function readExplicitFalse(name: string): boolean {
  const v = process.env[name]
  if (!v) return false
  return v === '0' || v.toLowerCase() === 'false'
}

export type OrchestratorMode = 'off' | 'shadow' | 'primary'

/**
 * Resolve the orchestrator's operating mode for the current request.
 * Read on every call (no module-load caching) so kill switch / mode
 * toggles take effect without redeploy.
 *
 * Phase 5: orchestrator is ON by default. The presence of
 * ORCHESTRATOR_ENABLED=false (or '0') opts out.
 *
 * Layering, highest precedence first:
 *   ORCHESTRATOR_KILL=1            → 'off' (operator escape hatch)
 *   ORCHESTRATOR_ENABLED in {false,0} → 'off' (explicit opt-out)
 *   ORCHESTRATOR_MODE=shadow       → 'shadow' (orchestrator runs
 *     alongside legacy; legacy wins the response, divergence is logged)
 *   default                        → 'primary'
 */
export function getOrchestratorMode(): OrchestratorMode {
  if (readBool('ORCHESTRATOR_KILL')) return 'off'
  if (readExplicitFalse('ORCHESTRATOR_ENABLED')) return 'off'
  if (process.env.ORCHESTRATOR_MODE === 'shadow') return 'shadow'
  return 'primary'
}

/**
 * Convenience for callers that only care whether the orchestrator
 * runs at all (primary OR shadow).
 */
export function isOrchestratorEnabled(): boolean {
  return getOrchestratorMode() !== 'off'
}

/**
 * @deprecated Lever B — `compose` handler's sub-classifier dispatch.
 *
 * The compose patch-vs-regen sub-dispatcher (Lever B) is superseded by
 * the M3.5 native tool-use dispatcher (`isNewToolDispatchEnabled`).
 * When the new dispatcher is enabled (default since PR-6), the compose
 * handler is reached only via the dispatcher's `regenerate_all` branch,
 * and this flag's sub-classifier is dead code on that path. The flag is
 * still honored when the new dispatcher is explicitly opted out via
 * `SL_NEW_TOOL_DISPATCH=0`. Will be removed in a future milestone once
 * the legacy classifier path is retired.
 *
 * Set `SL_COMPOSE_PATCH_DISPATCH=1` to enable. Read on every call so
 * toggles take effect on the next request without redeploy (matching
 * the existing kill-switch pattern).
 */
export function isComposePatchDispatchEnabled(): boolean {
  return readBool('SL_COMPOSE_PATCH_DISPATCH')
}

/**
 * M3.5 — native 5-tool dispatch layer replacing the legacy Haiku intent
 * classifier. When enabled, Claude itself picks among
 * extend_composition / insert_measures / region_replace /
 * edit_intra_measure / regenerate_all (with an explicit-rewrite gate)
 * — eliminating the misclassification risk that surfaced as the
 * triplet-demo silent-replacement bug.
 *
 * **Default ON since PR-6.** Set `SL_NEW_TOOL_DISPATCH=0` (or `false`)
 * to fall back to the legacy classifier path. Read on every call so
 * operators can flip without redeploy.
 */
export function isNewToolDispatchEnabled(): boolean {
  return !readExplicitFalse('SL_NEW_TOOL_DISPATCH')
}

/**
 * M3.5-PR-4 — replacement-as-confirmation gate. ON by default. When
 * disabled (`SL_REPLACEMENT_GATE=0` or `false`), the orchestrator
 * never marks a turn as `requiresConfirmation` and the legacy silent-
 * replace behaviour returns. Provided as an escape hatch in case the
 * gate misfires (e.g. on a corpus where wholesale key changes are
 * common and expected). Read on every call so operators can flip
 * without redeploy.
 */
export function isReplacementGateEnabled(): boolean {
  return !readExplicitFalse('SL_REPLACEMENT_GATE')
}

/**
 * M24 — AI ghost preview. When enabled, every successful score-
 * mutating LLM turn returns a proposal (instead of silently committing
 * the new score). The route gates head-version bump on the proposal,
 * and the client renders a warm-amber inline overlay (<=4 affected
 * event ids) or a right-docked diff panel (>=5). Manual edits during
 * a pending proposal interrupt it; a 30s toast offers Resume.
 *
 * **ON by default since M24-PR-6.** Set `SL_GHOST_PREVIEW=0` (or
 * `false`) to opt out — the orchestrator silently commits scores and
 * the overlay/panel UI never fires. Read on every call so operators
 * can flip without redeploy.
 *
 * Mutually exclusive with the replacement gate: when both apply to
 * the same turn, the replacement gate wins (it has its own modal +
 * "don't ask again this session" affordance that the proposal flow
 * doesn't replicate).
 */
export function isGhostPreviewEnabled(): boolean {
  return !readExplicitFalse('SL_GHOST_PREVIEW')
}

/**
 * M25 — sectional (chunked) streamed score generation. When enabled, a
 * fresh `generate_complex` request (no editedScore) is routed through the
 * plan -> seed -> extend-per-section pipeline (`runGenerateSectionalStream`)
 * and delivered over SSE, so large pieces never truncate and the score
 * renders section-by-section. **ON by default since M25-PR-5** (route
 * maxDuration raised + the client score-stream consumer landed). Set
 * `SL_SECTIONAL_GEN=0` (or `false`) to fall back to single-shot
 * `runGenerateComplex`. Read on every call so operators can flip without
 * redeploy.
 */
export function isSectionalGenEnabled(): boolean {
  return !readExplicitFalse('SL_SECTIONAL_GEN')
}

/**
 * M26 — free-tier bounded single-call generation. When enabled (default ON),
 * a fresh `generate` on the `free` product tier is served by the bounded
 * <=4-bar `runGenerateBounded` handler (one render_score call, tight max_tokens
 * ceiling, no planner/sectional loop). This is an INDEPENDENT emergency
 * off-switch for that code path: `SL_BOUNDED_GEN=0` reverts free users to the
 * legacy/sectional path WITHOUT opening the paywall (decouples "is the paywall
 * closed" from "is the bounded handler healthy"). The product-tier decision
 * itself lives in `generationTier.ts`. Read fresh; no redeploy.
 */
export function isBoundedGenEnabled(): boolean {
  return !readExplicitFalse('SL_BOUNDED_GEN')
}

/**
 * M26 — opt-in for the SECONDARY streaming-abort kill-switch (the reusable
 * `streamGuard` wired into the Anthropic `textStream` path). OFF by default
 * because the bounded `render_score` path is non-streaming and bounded by
 * `max_tokens` alone; turn ON (`SL_STREAM_ABORT=1`) to enforce a mid-stream
 * output-token / wall-clock cut-off on the converse/text (and any future
 * streamed-tool) path. Read fresh.
 */
export function isStreamAbortEnabled(): boolean {
  return readBool('SL_STREAM_ABORT')
}
