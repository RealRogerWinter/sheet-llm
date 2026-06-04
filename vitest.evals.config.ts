import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Mock-tier eval config. Runs `evals/**\/*.mock.eval.ts` files —
 * deterministic, no API spend, suitable for CI on every PR.
 *
 * `eval:live` and `eval:smoke` use sibling configs (or env-gated
 * `*.live.eval.ts` / `*.smoke.eval.ts` files that no-op without
 * RUN_LIVE_EVALS / RUN_SMOKE_EVALS).
 *
 * The pre-existing `tests/eval/` directory is intentionally NOT
 * matched here — that's the older single-LLM-tier eval surface that
 * `pnpm test:eval` runs. Once PR-5 lands the full live suite, we'll
 * migrate those cases into `evals/` and retire `vitest.eval.config.ts`.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['evals/**/*.mock.eval.ts'],
    exclude: [
      '**/node_modules/**',
      '**/.next/**',
      '**/.claude/**',
      // Keep the 2 known-failing tests + e2e out of the eval run; they
      // live under tests/, not evals/, but a wildcard include guard
      // here keeps us safe if someone later widens the pattern.
      'tests/**',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
