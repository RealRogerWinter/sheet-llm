import { test, expect } from '@playwright/test'

async function seedScore(page: import('@playwright/test').Page) {
  await page.goto('/')
  // Dev server mounts a DebugPanel that intercepts pointer events;
  // hide it for the duration of the test so locators can reach
  // anything in the bottom-right of the viewport.
  await page.addStyleTag({
    content: '[aria-label="Debug panel"], [aria-label="Open debug panel"] { display: none !important; }',
  })
  await page.getByLabel('Music request').fill('a C major scale')
  await page.getByRole('button', { name: /^send$/i }).click()
  await expect(page.locator('main svg').first()).toBeVisible({ timeout: 10_000 })
}

test('toolbar + Chord palette inserts a maj7 chord', async ({ page }) => {
  await seedScore(page)

  // Wait for the scale to fully render before snapshotting the count.
  await expect.poll(
    () => page.locator('main svg .abcjs-note').count(),
    { timeout: 10_000 },
  ).toBeGreaterThanOrEqual(8)
  const noteCountBefore = await page.locator('main svg .abcjs-note').count()

  await page.getByRole('button', { name: '+ Chord' }).click()
  // Palette is a dialog
  await expect(page.getByRole('dialog', { name: 'Chord palette' })).toBeVisible()

  // Pick Maj 7 quality (root stays at C, the default)
  await page.getByRole('button', { name: 'Maj 7' }).click()

  // Preview should show Cmaj7's pitches
  await expect(page.getByText(/C4 · E4 · G4 · B4/)).toBeVisible()

  await page.getByRole('button', { name: 'Insert' }).click()

  // Palette closes, score updates
  await expect(page.getByRole('dialog', { name: 'Chord palette' })).toBeHidden()
  await expect(page.locator('main svg .abcjs-note')).toHaveCount(noteCountBefore + 1)
})

test('keyboard shortcut c opens the palette', async ({ page }) => {
  await seedScore(page)

  // Focus the score region (so the editor keyboard handler fires).
  await page.locator('[role="application"]').first().focus()
  await page.keyboard.press('c')

  await expect(page.getByRole('dialog', { name: 'Chord palette' })).toBeVisible()
})
