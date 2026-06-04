import '@testing-library/jest-dom/vitest'
import { installGetBBoxPolyfill } from '../evals/lib/jsdomShim'

// Silence orchestrator structured logs in test runs. Individual tests
// can still spy on console.log via vitest.
process.env.ORCHESTRATOR_LOG_SILENT = '1'

// Phase 5 made orchestrator default-on. For tests that don't
// explicitly opt in (and don't mock the classifier), keep it off so
// they exercise the legacy path. Orchestrator-specific tests override
// via vi.stubEnv('ORCHESTRATOR_ENABLED', 'true') in their beforeEach.
process.env.ORCHESTRATOR_ENABLED = 'false'

// jsdom doesn't implement SVG layout — install the shared getBBox
// polyfill (the same one used by scripts/capture-visual-baselines.ts)
// so the two callers can't drift.
installGetBBoxPolyfill()
