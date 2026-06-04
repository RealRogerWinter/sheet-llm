# Evals

Hybrid mock + live eval harness for the orchestrator end-to-end against
the Score domain. Introduced in M3.5-PR-2 to lock the
"add 4 more bars" → wholesale-replacement regression and to give
future PRs a place to pin contract behavior before they go in.

## What evals are (and aren't)

- **Are**: integration-flavoured tests that exercise
  `orchestrator.run(...)` against an applied Score, asserting on
  **invariants of the applied state** — measure count, key/meter
  preservation, byte-identical retained measures, applied-op kinds,
  confirmation-gating flags. The cases capture user-visible contracts,
  not internal call shapes.
- **Aren't**: unit tests. Pure-function behavior (Operation transforms,
  schema validation, ABC parsing) belongs under `tests/unit/`.
- **Aren't**: full UI tests. That's `tests/e2e/` (Playwright).

## Tiers

| Tier   | Script              | API spend | Determinism | When                          |
| ------ | ------------------- | --------- | ----------- | ----------------------------- |
| Mock   | `npm run eval:mock` | Zero      | Full        | Every PR, fast (CI)           |
| Smoke  | `npm run eval:smoke`| ~$0.01    | High        | Per-PR gate                   |
| Visual | `npm run eval:visual`| Zero     | Full        | Every PR (renderer-only)      |
| Live   | `npm run eval:live` | Per case  | Best-effort | Nightly cron / on-demand      |

Cost estimates per tier:
- **Mock**: 0 — no provider call.
- **Smoke**: ~3 Haiku classifier calls (~200 input tokens each)
  ≈ \$0.001 per CI run.
- **Visual**: 0 — deterministic abcjs render, pure path-distance diff.
- **Live**: ~12 cases × ~1500 input × Sonnet $3/M + ~300 output × $15/M
  ≈ **\$0.10 warm cache / \$0.25 cold** per full run. Anthropic Batch
  API path (50% discount, async) is a future optimization — see the
  comment in `.github/workflows/nightly-evals.yml`.

## File-naming convention

- `evals/cases/<group>/<case>.mock.eval.ts` — mock tier, stubs Anthropic
- `evals/cases/<group>/<case>.smoke.eval.ts` — smoke tier, real Haiku
- `evals/cases/<group>/<case>.live.eval.ts` — live tier, real Anthropic
- `evals/cases/visual/<case>.visual.eval.ts` — visual tier, deterministic

Each config matches its tier suffix; you can't accidentally run a
live case from `eval:mock`.

## Live cases (PR-5 — the 12)

Authored via `buildLiveCase` (`evals/lib/buildLiveCase.ts`). Each case
file describes the initial Score, user prompt, and invariant
expectations. All are skipped when `RUN_LIVE_EVALS != 1`.

Additive bucket (preserve-original contract):

1. `triplet-demo-extend-turnaround` — Live equivalent of the PR-2 mock
   repro. The exact M3.5 incident prompt; asserts measureCount=8,
   bars 0-3 byte-identical, dispatch=extend_composition.
2. `turnaround-after-PAC` — 4-bar phrase ending in V-I + final
   barline; asserts cadenceAtBoundary=true.
3. `SATB-countermelody` — multi-voice grand-staff edit; expensive,
   gated behind `RUN_LIVE_FULL=1`.
4. `modal-transform-c-to-dorian` — converts C Ionian → Dorian;
   accepts either Bb accidental or key respelled to Bb (relative
   major).
5. `augmentation-double-duration` — doubles every duration; accepts
   measure-count growth OR same-count with doubled durations.
6. `harmonize-bach-style` — full 4-voice Bach chorale; expensive
   (`RUN_LIVE_FULL=1`). Accepts edit_intra_measure OR regenerate_all
   dispatch.
7. `interpolate-mid-phrase` — insert 2 measures mid-piece; verifies
   index-remap of techniqueStates (m5 → m7 after insertion).
8. `extend-across-meter-change` — adds 4 bars in 3/4 across a
   mid-piece meter change; meter marker at idx 2 must survive.
9. `add-B-section-key-change` — adds 8-bar B section in A minor;
   accepts a KeyMarker(Am) at m8 OR all-natural new bars.
