import { describe, it, expect } from 'vitest'
import { buildEventTimeIndex } from '@/lib/music/buildEventTimeIndex'
import { scoreToAbcWithMap } from '@/lib/music/scoreToAbcWithMap'
import type { Score } from '@/lib/music/types'

const SCORE: Score = {
  key: 'C',
  meter: '4/4',
  measures: [{ events: [
    { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
  ] }],
}

describe('buildEventTimeIndex', () => {
  it('returns an empty map when visualObj is missing the audio APIs', () => {
    const { map } = scoreToAbcWithMap(SCORE)
    const stubVisualObj = { /* no setupEvents */ }
    const idx = buildEventTimeIndex(stubVisualObj, map)
    expect(idx.msByPosition.size).toBe(0)
    expect(idx.totalMs).toBe(0)
  })

  it('builds a key per resolved event for a synthetic visualObj', () => {
    const { map } = scoreToAbcWithMap(SCORE)
    // Synthesize timing events that match each event's startChar.
    const stubVisualObj = {
      getBpm: () => 100,
      setupEvents: () =>
        map.events.map((r, i) => ({
          milliseconds: i * 500,
          startCharArray: [r.startChar],
        })),
    }
    const idx = buildEventTimeIndex(stubVisualObj, map)
    expect(idx.msByPosition.size).toBe(4)
    expect(idx.msByPosition.get('0:0:0:0')).toBe(0)
    expect(idx.msByPosition.get('0:0:0:1')).toBe(500)
    expect(idx.msByPosition.get('0:0:0:2')).toBe(1000)
    expect(idx.msByPosition.get('0:0:0:3')).toBe(1500)
    expect(idx.totalMs).toBe(1500)
  })

  it('uses the earliest ms when multiple timing events share a position (chord notes)', () => {
    const { map } = scoreToAbcWithMap(SCORE)
    const firstChar = map.events[0].startChar
    const stubVisualObj = {
      getBpm: () => 100,
      setupEvents: () => [
        { milliseconds: 100, startCharArray: [firstChar] },
        { milliseconds: 200, startCharArray: [firstChar] }, // duplicate position
      ],
    }
    const idx = buildEventTimeIndex(stubVisualObj, map)
    expect(idx.msByPosition.get('0:0:0:0')).toBe(100)
    expect(idx.totalMs).toBe(200)
  })
})
