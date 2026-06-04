/**
 * Comprehensive cross-measure note-move test suite.
 *
 * Covers the bug class reported in 2026-05: "values are not being
 * properly adjusted or represented on the staff" when notes move
 * between measures. Layers:
 *   1. Tied-note dangling-tie regression (the new fix in
 *      transformScoreBalanced.cloneEventStripTrailingTie /
 *      stripTrailingTieFromLast).
 *   2. Every Duration × representative meters → cross-measure move
 *      produces a measure-valid Score with preserved pitch.
 *   3. Cross-measure moves with rests interspersed in source AND dest.
 *   4. Property-based: random valid scores survive reorder invariants.
 *   5. Multi-staff / multi-voice non-interference.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { transformScoreBalanced } from '@/lib/music/transformScoreBalanced'
import { DURATION_32NDS } from '@/lib/music/measureBalance'
import { meterCapacityIn32nds } from '@/lib/music/meter'
import { validateScore } from '@/lib/music/validateScore'
import type { Duration, Event, Score } from '@/lib/music/types'

// ── helpers ────────────────────────────────────────────────────────────

function buildScore(partial: Partial<Score> & Pick<Score, 'measures'>): Score {
  return { key: 'C', meter: '4/4', ...partial }
}

function note(
  step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B',
  duration: Duration,
  extras: Partial<Event> = {},
): Event {
  return { pitches: [{ step, octave: 4 }], duration, ...extras }
}

function rest(duration: Duration): Event {
  return { pitches: [{ step: 'rest', octave: 4 }], duration }
}

function totalUnits(events: readonly Event[]): number {
  // Face-value sum (matches transformScoreBalanced.sumUnits). For tuplet-
  // free measures this equals the real time; we keep tuplets out of the
  // matrix below to avoid that divergence (validateScore is tuplet-aware
  // via eventDurationInEighths but the math layer is not).
  return events.reduce((s, e) => s + DURATION_32NDS[e.duration], 0)
}

function measureSumsMatchCapacity(score: Score): boolean {
  const cap = meterCapacityIn32nds(score.meter)
  return score.measures.every((m) => totalUnits(m.events) === cap)
}

function findPitchInScore(score: Score, step: string): boolean {
  return score.measures.some((m) =>
    m.events.some((e) => e.pitches.some((p) => p.step === step)),
  )
}

// ── Section A: tied-note dangling-tie regression ───────────────────────

describe('reorderBalanced — cross-measure preserves no dangling ties', () => {
  it('moved event LOSES its tied_to_next when crossing barlines', () => {
    // m0: [C-Q-TIED, D-Q, E-Q, F-Q]; m1: [G-Q, A-Q, B-Q, C-Q]
    // Move C (tied_to_next) to front of m1. The original tie was
    // C→D within m0; after move, C is alone in m1 and would dangle
    // if tied_to_next were preserved.
    const src: Score = buildScore({
      measures: [
        { events: [
          note('C', 'quarter', { tied_to_next: true }),
          note('D', 'quarter'),
          note('E', 'quarter'),
          note('F', 'quarter'),
        ] },
        { events: [
          note('G', 'quarter'),
          note('A', 'quarter'),
          note('B', 'quarter'),
          note('C', 'quarter'),
        ] },
      ],
    })
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 1, position32nds: 0 },
    })
    const movedC = out.measures[1].events[0]
    expect(movedC.pitches[0].step).toBe('C')
    expect(movedC.tied_to_next).toBeFalsy()
    expect(() => validateScore(out)).not.toThrow()
  })

  it('SOURCE PREDECESSOR loses its tied_to_next when it pointed at the moved event', () => {
    // m0: [C-Q, D-Q-TIED, E-Q, F-Q]; m1: [G-Q, A-Q, B-Q, C-Q]
    // Move E. PREDECESSOR D had tied_to_next pointing at E. After
    // the move D's "next" is a rest filler — strip the tie.
    const src: Score = buildScore({
      measures: [
        { events: [
          note('C', 'quarter'),
          note('D', 'quarter', { tied_to_next: true }),
          note('E', 'quarter'),
          note('F', 'quarter'),
        ] },
        { events: [
          note('G', 'quarter'),
          note('A', 'quarter'),
          note('B', 'quarter'),
          note('C', 'quarter'),
        ] },
      ],
    })
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 2 },
      target: { measureIdx: 1, position32nds: 32 }, // end of m1
    })
    const srcD = out.measures[0].events[1]
    expect(srcD.pitches[0].step).toBe('D')
    expect(srcD.tied_to_next).toBeFalsy()
    expect(() => validateScore(out)).not.toThrow()
  })

  it('cascade: internal ties preserved, terminal tie remains false when source was untied', () => {
    // 4/4: m0 = [C-Q, D-Q, E-half], m1 = [F-Q, G-Q, A-Q, B-Q], m2 = [C-whole]
    // Move E (16u, eventIdx=2) to position 24 of m1. Available in m1 from
    // pos 24 = 32-24 = 8. tieSplitOver returns [[8], [8]] → quarter in m1
    // (tied) + quarter in m2 (NOT tied — source was untied).
    const src: Score = buildScore({
      measures: [
        { events: [note('C', 'quarter'), note('D', 'quarter'), note('E', 'half')] },
        { events: [note('F', 'quarter'), note('G', 'quarter'), note('A', 'quarter'), note('B', 'quarter')] },
        { events: [note('C', 'whole')] },
      ],
    })
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 2 },
      target: { measureIdx: 1, position32nds: 24 },
    })
    expect(() => validateScore(out)).not.toThrow()
    const m1 = out.measures[1].events
    expect(m1[m1.length - 1].tied_to_next).toBe(true) // cascade-internal tie
    expect(out.measures[2].events[0].tied_to_next).toBeFalsy() // terminal: no dangle
  })

  it('cascade with originally-tied source: terminal tie ALSO stripped (no dangle)', () => {
    // Same setup but E has tied_to_next=true. Pre-fix, decoratePart
    // would preserve that tie on the cascade tail, making it tie INTO
    // whatever happens to be after it in m2 (now a rest, not the
    // original tie target). Post-fix: stripped.
    const src: Score = buildScore({
      measures: [
        { events: [note('C', 'quarter'), note('D', 'quarter'), note('E', 'half', { tied_to_next: true })] },
        { events: [note('F', 'quarter'), note('G', 'quarter'), note('A', 'quarter'), note('B', 'quarter')] },
        { events: [note('C', 'whole')] },
      ],
    })
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 2 },
      target: { measureIdx: 1, position32nds: 24 },
    })
    expect(() => validateScore(out)).not.toThrow()
    expect(out.measures[2].events[0].tied_to_next).toBeFalsy()
  })
})

// ── Section B: every Duration × representative meters ─────────────────

const METER_CAPACITY: Array<{ meter: Score['meter']; cap: number }> = [
  { meter: '4/4', cap: 32 },
  { meter: '3/4', cap: 24 },
  { meter: '6/8', cap: 24 },
  { meter: '5/4', cap: 40 },
  { meter: '7/8', cap: 28 },
  { meter: 'C|', cap: 16 },
]

const ALL_DURATIONS: Duration[] = [
  'whole', 'dotted-half', 'half', 'dotted-quarter', 'quarter',
  'dotted-eighth', 'eighth', 'sixteenth', '32nd',
]

/**
 * Build a source measure containing `pivot` at eventIdx 0 plus rest
 * padding to fill `cap`. Returns undefined when no padding fits
 * (single-event source → would_empty_measure).
 */
