import { describe, it, expect } from 'vitest'
import { checkCopyright } from '@/lib/orchestrator/copyright/filter'

/**
 * Deterministic copyright filter eval — no LLM, no API spend.
 * Runs whenever `pnpm test:eval` is invoked.
 *
 * Treated as a golden set: each row is a (text, expected_blocked)
 * pair. Adding a new row that fails forces a deliberate filter
 * update, not a silent regression.
 */
const GOLDEN: Array<{ text: string; blocked: boolean; label: string }> = [
  // True positives — must block.
  { text: 'Yesterday by The Beatles', blocked: true, label: 'song by artist' },
  { text: 'cover of Bohemian Rhapsody', blocked: true, label: 'cover of song' },
  { text: 'reproduce Smells Like Teen Spirit', blocked: true, label: 'reproduce song' },
  { text: 'copy of Hotel California', blocked: true, label: 'copy of song' },
  { text: 'Hey Jude by the Beatles', blocked: true, label: 'song by artist (lowercase the)' },
  // True negatives — common-word red-team set, must pass.
  { text: 'play happy birthday for my friend', blocked: false, label: 'play <common word>' },
  { text: 'sing yesterday\'s news in music', blocked: false, label: 'sing <common word>' },
  { text: 'write a happy melody', blocked: false, label: 'write <common word>' },
  { text: 'compose for my friend Taylor', blocked: false, label: 'standalone name' },
  { text: 'a hero theme for a video game', blocked: false, label: 'common-word title alone' },
  { text: 'a fanfare for the queen', blocked: false, label: 'common-word band name alone' },
  // Public domain — must pass even with co-occurrence verbs.
  { text: 'a chorale by Bach', blocked: false, label: 'PD composer + by' },
  { text: 'in the style of Mozart', blocked: false, label: 'PD style' },
  { text: 'in the style of Bach', blocked: false, label: 'PD style' },
  { text: 'compose like Beethoven', blocked: false, label: 'PD imitation' },
  // Style requests — never block.
  { text: 'in the style of a march', blocked: false, label: 'style genre' },
  { text: 'in the style of a Viennese waltz', blocked: false, label: 'style genre' },
]

describe('copyright eval — golden set', () => {
  it.each(GOLDEN)('$label: "$text" → blocked=$blocked', ({ text, blocked }) => {
    expect(checkCopyright(text).blocked).toBe(blocked)
  })

  it('precision: ≥ 95% of true negatives pass (no false positives)', () => {
    const negatives = GOLDEN.filter((g) => !g.blocked)
    const falsePositives = negatives.filter((g) => checkCopyright(g.text).blocked)
    const precision = (negatives.length - falsePositives.length) / negatives.length
    expect(precision).toBeGreaterThanOrEqual(0.95)
  })

  it('recall: ≥ 80% of true positives are blocked', () => {
    const positives = GOLDEN.filter((g) => g.blocked)
    const blocked = positives.filter((g) => checkCopyright(g.text).blocked)
    const recall = blocked.length / positives.length
    expect(recall).toBeGreaterThanOrEqual(0.8)
  })
})
