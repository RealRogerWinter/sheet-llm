import { defineConfig, devices } from '@playwright/test'

/**
 * Test-only SESSION_SECRET. The auth layer rejects secrets shorter
 * than 32 bytes (HS256 RFC 7518 minimum). This value is deliberately
 * non-secret — it only signs ephemeral cookies inside the Playwright
 * dev server, which never accepts production traffic. Override with
 * a real secret via the SESSION_SECRET env var if you need cookies
 * to survive across runs.
 *
 * Without this, /api/import (and any route that calls
 * getOrCreateUserId) returns 500 because the session-signer can't
 * initialize — breaking every e2e test that hits a server route.
 */
const E2E_SESSION_SECRET =
  process.env.SESSION_SECRET ?? 'e2e-test-session-secret-not-for-production-use-32b+'

/**
 * Test-only RECOVERY_SECRET. The auth layer signs recovery tokens on user
 * creation and REQUIRES this to be present and DIFFERENT from SESSION_SECRET
 * (so the two can be rotated independently). Without it, any e2e flow that
 * creates a user (i.e. anything hitting /api/sessions or sending a prompt)
 * 500s. Non-secret — it only signs ephemeral tokens in the Playwright dev
 * server. Override via the RECOVERY_SECRET env var if needed.
 */
const E2E_RECOVERY_SECRET =
  process.env.RECOVERY_SECRET ?? 'e2e-test-recovery-secret-distinct-from-session-32b+'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      SESSION_SECRET: E2E_SESSION_SECRET,
      RECOVERY_SECRET: E2E_RECOVERY_SECRET,
      // Permit the insecure-cookie path: Playwright drives the dev
      // server over plain HTTP, and the auth layer's Secure-by-default
      // cookie would otherwise be dropped.
      SL_INSECURE_COOKIE_OK: '1',
      // Turn off the dev Debug panel — a fixed overlay that intercepts pointer
      // events along its edges (it otherwise breaks touch/click e2e). The
      // explicit 'off' is honored even in dev (see isDebugPanelEnabled).
      NEXT_PUBLIC_DEBUG_PANEL: 'off',
    },
  },
})
