import { describe, it, expect } from 'vitest'
import { pasteEvents } from '@/lib/music/pasteEvents'
import { DURATION_32NDS } from '@/lib/music/measureBalance'
import type { Event, Score } from '@/lib/music/types'

const rest = (duration: string): Event =>
  ({ pitches: [{ step: 'rest', octave: 4 }], duration } as unknown as Event)
const note = (step: string, duration: string, id?: string): Event =>
  ({ pitches: [{ step, octave: 4 }], duration, ...(id ? { id } : {}) } as unknown as Event)

const scoreWith = (events: Event[]): Score =>
  ({ key: 'C', meter: '4/4', measures: [{ events }] } as unknown as Score)
const totalUnits = (events: Event[]) => events.reduce((s, e) => s + DURATION_32NDS[e.duration], 0)
const frontTarget = { staffIdx: 0, voiceIdx: 0, measureIdx: 0, insertAfterIdx: -1 }

describe('pasteEvents (M28-PR-2)', () => {
  it('pastes a note into an empty bar, padding back to capacity', () => {
    const res = pasteEvents(scoreWith([rest('whole')]), frontTarget, [note('C', 'quarter')])
    expect(res.ok).toBe(true)
    const events = res.score.measures[0].events
    expect(events[0].pitches[0].step).toBe('C')
    expect(events[0].duration).toBe('quarter')
    expect(totalUnits(events)).toBe(32) // still a full 4/4 bar
  })

  it('pastes a multi-note run into an empty bar in order', () => {
    const res = pasteEvents(scoreWith([rest('whole')]), frontTarget, [note('C', 'quarter'), note('D', 'quarter')])
    expect(res.ok).toBe(true)
    const events = res.score.measures[0].events
    expect(events[0].pitches[0].step).toBe('C')
    expect(events[1].pitches[0].step).toBe('D')
    expect(totalUnits(events)).toBe(32)
  })

  it('absorbs the following rests when pasting after a note', () => {
    // [C quarter (8), rest dotted-half (24)] — paste a half AFTER the C.
    const score = scoreWith([note('C', 'quarter'), rest('dotted-half')])
    const res = pasteEvents(score, { ...frontTarget, insertAfterIdx: 0 }, [note('E', 'half')])
    expect(res.ok).toBe(true)
    const events = res.score.measures[0].events
    expect(events[0].pitches[0].step).toBe('C')
    expect(events[1].pitches[0].step).toBe('E')
    expect(totalUnits(events)).toBe(32)
  })

  it('spills into a new padded bar when the run does not fit the rest space', () => {
    const score = scoreWith([note('C', 'whole')]) // full bar, no following rests
    const res = pasteEvents(score, { ...frontTarget, insertAfterIdx: 0 }, [note('D', 'quarter')])
    expect(res.ok).toBe(true)
    expect(res.score.measures).toHaveLength(2) // a new bar was created
    expect(res.score.measures[0].events[0].pitches[0].step).toBe('C') // original bar untouched
    expect(res.score.measures[1].events[0].pitches[0].step).toBe('D')
    expect(totalUnits(res.score.measures[1].events)).toBe(32) // padded to capacity
  })

  it('spills a multi-bar run into multiple new meter-valid bars', () => {
    const score = scoreWith([note('C', 'whole')])
    const res = pasteEvents(score, { ...frontTarget, insertAfterIdx: 0 }, [note('D', 'whole'), note('E', 'whole')])
    expect(res.ok).toBe(true)
    expect(res.score.measures).toHaveLength(3)
    expect(res.score.measures[1].events[0].pitches[0].step).toBe('D')
    expect(res.score.measures[2].events[0].pitches[0].step).toBe('E')
  })

  it('tie-splits an over-long note across the spilled bars', () => {
    // paste a whole note (32) into a 2/4 bar (capacity 16) with no room
    const score = { key: 'C', meter: '2/4', measures: [{ events: [note('C', 'half')] }] } as unknown as Score
    const res = pasteEvents(score, { ...frontTarget, insertAfterIdx: 0 }, [note('D', 'whole')])
    expect(res.ok).toBe(true)
    // 32 units / 16 capacity → 2 bars, each a half note tied
    expect(res.score.measures).toHaveLength(3)
    expect(totalUnits(res.score.measures[1].events)).toBe(16)
    expect(totalUnits(res.score.measures[2].events)).toBe(16)
  })

  it('mints fresh ids (never reuses the clipboard event id)', () => {
    const res = pasteEvents(scoreWith([rest('whole')]), frontTarget, [note('C', 'quarter', 'origInputId')])
    expect(res.ok).toBe(true)
    const pasted = res.score.measures[0].events[0]
    expect(pasted.id).toBeDefined()
    expect(pasted.id).not.toBe('origInputId')
  })

  it('returns ok:false for an empty run or a missing measure', () => {
    expect(pasteEvents(scoreWith([rest('whole')]), frontTarget, []).ok).toBe(false)
    expect(
      pasteEvents(scoreWith([rest('whole')]), { ...frontTarget, measureIdx: 9 }, [note('C', 'quarter')]).ok,
    ).toBe(false)
  })
})
