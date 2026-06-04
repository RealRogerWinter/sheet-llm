import '@testing-library/jest-dom/vitest'
import { installGetBBoxPolyfill } from '../evals/lib/jsdomShim'
import { installPointerEventPolyfills } from './helpers/pointer'

// Silence orchestrator structured logs in test runs. Individual tests
// can still spy on console.log via vitest.
process.env.ORCHESTRATOR_LOG_SILENT = '1'

// Phase 5 made orchestrator default-on. For tests that don't
// explicitly opt in (and don't mock the classifier), keep it off so
// they exercise the legacy path. Orchestrator-specific tests override
// via vi.stubEnv('ORCHESTRATOR_ENABLED', 'true') in their beforeEach.
process.env.ORCHESTRATOR_ENABLED = 'false'

// The expensive-route per-IP limiter (requestRateLimit) keys off the client IP,
// which is 'local' for every test request (no XFF / CF-Connecting-IP header) — so
// the whole suite shares ONE bucket. Use a very high limit so integration tests
// that POST many times to /api/chat or /api/import don't trip it; the limiter's
// own behavior is covered by tests/unit/orchestrator/requestRateLimit.test.ts
// (which overrides this via vi.stubEnv).
process.env.SL_REQUEST_IP_RATE_LIMIT = '1000000'

// jsdom doesn't implement SVG layout — install the shared getBBox
// polyfill (the same one used by scripts/capture-visual-baselines.ts)
// so the two callers can't drift.
installGetBBoxPolyfill()

// jsdom lacks the pointer-capture methods (and, on some versions,
// PointerEvent) — install no-op/portable stubs so pointer-based touch
// interactions can be exercised in unit tests.
installPointerEventPolyfills()

// jsdom doesn't implement matchMedia — provide a default stub (matches:false)
// so components using useMatchMedia render without a per-test mock. Tests that
// need a specific breakpoint result still override via vi.stubGlobal.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
