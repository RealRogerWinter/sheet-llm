import { test as base, expect, type Page } from '@playwright/test'

/**
 * The dev-mode Debug panel is absolutely-positioned over the page and
 * intercepts pointer events along its edges. Collapse it once per test
 * via the `dismissedDebugPanel` fixture (auto-applied below). No-op if
 * the panel is not rendered (e.g. production build, or
 * NEXT_PUBLIC_DEBUG_PANEL=off).
 */
async function dismissDebugPanelIfPresent(page: Page) {
  const collapse = page.getByRole('button', { name: /collapse debug panel/i })
  if (await collapse.isVisible().catch(() => false)) {
    await collapse.click()
  }
}

/**
 * Drive the Import modal flow to seed a deterministic score into the
 * editor without going through the LLM. Use this whenever a test needs
 * a *specific* score shape (rests in particular positions, multi-staff
 * layout, etc.).
 *
 * `pasteFormat` toggles the modal's paste-format detection. ABC text
 * starting with `X:` is auto-detected so default works for the common
 * case.
 */
export async function importAbc(page: Page, abc: string): Promise<void> {
  await page.getByRole('button', { name: /import an existing score/i }).click()
  await page.locator('#import-paste').fill(abc)
  await page.getByRole('button', { name: /^parse paste$/i }).click()
  const commit = page.getByRole('button', { name: /^import this score$/i })
  await expect(commit).toBeEnabled({ timeout: 5_000 })
  await commit.click()
  await expect(page.locator('main svg').first()).toBeVisible({ timeout: 10_000 })
  // Wait for the post-render tagging pass to attach data-startchar
  // (drag/select interactions depend on this attribute).
  await expect.poll(
    async () => page.locator('[data-startchar]').count(),
    { timeout: 5_000 },
  ).toBeGreaterThan(0)
}

/**
 * Extended Playwright test object. Every test using this `test` import
 * lands on `/` with the Debug panel collapsed already — no per-test
 * boilerplate needed. Re-export expect for ergonomics.
 */
export const test = base.extend<object>({
  page: async ({ page }, use) => {
    await page.goto('/')
    await dismissDebugPanelIfPresent(page)
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Playwright fixture callback, not React's `use` hook
    await use(page)
  },
})

export { expect }
