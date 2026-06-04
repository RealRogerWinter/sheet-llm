import { test, expect } from '@playwright/test'

test('blank staff shown on initial load', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('sheet-llm')

  // Blank staff present on empty state.
  await expect(page.getByLabel('Empty sheet music staff awaiting notes')).toBeVisible()

  // Headline visible.
  await expect(page.getByText('What should we compose today?')).toBeVisible()

  // Suggestion chips visible.
  await expect(page.getByRole('button', { name: 'a C major scale' })).toBeVisible()
})

test('chat flow renders a score from the stub response', async ({ page }) => {
  await page.goto('/')

  // Send a message.
  await page.getByLabel('Music request').fill('a C major scale')
  await page.getByRole('button', { name: /^send$/i }).click()

  // Score appears after stub response (svg from abcjs inside <main>).
  await expect(page.locator('main svg').first()).toBeVisible({ timeout: 10_000 })

  // Last prompt label appears below input.
  await expect(page.getByText('a C major scale')).toBeVisible()
})

test('MIDI download produces a .mid file', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Music request').fill('a C major scale')
  await page.getByRole('button', { name: /^send$/i }).click()
  await expect(page.locator('main svg').first()).toBeVisible({ timeout: 10_000 })

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /download midi/i }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.mid$/)
})

test('PDF download produces a .pdf file', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Music request').fill('a C major scale')
  await page.getByRole('button', { name: /^send$/i }).click()
  await expect(page.locator('main svg').first()).toBeVisible({ timeout: 10_000 })

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /download pdf/i }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.pdf$/)
})

test('New Score button resets to blank staff', async ({ page }) => {
  page.on('dialog', (d) => d.accept())

  await page.goto('/')
  await page.getByLabel('Music request').fill('a C major scale')
  await page.getByRole('button', { name: /^send$/i }).click()
  await expect(page.locator('main svg').first()).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: /start a new score/i }).click()

  await expect(page.getByLabel('Empty sheet music staff awaiting notes')).toBeVisible()
  await expect(page.getByText('What should we compose today?')).toBeVisible()
})
