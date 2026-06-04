# Orchestrator (M3.5)

The orchestrator is the entry point for every `/api/chat` request that
needs LLM reasoning over a Score. It owns:

- copyright filter (synchronous, pre-LLM)
- dispatch — pick the right handler for the user's prompt
- handler execution
- server-side preservation verification
- replacement-as-confirmation gate
- observability (`orchestrator_turns` table)

The single entry point is `run(input)` in `index.ts`.

## Architecture overview

```
                ┌─────────────────────────────────────┐
                │           /api/chat POST            │
                └──────────────────┬──────────────────┘
                                   │
                          orchestrator.run(input)
                                   │
                                   ▼
                       ┌──────── copyright ────────┐
                       │  blocked?  → refuse(422)  │
                       └─────────────┬─────────────┘
                                     │ pass
                                     ▼
            ┌──────────────────────────────────────────────┐
            │   SL_NEW_TOOL_DISPATCH default-ON since PR-6 │
            │              + editedScore present           │
            └──────────────┬───────────────────────────────┘
                  ┌────────┴────────┐
                  ▼                 ▼
            new path           legacy path
       (native tool-use)    (Haiku classifier)
                  │                 │
            ┌─────┴─────┐            ▼
            │ dispatcher│       classify({kind, ...})
            │ picks 1/6 │            │
            └─────┬─────┘            ▼
                  │            switch(kind):
                  ▼            edit_score_level / edit_intra_measure /
       extend_composition      generate_simple / generate_complex /
       insert_measures         compose / converse / refuse
       region_replace                 │
       edit_intra_measure             │
       regenerate_all                 │
       answer_question                │
                  │                   │
                  └─────────┬─────────┘
                            ▼
                  ┌──────── handler ────────┐
                  │  emits Score + appliedOps│
                  └──────────────┬──────────┘
                                 ▼
                      preservationVerifier
                       (hash check on
                        retained measures)
                                 │
                                 ▼
                       replacementDetect
                       (gate fires when
                        > 0.5 of measures
                        replaced AND
                        meta changed AND
                        prompt lacks
                        rewrite intent)
                                 │
                                 ▼
                       recordTurn → DB
                                 │
                                 ▼
                            response
```

### The 6-tool dispatcher (PR-3; `answer_question` added later)

`toolDispatch.ts` calls Claude (Sonnet, with prompt caching) with a
schema that lists exactly six tools. The model picks the one that fits
the user's prompt + the current Score:

| Tool                  | Used when                                          | Handler                  |
| --------------------- | -------------------------------------------------- | ------------------------ |
| `extend_composition`  | "add N more bars", "continue this"                 | `runExtendComposition`   |
| `insert_measures`     | "insert 2 bars after bar 4"                        | `runInsertMeasures`      |
| `region_replace`      | "replace bars 5-8 with a turnaround"               | `runRegionReplace`       |
| `edit_intra_measure`  | "raise the third note", "make beat 2 a quarter"    | `runEditIntraMeasure`    |
| `regenerate_all`      | "start over", "rewrite this from scratch"          | `runCompose`             |
| `answer_question`     | "explain the bass line", "what key is this?"       | `runConverse` (stream)   |

`answer_question` is the only **read-only** tool: it answers a question
about the score (theory / analysis / "what's happening") and returns an
`OrchestratorConverseStream` rather than a Score. It exists because the
dispatcher runs with `tool_choice:'required'` — without a question
option, a theory question was forced into `edit_intra_measure`, which
emitted no ops, threw, and fell through to the legacy score path, so the
user got no answer. `runDispatchedHandler` returns its stream **before**
`finalizeDispatchResult`, so it skips preservation verification, the
replacement gate, and the ghost-preview hook (there is no score
mutation), and records its own `converse` turn inline.

