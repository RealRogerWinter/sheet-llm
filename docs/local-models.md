---
title: Local Models (Ollama)
subsystem: providers-llm
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/providers/ollama.ts
  - src/lib/providers/registry.ts
  - src/lib/providers/select.ts
related:
  - providers-llm
  - add-provider
---

# Local models (Ollama)

Run sheet-llm against a local LLM via [Ollama](https://ollama.com). Useful for offline development, zero-cost iteration, and as a fallback when you don't want to spend on cloud providers.

## Setup (Windows / macOS / Linux)

1. **Install Ollama** — download the installer for your OS from <https://ollama.com/download>. On Windows the installer drops a background service that binds `http://localhost:11434`.

2. **Pull the recommended models**:

   ```bash
   ollama pull qwen2.5:7b-instruct      # ~4.5 GB; fits on 8 GB consumer GPU; classifier-grade
   ollama pull qwen2.5:14b-instruct     # ~9 GB; needs 16 GB GPU; edit + simple-gen reliable
   # Optional, for 24 GB GPUs:
   # ollama pull qwen2.5:32b-instruct
   ```

   Why Qwen2.5: community-consensus best small/medium model for **strict JSON output with tool calls** as of 2026. Llama 3.x works but trips on enums and nested types more often.

3. **Verify the endpoint**:

   ```bash
   curl http://localhost:11434/v1/chat/completions \
     -H "content-type: application/json" \
     -d '{ "model": "qwen2.5:7b-instruct", "messages": [{"role":"user","content":"hi"}] }'
   ```

## Configuration

Set per-tier in your `.env.local`:

```bash
# Default — every tier on Anthropic
# (no env vars needed — that's the default)

# Hybrid — classifier local, generation cloud
PROVIDER_SMALL=ollama
PROVIDER_MEDIUM=anthropic
PROVIDER_LARGE=anthropic

# All-local
PROVIDER_SMALL=ollama
PROVIDER_MEDIUM=ollama
PROVIDER_LARGE=ollama

# Override the base URL (default is http://localhost:11434/v1)
OLLAMA_BASE_URL=http://localhost:11434/v1
```

The `PROVIDER_FALLBACK` env (default `anthropic`) takes over when:
- The active provider's API key is missing.
- The active provider triggers ≥2 schema-validation failures on the same chat (auto-degradation per chat).

So even with `PROVIDER_SMALL=ollama`, the system gracefully falls back to Anthropic if `qwen2.5:7b` returns malformed JSON twice in a row in the same conversation.

## Hardware reality check

| GPU | Models that work | Realistic tier mapping |
| --- | --- | --- |
| 8 GB | Qwen2.5 7B Q4 | `PROVIDER_SMALL=ollama` only |
| 16 GB (RTX 4060Ti / 4070) | + Qwen2.5 14B Q4 | All tiers — minimum spec for `PROVIDER_MEDIUM/LARGE=ollama` |
| 24 GB (RTX 3090 / 4090) | + Qwen2.5 32B Q4 | All tiers; can pin large to 32B via env model override |
| CPU only | 7B at ~3–8 tok/s | Don't ship this — fails the deadline guard on real prompts |

## Running the live eval

```bash
RUN_LOCAL_EVALS=1 pnpm test:eval
```

This hits your local Ollama with 10 labeled classifier prompts and asserts ≥60% accuracy on `qwen2.5:7b-instruct`. Logs each case for inspection. Skipped by default — the eval suite never tries to reach Ollama unless `RUN_LOCAL_EVALS=1` is set.

## Debug panel

The debug panel's **model selector** dropdown does not yet include Ollama models by default (they vary per user setup). Use the orchestrator-on toggle + your env config to drive routing, or enter a model id manually in a future build.

The **tier keys** row of the panel shows green per tier when that tier's active provider is configured (Ollama is always "configured" since it's keyless local).

## Failure modes

- **Slow first token** — Ollama loads the model on first use (~5–30s for 14B). Subsequent calls are fast. The deadline guard (default 55s) will return a `deadline_exceeded` fall-through on the first cold call; retry.
- **Malformed JSON** — small models occasionally emit invalid tool input. The OllamaProvider uses Ollama's `format: <jsonSchema>` parameter (grammar-constrained sampling) for stronger adherence. After 2 schema-failures on the same chat, that tier auto-falls back to `PROVIDER_FALLBACK`.
- **Wrong measure indices** on edit operations — 7B/14B models drift on indices into long scores. Stick to short scores for local-only workflows, or pin `PROVIDER_MEDIUM=anthropic` when editing.
