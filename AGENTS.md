<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Orchestrator (M3.5)

The `/api/chat` orchestrator now uses **native tool-use dispatch** (the
dispatcher LLM picks among `extend_composition`, `insert_measures`,
`region_replace`, `edit_intra_measure`, `regenerate_all`) plus
**server-side preservation verification** (measure-hash check on
retained bars; the LLM is never trusted to self-report preservation)
and a **replacement-as-confirmation gate** (gates wholesale rewrites
behind a UI modal when the user didn't explicitly ask to start over).
Both layers are default-on since M3.5-PR-6. See
[`src/lib/orchestrator/README.md`](src/lib/orchestrator/README.md) for
the architecture, flag reference, and rollback procedure, and
[`evals/README.md`](evals/README.md) for the mock+live eval harness
that pins the behavior.

## Daily quota & abuse gating (hosted-only, off by default)

`/api/chat` has an optional daily request-quota + IP-reputation layer that exists
ONLY to protect tokens on the hosted demo at **https://sheetllm.com**. It is
**disabled by default** (`SL_DAILY_QUOTA_ENABLED` unset) and inert for
self-hosted/local installs — never enable it by default. Architecture, config,
threat model, and the Cloudflare runbook are in
[`docs/subsystems/daily-quota.md`](docs/subsystems/daily-quota.md).

## Documentation (read this to orient fast)

The canonical documentation set lives in [`docs/`](docs/README.md). When
working in this repo:

- **Start from** [`docs/ai-agents/AGENT_GUIDE.md`](docs/ai-agents/AGENT_GUIDE.md),
  then load the relevant per-subsystem **context card** under
  [`docs/ai-agents/context-cards/`](docs/ai-agents/context-cards/) (terse,
  high-signal quick-reference) before diving into a subsystem.
- [`docs/architecture/overview.md`](docs/architecture/overview.md) maps the
  whole system; [`docs/architecture/data-model.md`](docs/architecture/data-model.md)
  is the central `Score` type; [`docs/llms.txt`](docs/llms.txt) is a
  machine-readable navigation map.
- **Docs are frontmatter-stamped and self-checking.** Every doc pins the
  `source_paths` it describes. When you change code, update the doc whose
  `source_paths` covers the file you touched, then bump its `last_verified`
  and `verified_against` (current HEAD short SHA). Run `pnpm docs:check` to
  see which docs your change made stale. The contract is in
  [`docs/ai-agents/maintenance-protocol.md`](docs/ai-agents/maintenance-protocol.md)
  and [`docs/_meta/STYLE_GUIDE.md`](docs/_meta/STYLE_GUIDE.md).