10. `extend-tied-whole-note-ending` — extends a piece ending on a
    tied whole note; accepts continuation OR a "tie" warning
    (auto-downgrade).

Destructive bucket (replace-with-confirmation contract):

11. `lowercase-roman-ambiguity` — soft-assertion diagnostic. The
    lowercase `i iv v` is ambiguous (model may interpret as minor or
    loose shorthand for major); the case logs but never hard-fails.
12. `multi-voice-piano-hand-division` — extends a piano grand-staff;
    asserts bass-staff hand-division preserved (octave ≤ 3 in new
    bass bars).

## Visual regression (PR-5)

3 reference scores (`evals/baselines/visual/`):

- `bach-invention-1` — first 4 bars of BWV 772 (monophonic, fast 16ths).
- `chopin-nocturne-op9-no2` — first 4 bars (12/8 with grace notes etc).
- `mozart-eine-kleine-nachtmusik` — first 4 bars (gallant style).

Each baseline is a pinned SVG (`<name>.baseline.svg`) regenerated via
`pnpm eval:baselines:capture`. The eval case renders the
`<name>.score.json` to SVG via abcjs and diffs against the baseline
using `pathDistance` (see `evals/lib/svgPathDistance.ts`).

**Threshold: 0.05** — a value of 0 is byte-identical render; small
float jitter from layout typically scores 0.01-0.02. A value above
0.05 indicates a real visual change.

Regenerate baselines after a deliberate renderer change:
```sh
pnpm eval:baselines:capture
git add evals/baselines/visual/*.baseline.svg
```
Inspect the diff (open both SVGs in a browser) before committing.

## Running

```sh
# CI default — no API calls:
npm run eval:mock

# Local validation against the real classifier (~$0.001):
RUN_SMOKE_EVALS=1 ANTHROPIC_API_KEY=sk-... npm run eval:smoke

# Full live suite (lands in PR-5):
RUN_LIVE_EVALS=1 ANTHROPIC_API_KEY=sk-... npm run eval:live
```

Live cases assert on `result.dispatchTool` and `result.cadenceAtBoundary`,
which are only set when the new tool-dispatch path is enabled
(`isNewToolDispatchEnabled()` returns `true`). **Since PR-6 the
dispatcher is default-on**, so the 12 live cases now exercise the
default path the production server uses.

`buildLiveCase` still forces `SL_NEW_TOOL_DISPATCH=1` for the duration
of each case (and restores the prior value in `afterAll`) as
defense-in-depth — it would survive a future opt-out flip without
silent failure. The nightly workflow also sets it at the job level.
If you run a case file directly without `buildLiveCase`, no env stub
is needed in default-env mode; only if the surrounding shell has
explicitly opted out.

The `triplet-demo-extend` mock case in `evals/cases/additive/` no
longer stubs the env flag for the same reason — the default path
fires the dispatcher. The wholesale-replace mock case in
`evals/cases/destructive/` does still set `SL_NEW_TOOL_DISPATCH=0`
because it is specifically exercising the legacy classifier path's
interaction with the replacement-confirmation gate.

## Adding a case

1. Decide tier (mock / smoke / live).
2. Drop a file under `evals/cases/<group>/<case>.<tier>.eval.ts`.
3. Build an invariant object (`ScoreInvariants` in `lib/assertions.ts`):
   prefer `firstNMeasuresIdentical` over deep-equality JSON checks —
   they're more robust to event-id reshuffling.
4. For mock: use `vi.mock('@anthropic-ai/sdk', ...)` and feed canned
   `tool_use` payloads via `mockProvider.ts:toolUseResponse`.
5. For live: use `liveRunner.ts:runLiveCase` so retry + cache-hit
   warning + cost telemetry come for free.

## The "first failing repro" pattern

When a production bug surfaces, the FIRST PR to address it should land
a **failing eval case** that captures the exact failure mode. Use
`it.fails(...)`/`test.fails(...)` so vitest reports the failure as
expected and CI stays green. The fix-PR turns the marker to a regular
`it(...)`/`test(...)` and the green status pins the fix forward.

