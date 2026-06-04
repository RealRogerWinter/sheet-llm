import { test, expect } from '@playwright/test'
import { importAbc } from './fixtures'

/**
 * Real-browser validation of the touch input path (responsive PR-4/5/6). The
 * pointer-event logic is unit-tested exhaustively; this confirms it integrates
 * end-to-end under genuine touch emulation (hasTouch) — a finger tap reaches
 * the score and selects a note, surfacing the editing menu. Tablet viewport
 * (768) where the editor is comfortably usable. Non-blocking (local e2e).
 *
 * Uses base `test` (not the fixtures) so an addInitScript can suppress the
 * onboarding coachmark before first paint — it otherwise anchors over the
 * first notehead and intercepts the tap. (The dev Debug panel is disabled via
 * NEXT_PUBLIC_DEBUG_PANEL=off in the webServer env.)
 */
test.describe('touch editing', () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('sheet-llm.coachmark-dismissed', '1')
      } catch {
        /* ignore */
      }
    })
    await page.goto('/')
  })

  test('tapping a notehead selects it and opens the editing menu', async ({ page }) => {
    await importAbc(page, 'X:1\nK:C\nL:1/4\nCDEF|')
    // Genuine coordinate touch (NOT force-tap): this respects z-order, so if a
    // real overlay regressed back over the score the tap would miss and the
    // menu wouldn't open — which is the regression class this test guards.
    const note = page.locator('.abcjs-note').first()
    await expect(note).toBeVisible()
    const box = await note.boundingBox()
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await expect(page.getByRole('toolbar', { name: /edit selected note/i })).toBeVisible({
      timeout: 5_000,
    })
  })

  test('the score surface routes touch gestures (pan-y wrapper, notes own gestures)', async ({
    page,
  }) => {
    await importAbc(page, 'X:1\nK:C\nL:1/4\nCDEF|')
    const wrapperTouch = await page
      .locator('main [class*="scoreArea"]')
      .first()
      .evaluate((el) => getComputedStyle(el).touchAction)
    expect(wrapperTouch).toBe('pan-y')
    const noteTouch = await page
      .locator('.abcjs-note')
      .first()
      .evaluate((el) => getComputedStyle(el).touchAction)
    expect(noteTouch).toBe('none')
  })
})
