/**
 * E2E tests for the horizontal-drag editor flow.
 *
 * Two layers:
 *   1. LLM-driven smoke tests — kept for end-to-end coverage of the
 *      full chat → render → drag path. Skipped when no
 *      ANTHROPIC_API_KEY is available (CI sets it; local devs may not).
 *   2. Import-driven deterministic tests — paste a known ABC fixture
 *      via the Import modal, then assert specific drag outcomes. These
 *      are the regression suite for cross-measure drag bugs.
 *
 * All tests use the `test` re-export from ./fixtures which:
 *   - navigates to '/' before every test
 *   - dismisses the dev-mode Debug panel (which intercepts clicks)
 */
import { test, expect, importAbc } from './fixtures'

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY

// ── LLM-driven smoke tests ─────────────────────────────────────────────

test.describe('LLM-driven smoke', () => {
  test.skip(!HAS_API_KEY, 'no ANTHROPIC_API_KEY set — skipping LLM-driven smoke tests')

  test('noteheads carry data-startchar after render (drag bridge)', async ({ page }) => {
    await page.getByLabel('Music request').fill('a C major scale')
    await page.getByRole('button', { name: /^send$/i }).click()

    await expect(page.locator('main svg').first()).toBeVisible({ timeout: 10_000 })
    await expect.poll(
      async () => page.locator('.abcjs-note[data-startchar]').count(),
      { timeout: 5_000 },
    ).toBeGreaterThan(0)

    const tagged = await page.locator('.abcjs-note[data-startchar]').count()
    const total = await page.locator('.abcjs-note').count()
    expect(tagged).toBe(total)
  })

  test('horizontal pointer drag updates the score (reorder)', async ({ page }) => {
    await page.getByLabel('Music request').fill('a C major scale')
    await page.getByRole('button', { name: /^send$/i }).click()
    await expect(page.locator('main svg').first()).toBeVisible({ timeout: 10_000 })
    await expect.poll(
      async () => page.locator('.abcjs-note[data-startchar]').count(),
      { timeout: 5_000 },
    ).toBeGreaterThan(1)

    const before = await page.locator('.abcjs-note').count()
    const firstNote = page.locator('.abcjs-note').first()
    const box = await firstNote.boundingBox()
    if (!box) throw new Error('first notehead has no bounding box')

    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2

    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 20, cy, { steps: 5 })
    await page.mouse.move(cx + 40, cy, { steps: 5 })
    await page.mouse.up()

    await expect(page.locator('.abcjs-note').first()).toBeVisible()
    const after = await page.locator('.abcjs-note').count()
    expect(after).toBe(before)
  })
})

// ── Import-driven deterministic tests ──────────────────────────────────

