import { describe, it, expect } from 'vitest'
import { smartInsertNote } from '@/lib/music/smartInsertNote'
import { validateScore } from '@/lib/music/validateScore'
import type { Score } from '@/lib/music/types'

function buildScore(partial: Partial<Score> & Pick<Score, 'measures'>): Score {
  return { key: 'C', meter: '4/4', ...partial }
}

const FULL_4_4: Score = buildScore({
  measures: [{ events: [
    { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
  ] }],
})

// half-C followed by a half-rest so the measure is meter-valid; the new
// rest-absorbing algorithm requires real rest events to consume rather
// than the unwritten capacity it used to lean on.
const HALF_FULL_4_4: Score = buildScore({
  measures: [{ events: [
    { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
    { pitches: [{ step: 'rest', octave: 4 }], duration: 'half' },
  ] }],
})

// 28/32 of pitched content + a trailing eighth-rest to make the bar
// meter-valid. Leaves exactly 1 eighth absorbable at the end.
const ONE_EIGHTH_REMAINING: Score = buildScore({
  measures: [{ events: [
    { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
    { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth' },
    { pitches: [{ step: 'rest', octave: 4 }], duration: 'eighth' },
  ] }],
})

describe('smartInsertNote', () => {
  it('inserts at requested duration when measure has room', () => {
    const result = smartInsertNote(HALF_FULL_4_4, undefined, {
      pitches: [{ step: 'G', octave: 4 }],
      duration: 'quarter',
    })
    // Half-C kept, half-rest absorbed → quarter-G + quarter-rest fill.
    expect(result.score.measures[0].events).toHaveLength(3)
    expect(result.score.measures[0].events[0].duration).toBe('half')
    expect(result.score.measures[0].events[1].duration).toBe('quarter')
    expect(result.score.measures[0].events[1].pitches[0].step).toBe('G')
    expect(result.score.measures[0].events[2].pitches[0].step).toBe('rest')
    expect(result.score.measures[0].events[2].duration).toBe('quarter')
    expect(result.statusMessage).toBeUndefined()
    expect(result.newSelection).toEqual({ staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 1, pitchIdx: 0 })
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('shrinks the requested duration when there is partial room', () => {
    // ONE_EIGHTH_REMAINING has a trailing eighth-rest — 1 eighth
    // absorbable, less than the requested quarter.
    const result = smartInsertNote(ONE_EIGHTH_REMAINING, undefined, {
      pitches: [{ step: 'G', octave: 4 }],
      duration: 'quarter',
    })
    expect(result.score.measures).toHaveLength(1)
    expect(result.score.measures[0].events).toHaveLength(4)
    expect(result.score.measures[0].events[3].duration).toBe('eighth')
    expect(result.score.measures[0].events[3].pitches[0].step).toBe('G')
    expect(result.statusMessage).toMatch(/eighth/)
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('spills into a new measure when the target is full, padding the new bar with rests', () => {
    const result = smartInsertNote(FULL_4_4, undefined, {
      pitches: [{ step: 'G', octave: 4 }],
      duration: 'quarter',
    })
    expect(result.score.measures).toHaveLength(2)
    expect(result.score.measures[0].events).toHaveLength(4) // unchanged
    // New bar: inserted quarter G + padding rests filling the rest of 4/4.
    const newBar = result.score.measures[1]
    expect(newBar.events[0]).toEqual({ pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' })
    expect(newBar.events.length).toBeGreaterThan(1)
    expect(newBar.events.slice(1).every((e) => e.pitches[0].step === 'rest')).toBe(true)
    expect(() => validateScore(result.score)).not.toThrow()
    expect(result.newSelection).toEqual({ staffIdx: 0, voiceIdx: 0, measureIdx: 1, eventIdx: 0, pitchIdx: 0 })
    expect(result.statusMessage).toMatch(/measure 2/)
  })

  it('with explicit target inserts AFTER that event, consuming following rests', () => {
    const result = smartInsertNote(HALF_FULL_4_4, { measureIdx: 0, eventIdx: 0 }, {
      pitches: [{ step: 'G', octave: 4 }],
      duration: 'quarter',
    })
    // Anchor = half-C (note); absorbable scan starts at the half-rest
    // that follows and consumes it → quarter-G + quarter-rest.
    expect(result.score.measures[0].events).toHaveLength(3)
    expect(result.score.measures[0].events[0].duration).toBe('half')
    expect(result.score.measures[0].events[1].duration).toBe('quarter')
    expect(result.score.measures[0].events[1].pitches[0].step).toBe('G')
    expect(result.score.measures[0].events[2].pitches[0].step).toBe('rest')
    expect(result.newSelection.eventIdx).toBe(1)
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('does not mutate the input score', () => {
    const before = JSON.stringify(HALF_FULL_4_4)
    smartInsertNote(HALF_FULL_4_4, undefined, {
      pitches: [{ step: 'G', octave: 4 }],
      duration: 'quarter',
    })
    expect(JSON.stringify(HALF_FULL_4_4)).toBe(before)
  })

  it('respects 6/8 capacity (6 eighths)', () => {
    const sixEight: Score = buildScore({
      meter: '6/8',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'dotted-quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth' },
      ] }],
    })
    // m.0 sums to 6 eighths — full, no trailing rests. Insert spills.
    const result = smartInsertNote(sixEight, undefined, {
      pitches: [{ step: 'G', octave: 4 }],
      duration: 'eighth',
    })
    expect(result.score.measures).toHaveLength(2)
    expect(result.score.measures[1].events[0].pitches[0].step).toBe('G')
  })

  it('handles a chord (multi-pitch) insert', () => {
    const result = smartInsertNote(HALF_FULL_4_4, undefined, {
      pitches: [
        { step: 'C', octave: 4 },
        { step: 'E', octave: 4 },
        { step: 'G', octave: 4 },
      ],
      duration: 'quarter',
    })
    expect(result.score.measures[0].events[1].pitches).toHaveLength(3)
  })

  it('respects 5/4 capacity (10 eighths) — fits a 4th quarter cleanly', () => {
    const fiveFour: Score = buildScore({
      meter: '5/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        // half-rest pads to 5/4 capacity (24+16 = 40 thirty-seconds).
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'half' },
      ] }],
    })
    const result = smartInsertNote(fiveFour, undefined, {
      pitches: [{ step: 'F', octave: 4 }],
      duration: 'quarter',
    })
    expect(result.score.measures).toHaveLength(1)
    // half-rest (16) absorbed → quarter-F (8) + quarter-rest (8).
    expect(result.score.measures[0].events).toHaveLength(5)
    expect(result.score.measures[0].events[3].duration).toBe('quarter')
    expect(result.score.measures[0].events[3].pitches[0].step).toBe('F')
    expect(result.score.measures[0].events[4].pitches[0].step).toBe('rest')
    expect(result.statusMessage).toBeUndefined()
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('shrinks a quarter to an eighth in 7/8 when only an eighth of room is left', () => {
    const sevenEight: Score = buildScore({
      meter: '7/8',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        // eighth-rest pads to 7/8 capacity (24+4 = 28 thirty-seconds).
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'eighth' },
      ] }],
    })
    const result = smartInsertNote(sevenEight, undefined, {
      pitches: [{ step: 'F', octave: 4 }],
      duration: 'quarter',
    })
    expect(result.score.measures).toHaveLength(1)
    expect(result.score.measures[0].events).toHaveLength(4)
    expect(result.score.measures[0].events[3].duration).toBe('eighth')
    expect(result.statusMessage).toMatch(/eighth/)
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('inserts on the targeted staff in a two-staff score (bass clef)', () => {
    const grandStaff: Score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 5 }], duration: 'half' },
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'half' },
      ] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [
          { pitches: [{ step: 'C', octave: 3 }], duration: 'half' },
          { pitches: [{ step: 'rest', octave: 3 }], duration: 'half' },
        ] }],
      },
    })
    const result = smartInsertNote(
      grandStaff,
      { measureIdx: 0, eventIdx: 0 },
      { pitches: [{ step: 'F', octave: 3 }], duration: 'quarter' },
      1,
    )
    // Treble staff untouched.
    expect(result.score.measures[0].events).toHaveLength(2)
    expect(result.score.measures[0].events[0].pitches[0].step).toBe('C')
    expect(result.score.measures[0].events[0].pitches[0].octave).toBe(5)
    // Bass staff: anchor=half-C3 (note), following half-rest absorbed
    // into quarter-F3 + quarter-rest.
    expect(result.score.secondStaff?.measures[0].events).toHaveLength(3)
    expect(result.score.secondStaff?.measures[0].events[1].pitches[0]).toEqual({ step: 'F', octave: 3 })
    expect(result.score.secondStaff?.measures[0].events[1].duration).toBe('quarter')
    expect(result.newSelection).toEqual({ staffIdx: 1, voiceIdx: 0, measureIdx: 0, eventIdx: 1, pitchIdx: 0 })
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('spillover into a new measure fans across both staves and pads the target with rests', () => {
    const grandStaff: Score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 5 }], duration: 'whole' },
      ] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [
          { pitches: [{ step: 'C', octave: 3 }], duration: 'whole' },
        ] }],
      },
    })
    const result = smartInsertNote(
      grandStaff,
      undefined,
      { pitches: [{ step: 'F', octave: 3 }], duration: 'quarter' },
      1,
    )
    // Both staves now have 2 measures (bar-aligned).
    expect(result.score.measures).toHaveLength(2)
    expect(result.score.secondStaff?.measures).toHaveLength(2)
    // Primary staff's new measure is a whole-rest padding.
    expect(result.score.measures[1].events[0].pitches[0].step).toBe('rest')
    expect(result.score.measures[1].events[0].duration).toBe('whole')
    // Bass staff's new measure: inserted quarter F, then padding rests
    // so the bar still sums to 4/4.
    const bassNew = result.score.secondStaff!.measures[1]
    expect(bassNew.events[0].pitches[0]).toEqual({ step: 'F', octave: 3 })
    expect(bassNew.events[0].duration).toBe('quarter')
    expect(bassNew.events.length).toBeGreaterThan(1)
    expect(bassNew.events.slice(1).every((e) => e.pitches[0].step === 'rest')).toBe(true)
    expect(() => validateScore(result.score)).not.toThrow()
    expect(result.newSelection).toEqual({ staffIdx: 1, voiceIdx: 0, measureIdx: 1, eventIdx: 0, pitchIdx: 0 })
  })

  it('spillover on the treble of a grand staff: target gets the note + padding rests, other staff gets the bar rest (regression: was underflowing the target bar)', () => {
    const grandStaff: Score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 5 }], duration: 'whole' },
      ] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [
          { pitches: [{ step: 'C', octave: 3 }], duration: 'whole' },
        ] }],
      },
    })
    // Mirrors the NoteFloatingMenu "+" button: target the existing
    // treble C5, default staffIdx = 0, insert a quarter C4.
    const result = smartInsertNote(
      grandStaff,
      { measureIdx: 0, eventIdx: 0 },
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
    )
    expect(result.score.measures).toHaveLength(2)
    expect(result.score.secondStaff?.measures).toHaveLength(2)
    // Treble new measure: quarter C4 + padding rests, sums to 4/4.
    const trebleNew = result.score.measures[1]
    expect(trebleNew.events[0].pitches[0]).toEqual({ step: 'C', octave: 4 })
    expect(trebleNew.events[0].duration).toBe('quarter')
    expect(trebleNew.events.length).toBeGreaterThan(1)
    expect(trebleNew.events.slice(1).every((e) => e.pitches[0].step === 'rest')).toBe(true)
    // Bass new measure: whole-rest, untouched by the staff-0 insertion.
    const bassNew = result.score.secondStaff!.measures[1]
    expect(bassNew.events).toHaveLength(1)
    expect(bassNew.events[0].pitches[0].step).toBe('rest')
    expect(bassNew.events[0].duration).toBe('whole')
    // Score must validate end-to-end.
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('spillover in 3/4: rest-measure on other staves uses meter-correct rests (regression: hardcoded whole-rest broke non-4/4)', () => {
    const threeFour: Score = buildScore({
      meter: '3/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 5 }], duration: 'dotted-half' },
      ] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [
          { pitches: [{ step: 'C', octave: 3 }], duration: 'dotted-half' },
        ] }],
      },
    })
    const result = smartInsertNote(
      threeFour,
      undefined,
      { pitches: [{ step: 'F', octave: 3 }], duration: 'quarter' },
      1,
    )
    // Both bars meter-valid (3/4 capacity = 12 thirty-seconds).
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('fits an eighth into 5/16 with 1 eighth already present (integer-exact math)', () => {
    const fiveSixteen: Score = buildScore({
      meter: '5/16',
      // 5/16 capacity = 2.5 eighths = 10 thirty-seconds.
      // Two sixteenths (4) + a dotted-eighth rest (6) = 10. Meter-valid.
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'sixteenth' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'sixteenth' },
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'dotted-eighth' },
      ] }],
    })
    const result = smartInsertNote(fiveSixteen, undefined, {
      pitches: [{ step: 'E', octave: 4 }],
      duration: 'eighth',
    })
    // Anchor = dotted-eighth-rest (6 units). Eighth (4) fits with 2
    // leftover → sixteenth-rest. Result is [s,s,eighth-E,sixteenth-rest].
    expect(result.score.measures).toHaveLength(1)
    expect(result.score.measures[0].events).toHaveLength(4)
    expect(result.score.measures[0].events[2].duration).toBe('eighth')
    expect(result.score.measures[0].events[2].pitches[0].step).toBe('E')
    expect(result.score.measures[0].events[3].duration).toBe('sixteenth')
    expect(result.score.measures[0].events[3].pitches[0].step).toBe('rest')
    expect(result.statusMessage).toBeUndefined()
    expect(() => validateScore(result.score)).not.toThrow()
  })

  // ── Rest-absorption tests (the new behavior the fix delivers) ──────

  it('absorbs a whole-rest in 4/4 when a quarter is inserted, leaving the bar meter-valid', () => {
    const blank: Score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' },
      ] }],
    })
    const result = smartInsertNote(blank, undefined, {
      pitches: [{ step: 'C', octave: 4 }],
      duration: 'quarter',
    })
    // Exactly one measure — no spillover. Whole-rest (32) is absorbed
    // and the 24 leftover decomposes greedily to a single dotted-half.
    expect(result.score.measures).toHaveLength(1)
    const events = result.score.measures[0].events
    expect(events).toHaveLength(2)
    expect(events[0].pitches[0]).toEqual({ step: 'C', octave: 4 })
    expect(events[0].duration).toBe('quarter')
    expect(events[1].pitches[0].step).toBe('rest')
    expect(events[1].duration).toBe('dotted-half')
    expect(result.statusMessage).toBeUndefined()
    expect(result.newSelection).toEqual({ staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0, pitchIdx: 0 })
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('absorbs a 3/4 whole-bar rest correctly (dotted-half) when an eighth is inserted', () => {
    const blank3_4: Score = buildScore({
      meter: '3/4',
      // 3/4 capacity = 12 thirty-seconds. A dotted-half rest fills it.
      measures: [{ events: [
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'dotted-half' },
      ] }],
    })
    const result = smartInsertNote(blank3_4, undefined, {
      pitches: [{ step: 'G', octave: 4 }],
      duration: 'eighth',
    })
    expect(result.score.measures).toHaveLength(1)
    const events = result.score.measures[0].events
    // 24 absorbed − 4 (eighth) = 20 leftover. decompose32nds(20) = half + eighth.
    expect(events[0].pitches[0]).toEqual({ step: 'G', octave: 4 })
    expect(events[0].duration).toBe('eighth')
    expect(events.slice(1).every((e) => e.pitches[0].step === 'rest')).toBe(true)
    const leftoverUnits = events.slice(1).reduce((sum, e) => {
      const u = { whole:32,'dotted-half':24,half:16,'dotted-quarter':12,quarter:8,'dotted-eighth':6,eighth:4,sixteenth:2,'32nd':1 }[e.duration]
      return sum + u
    }, 0)
    expect(leftoverUnits).toBe(20)
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('absorbs only the trailing rest when clicking at the end of a partial bar', () => {
    // [quarter-C, half-rest, quarter-rest] in 4/4. Click targets the
    // trailing quarter-rest (eventIdx 2). Only that rest absorbs.
    const partial: Score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter' },
      ] }],
    })
    const result = smartInsertNote(partial, { measureIdx: 0, eventIdx: 2 }, {
      pitches: [{ step: 'G', octave: 4 }],
      duration: 'quarter',
    })
    expect(result.score.measures).toHaveLength(1)
    const events = result.score.measures[0].events
    expect(events).toHaveLength(3)
    expect(events[0].duration).toBe('quarter')
    expect(events[0].pitches[0].step).toBe('C')
    expect(events[1].pitches[0].step).toBe('rest')
    expect(events[1].duration).toBe('half')
    expect(events[2].pitches[0]).toEqual({ step: 'G', octave: 4 })
    expect(events[2].duration).toBe('quarter')
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('spills into a new bar when the measure has notes only, no rests to absorb (regression)', () => {
    const full: Score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ] }],
    })
    const result = smartInsertNote(full, undefined, {
      pitches: [{ step: 'G', octave: 4 }],
      duration: 'quarter',
    })
    // Original bar untouched; new bar created with the quarter + padding.
    expect(result.score.measures).toHaveLength(2)
    expect(result.score.measures[0].events).toHaveLength(1)
    expect(result.score.measures[0].events[0].duration).toBe('whole')
    expect(result.score.measures[1].events[0].duration).toBe('quarter')
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('refuses to absorb a tuplet rest — falls through to spillover', () => {
    // A 4/4 bar built as a quarter-rest plus a triplet-of-quarters
    // (worth a half-note's time). Clicking at the trailing tuplet rest
    // must NOT split the tuplet — spillover instead.
    const tupletBar: Score = buildScore({
      meter: '4/4',
      measures: [{ events: [
        // Two free quarters (16/32), then a triplet group of three
        // tied-into-tuplet rests totalling 16/32. The triplet's three
        // members each carry tuplet:3.
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter', tuplet: 3 },
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter', tuplet: 3 },
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter', tuplet: 3 },
      ] }],
    })
    const result = smartInsertNote(
      tupletBar,
      { measureIdx: 0, eventIdx: 4 },
      { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
    )
    // Tuplet must remain intact; insert spills into a new bar.
    expect(result.score.measures).toHaveLength(2)
    expect(result.score.measures[0].events).toHaveLength(5)
    expect(result.score.measures[0].events[2].tuplet).toBe(3)
    expect(result.score.measures[0].events[4].tuplet).toBe(3)
    expect(result.score.measures[1].events[0].pitches[0]).toEqual({ step: 'G', octave: 4 })
  })

  it('grand-staff: click on staff 0 absorbs only that staff’s rest; staff 1 stays intact', () => {
    const blankGrand: Score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' },
      ] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [
          { pitches: [{ step: 'rest', octave: 3 }], duration: 'whole' },
        ] }],
      },
    })
    const result = smartInsertNote(
      blankGrand,
      undefined,
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      0,
    )
    // No spillover — exactly one measure on each staff.
    expect(result.score.measures).toHaveLength(1)
    expect(result.score.secondStaff?.measures).toHaveLength(1)
    // Treble: quarter-C absorbed the whole-rest → [Q, dotted-half-rest]
    // (decompose32nds(24) is greedy, so 24 units → single dotted-half).
    const treble = result.score.measures[0].events
    expect(treble).toHaveLength(2)
    expect(treble[0].pitches[0]).toEqual({ step: 'C', octave: 4 })
    expect(treble[1].duration).toBe('dotted-half')
    // Bass: untouched.
    const bass = result.score.secondStaff!.measures[0].events
    expect(bass).toHaveLength(1)
    expect(bass[0].pitches[0].step).toBe('rest')
    expect(bass[0].duration).toBe('whole')
    expect(() => validateScore(result.score)).not.toThrow()
  })

  it('refuses to absorb past a tied note anchor — spillover instead', () => {
    // A half-C that ties forward into a half-rest. Clicking with target
    // at the tied half-C must NOT splice between the tie pair; spill
    // into a new bar instead. (The tie would be musically meaningless
    // on a rest, but the schema permits the flag — guard defensively.)
    const tiedAnchor: Score = buildScore({
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'half', tied_to_next: true },
        { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
      ] }],
    })
    const result = smartInsertNote(
      tiedAnchor,
      { measureIdx: 0, eventIdx: 0 },
      { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
    )
    // Spilled into a new bar; original tie intact.
    expect(result.score.measures).toHaveLength(2)
    expect(result.score.measures[0].events).toHaveLength(2)
    expect(result.score.measures[0].events[0].tied_to_next).toBe(true)
    expect(result.score.measures[1].events[0].pitches[0]).toEqual({ step: 'G', octave: 4 })
  })
})