function buildSourceMeasure(pivot: Event, cap: number): Event[] | undefined {
  const pivotUnits = DURATION_32NDS[pivot.duration]
  if (pivotUnits > cap) return undefined
  const remaining = cap - pivotUnits
  if (remaining === 0) return undefined
  const events: Event[] = [pivot]
  let left = remaining
  for (const d of ALL_DURATIONS) {
    const u = DURATION_32NDS[d]
    while (left >= u) {
      events.push(rest(d))
      left -= u
    }
  }
  return events
}

function buildEmptyRestMeasure(cap: number): Event[] {
  const events: Event[] = []
  let left = cap
  for (const d of ALL_DURATIONS) {
    const u = DURATION_32NDS[d]
    while (left >= u) {
      events.push(rest(d))
      left -= u
    }
  }
  return events
}

describe('reorderBalanced — Duration × meter cross-measure matrix', () => {
  for (const { meter, cap } of METER_CAPACITY) {
    for (const dur of ALL_DURATIONS) {
      const durUnits = DURATION_32NDS[dur]
      if (durUnits > cap) continue
      // Skip the single-event-source cells (covered elsewhere with
      // an explicit would_empty_measure assertion).
      if (durUnits === cap) continue

      it(`moves a ${dur} in ${meter} (cap ${cap}) from m0 to m1@0`, () => {
        const m0 = buildSourceMeasure(note('C', dur), cap)
        if (!m0) throw new Error(`builder produced undefined for ${dur}/${meter}`)
        const m1 = buildEmptyRestMeasure(cap)
        const score: Score = buildScore({
          meter,
          measures: [{ events: m0 }, { events: m1 }],
        })
        // Sanity: constructed score must be valid.
        expect(() => validateScore(score)).not.toThrow()
        const out = transformScoreBalanced(score, {
          kind: 'reorderBalanced',
          selection: { measureIdx: 0, eventIdx: 0 },
          target: { measureIdx: 1, position32nds: 0 },
        })
        // Post: still valid, measure count preserved.
        expect(() => validateScore(out)).not.toThrow()
        expect(out.measures.length).toBe(2)
        expect(measureSumsMatchCapacity(out)).toBe(true)
        // C must appear somewhere in m1 (possibly tied chain).
        const m1Out = out.measures[1].events
        expect(m1Out.some((e) => e.pitches.some((p) => p.step === 'C'))).toBe(true)
        // Source m0 must NO LONGER have C at eventIdx 0 (it moved).
        const m0Out = out.measures[0].events
        expect(m0Out[0].pitches[0].step).not.toBe('C')
      })
    }
  }
})

