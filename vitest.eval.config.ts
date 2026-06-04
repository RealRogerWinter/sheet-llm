import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Eval-only vitest config. Includes `*.eval.ts` files under
 * tests/eval/. Real Anthropic API calls in classifier.eval.ts only
 * fire when RUN_EVALS=1 and ANTHROPIC_API_KEY are set.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/eval/**/*.eval.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/.claude/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
