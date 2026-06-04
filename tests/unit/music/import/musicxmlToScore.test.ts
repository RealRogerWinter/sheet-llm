import { describe, it, expect } from 'vitest'
import { musicxmlToScore } from '@/lib/music/import/musicxmlToScore'
import { detectFormat } from '@/lib/music/import/detect'
import { scoreToMusicXml } from '@/lib/music/export/musicxml'
import { validateScore } from '@/lib/music/validateScore'
import type { Score } from '@/lib/music/types'

/** Strip block warnings for assertions; the import contract treats any
 *  block warning as a failed parse. */
function blockWarnings(r: ReturnType<typeof musicxmlToScore>) {
  return r.warnings.filter((w) => w.severity === 'block')
}

describe('musicxmlToScore — round-trip with scoreToMusicXml', () => {
  it('round-trips a single-staff score (accidentals, rests, ties, chord)', () => {
    const original: Score = {
      title: 'Round Trip',
      composer: 'Test Composer',
      key: 'G',
      meter: '4/4',
      tempo_bpm: 96,
      measures: [
        {
          events: [
            // F# (sharp accidental), tied to the next F#.
            { pitches: [{ step: 'F', octave: 5, accidental: 'sharp', tied_to_next: true }], duration: 'quarter' },
            { pitches: [{ step: 'F', octave: 5, accidental: 'sharp' }], duration: 'quarter' },
            // A rest.
            { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter' },
            // A C-E-G chord.
            {
              pitches: [
                { step: 'C', octave: 5 },
                { step: 'E', octave: 5 },
                { step: 'G', octave: 5 },
              ],
              duration: 'quarter',
            },
          ],
        },
        {
          events: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'whole' }],
        },
      ],
    }

    const xml = scoreToMusicXml(original)
    const r = musicxmlToScore(xml)
    expect(blockWarnings(r)).toEqual([])
    const s = r.score

    expect(r.format).toBe('musicxml')
    expect(s.key).toBe('G')
    expect(s.meter).toBe('4/4')
    expect(s.tempo_bpm).toBe(96)
    expect(s.title).toBe('Round Trip')
    expect(s.composer).toBe('Test Composer')
    expect(s.measures).toHaveLength(2)

    // Measure 1, event 0: F# tied forward.
    const m1 = s.measures[0]
    expect(m1.events[0].pitches[0].step).toBe('F')
    expect(m1.events[0].pitches[0].octave).toBe(5)
    expect(m1.events[0].pitches[0].accidental).toBe('sharp')
    expect(m1.events[0].pitches[0].tied_to_next).toBe(true)

    // event 2: a rest.
    expect(m1.events[2].pitches[0].step).toBe('rest')

    // event 3: a 3-note chord.
    expect(m1.events[3].pitches.map((p) => p.step)).toEqual(['C', 'E', 'G'])

    // Validator runs as part of the import contract.
    validateScore(s)
  })

  it('round-trips a grand-staff score (two staves, bass clef on staff 2)', () => {
    const original: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] }],
      secondStaff: {
        clef: 'bass',
        measures: [{ events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] }],
      },
    }
    const xml = scoreToMusicXml(original)
    const r = musicxmlToScore(xml)
    expect(blockWarnings(r)).toEqual([])
    const s = r.score
    expect(s.measures).toHaveLength(1)
    expect(s.secondStaff).toBeDefined()
    expect(s.secondStaff?.clef).toBe('bass')
    expect(s.secondStaff?.measures[0].events[0].pitches[0].step).toBe('C')
    expect(s.secondStaff?.measures[0].events[0].pitches[0].octave).toBe(3)
    validateScore(s)
  })

  it('round-trips a dotted-rhythm + triplet measure', () => {
    const original: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 5 }], duration: 'dotted-quarter' },
            { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' },
            // Triplet of eighths fills the remaining half note.
            { pitches: [{ step: 'E', octave: 5 }], duration: 'quarter', tuplet: 3 },
            { pitches: [{ step: 'F', octave: 5 }], duration: 'quarter', tuplet: 3 },
            { pitches: [{ step: 'G', octave: 5 }], duration: 'quarter', tuplet: 3 },
          ],
        },
      ],
    }
    const xml = scoreToMusicXml(original)
    const r = musicxmlToScore(xml)
    expect(blockWarnings(r)).toEqual([])
    const s = r.score
    expect(s.measures[0].events[0].duration).toBe('dotted-quarter')
    expect(s.measures[0].events[1].duration).toBe('eighth')
    // Triplet flag survives on each tuplet member.
    expect(s.measures[0].events[2].tuplet).toBe(3)
    expect(s.measures[0].events[3].tuplet).toBe(3)
    expect(s.measures[0].events[4].tuplet).toBe(3)
    validateScore(s)
  })

  it('round-trips a minor key + cut time', () => {
    const original: Score = {
      key: 'Am',
      meter: 'C|',
      // C| (cut time) sums to 4 eighths (one half note) per our meter model.
      measures: [{ events: [{ pitches: [{ step: 'A', octave: 4 }], duration: 'half' }] }],
    }
    const xml = scoreToMusicXml(original)
    const r = musicxmlToScore(xml)
    expect(blockWarnings(r)).toEqual([])
    expect(r.score.key).toBe('Am')
    expect(r.score.meter).toBe('C|')
    validateScore(r.score)
  })
})

describe('musicxmlToScore — malformed input', () => {
  it('returns a blocking warning (not a throw) for malformed XML', () => {
    const r = musicxmlToScore('<score-partwise><part><measure>')
    expect(blockWarnings(r).length).toBeGreaterThan(0)
    expect(r.format).toBe('musicxml')
  })

  it('returns a blocking warning for non-MusicXML XML', () => {
    const r = musicxmlToScore('<html><body>not music</body></html>')
    expect(blockWarnings(r).length).toBeGreaterThan(0)
  })

  it('returns a blocking warning for an empty string', () => {
    const r = musicxmlToScore('')
    expect(blockWarnings(r).length).toBeGreaterThan(0)
  })
})

describe('detectFormat — MusicXML', () => {
  it('detects musicxml by .musicxml / .xml extension', () => {
    expect(detectFormat({ filename: 'song.musicxml' })).toBe('musicxml')
    expect(detectFormat({ filename: 'song.xml' })).toBe('musicxml')
  })

  it('keeps compressed .mxl unsupported', () => {
    expect(detectFormat({ filename: 'song.mxl' })).toBe('xml-unsupported')
  })

  it('detects musicxml by score-partwise content sniff', () => {
    const xml =
      '<?xml version="1.0"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "x">\n<score-partwise version="4.0"></score-partwise>'
    expect(detectFormat({ text: xml })).toBe('musicxml')
  })

  it('keeps generic / non-MusicXML XML unsupported', () => {
    expect(detectFormat({ text: '<html><body>x</body></html>' })).toBe('xml-unsupported')
  })

  it('keeps PK/zip (compressed) magic unsupported', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    expect(detectFormat({ bytes })).toBe('xml-unsupported')
  })
})
