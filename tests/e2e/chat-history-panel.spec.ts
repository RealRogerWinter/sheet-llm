import { test, expect, type Page } from '@playwright/test'

// The dev DebugPanel sits in the bottom-right corner and overlaps the
// hero PromptBar's Send button at the default 1280×720 viewport (and
// also reopens itself on subsequent renders). Hiding via CSS injection
// is more reliable than clicking its collapse button mid-test.
async function dismissDebugPanel(page: Page) {
  await page.addStyleTag({
    content:
      '[aria-label="Debug panel"], [aria-label="Open debug panel"] { display: none !important; }',
  })
}

test('chat history panel: open via button, send from hero, see both turns', async ({ page }) => {
  await page.goto('/')
  await dismissDebugPanel(page)

  // Panel is closed initially; trigger button is in the header.
  await expect(page.getByRole('button', { name: /open conversation panel/i })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Chat history' })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Chat history' })).toHaveCount(0)

  // Open the panel.
  await page.getByRole('button', { name: /open conversation panel/i }).click()
  await expect(
    page.getByRole('complementary', { name: 'Chat history' })
      .or(page.getByRole('dialog', { name: 'Chat history' })),
  ).toBeVisible()
  await expect(page.getByText('Your conversation will appear here')).toBeVisible()

  // Send a prompt from the hero PromptBar.
  await page.getByLabel('Music request').fill('a C major scale')
  await page.getByRole('main').getByRole('button', { name: /^send$/i }).click()

  // Score renders.
  await expect(page.locator('main svg').first()).toBeVisible({ timeout: 10_000 })

  // Both turns appear inside the panel.
  await expect(page.locator('#chat-history-panel').getByText('a C major scale')).toBeVisible()
  await expect(page.locator('#chat-history-panel').getByText(/bars? · C · 4\/4/)).toBeVisible()
  await expect(page.locator('#chat-history-panel').getByText('Current')).toBeVisible()
})

test('chat history panel: prompt from panel footer appears as a new turn', async ({ page }) => {
  await page.goto('/')
  await dismissDebugPanel(page)
  await page.getByRole('button', { name: /open conversation panel/i }).click()

  // Send the first prompt from the hero (the panel footer's input pad is
  // a separate concern — but the panel's submit shares the same hook).
  await page.getByLabel('Music request').fill('a C major scale')
  await page.getByRole('main').getByRole('button', { name: /^send$/i }).click()
  await expect(page.locator('main svg').first()).toBeVisible({ timeout: 10_000 })

  // Now submit from the panel footer.
  const panelInput = page.getByLabel('Continue the conversation')
  await panelInput.fill('now in G')
  await page
    .locator('#chat-history-panel')
    .getByRole('button', { name: /^send$/i })
    .click()

  // Two user turns visible in the panel.
  await expect(page.locator('#chat-history-panel').getByText('a C major scale')).toBeVisible()
  await expect(page.locator('#chat-history-panel').getByText('now in G')).toBeVisible({
    timeout: 10_000,
  })
})

test('chat history panel: New Score clears the transcript', async ({ page }) => {
  page.on('dialog', (d) => d.accept())
  await page.goto('/')
  await dismissDebugPanel(page)
  await page.getByRole('button', { name: /open conversation panel/i }).click()
  await page.getByLabel('Music request').fill('a C major scale')
  await page.getByRole('main').getByRole('button', { name: /^send$/i }).click()
  await expect(page.locator('main svg').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('#chat-history-panel').getByText('a C major scale')).toBeVisible()

  await page.getByRole('button', { name: /start a new score/i }).click()
  await expect(page.locator('#chat-history-panel').getByText('a C major scale')).toHaveCount(0)
})

test('chat history panel: Ctrl+/ toggles', async ({ page }) => {
  await page.goto('/')
  await dismissDebugPanel(page)
  await expect(page.getByRole('complementary', { name: 'Chat history' })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Chat history' })).toHaveCount(0)
  await page.keyboard.press('Control+/')
  await expect(
    page.getByRole('complementary', { name: 'Chat history' })
      .or(page.getByRole('dialog', { name: 'Chat history' })),
  ).toBeVisible()
  await page.keyboard.press('Control+/')
  await expect(page.getByRole('complementary', { name: 'Chat history' })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Chat history' })).toHaveCount(0)
})