Confidence in the dispatcher is heuristic — Claude doesn't return a
tool-pick confidence natively. We tag explicit tool calls at 0.85 and
let the gate downstream catch any wrong-tool mistakes. The
`regenerate_all` schema requires `confirmExplicitRewrite: true` AND a
`justification` field; defense-in-depth, if the model ever picks it
without an explicit prompt signal we return a preview-mode payload
instead of applying.

### Server-side preservation verification (PR-3)

`preservationVerifier.ts` re-hashes the measures the tool was
supposed to leave untouched (`extend_composition` and `insert_measures`
both carry an implicit "retain bars 0..N-1" contract) and refuses to
apply the result if any measure hash doesn't match the input.
Trust-nothing-the-LLM-says: even though the tool schemas forbid
re-emitting key/meter/title/tempo, the verifier catches the case where
the model returns a measure with the same conceptual content but a
single-event mutation that would corrupt user work.

When verification fails, the handler throws and the orchestrator
falls through to the legacy path so the user still gets a response.

### Index remap (PR-3)

When `insert_measures` adds bars in the middle of a score, every
`techniqueState.measureIdx`, `volta.startMeasureIdx/endMeasureIdx`,
`jumpMarker.measureIdx`, `marker.measureIdx`, and
`annotation.measureIdx` must shift by the inserted count.
`structuralOps.ts:remapMeasureIndicesAfterInsert` rewrites these in
place after each insertion. The function is pure (returns a new score)
and covered by unit tests in `tests/unit/orchestrator/structuralOps.test.ts`.

### Cadence-at-boundary detect (PR-3)

`cadenceDetect.ts` is a heuristic that flags when an
`extend_composition` is appending bars after a V→I motion that lands
on a final-barline-terminated measure (i.e., the piece was already
"ending"). The detector is **warn-only** — sets
`result.cadenceAtBoundary = true` on the result envelope; the UI may
choose to surface a soft "Are you sure you want to extend past the
final cadence?" notice, but the orchestrator never blocks the edit.

### Replacement-as-confirmation gate (PR-4)

`replacementDetect.ts` runs after EVERY score-producing handler. The
gate fires when ALL of:

1. **retained-measure-identity ratio < 0.5** — over half the measures
   that existed in the input score are no longer byte-identical in the
   output.
2. **at least one of `key` / `meter` / `title` changed**
3. **the user's prompt did NOT contain explicit-rewrite intent** — the
   keyword regex matches `rewrite | replace | start over | from scratch |
   new piece | redo | scrap this | fresh start | recompose | compose anew`.

When the gate fires, the orchestrator sets
`result.requiresConfirmation = true` and attaches
`result.replacement = { retainedIdentityRatio, reasons }`. The route
persists the candidate score_version without bumping head, and the UI
modal (`ReplacementConfirmModal.tsx`) lets the user accept, reject, or
"don't ask again this session".

#### Override mechanisms

- `SL_REPLACEMENT_GATE=0` — kill the gate entirely (operator escape
  hatch).
- `sessions.replacement_gate_suppressed = 1` — per-session toggle set
  by the modal's "don't ask again" option.
- `regenerate_all` dispatch — the dispatcher's choice of
  `regenerate_all` with `confirmExplicitRewrite: true` is treated as
  the user's explicit intent; the gate downgrades to soft-confirm.

### AI ghost preview (M24)

`maybeAttachGhostProposal` runs immediately after the replacement gate
on every score-producing handler. When the flag is enabled (default ON
since M24-PR-6), the hook computes `affectedEventIds` from the
before/after score diff and attaches a `proposal` payload to the
result envelope:

```ts
result.proposal = { affectedEventIds: string[] }
result.requiresConfirmation = true
```

The route honors `requiresConfirmation` exactly like the replacement
gate (skip head bump, return the candidate row id). The client renders
either an inline warm-amber overlay (`<=4` affected event ids) or a
right-docked diff panel (`>=5`) and lets the user accept (Enter) or
reject (Esc).

