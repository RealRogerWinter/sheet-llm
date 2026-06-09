/**
 * SHE-8 — authoritative OSS↔SaaS build-graph boundary.
 *
 * The platform-portable core (music / abc / providers) and the headless
 * orchestrator must NOT depend on the SaaS surface (billing / auth). Usage &
 * cost live in `@/lib/metering`, request helpers in `@/lib/http` — both allowed
 * (they are not under billing/ or auth/, so the `to` path simply doesn't match).
 *
 * This is the authoritative check (full module graph, alias-resolved); the
 * ESLint `no-restricted-imports` rule in eslint.config.mjs is the fast,
 * editor-time mirror. Run via `pnpm lint:boundaries`.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-billing-auth-from-core',
      comment:
        'Core/render/orchestrator code must not import billing or auth (SaaS surface). ' +
        'Use @/lib/metering for usage/cost and @/lib/http for request helpers. SHE-8 boundary.',
      severity: 'error',
      from: { path: '^src/lib/(music|abc|providers|orchestrator)/' },
      to: { path: '^src/lib/(billing|auth)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Resolve the `@/*` → `src/*` path alias (and .ts/.tsx) via the TS resolver,
    // and follow type-only imports so a `import type { X } from '@/lib/auth/...'`
    // is caught too.
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
  },
}
