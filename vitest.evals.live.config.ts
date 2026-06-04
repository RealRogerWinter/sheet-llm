import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Live-tier eval config. Runs `evals/**\/*.live.eval.ts` files — real
 * Anthropic API calls. Gated by `RUN_LIVE_EVALS=1` + `ANTHROPIC_API_KEY`
 * inside each case file via `describe.skipIf`.
 *
 * 12 live cases live under `evals/cases/{additive,destructive}/` as of
 * PR-5. Without the env flag they `describe.skip` cleanly, so
 * `passWithNoTests: true` below covers the local "no key configured"
 * developer flow (vitest would otherwise error "No test files found").
 */
export default defineConfig({
  test: {
    // node, not jsdom — the Anthropic SDK refuses to run when it detects
    // a browser-like environment (default policy for not exposing API
    // keys client-side). Live evals call orchestrator → Anthropic SDK
    // directly; no DOM needed. The visual tier keeps jsdom because
    // abcjs renders into a DOM container.
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['evals/**/*.live.eval.ts'],
    exclude: [
      '**/node_modules/**',
      '**/.next/**',
      '**/.claude/**',
      'tests/**',
    ],
    // When developers run `pnpm eval:live` without RUN_LIVE_EVALS=1
    // all 12 cases short-circuit through `describe.skipIf`. Vitest
    // would otherwise error "No test files found"; this keeps the
    // command a no-op zero-exit in that mode.
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