**Mutually exclusive** with the replacement gate — when both apply
to the same turn, the replacement gate wins (it has its own modal +
"don't ask again this session" affordance the proposal flow doesn't
replicate).

**No-op cases** (silent commit, no proposal):
- `SL_GHOST_PREVIEW=0` (operator opt-out)
- No `editedScore` (compose-from-scratch)
- Replacement gate already fired
- `requiresConfirmation` already set (preview-mode `regenerate_all`)
- Result score is byte-identical to input (nothing to preview)

**Manual edits during a pending proposal** auto-interrupt the
proposal via the store's `interruptedProposal` slot; a 30s
"Resume AI suggestion" toast lets the user put it back.

Rollback: `SL_GHOST_PREVIEW=0` reverts to the M3.5 silent-commit
behavior. Score-mutating turns commit head immediately as before.

### Handler validation-retry (PR-5b)

The four score-producing handlers (`extendComposition`, `insertMeasures`,
`regionReplace`, `editIntraMeasure`) retry once on `ValidationError` —
when the LLM emits measures whose durations don't sum to the meter, or
otherwise produces a score that fails `validateScore`, the handler
re-prompts with the validation failure message injected into the user
text and accepts the second attempt. After two failed attempts the
handler throws its dedicated error and the orchestrator falls through.