test.describe('import-driven cross-measure drag regression', () => {
  // 4/4, L:1/8: z = eighth-rest (1), X2 = quarter (2 eighths).
  // m0: eighth-rest + 3 quarters + eighth-rest = 1+2+2+2+1 = 8 eighths ✓
  // m1: 4 quarters = 8 eighths ✓
  const ABC_WITH_RESTS = [
    'X:1',
    'T:E2E test with rests',
    'M:4/4',
    'L:1/8',
    'K:C',
    'z C2 D2 E2 z|F2 G2 A2 B2|',
  ].join('\n')

  test('both notes AND rests carry data-startchar after import', async ({ page }) => {
    await importAbc(page, ABC_WITH_RESTS)

    // abcjs's `.abcjs-note` / `.abcjs-rest` class is applied to multiple
    // SVG elements per source event (notehead + stem + wrapper groups),
    // so a strict ".abcjs-note count === tagged count" assertion is too
    // brittle. Instead, count UNIQUE tagged events by data-startchar.
    // Our fixture has 7 notes + 2 rests = 9 source events; the post-
    // render tagging pass should tag exactly one element per event.
    const distinctTaggedNotes = await page.locator('.abcjs-note[data-startchar]').evaluateAll(
      (els) => new Set(els.map((el) => el.getAttribute('data-startchar'))).size,
    )
    const distinctTaggedRests = await page.locator('.abcjs-rest[data-startchar]').evaluateAll(
      (els) => new Set(els.map((el) => el.getAttribute('data-startchar'))).size,
    )

    expect(distinctTaggedNotes).toBe(7)
    // The cross-measure-drag fix from PR #61 requires rests to also be
    // tagged so the snap-position cumulative-32nds counter doesn't
    // skip them.
    expect(distinctTaggedRests).toBe(2)
  })

  test('horizontal drag across barline produces a still-valid score', async ({ page }) => {
    await importAbc(page, ABC_WITH_RESTS)

    const noteCountBefore = await page.locator('.abcjs-note').count()
    const restCountBefore = await page.locator('.abcjs-rest').count()
    const startCharsBefore = await page.locator('.abcjs-note').evaluateAll(
      (els) => els.map((el) => el.getAttribute('data-startchar')),
    )

    // Pick the last notehead in m0 (the "E" — third notehead overall
    // since m0 has 3 notes).
    const sourceNote = page.locator('.abcjs-note').nth(2)
    const srcBox = await sourceNote.boundingBox()
    if (!srcBox) throw new Error('source notehead has no bounding box')
    const cxSrc = srcBox.x + srcBox.width / 2
    const cySrc = srcBox.y + srcBox.height / 2

    // Drag ~180px right (well into m1 territory).
    await page.mouse.move(cxSrc, cySrc)
    await page.mouse.down()
    await page.mouse.move(cxSrc + 60, cySrc, { steps: 8 })
    await page.mouse.move(cxSrc + 120, cySrc, { steps: 8 })
    await page.mouse.move(cxSrc + 180, cySrc, { steps: 8 })
    await page.mouse.up()

    await expect(page.locator('.abcjs-note').first()).toBeVisible()
    const noteCountAfter = await page.locator('.abcjs-note').count()
    const restCountAfter = await page.locator('.abcjs-rest').count()

    // mergeAdjacentRests can collapse adjacent rest pairs; notes never
    // appear from nowhere. Total event count should not grow.
    expect(noteCountAfter).toBeLessThanOrEqual(noteCountBefore)
    expect(noteCountAfter + restCountAfter).toBeLessThanOrEqual(
      noteCountBefore + restCountBefore,
    )

    // The reorder happened: the start-char sequence on the rendered
    // notes is different from before. (If the drag was rejected for
    // any reason — tuplet, would_empty_measure, etc. — the sequence
    // would be unchanged.)
    const startCharsAfter = await page.locator('.abcjs-note').evaluateAll(
      (els) => els.map((el) => el.getAttribute('data-startchar')),
    )
    expect(startCharsAfter.join(',')).not.toBe(startCharsBefore.join(','))
  })

  test('vertical drag retunes a note without reordering (drag-to-pitch)', async ({ page }) => {
    // Four identical quarter notes in one bar. Dragging the SECOND
    // notehead straight DOWN must lower its pitch, so the four noteheads
    // — previously all at the same height — end up vertically spread.
    //
    // The second note (eventIdx 1) is the discriminator. A pure vertical
    // drag keeps the pointer over the notehead center, where
    // snapTargetAtX returns the event's TRAILING boundary (its leading
    // boundary sits at the previous note's right edge, farther from
    // center). The old disambiguation matched only the leading boundary,
    // so it misread the gesture as a reorder and the pitch never changed
    // — leaving all four noteheads flat. (The first note hides the bug:
    // its leading boundary is the measure start, which ties with its
    // trailing edge and wins by iteration order.) The fix treats both
    // own-boundaries as "stayed in slot" → pitch change. A reorder of
    // identical notes would leave them flat, so a vertical spread cleanly
    // proves a real retune happened (and discriminates against the bug,
    // which left every notehead at the same height).
    const ABC = ['X:1', 'T:vdrag', 'M:4/4', 'L:1/4', 'K:C', 'G G G G|'].join('\n')
    await importAbc(page, ABC)

    // Vertical span of the noteheads. abcjs tags the note GROUP (which
    // includes the stem) with data-startchar, so measure the inner
    // `.abcjs-notehead` glyphs instead — their centers are the true
    // pitch positions.
    const noteheadSpread = () =>
      page.locator('.abcjs-note[data-startchar] .abcjs-notehead').evaluateAll((els) => {
        const ys = els
          .map((el) => (el as SVGGraphicsElement).getBoundingClientRect())
          .filter((r) => r.height > 0)
          .map((r) => r.top + r.height / 2)
        return ys.length ? Math.max(...ys) - Math.min(...ys) : 0
      })

    // All four are G4 → noteheads are effectively flat.
    expect(await noteheadSpread()).toBeLessThan(4)

    // Target the SECOND note (eventIdx 1) — the discriminator. Grab the
    // actual notehead glyph, not the group box (whose center sits on the
    // stem, where pointerdown misses `.abcjs-note`).
    const startChars = await page.locator('.abcjs-note[data-startchar]').evaluateAll((els) =>
      [...new Set(els.map((el) => Number(el.getAttribute('data-startchar'))))].sort((a, b) => a - b),
    )
    const secondNote = page.locator(`.abcjs-note[data-startchar="${startChars[1]}"] .abcjs-notehead`).first()
    const box = await secondNote.boundingBox()
    if (!box) throw new Error('second notehead has no bounding box')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2

    // Drag straight down ~36px (several diatonic steps), no horizontal
    // movement → unambiguously a pitch change.
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx, cy + 18, { steps: 6 })
    await page.mouse.move(cx, cy + 36, { steps: 6 })
    await page.mouse.up()

    await expect(page.locator('.abcjs-note').first()).toBeVisible()

    // The dragged note dropped well below the others → clear vertical
    // spread. Poll to ride out the re-render. A misclassified reorder
    // (the bug) leaves all four flat, so this never crosses the threshold.
    await expect.poll(() => noteheadSpread(), { timeout: 4_000 }).toBeGreaterThan(8)
  })
})
