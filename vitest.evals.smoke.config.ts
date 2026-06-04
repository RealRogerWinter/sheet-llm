import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Smoke-tier eval config. Runs `evals/**\/*.smoke.eval.ts` — 3 cheap
 * Haiku classifier checks. Each file gates itself on
 * `RUN_SMOKE_EVALS=1 ANTHROPIC_API_KEY=...` so accidental invocation
 * exits 0 with all describes skipped.
 *
 * Not wired into PR CI in this PR (deferred to PR-5/PR-6). The
 * commit-message bypass token `[skip-live-eval]` is honored by the
 * future CI driver — see `evals/lib/liveRunner.ts:isSkippedByCommitMessage`.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['evals/**/*.smoke.eval.ts'],
    exclude: [
      '**/node_modules/**',
      '**/.next/**',
      '**/.claude/**',
      'tests/**',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
