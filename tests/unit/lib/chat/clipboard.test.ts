import { describe, it, expect } from 'vitest'
import {
  copyEventSelection,
  copyEventRun,
  copyMeasureRange,
  clipboardEntryToJSON,
  clipboardEntryFromJSON,
  removeEventRun,
} from '@/lib/chat/clipboard'
import { DURATION_32NDS } from '@/lib/music/measureBalance'
import type { Score } from '@/lib/music/types'

const note = (step: string, octave: number) => ({ pitches: [{ step, octave }], duration: 'quarter' })
const chord = () => ({
  pitches: [
    { step: 'C', octave: 4 },
    { step: 'E', octave: 4 },
    { step: 'G', octave: 4 },
  ],
  duration: 'half',
})

function buildScore(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [note('C', 4), chord(), note('D', 4)] },
      { events: [note('E', 4)] },
      { events: [note('F', 4)] },
    ],
  } as unknown as Score
}

describe('clipboard copy serializers (M28-PR-1)', () => {
  it('copies a single event as a kind:events entry with totalUnits', () => {
    const entry = copyEventSelection(buildScore(), { measureIdx: 0, eventIdx: 0 })
    expect(entry?.kind).toBe('events')
    if (entry?.kind !== 'events') throw new Error('expected events')
    expect(entry.events).toHaveLength(1)
    expect(entry.events[0].pitches).toEqual([{ step: 'C', octave: 4 }])
    expect(entry.sourceMeta.totalUnits).toBe(8) // quarter
    expect(entry.sourceMeta.meter).toBe('4/4')
  })

  it('copies a chord-note (pitchIdx) as a single-pitch event', () => {
    const entry = copyEventSelection(buildScore(), { measureIdx: 0, eventIdx: 1, pitchIdx: 1 })
    if (entry?.kind !== 'events') throw new Error('expected events')
    expect(entry.events[0].pitches).toEqual([{ step: 'E', octave: 4 }])
  })

  it('copies the whole chord when no pitchIdx is given', () => {
    const entry = copyEventSelection(buildScore(), { measureIdx: 0, eventIdx: 1 })
    if (entry?.kind !== 'events') throw new Error('expected events')
    expect(entry.events[0].pitches).toHaveLength(3)
    expect(entry.sourceMeta.totalUnits).toBe(16) // half
  })

  it('returns null for an unresolvable selection', () => {
    expect(copyEventSelection(buildScore(), { measureIdx: 9, eventIdx: 0 })).toBeNull()
  })

  it('deep-clones events so later score edits do not mutate the entry', () => {
    const score = buildScore()
    const entry = copyEventSelection(score, { measureIdx: 0, eventIdx: 0 })
    if (entry?.kind !== 'events') throw new Error('expected events')
    score.measures[0].events[0].pitches[0].step = 'G'
    expect(entry.events[0].pitches[0].step).toBe('C')
  })

  it('copies a measure range with per-bar hashes + arity meta', () => {
    const entry = copyMeasureRange(buildScore(), { fromStart: 0, fromEnd: 1 })
    expect(entry.kind).toBe('measures')
    if (entry.kind !== 'measures') throw new Error('expected measures')
    expect(entry.captured.primaryMeasures).toHaveLength(2)
    expect(entry.sourceMeta.measureHashes).toHaveLength(2)
    expect(entry.sourceMeta.staffCount).toBe(1)
    expect(entry.sourceMeta.voiceCount).toBe(1)
    // capture invariant preserved through the clone
    expect(entry.captured.primaryMeasures).toBe(entry.captured.perVoiceContent[0].voices[0])
  })

  it('measure-range copy is isolated from later score edits', () => {
    const score = buildScore()
    const entry = copyMeasureRange(score, { fromStart: 0, fromEnd: 0 })
    if (entry.kind !== 'measures') throw new Error('expected measures')
    score.measures[0].events[0].pitches[0].step = 'G'
    expect(entry.captured.primaryMeasures[0].events[0].pitches[0].step).toBe('C')
  })

  it('clipboardEntryToJSON emits a tagged, parseable payload', () => {
    const entry = copyEventSelection(buildScore(), { measureIdx: 0, eventIdx: 0 })
    if (!entry) throw new Error('expected entry')
    const parsed = JSON.parse(clipboardEntryToJSON(entry))
    expect(parsed._sheetLlmClipboard).toBe(1)
    expect(parsed.entry.kind).toBe('events')
  })

  it('clipboardEntryFromJSON round-trips a toJSON payload (D3)', () => {
    const entry = copyMeasureRange(buildScore(), { fromStart: 0, fromEnd: 1 })
    const back = clipboardEntryFromJSON(clipboardEntryToJSON(entry))
    expect(back?.kind).toBe('measures')
  })

  it('clipboardEntryFromJSON rejects non-tagged / malformed / wrong-kind text (D3)', () => {
    expect(clipboardEntryFromJSON('')).toBeNull()
    expect(clipboardEntryFromJSON('not json {')).toBeNull()
    expect(clipboardEntryFromJSON(JSON.stringify({ entry: { kind: 'events' } }))).toBeNull() // no marker
    expect(clipboardEntryFromJSON(JSON.stringify({ _sheetLlmClipboard: 1 }))).toBeNull() // no entry
    expect(
      clipboardEntryFromJSON(JSON.stringify({ _sheetLlmClipboard: 1, entry: { kind: 'bogus' } })),
    ).toBeNull() // unknown kind
  })
})

