import { describe, it, expect } from 'vitest'
import { pitchToFrequency } from '@/lib/abc/pitchAudioPing'

describe('pitchToFrequency', () => {
  it('A4 = 440 Hz', () => {
    expect(pitchToFrequency('A', 4)).toBeCloseTo(440, 2)
  })

  it('C4 ≈ 261.6 Hz (middle C)', () => {
    expect(pitchToFrequency('C', 4)).toBeCloseTo(261.6256, 2)
  })

  it('A5 = 880 Hz (octave above)', () => {
    expect(pitchToFrequency('A', 5)).toBeCloseTo(880, 2)
  })

  it('A3 = 220 Hz (octave below)', () => {
    expect(pitchToFrequency('A', 3)).toBeCloseTo(220, 2)
  })

  it('F#4 ≈ 369.99 Hz', () => {
    expect(pitchToFrequency('F', 4, 'sharp')).toBeCloseTo(369.99, 2)
  })

  it('Bb3 ≈ 233.08 Hz', () => {
    expect(pitchToFrequency('B', 3, 'flat')).toBeCloseTo(233.08, 2)
  })

  it('rest returns 0', () => {
    expect(pitchToFrequency('rest', 4)).toBe(0)
  })
})
