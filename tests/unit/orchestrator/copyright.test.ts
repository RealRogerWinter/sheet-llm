import { describe, it, expect } from 'vitest'
import { checkCopyright } from '@/lib/orchestrator/copyright/filter'

describe('copyright filter', () => {
  describe('blocks unambiguous infringement requests', () => {
    it.each([
      'Yesterday by The Beatles',
      'play Hey Jude by the Beatles',
      'cover of Shake It Off',
      'reproduce Bohemian Rhapsody',
      'copy of Hotel California',
      'write Smells Like Teen Spirit by Nirvana',
    ])('blocks: %s', (text) => {
      const result = checkCopyright(text)
      expect(result.blocked).toBe(true)
      expect(result.refusalCode).toBe('copyright')
      expect(result.reason).toBeTruthy()
    })
  })

  describe('does NOT block common-word ambiguities (red-team false positives)', () => {
    it.each([
      'write a sad melody about yesterday\'s rain',
      'a fanfare for the queen\'s coronation',
      'happy tune to make a kid smile',
      'apple pie waltz',
      'a folk tune about a journey',
      'compose something for my friend Taylor',
      'a hero theme for a video game',
      'write something simple',
      'a love song',
      // Bare reproduction verbs no longer fire; require ownership marker.
      'play a happy melody',
      'sing yesterday\'s news',
      'write let it be a major key piece',
      'perform yesterday\'s tasks in music',
      'play imagine you are sad',
      'write happy chords',
      'play happy birthday for a kid',
    ])('passes: %s', (text) => {
      const result = checkCopyright(text)
      expect(result.blocked).toBe(false)
    })
  })

  describe('public-domain allowlist short-circuits', () => {
    it.each([
      'a fugue in the style of Bach',
      'compose like Mozart',
      'in the style of Beethoven',
      'a piece reminiscent of Chopin',
      'Eine kleine Nachtmusik style',
    ])('allows PD: %s', (text) => {
      const result = checkCopyright(text)
      expect(result.blocked).toBe(false)
    })

    it('PD allowlist beats a "by" co-occurrence (Bach is dead, no infringement)', () => {
      // Defensive: even if someone writes "by Bach", we don't block.
      const result = checkCopyright('a chorale by Bach')
      expect(result.blocked).toBe(false)
    })
  })

  describe('punctuation and casing', () => {
    it('case-insensitive', () => {
      expect(checkCopyright('YESTERDAY BY THE BEATLES').blocked).toBe(true)
      expect(checkCopyright('yesterday by the beatles').blocked).toBe(true)
    })

    it('handles surrounding punctuation', () => {
      expect(checkCopyright('"Yesterday" by The Beatles, please').blocked).toBe(true)
    })
  })

  describe('does not block style-only requests', () => {
    it.each([
      'in the style of a march',
      'in the style of a Viennese waltz',
      'in the style of Appalachian folk',
      'in the style of Gregorian chant',
    ])('passes style: %s', (text) => {
      const result = checkCopyright(text)
      expect(result.blocked).toBe(false)
    })
  })
})