`evals/cases/additive/triplet-demo-extend.mock.eval.ts` is the
canonical example — captures the M3.5 incident with the wholesale-
replacement Score the live model actually produced, and turns green
when PR-3 lands `extend_composition` + native tool-use dispatch.

`evals/cases/destructive/wholesale-replace.mock.eval.ts` is the
second positive case — added in PR-4. The mock provider returns a
wholesale "make this jazz" rewrite with a changed title + key on the
Triplet demo. PR-4's replacement-as-confirmation gate fires:
`requiresConfirmation: true`, `replacement.retainedIdentityRatio < 0.5`,
and the `replacement.reasons` array carries the metadata diffs the
modal renders.

## Per-case cache-hit warning

`runLiveCase` emits a stderr WARNING (not a failure) when a case's
cache-hit ratio drops below 0.8 — i.e., the prompt structure isn't
being re-used efficiently. Aggregated at end-of-run by
`summarizeLiveResults`. Rationale: Anthropic's cache TTL is 5 min, so
legitimate prompt edits or low-traffic windows can legitimately drop
this number temporarily. A hard assertion would flake and quickly
turn into an ignored yellow.

If you see persistent low cache-hit rates after a prompt change, the
likely culprits are: (a) a new dynamic value in a system block that
should be cached, (b) a system block split across previously-cached
prefix vs. new suffix, or (c) `providerOptions.anthropic.cacheControl`
not threaded to a new handler.

## Infra-fail vs eval-fail (live tier)

`runLiveCase` distinguishes:
- `kind: 'ok'` — the provider returned and we have an outcome to
  assert against. Assertion failures here are real bugs.
- `kind: 'infra'` — `UpstreamError` / `RateLimitedError` after
  exponential-backoff retry. CI should treat these as RETRYABLE, not
  REGRESSIONS.

Once PR-5 wires CI, the runner emits exit code **78** for
infra-only failures (POSIX EX_CONFIG; reserved by `sysexits.h` for
config-like reasons; we co-opt it as a stable "skip-worthy" signal).

## `[skip-live-eval]` bypass

Include `[skip-live-eval]` in a **PR title** to allow the smoke tier
to be skipped for that PR's CI run. Useful for doc-only PRs.
Honored by the `if:` clause on the smoke-evals step in
`.github/workflows/ci.yml`.

Note: the nightly live + visual workflow does not honor this bypass
(it runs on `schedule` / `workflow_dispatch`, not on PRs).

Note: only PR title is checked, not commit messages.
`github.event.head_commit` is null on `pull_request` events, so a
commit-message gate would be dead code in PR context.

## Known-failing-tests policy

Two pre-existing tests under `tests/` flake non-deterministically:
- `tests/integration/api-chat-fork.test.ts`
- midiToScore octave-2-vs-4