// ── Section C: cross-measure moves with mixed notes+rests ─────────────

describe('reorderBalanced — interspersed rests in source and destination', () => {
  it('drops past leading rest in destination (the integration repro)', () => {
    // m0: [Q, Q, Q, Q]; m1: [eighth-rest, Q, Q, Q, eighth-rest]
    // Move m0's F to position 12 of m1 (after the eighth-rest + first
    // quarter in m1). Pre-fix this would have landed at the wrong slot
    // because the snap layer would have computed pos 8 instead of 12.
    const src: Score = buildScore({
      measures: [
        { events: [note('C', 'quarter'), note('D', 'quarter'), note('E', 'quarter'), note('F', 'quarter')] },
        { events: [
          rest('eighth'),
          note('G', 'quarter'),
          note('A', 'quarter'),
          note('B', 'quarter'),
          rest('eighth'),
        ] },
      ],
    })
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 3 },
      target: { measureIdx: 1, position32nds: 12 },
    })
    expect(() => validateScore(out)).not.toThrow()
    expect(measureSumsMatchCapacity(out)).toBe(true)
    const m1 = out.measures[1].events
    const fIdx = m1.findIndex((e) => e.pitches.some((p) => p.step === 'F'))
    expect(fIdx).toBeGreaterThan(0)
  })

  it('drops into all-rest destination measure', () => {
    const src: Score = buildScore({
      measures: [
        { events: [note('C', 'quarter'), note('D', 'quarter'), note('E', 'quarter'), note('F', 'quarter')] },
        { events: [rest('whole')] },
      ],
    })
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 1 },
      target: { measureIdx: 1, position32nds: 0 },
    })
    expect(() => validateScore(out)).not.toThrow()
    expect(measureSumsMatchCapacity(out)).toBe(true)
    expect(findPitchInScore(out, 'D')).toBe(true)
  })

  it('drops at end of measure that contains trailing rests', () => {
    const src: Score = buildScore({
      measures: [
        { events: [note('C', 'quarter'), note('D', 'quarter'), note('E', 'quarter'), note('F', 'quarter')] },
        { events: [note('G', 'quarter'), rest('dotted-half')] },
      ],
    })
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 1, position32nds: 32 }, // end of m1
    })
    expect(() => validateScore(out)).not.toThrow()
    const m1 = out.measures[1].events
    expect(m1[m1.length - 1].pitches[0].step).toBe('C')
  })
})

// ── Section D: invariants over random valid scores (fast-check) ───────

