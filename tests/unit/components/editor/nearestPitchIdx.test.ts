import { describe, it, expect } from 'vitest'
import { nearestPitchIdx } from '@/components/editor/useNoteClickHandler'
import type { Pitch } from '@/lib/music/types'

const C4: Pitch = { step: 'C', octave: 4 }
const E4: Pitch = { step: 'E', octave: 4 }
const G4: Pitch = { step: 'G', octave: 4 }
const C5: Pitch = { step: 'C', octave: 5 }

describe('nearestPitchIdx', () => {
  it('returns 0 for the bottom pitch of a triad', () => {
    expect(nearestPitchIdx([C4, E4, G4], { step: 'C', octave: 4 })).toBe(0)
  })
  it('returns the middle index for the middle pitch', () => {
    expect(nearestPitchIdx([C4, E4, G4], { step: 'E', octave: 4 })).toBe(1)
  })
  it('returns the top index for the top pitch', () => {
    expect(nearestPitchIdx([C4, E4, G4], { step: 'G', octave: 4 })).toBe(2)
  })
  it('rounds to the nearest pitch when click lands between them', () => {
    // D4 is between C4 and E4. Distance to C=2 semitones, to E=2 → ties go to first.
    expect(nearestPitchIdx([C4, E4, G4], { step: 'D', octave: 4 })).toBe(0)
    // F4 is between E4 and G4. Distance to E=1, to G=2 → E wins.
    expect(nearestPitchIdx([C4, E4, G4], { step: 'F', octave: 4 })).toBe(1)
  })
  it('handles octave-wide chords by distance', () => {
    // [C4, E4, G4, C5]; click B4 (midi 71). C4=60, E4=64, G4=67, C5=72.
    // distances: 11, 7, 4, 1 → C5 (idx 3).
    expect(nearestPitchIdx([C4, E4, G4, C5], { step: 'B', octave: 4 })).toBe(3)
  })
  it('skips rests and still picks the nearest pitch', () => {
    const rest: Pitch = { step: 'rest', octave: 4 }
    expect(nearestPitchIdx([rest, E4, G4], { step: 'G', octave: 4 })).toBe(2)
  })
})
