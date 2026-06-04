# sheet-llm

A chat-driven, publisher-grade **music notation editor**. Describe music in
natural language and an LLM **orchestrator** turns the request into *additive*
edit operations against a canonical JSON `Score` — which is rendered to staff
notation (via [abcjs](https://www.abcjs.net/)), played back through a transport,
and exported to MusicXML / MIDI / PDF.

The defining invariant is **additive editing**: the system never silently
rewrites work you didn't ask it to replace. Server-side preservation
verification plus a replacement-as-confirmation gate enforce this on every turn.

```
prompt ─▶ /api/chat ─▶ orchestrator ─▶ handler ─▶ Score (validated, versioned)
                       │  copyright filter            │
                       │  tool-use dispatch           ▼
                       │  preservation verify    Score ─▶ ABC ─▶ abcjs render
                       │  replacement gate            │            (+ SourceMap)
                       └  ghost-preview proposal      └─▶ MusicXML / MIDI / PDF
```

## Quick start

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

You'll need `ANTHROPIC_API_KEY` set (or a local provider — see
[Local models](docs/local-models.md)) and a `SESSION_SECRET`. The full
setup, environment, and database steps are in
**[docs/guides/getting-started.md](docs/guides/getting-started.md)**.

```bash
pnpm test           # unit + integration (Vitest)
pnpm typecheck      # tsc --noEmit
pnpm lint           # ESLint
```

## Tech stack

Next.js 16 · React 19 · TypeScript · Zod · Drizzle ORM / SQLite (better-sqlite3) ·
abcjs · zustand · the Anthropic SDK (with multi-provider failover to Groq /
Ollama / OpenAI-compatible endpoints).

## Documentation

The full, frontmatter-stamped documentation set lives in
**[`docs/`](docs/README.md)** — start there. Highlights:

| Start here | |
| --- | --- |
| [Architecture Overview](docs/architecture/overview.md) | The whole system in one pass. |
| [The Score Data Model](docs/architecture/data-model.md) | The central `Score` JSON type. |
| [Getting Started](docs/guides/getting-started.md) | Run it locally and make a first change. |
| [Contributing](docs/contributing/CONTRIBUTING.md) | Conventions, CI gates, the additive-edit contract. |
| [AI Agent Guide](docs/ai-agents/AGENT_GUIDE.md) | Orientation for AI coding agents maintaining this repo. |

Each subsystem has a deep-dive under [`docs/subsystems/`](docs/README.md#subsystems)
and an ultra-compact [context card](docs/ai-agents/context-cards/) for fast
agent orientation. Docs are kept honest by
[`pnpm docs:check`](docs/reference/scripts.md) — every doc pins the
`source_paths` it describes and is flagged stale when that code changes.

## License

Released under the [MIT License](LICENSE) © 2026 RealRogerWinter.