const q = (step: string, extra: Record<string, unknown> = {}) => ({
  pitches: [{ step, octave: 4 }],
  duration: 'quarter',
  ...extra,
})
// Four quarters = a full 4/4 bar (4 × 8 = 32).
const runScore = (events = [q('C'), q('D'), q('E'), q('F')]): Score =>
  ({ key: 'C', meter: '4/4', measures: [{ events }] }) as unknown as Score
const run = (startEventIdx: number, endEventIdx: number) => ({
  staffIdx: 0,
  voiceIdx: 0,
  measureIdx: 0,
  startEventIdx,
  endEventIdx,
})
const totalUnits = (events: { duration: string }[]) =>
  events.reduce((s, e) => s + (DURATION_32NDS[e.duration as keyof typeof DURATION_32NDS] ?? 0), 0)

describe('copyEventRun (D2)', () => {
  it('serializes the inclusive run as a kind:events entry', () => {
    const entry = copyEventRun(runScore(), run(1, 2))
    if (entry?.kind !== 'events') throw new Error('expected events')
    expect(entry.events.map((e) => e.pitches[0].step)).toEqual(['D', 'E'])
    expect(entry.sourceMeta.totalUnits).toBe(16) // two quarters
  })

  it('normalizes reversed endpoints (end < start)', () => {
    const entry = copyEventRun(runScore(), run(2, 1))
    if (entry?.kind !== 'events') throw new Error('expected events')
    expect(entry.events.map((e) => e.pitches[0].step)).toEqual(['D', 'E'])
  })

  it('strips the run’s trailing event-level tie (it dangled past the run)', () => {
    const entry = copyEventRun(runScore([q('C'), q('D'), q('E', { tied_to_next: true }), q('F')]), run(1, 2))
    if (entry?.kind !== 'events') throw new Error('expected events')
    expect(entry.events[entry.events.length - 1].tied_to_next).toBeUndefined()
  })

  it('strips a trailing pitch-level tie on the last run event', () => {
    const tiedE = { pitches: [{ step: 'E', octave: 4, tied_to_next: true }], duration: 'quarter' }
    const entry = copyEventRun(runScore([q('C'), q('D'), tiedE, q('F')]), run(1, 2))
    if (entry?.kind !== 'events') throw new Error('expected events')
    expect(entry.events[1].pitches[0].tied_to_next).toBeUndefined()
  })

  it('preserves an INTERNAL tie (not at the run boundary)', () => {
    const entry = copyEventRun(runScore([q('C'), q('D', { tied_to_next: true }), q('E'), q('F')]), run(1, 2))
    if (entry?.kind !== 'events') throw new Error('expected events')
    expect(entry.events[0].tied_to_next).toBe(true) // D→E tie is inside the run
  })

  it('deep-clones so later score edits do not mutate the entry', () => {
    const score = runScore()
    const entry = copyEventRun(score, run(1, 2))
    if (entry?.kind !== 'events') throw new Error('expected events')
    score.measures[0].events[1].pitches[0].step = 'G'
    expect(entry.events[0].pitches[0].step).toBe('D')
  })

  it('returns null for a missing measure', () => {
    expect(copyEventRun(runScore(), { ...run(0, 1), measureIdx: 9 })).toBeNull()
  })
})

describe('removeEventRun (D2)', () => {
  it('replaces the run with rests, keeping the bar meter-valid and neighbors intact', () => {
    const next = removeEventRun(runScore(), run(1, 2))
    const events = next.measures[0].events
    expect(totalUnits(events)).toBe(32) // still a full 4/4 bar
    expect(events[0].pitches[0].step).toBe('C') // head untouched
    expect(events[events.length - 1].pitches[0].step).toBe('F') // tail untouched
    // The middle is now rest(s) summing to the removed 16 units.
    const middle = events.slice(1, events.length - 1)
    expect(middle.every((e) => e.pitches[0].step === 'rest')).toBe(true)
    expect(totalUnits(middle)).toBe(16)
  })

  it('strips a dangling tie on the event BEFORE the run', () => {
    const next = removeEventRun(runScore([q('C', { tied_to_next: true }), q('D'), q('E'), q('F')]), run(1, 2))
    expect(next.measures[0].events[0].tied_to_next).toBeUndefined()
  })

  it('returns the score unchanged for a missing measure', () => {
    const score = runScore()
    expect(removeEventRun(score, { ...run(0, 1), measureIdx: 9 })).toBe(score)
  })
})
