import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Visual-regression eval tier. Runs `evals/**\/*.visual.eval.ts`
 * files — each renders a Score to ABC, then to SVG via abcjs, then
 * diffs against a pinned baseline SVG using `pathDistance`.
 *
 * Unlike live evals, these are deterministic (the abcjs renderer is
 * pure given a fixed version of the library). They run on every PR
 * via `pnpm eval:visual`. A failing case means a renderer change
 * shifted the visual output; investigate vs. regenerate the baseline
 * via `pnpm eval:baselines:capture`.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['evals/**/*.visual.eval.ts'],
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
