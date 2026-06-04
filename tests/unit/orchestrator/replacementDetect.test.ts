import { describe, it, expect } from 'vitest'
import type { Score } from '@/lib/music/types'
import { detectReplacement } from '@/lib/orchestrator/replacementDetect'

/**
 * M3.5-PR-4 — pure-function tests for the replacement-detection gate.
 * Cover every branch of the boolean logic AND the word-boundary
 * keyword matcher.
 */

const BASE_TRIPLET: Score = {
  title: 'Triplet demo',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
  ],
}

/** Wholesale replacement — different key/meter/title, all bars new. */
const REPLACEMENT_SCORE: Score = {
  title: '5/4 ostinato',
  key: 'Am',
  meter: '5/4',
  measures: Array.from({ length: 4 }, () => ({
    events: [
      { pitches: [{ step: 'A', octave: 3 }], duration: 'quarter' },
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
    ],
  })),
}

/** Identical to BASE_TRIPLET with 4 extra new bars appended — ratio 1.0. */
const APPENDED_8_BARS: Score = {
  ...BASE_TRIPLET,
  measures: [
    ...BASE_TRIPLET.measures,
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'F', octave: 4 }], duration: 'whole' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'G', octave: 4 }], duration: 'whole' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ],
    },
  ],
}

describe('detectReplacement (M3.5-PR-4)', () => {
  describe('fires when all gating conditions hold', () => {
    it('flags wholesale key + meter + title change with 0% retention', () => {
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore: REPLACEMENT_SCORE,
        userText: 'add 4 more bars with a i iv v turnaround',
      })
      expect(d.isReplacement).toBe(true)
      expect(d.retainedIdentityRatio).toBe(0)
      expect(d.reasons.length).toBeGreaterThanOrEqual(3)
      expect(d.reasons.some((r) => r.includes('key C → Am'))).toBe(true)
      expect(d.reasons.some((r) => r.includes('meter 4/4 → 5/4'))).toBe(true)
      expect(d.reasons.some((r) => r.includes('Triplet demo'))).toBe(true)
      expect(d.userExplicitRewrite).toBe(false)
    })
  })

  describe('does NOT fire on additive edits', () => {
    it('extend_composition output (8 bars, key/meter/title intact) is not a replacement', () => {
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore: APPENDED_8_BARS,
        userText: 'add 4 more bars',
        dispatchTool: 'extend_composition',
      })
      expect(d.isReplacement).toBe(false)
      expect(d.retainedIdentityRatio).toBe(1)
      // No reasons populated because nothing changed.
      expect(d.reasons).toEqual([])
    })
  })

  describe('retainedIdentityRatio threshold', () => {
    it('ratio >= 0.5 → not a replacement even with key/meter change', () => {
      // 3 of 4 bars retained (75%), title changed → not a replacement.
      const partial: Score = {
        ...BASE_TRIPLET,
        title: 'New title',
        measures: [
          BASE_TRIPLET.measures[0],
          BASE_TRIPLET.measures[1],
          BASE_TRIPLET.measures[2],
          {
            events: [
              { pitches: [{ step: 'B', octave: 5 }], duration: 'whole' },
            ],
          },
        ],
      }
      // sanity: ratio is 0.75
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore: partial,
        userText: 'change the title',
      })
      expect(d.retainedIdentityRatio).toBeCloseTo(0.75, 5)
      expect(d.isReplacement).toBe(false)
    })

    it('ratio < 0.5 + key change → fires', () => {
      const afterScore: Score = {
        ...REPLACEMENT_SCORE,
        meter: BASE_TRIPLET.meter, // only key + title differ
        title: BASE_TRIPLET.title,
      }
      // bars all different, key C → Am, meter same, title same.
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore,
        userText: 'modulate to A minor',
      })
      expect(d.retainedIdentityRatio).toBeLessThan(0.5)
      // metadata changed (key)
      expect(d.isReplacement).toBe(true)
    })
  })

  describe('metadata change requirement', () => {
    it('no metadata change → not a replacement, even at 0% retention', () => {
      // All 4 bars different, but key/meter/title preserved.
      const afterScore: Score = {
        ...BASE_TRIPLET,
        measures: REPLACEMENT_SCORE.measures.map((m) => ({ events: m.events })),
      }
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore,
        userText: 'recompose the melody from scratch',
      })
      // metadata identical → not a replacement, BUT userExplicitRewrite is true
      expect(d.isReplacement).toBe(false)
      expect(d.userExplicitRewrite).toBe(true)
    })
  })

  describe('explicit-rewrite intent', () => {
    const EXPECTED_KEYWORDS = [
      'start over please',
      'do it from scratch',
      'compose a new piece',
      'scrap this and try again',
      'scrap that and try again',
      'recompose the piece',
      'compose anew with a swing feel',
    ]
    for (const text of EXPECTED_KEYWORDS) {
      it(`matches keyword in: "${text}"`, () => {
        const d = detectReplacement({
          beforeScore: BASE_TRIPLET,
          afterScore: REPLACEMENT_SCORE,
          userText: text,
        })
        expect(d.userExplicitRewrite).toBe(true)
        // Even with all gating conditions met structurally, the explicit
        // intent flag flips the gate off.
        expect(d.isReplacement).toBe(false)
      })
    }

    it('case-insensitive', () => {
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore: REPLACEMENT_SCORE,
        userText: 'COMPOSE this from SCRATCH',
      })
      expect(d.userExplicitRewrite).toBe(true)
    })

    it('positive: "scrap this and start over"', () => {
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore: REPLACEMENT_SCORE,
        userText: 'scrap this and start over',
      })
      expect(d.userExplicitRewrite).toBe(true)
      expect(d.isReplacement).toBe(false)
    })

    it('positive: "recompose this from scratch in F minor"', () => {
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore: REPLACEMENT_SCORE,
        userText: 'recompose this from scratch in F minor',
      })
      expect(d.userExplicitRewrite).toBe(true)
      expect(d.isReplacement).toBe(false)
    })

    // Negation false-positive cases — these MUST NOT trigger
    // userExplicitRewrite. Before the H1 fix the keyword scan included
    // bare verbs `rewrite`/`replace`/`redo`, which matched inside
    // negated intent and silently disabled the gate exactly when the
    // user wanted protection.
    it('negation: "please don\'t replace what I have" → false', () => {
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore: REPLACEMENT_SCORE,
        userText: "please don't replace what I have",
      })
      expect(d.userExplicitRewrite).toBe(false)
      // gate still fires because user didn't actually ask for rewrite
      expect(d.isReplacement).toBe(true)
    })

    it('negation: "no rewrites — just extend it" → false', () => {
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore: REPLACEMENT_SCORE,
        userText: 'no rewrites — just extend it',
      })
      expect(d.userExplicitRewrite).toBe(false)
      expect(d.isReplacement).toBe(true)
    })

    it("negation: \"I don't want to redo this; add 4 more bars\" → false", () => {
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore: REPLACEMENT_SCORE,
        userText: "I don't want to redo this; add 4 more bars",
      })
      expect(d.userExplicitRewrite).toBe(false)
      expect(d.isReplacement).toBe(true)
    })

    it('does NOT false-match on partial substrings', () => {
      // "gateway", "redo" inside "redone" with word boundary should NOT
      // match a standalone "redo". Actually "redone" CONTAINS "redo" as a
      // prefix — word boundary at start (\b before r) matches but the
      // boundary AFTER "redo" requires a non-word char; "redone" has
      // "n" right after so no boundary. So "redone" does NOT match.
      const safeTexts = [
        'the gateway has a played by red',
        'I redone my homework but actually nothing matches here',
        'replaceability is not in the keyword list',
      ]
      for (const t of safeTexts) {
        const d = detectReplacement({
          beforeScore: BASE_TRIPLET,
          afterScore: REPLACEMENT_SCORE,
          userText: t,
        })
        expect(
          d.userExplicitRewrite,
          `expected "${t}" to not match`,
        ).toBe(false)
      }
    })

    it('regenerate_all + confirmExplicitRewrite=true bypasses keyword scan', () => {
      // User text has no keyword, but dispatcher confirmed explicit
      // rewrite. The gate should treat as user-explicit and skip firing.
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore: REPLACEMENT_SCORE,
        userText: 'change everything',
        dispatchTool: 'regenerate_all',
        confirmExplicitRewrite: true,
      })
      expect(d.userExplicitRewrite).toBe(true)
      expect(d.isReplacement).toBe(false)
    })

    it('regenerate_all WITHOUT confirmExplicitRewrite still fires the gate', () => {
      // Defense-in-depth: the PR-3 preview-mode branch sets
      // requiresConfirmation directly when confirmExplicitRewrite=false,
      // but if someone bypasses that, the gate still catches it.
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore: REPLACEMENT_SCORE,
        userText: 'change everything',
        dispatchTool: 'regenerate_all',
        // no confirmExplicitRewrite provided
      })
      expect(d.userExplicitRewrite).toBe(false)
      expect(d.isReplacement).toBe(true)
    })
  })

  describe('no prior score', () => {
    it('beforeScore=undefined → never a replacement', () => {
      const d = detectReplacement({
        beforeScore: undefined,
        afterScore: REPLACEMENT_SCORE,
        userText: 'compose a piece in A minor 5/4',
      })
      expect(d.isReplacement).toBe(false)
      expect(d.reasons).toEqual([])
    })
  })

  describe('reasons strings', () => {
    it('formats key/meter/title diffs and retained count', () => {
      const d = detectReplacement({
        beforeScore: BASE_TRIPLET,
        afterScore: REPLACEMENT_SCORE,
        userText: 'change everything please',
      })
      // BASE_TRIPLET has 4 measures; REPLACEMENT has 4 measures all different.
      expect(d.reasons).toContain('only 0 of 4 measures retained')
      expect(d.reasons).toContain('key C → Am')
      expect(d.reasons).toContain('meter 4/4 → 5/4')
      expect(d.reasons).toContain("title 'Triplet demo' → '5/4 ostinato'")
    })
  })
})