These are excluded from eval runs by the configs' `exclude: ['tests/**']`
glob. The default `npm test` may still surface them — that's expected
for the duration of M3.5 (see `session_progress.md`).

## Nightly workflow (PR-5)

`.github/workflows/nightly-evals.yml` runs the live + visual suites
at 03:00 UTC daily. Triggers:

- `schedule: '0 3 * * *'` — cron daily.
- `workflow_dispatch` — manual trigger.

Forks: the workflow is gated by
`github.repository_owner == 'RealRogerWinter'`, so fork PRs do
not consume the API budget. `pull_request` is intentionally not a
trigger here; if a future PR adds one, it must use
`pull_request_target` with an `/ok-to-test` label gate.

On failure: the workflow files a GitHub issue tagged
`nightly-evals` / `auto-filed` with the run URL. Regression failures
(previously-passing case now failing) are titled "REGRESSION" vs.
ordinary "failure" — see exit-code distinction below.

## Per-model-SHA baselines

`evals/baselines/eval-scores.json` tracks `{ <model-sha>: { <case-id>:
{ firstSeen, lastPassed, lastResult, failures } } }`. The live runner
updates this in memory on every run; the nightly workflow commits
the file on ANY main-branch nightly (success or failure, guarded by a
`git diff --quiet` check so no-op runs don't churn the git log). This
matters for the FIRST nightly: the file ships as `{}` in this PR, and
seeding only on success would mean a single failing case prevents the
ledger from ever populating — so the regression-vs-new-failure
distinction would never light up.

The harness distinguishes:

- **Exit 79 (regression)** — a case that PREVIOUSLY-PASSED on the
  current Anthropic model SHA now fails. The error message is
  prefixed `[REGRESSION]` so the CI driver can grep for it.
- **Exit 1 (new failure)** — a case failing for the first time on
  the current model (no prior baseline entry, or prior was also
  fail). Treat as a new bug or a model-behavior change to triage.
- **Exit 78 (infra)** — repeated 5xx / rate-limited after backoff
  retry. Retryable; not a regression.

## Known live-eval pass rate (post-PR-7)

As of M3.5-PR-7 the 12 live eval cases hit **6/10 hard-pass cases
passing** against the real Anthropic Sonnet model (up from 0/10
pre-PR-3). The 2 soft-assert cases (`lowercase-roman-ambiguity` and
`SATB-countermelody`) log but never hard-fail.

**Passing (6):**

- `triplet-demo-extend-turnaround` — the original incident repro
- `turnaround-after-PAC` — PR-7 cadence-detector tuning fixed this
- `modal-transform-c-to-dorian`
- `augmentation-double-duration`
- `interpolate-mid-phrase`
- `add-B-section-key-change`

**Known failures (4) — documented as future tuning targets:**

- `extend-across-meter-change` — the dispatcher picks
  `extend_composition`, but the model either re-emits the meter
  marker in the appended bars (verifier rejects) or omits the 3/4
  semantics entirely. Needs a prompt nudge in `extendComposition.ts`
  to handle mid-piece meter markers explicitly.
- `multi-voice-piano-hand-division` — bass-staff octave bound (≤ 3)
  intermittently violated; the model treats the grand-staff as a
  single voice. Needs per-staff prompt enrichment.
- `harmonize-bach-style` — `RUN_LIVE_FULL=1` only; intermittent
  validate-failure on the 4-voice tuplet sums.
- `extend-tied-whole-note-ending` — tie-at-boundary auto-downgrade
  fires but the warn message is missed by the assertion (assertion
  is overly literal). The handler behavior is correct; the case
  needs updating.

Track regressions against this baseline via
`evals/baselines/eval-scores.json` (auto-committed by the nightly
workflow). The regression-detection ledger is more reliable than
this README once a few nightlies have populated it.

## Smoke-evals cost (PR-7)

The `Smoke evals` CI step runs 4 cases per PR:
- 3 Haiku classifier probes (~200 input tokens each)
- 1 Sonnet dispatcher probe (~800 input tokens)

Cost per run: **~$0.005** with prompt caching warm. At ~40 PRs/month
of active development, that's **~$0.20/month** on smoke alone — the
nightly live + visual suite at ~$0.30/run × 30 = ~$9/month dominates.
Total observability+regression budget: **~$10/month**.

## Forks-policy for CI (smoke tier)

**PR-6 wired smoke evals into the PR CI workflow.** Every PR runs the
4 smoke cases (3 Haiku classifier probes + 1 Sonnet dispatcher probe,
~$0.01 total) as part of `.github/workflows/ci.yml`. Skip conditions:

- Fork PRs — `secrets.ANTHROPIC_API_KEY` is unavailable in fork
  contexts on `pull_request` events, so the step's `if:` short-circuits
  the run. (If this workflow ever moves to `pull_request_target`, the
  step MUST add an `/ok-to-test` label gate before running on fork PR
  contents.)
- PR title contains `[skip-live-eval]` — useful for doc-only PRs.
  (Commit messages are NOT checked — `github.event.head_commit` is
  null on `pull_request` events, so the gate has to live in PR title.)

The 4 smoke cases are:

- `classifier-compose` — Haiku classify() on "add 4 more bars"
- `classifier-converse` — Haiku classify() on a discussion prompt
- `classifier-edit-score-level` — Haiku classify() on a key change
- `dispatch-extend-composition` — full `orchestrator.run` with the
  new tool-dispatch path on a 4-bar extend prompt; asserts the
  dispatcher (not the legacy classifier) picked a structural tool.

The nightly live + visual workflow stays in `.github/workflows/nightly-evals.yml`.
