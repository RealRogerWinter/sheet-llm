import { describe, it, expect } from 'vitest'
import { transformScore, EditError } from '@/lib/music/editOperations'
import { validateScore } from '@/lib/music/validateScore'
import {
  getVoiceCount,
  voiceHasContent,
} from '@/lib/music/scoreAccessors'
import type { Score } from '@/lib/music/types'

function singleStaff(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
    ],
  }
}

function grandStaff(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    ],
    secondStaff: {
      clef: 'bass',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
      ],
    },
  }
}

describe('addVoice op', () => {
  it('appends an empty voice to a single-staff score (bar-aligned)', () => {
    const before = singleStaff()
    const after = transformScore(before, { kind: 'addVoice', staffIdx: 0 })
    expect(getVoiceCount(after, 0)).toBe(2)
    expect(after.extraVoices?.[0].measures).toHaveLength(2)
    expect(() => validateScore(after)).not.toThrow()
  })

  it('appends a bar-aligned voice in a non-4/4 meter', () => {
    const before: Score = {
      key: 'C',
      meter: '6/8',
      measures: [
        { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'dotted-half' }] },
      ],
    }
    const after = transformScore(before, { kind: 'addVoice', staffIdx: 0 })
    expect(() => validateScore(after)).not.toThrow()
  })

  it('appends to staff 1 (secondStaff) independently of staff 0', () => {
    const after = transformScore(grandStaff(), { kind: 'addVoice', staffIdx: 1 })
    expect(getVoiceCount(after, 0)).toBe(1)
    expect(getVoiceCount(after, 1)).toBe(2)
    expect(() => validateScore(after)).not.toThrow()
  })

  it('caps at 4 voices per staff (3 extras)', () => {
    let s = singleStaff()
    s = transformScore(s, { kind: 'addVoice', staffIdx: 0 })
    s = transformScore(s, { kind: 'addVoice', staffIdx: 0 })
    s = transformScore(s, { kind: 'addVoice', staffIdx: 0 })
    expect(getVoiceCount(s, 0)).toBe(4)
    expect(() => transformScore(s, { kind: 'addVoice', staffIdx: 0 })).toThrow(EditError)
  })

  it('rejects addVoice on a non-existent staff', () => {
    expect(() => transformScore(singleStaff(), { kind: 'addVoice', staffIdx: 1 })).toThrow(EditError)
  })
})

describe('removeVoice op', () => {
  it('removes an extra voice from staff 0', () => {
    const seeded = transformScore(singleStaff(), { kind: 'addVoice', staffIdx: 0 })
    expect(getVoiceCount(seeded, 0)).toBe(2)
    const after = transformScore(seeded, { kind: 'removeVoice', staffIdx: 0, voiceIdx: 1 })
    expect(getVoiceCount(after, 0)).toBe(1)
    expect(after.extraVoices).toBeUndefined()
    expect(() => validateScore(after)).not.toThrow()
  })

  it('removes a specific extra voice and preserves the others', () => {
    let s = singleStaff()
    s = transformScore(s, { kind: 'addVoice', staffIdx: 0 })
    s = transformScore(s, { kind: 'addVoice', staffIdx: 0 })
    s = transformScore(s, { kind: 'addVoice', staffIdx: 0 })
    expect(getVoiceCount(s, 0)).toBe(4)
    const after = transformScore(s, { kind: 'removeVoice', staffIdx: 0, voiceIdx: 2 })
    expect(getVoiceCount(after, 0)).toBe(3)
    expect(after.extraVoices).toHaveLength(2)
    expect(() => validateScore(after)).not.toThrow()
  })

  it('removes from staff 1 without touching staff 0', () => {
    const seeded = transformScore(grandStaff(), { kind: 'addVoice', staffIdx: 1 })
    const after = transformScore(seeded, { kind: 'removeVoice', staffIdx: 1, voiceIdx: 1 })
    expect(getVoiceCount(after, 0)).toBe(1)
    expect(getVoiceCount(after, 1)).toBe(1)
    expect(after.secondStaff?.extraVoices).toBeUndefined()
  })

  it('rejects voiceIdx 0 (must remove the staff instead)', () => {
    const seeded = transformScore(singleStaff(), { kind: 'addVoice', staffIdx: 0 })
    expect(() =>
      transformScore(seeded, { kind: 'removeVoice', staffIdx: 0, voiceIdx: 0 }),
    ).toThrow(EditError)
  })

  it('rejects voiceIdx out of range', () => {
    expect(() =>
      transformScore(singleStaff(), { kind: 'removeVoice', staffIdx: 0, voiceIdx: 1 }),
    ).toThrow(EditError)
  })

  it('rejects removeVoice on a non-existent staff', () => {
    expect(() =>
      transformScore(singleStaff(), { kind: 'removeVoice', staffIdx: 1, voiceIdx: 1 }),
    ).toThrow(EditError)
  })
})

describe('voiceHasContent', () => {
  it('returns false for an all-rest voice', () => {
    const seeded = transformScore(singleStaff(), { kind: 'addVoice', staffIdx: 0 })
    expect(voiceHasContent(seeded, 0, 1)).toBe(false)
  })

  it('returns true for the primary voice with notes', () => {
    expect(voiceHasContent(singleStaff(), 0, 0)).toBe(true)
  })

  it('returns false for a non-existent voice', () => {
    expect(voiceHasContent(singleStaff(), 0, 1)).toBe(false)
  })

  it('returns true for an extra voice that has non-rest pitches', () => {
    const seeded = transformScore(singleStaff(), { kind: 'addVoice', staffIdx: 0 })
    // Replace voice 1's first measure events with a real note.
    const populated: Score = {
      ...seeded,
      extraVoices: [
        { measures: [
          { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
        ] },
      ],
    }
    expect(voiceHasContent(populated, 0, 1)).toBe(true)
  })
})