function arbMeasureWithLeadNote(cap: number): fc.Arbitrary<{ events: Event[]; pivot: Duration }> {
  // Exclude durations that fill the entire meter — those produce
  // single-event measures and can't be the source of a balanced move.
  const validDurs = ALL_DURATIONS.filter((d) => DURATION_32NDS[d] < cap)
  return fc.constantFrom(...validDurs).map((d) => {
    const ev = buildSourceMeasure(note('C', d), cap)!
    return { events: ev, pivot: d }
  })
}

describe('reorderBalanced — property: invariants over random valid sources', () => {
  it('every randomly-constructed cross-measure move produces a valid Score', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...METER_CAPACITY),
        (entry) => {
          fc.assert(
            fc.property(arbMeasureWithLeadNote(entry.cap), (m0) => {
              const m1 = buildEmptyRestMeasure(entry.cap)
              const score: Score = buildScore({
                meter: entry.meter,
                measures: [{ events: m0.events }, { events: m1 }],
              })
              try { validateScore(score) } catch { return true }
              const out = transformScoreBalanced(score, {
                kind: 'reorderBalanced',
                selection: { measureIdx: 0, eventIdx: 0 },
                target: { measureIdx: 1, position32nds: 0 },
              })
              try { validateScore(out) } catch { return false }
              if (out.measures.length !== 2) return false
              if (!measureSumsMatchCapacity(out)) return false
              if (!findPitchInScore(out, 'C')) return false
              return true
            }),
            { numRuns: 30 },
          )
          return true
        },
      ),
      { numRuns: 6 },
    )
  })
})

// ── Section E: multi-staff / multi-voice ──────────────────────────────

describe('reorderBalanced — multi-staff / multi-voice (cross-measure)', () => {
  it('primary-staff cross-measure move does not perturb secondStaff', () => {
    const src: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [note('C', 'quarter'), note('D', 'quarter'), note('E', 'quarter'), note('F', 'quarter')] },
        { events: [rest('whole')] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [note('A', 'whole')] },
          { events: [note('B', 'whole')] },
        ],
      },
    }
    const beforeSecond = JSON.stringify(src.secondStaff)
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { staffIdx: 0, measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 1, position32nds: 0 },
    })
    expect(JSON.stringify(out.secondStaff)).toBe(beforeSecond)
    expect(() => validateScore(out)).not.toThrow()
  })

  it('secondStaff cross-measure move does not perturb primary', () => {
    const src: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [note('C', 'whole')] },
        { events: [note('D', 'whole')] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [note('A', 'quarter'), note('B', 'quarter'), note('C', 'quarter'), note('D', 'quarter')] },
          { events: [rest('whole')] },
        ],
      },
    }
    const beforePrimary = JSON.stringify(src.measures)
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { staffIdx: 1, measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 1, position32nds: 0 },
    })
    expect(JSON.stringify(out.measures)).toBe(beforePrimary)
    expect(() => validateScore(out)).not.toThrow()
  })

  it('move in extraVoices does not perturb primary voice', () => {
    const src: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [note('C', 'whole')] },
        { events: [note('D', 'whole')] },
      ],
      extraVoices: [
        { measures: [
          { events: [note('A', 'quarter'), note('B', 'quarter'), note('C', 'quarter'), note('D', 'quarter')] },
          { events: [rest('whole')] },
        ] },
      ],
    }
    const beforePrimary = JSON.stringify(src.measures)
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { voiceIdx: 1, measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 1, position32nds: 0 },
    })
    expect(JSON.stringify(out.measures)).toBe(beforePrimary)
    expect(() => validateScore(out)).not.toThrow()
  })
})

// ── Section F: identity / no-op observation ───────────────────────────

describe('reorderBalanced — identity case', () => {
  it('drop at the same position (within-measure) preserves the layout', () => {
    const src: Score = buildScore({
      measures: [{ events: [
        note('C', 'quarter'),
        note('D', 'quarter'),
        note('E', 'quarter'),
        note('F', 'quarter'),
      ] }],
    })
    const out = transformScoreBalanced(src, {
      kind: 'reorderBalanced',
      selection: { measureIdx: 0, eventIdx: 0 },
      target: { measureIdx: 0, position32nds: 0 },
    })
    const steps = out.measures[0].events.map((e) => e.pitches[0].step)
    expect(steps).toEqual(['C', 'D', 'E', 'F'])
  })
})
