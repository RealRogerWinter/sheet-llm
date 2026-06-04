import { describe, it, expect } from 'vitest'
import {
  HELP_SECTIONS,
  QUICK_START_INTRO,
  QUICK_START_FOOTER,
  QUICK_START_STEPS,
} from './content'

// Every visible string in the help system, concatenated so the style
// rules can be enforced mechanically. This is the automated half of the
// copy audit: the human-judgment rules (rule-of-three, throat-clearing)
// are reviewed by hand; the objective ones are pinned here.
const ALL_COPY = [
  QUICK_START_INTRO,
  QUICK_START_FOOTER,
  ...QUICK_START_STEPS.flatMap((s) => [s.title, s.body]),
  ...HELP_SECTIONS.flatMap((s) => [s.title, s.body]),
].join('\n')

// AI-cliché words that must never appear (the house banned list).
const BANNED_WORDS = [
  'delve', 'utilize', 'leverage', 'harness', 'streamline', 'unlock',
  'foster', 'underscore', 'elevate', 'empower', 'spearhead', 'orchestrate',
  'navigate', 'robust', 'crucial', 'vital', 'essential', 'cutting-edge',
  'groundbreaking', 'transformative', 'innovative', 'seamless', 'holistic',
  'comprehensive', 'pivotal', 'multifaceted', 'game-changing', 'landscape',
  'paradigm', 'synergy', 'tapestry', 'realm', 'journey', 'ecosystem',
]

const BANNED_PHRASES = [
  'deep dive',
  'paradigm shift',
  "it's important to note",
  "it's worth noting",
  "let's dive in",
  "let's explore",
  'at the end of the day',
  'the bottom line',
]

describe('help copy style guard', () => {
  it('uses no second person ("you"/"your")', () => {
    const match = ALL_COPY.match(/\byou(r|rs|rself|'ll|'ve|'re|'d)?\b/i)
    expect(match ? match[0] : null).toBeNull()
  })

  it('uses none of the banned AI-cliché words', () => {
    const hits = BANNED_WORDS.filter((w) => {
      const re = new RegExp(`\\b${w.replace(/-/g, '\\-')}\\b`, 'i')
      return re.test(ALL_COPY)
    })
    expect(hits).toEqual([])
  })

  it('uses none of the banned filler phrases', () => {
    const lower = ALL_COPY.toLowerCase()
    const hits = BANNED_PHRASES.filter((p) => lower.includes(p))
    expect(hits).toEqual([])
  })

  it('avoids em dashes (commas, colons, periods instead)', () => {
    expect(ALL_COPY.includes('—')).toBe(false)
  })

  it('has well-formed, uniquely-identified sections', () => {
    const seen = new Set<string>()
    for (const section of HELP_SECTIONS) {
      expect(section.id).toMatch(/^[a-z0-9-]+$/)
      expect(seen.has(section.id)).toBe(false)
      seen.add(section.id)
      expect(section.title.length).toBeGreaterThan(0)
      expect(section.body.startsWith('## ')).toBe(true)
    }
    expect(HELP_SECTIONS).toHaveLength(10)
  })
})