Only `ValidationError` triggers retry. `ProviderSchemaError` (the model
returned malformed tool input) and `UpstreamError` / `RateLimitedError`
(handled by `callWithFailover` and the SDK's own retry layer) fall
through immediately. Provider-level retries are separate.

## Env flag reference

| Flag                          | Default | Purpose                                                                                              |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `SL_NEW_TOOL_DISPATCH`        | **on**  | Native tool-use dispatcher. Set to `0`/`false` to roll back to the legacy Haiku classifier path.     |
| `SL_REPLACEMENT_GATE`         | on      | Replacement-as-confirmation gate. Set to `0`/`false` to skip the gate entirely.                      |
| `SL_GHOST_PREVIEW`            | **on**  | AI ghost preview (M24). Set to `0`/`false` to opt out — orchestrator silently commits scores.        |
| `SL_COMPOSE_PATCH_DISPATCH`   | off     | **Deprecated.** Lever B patch-vs-regen sub-classifier. Ignored when the new dispatcher is enabled.   |
| `SL_GENERATION_TIER`          | free    | **M26** product/paywall tier (orthogonal to the model-size tier). `free` (default) routes a fresh from-scratch generation to the bounded ≤4-bar single-call handler (2600-token kill-switch, no planner/sectional loop); `pro` keeps the sectional/whole-score pipeline. Resolved per request in `generationTier.ts`; swap that one function's body for a per-user entitlement to flip the paywall. |
| `SL_FORCE_FREE_TIER`          | unset   | **M26** operator kill: forces `free` for the whole instance regardless of tier/entitlement — instantly stops long-running pro generation, no redeploy. |
| `SL_ALLOW_TIER_OVERRIDE`      | unset   | **PR-0** opt-in to honor the **client-supplied** debug `generationTier` override under `NODE_ENV=production` (staging boxes). **Dangerous in real prod** — lets callers self-select `pro`. Unset on internet-reachable deploys; auto-honored only in `development`/`test`. |
| `SL_BOUNDED_GEN`              | **on**  | **M26** the free-tier bounded handler. `0`/`false` reverts free users to the legacy/sectional path WITHOUT opening the paywall (independent rollback of the new code path). |
| `SL_STREAM_ABORT`            | off     | **M26** opt-in secondary streaming kill-switch (output-token + wall-clock abort wired into `textStream`). Off by default — the bounded `render_score` path is non-streaming and bounded by `max_tokens` alone; on enforces a mid-stream cutoff on the converse/text path. |
| `ORCHESTRATOR_KILL`           | unset   | Operator kill switch — orchestrator returns null from every call, route falls through to legacy LLM. |
| `ORCHESTRATOR_ENABLED`        | on      | Set `false` / `0` to disable the orchestrator at the route level.                                    |
| `ORCHESTRATOR_MODE`           | primary | Set `shadow` to run the orchestrator alongside legacy (legacy wins the response; divergence logged). |
| `ORCHESTRATOR_LOG_SILENT`     | unset   | Set `1` in tests to suppress `recordTurn` stdout/DB writes.                                          |

The replacement-as-confirmation gate flag and the dispatcher flag are
orthogonal — both default-on. The gate runs on the new-dispatch path
AND the legacy-classifier path.

**M26 bounded generation (default-on, free tier).** A fresh from-scratch
generation defaults to a single bounded `render_score` call (≤4 bars grand
staff) via `handlers/generateBounded.ts`, gated at a pre-classify choke point in
`run()` so it catches every fresh-generation path (`generate_simple` /
`generate_complex` / `compose` AND confidence-floor fall-throughs) in one place.
The `BOUNDED_EMIT_CEILING` (2600) `max_tokens` IS the per-request kill-switch —
an overflow throws the already-handled `OutputTruncatedError` → clean 422, never
a runaway. The product tier is resolved in `generationTier.ts`
(`resolveGenerationTier`) — env/operator default now (the client debug override
is gated to dev/test or `SL_ALLOW_TIER_OVERRIDE`, never honored in prod), a
one-function swap to a per-user entitlement later. Roll back with `SL_BOUNDED_GEN=0` (free users → the
legacy/sectional path, paywall stays closed) or `SL_GENERATION_TIER=pro` (reopen
whole-score generation for everyone). The reusable streaming guard
(`providers/streamGuard.ts`, behind `SL_STREAM_ABORT`) is the secondary
kill-switch for the streamed converse/text path. Edit handlers cap input by
sending only the relevant bars (`extendComposition`) or compact JSON
(`editIntraMeasure`).

## Forensic replay

Every orchestrator turn is persisted to the `orchestrator_turns`
table (Drizzle migration `0004_orchestrator_turns.sql`). Replay any
historical session with:

```sh
npm run replay -- --session <session-id>
# Redacted by default. Include full prompts + scores:
npm run replay -- --session <session-id> --unsafe-include-content
```

`scripts/replay.ts` walks the `orchestrator_turns` rows in
chronological order, prints classification + handler decisions,
before/after score diffs (via `scoreDiff.ts`), and flags any rows
where `replacement_blocked=1`. Useful for triaging "the AI did
something weird" support tickets without re-running the LLM.

## Observability schema

`orchestrator_turns` columns (see `drizzle/0004_orchestrator_turns.sql`
and `0005_replacement_gate.sql`):

- `id`, `request_id`, `session_id`, `created_at`
- `label` (TaskKind), `handler`, `model`, `latency_ms`,
  `final_status` (`ok` | `refused` | `fell_through` | `error`)
- `confidence` (classifier or dispatcher score)
- `error` (string error class + message), `applied_ops_count`
- `before_score_version_id`, `after_score_version_id` — FK to
  `score_versions` (no JSON duplication; rehydrate via join)
- `compose_patch_dispatch` — broadened in PR-3 to record the dispatcher's
  picked tool name (`extend_composition`, `insert_measures`, etc.) for
  rows that fired through the new path
- `replacement_blocked` (0/1) — PR-4
- `diff_algo_version`

Cost of a typical row: ~200 bytes. 90-day retention is enforced by
the weekly `Retention` GitHub Actions workflow
(`.github/workflows/retention.yml`), which runs
`pnpm trim:orchestrator-turns` every Sunday at 04:00 UTC.

## PR-7 hardening

M3.5-PR-7 closes the milestone with a cleanup + tuning batch on top
of the dispatcher / verifier / gate substrate:

- **Backfill**: `scripts/backfill-orchestrator-turns.ts` walks every
  historical assistant `messages` row and synthesizes a best-effort
  `orchestrator_turns` row keyed by `messageId`. Re-runnable
  (idempotent — second pass is a no-op). Wire via
  `pnpm backfill:orchestrator-turns`.
- **Retention**: `scripts/trim-orchestrator-turns.ts` wraps the pure
  `trimOrchestratorTurns(90)` helper and the new
  `.github/workflows/retention.yml` cron fires it weekly.
- **Cadence-detector tuning**: PAC phrases that end with a repeated
  tonic (IV V I I) now detect — the detector skips trailing
  tonic-repeats before identifying the cadential motion. Fixes the
  `turnaround-after-PAC` live eval.
- **Logging silence guards**: the 4 score-producing handlers'
  retry-attempt + validation-failure log lines now respect
  `ORCHESTRATOR_LOG_SILENT=1` (matches the observability.ts
  convention). Test suites no longer surface 8 expected warnings.
- **Replay perf**: `scripts/replay.ts` pre-fetches all referenced
  `score_versions` in one query instead of issuing 2N point queries
  inside the per-turn loop (PR-3 review M4).
- **Error-truncation constant**: `ERROR_MAX_LEN` (500) is exported
  alongside a new `RECOVERY_ERROR_MAX_LEN` (200) for the in-process
  insert-failure recovery line (PR-3 review M5).
- **Canon-event empty-pitches handling**: `canonEvent` collapses
  empty-`pitches[]` rests to a canonical form so they don't
  hash-match against unrelated empty-pitches events (PR-3 review M3).

## When something goes wrong

### Roll back the dispatcher

Set `SL_NEW_TOOL_DISPATCH=0` in the production env. The orchestrator
falls back to the Haiku classifier on the next request — no redeploy
needed (flags are read on every call).

### Roll back the replacement gate

Set `SL_REPLACEMENT_GATE=0`. The orchestrator stops marking turns as
`requiresConfirmation`; head pointers advance silently as in pre-PR-4.

### Kill the orchestrator entirely

Set `ORCHESTRATOR_KILL=1`. Every `/api/chat` request falls through to
the legacy single-shot Sonnet path. Use this if the orchestrator
itself is the problem (rare — the dispatcher and gate have
independent flags).

### Surface a specific session's decision trail

```sh
npm run replay -- --session <id> --unsafe-include-content
```

If the session predates PR-1's observability layer (before 2026-05-25),
the rows won't exist. PR-7's backfill (`scripts/backfill-orchestrator-turns.ts`,
deferred) will reconstruct best-effort rows from `messages` and
`score_versions`.

## Eval coverage

The 12 live eval cases in `evals/cases/{additive,destructive}/`
exercise the M3.5 red-team scenario list. Cases pin the dispatch tool
(`extend_composition`, `insert_measures`, `edit_intra_measure`, etc.)
and preservation invariants (first N bars byte-identical, key/meter/
title preserved). Run with:

```sh
RUN_LIVE_EVALS=1 ANTHROPIC_API_KEY=... pnpm eval:live
```

See `evals/README.md` for the full case list, threshold rationale,
and the visual-regression / nightly cron setup.

## Related files

- `flags.ts` — env-flag accessors (always read fresh, never cached)
- `index.ts` — orchestrator entry point + dispatch + gate hook
- `classifier.ts` — Haiku classifier (legacy path)
- `toolDispatch.ts` — native tool-use dispatcher (default path)
- `handlers/extendComposition.ts`, `insertMeasures.ts`,
  `regionReplace.ts`, `editIntraMeasure.ts`, `compose.ts`
- `preservationVerifier.ts` — server-side hash verification
- `structuralOps.ts` — index remap after insert
- `cadenceDetect.ts` — warn-only cadence-at-boundary detector
- `replacementDetect.ts` — replacement-gate decision function
- `observability.ts`, `scoreDiff.ts`, `scripts/replay.ts`
