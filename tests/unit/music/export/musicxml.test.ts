import { describe, it, expect, vi } from 'vitest'
import { downloadMusicXml, scoreToMusicXml } from '@/lib/music/export/musicxml'
import type { Score } from '@/lib/music/types'

function singleNoteScore(overrides: Partial<Score> = {}): Score {
  return {
    title: 'Test',
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
        ],
      },
    ],
    ...overrides,
  }
}

/**
 * Lightweight DOM-based XML parser check. Uses the jsdom-provided
 * DOMParser since these tests already run in the jsdom environment
 * (canvas-mocking aside). A failed parse surfaces as a <parsererror>
 * element; an XML declaration mismatch or unbalanced tag is the
 * primary failure mode this guards against.
 */
function parseXml(xml: string): Document {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xml, 'application/xml')
  const err = doc.querySelector('parsererror')
  if (err) {
    throw new Error(`MusicXML failed to parse: ${err.textContent ?? '<no detail>'}`)
  }
  return doc
}

describe('scoreToMusicXml — document scaffold', () => {
  it('emits a parseable XML document with score-partwise root', () => {
    const xml = scoreToMusicXml(singleNoteScore())
    const doc = parseXml(xml)
    expect(doc.documentElement.tagName).toBe('score-partwise')
    expect(doc.documentElement.getAttribute('version')).toBe('4.0')
  })

  it('starts with the XML declaration', () => {
    const xml = scoreToMusicXml(singleNoteScore())
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"')).toBe(true)
  })

  it('includes the MusicXML 4.0 partwise DOCTYPE', () => {
    const xml = scoreToMusicXml(singleNoteScore())
    expect(xml).toContain('PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"')
  })

  it('emits exactly one <part> with id P1 referencing one <score-part>', () => {
    const xml = scoreToMusicXml(singleNoteScore())
    const doc = parseXml(xml)
    const parts = doc.querySelectorAll('part-list > score-part')
    expect(parts.length).toBe(1)
    expect(parts[0].getAttribute('id')).toBe('P1')
    const parts2 = doc.querySelectorAll('part-partwise > part, score-partwise > part')
    expect(parts2.length).toBe(1)
    expect(parts2[0].getAttribute('id')).toBe('P1')
  })
})

describe('scoreToMusicXml — metadata', () => {
  it('emits <work-title> when title is set', () => {
    const xml = scoreToMusicXml(singleNoteScore({ title: 'My Piece' }))
    const doc = parseXml(xml)
    expect(doc.querySelector('work > work-title')?.textContent).toBe('My Piece')
  })

  it('escapes XML-special characters in title (no DOCTYPE injection)', () => {
    const xml = scoreToMusicXml(singleNoteScore({ title: 'A & B <hi>' }))
    const doc = parseXml(xml)
    expect(doc.querySelector('work > work-title')?.textContent).toBe('A & B <hi>')
  })

  it('emits composer / arranger / lyricist / copyright under <identification>', () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        composer: 'Bach',
        arranger: 'Liszt',
        lyricist: 'Schiller',
        copyright: '© 2026',
      }),
    )
    const doc = parseXml(xml)
    const creators = doc.querySelectorAll('identification > creator')
    expect(creators.length).toBe(3)
    expect(creators[0].getAttribute('type')).toBe('composer')
    expect(creators[0].textContent).toBe('Bach')
    expect(creators[1].getAttribute('type')).toBe('arranger')
    expect(creators[2].getAttribute('type')).toBe('lyricist')
    expect(doc.querySelector('identification > rights')?.textContent).toBe('© 2026')
  })

  it('omits <identification> when no metadata fields are set', () => {
    const xml = scoreToMusicXml(singleNoteScore())
    const doc = parseXml(xml)
    expect(doc.querySelector('identification')).toBeNull()
  })
})

describe('scoreToMusicXml — first-measure attributes', () => {
  it('emits divisions=8 (covers every Duration enum value as an integer)', () => {
    const xml = scoreToMusicXml(singleNoteScore())
    const doc = parseXml(xml)
    expect(doc.querySelector('measure attributes > divisions')?.textContent).toBe('8')
  })

  it('maps C major → fifths=0, mode=major', () => {
    const xml = scoreToMusicXml(singleNoteScore({ key: 'C' }))
    const doc = parseXml(xml)
    expect(doc.querySelector('key > fifths')?.textContent).toBe('0')
    expect(doc.querySelector('key > mode')?.textContent).toBe('major')
  })

  it('maps F# major → fifths=6, mode=major', () => {
    const xml = scoreToMusicXml(singleNoteScore({ key: 'F#' }))
    const doc = parseXml(xml)
    expect(doc.querySelector('key > fifths')?.textContent).toBe('6')
    expect(doc.querySelector('key > mode')?.textContent).toBe('major')
  })

  it('maps Bbm (Bb minor) → fifths=-5, mode=minor', () => {
    const xml = scoreToMusicXml(singleNoteScore({ key: 'Bbm' }))
    const doc = parseXml(xml)
    expect(doc.querySelector('key > fifths')?.textContent).toBe('-5')
    expect(doc.querySelector('key > mode')?.textContent).toBe('minor')
  })

  it("emits 4/4 as plain <time> with beats=4, beat-type=4", () => {
    const xml = scoreToMusicXml(singleNoteScore({ meter: '4/4' }))
    const doc = parseXml(xml)
    const time = doc.querySelector('time')!
    expect(time.getAttribute('symbol')).toBeNull()
    expect(time.querySelector('beats')?.textContent).toBe('4')
    expect(time.querySelector('beat-type')?.textContent).toBe('4')
  })

  it("emits 'C' meter with symbol=common, beats=4, beat-type=4", () => {
    const xml = scoreToMusicXml(singleNoteScore({ meter: 'C' }))
    const doc = parseXml(xml)
    const time = doc.querySelector('time')!
    expect(time.getAttribute('symbol')).toBe('common')
    expect(time.querySelector('beats')?.textContent).toBe('4')
  })

  it("emits 'C|' (cut time) with symbol=cut, beats=2, beat-type=2", () => {
    const xml = scoreToMusicXml(singleNoteScore({ meter: 'C|' }))
    const doc = parseXml(xml)
    const time = doc.querySelector('time')!
    expect(time.getAttribute('symbol')).toBe('cut')
    expect(time.querySelector('beats')?.textContent).toBe('2')
    expect(time.querySelector('beat-type')?.textContent).toBe('2')
  })

  it("emits 7/8 (odd meter) with the literal beats/beat-type", () => {
    const xml = scoreToMusicXml(singleNoteScore({ meter: '7/8' }))
    const doc = parseXml(xml)
    expect(doc.querySelector('time > beats')?.textContent).toBe('7')
    expect(doc.querySelector('time > beat-type')?.textContent).toBe('8')
  })

  it("defaults to treble clef (G/2) when score.clef is undefined", () => {
    const xml = scoreToMusicXml(singleNoteScore({ clef: undefined }))
    const doc = parseXml(xml)
    expect(doc.querySelector('clef > sign')?.textContent).toBe('G')
    expect(doc.querySelector('clef > line')?.textContent).toBe('2')
  })

  it("emits bass clef (F/4) when score.clef is 'bass'", () => {
    const xml = scoreToMusicXml(singleNoteScore({ clef: 'bass' }))
    const doc = parseXml(xml)
    expect(doc.querySelector('clef > sign')?.textContent).toBe('F')
    expect(doc.querySelector('clef > line')?.textContent).toBe('4')
  })

  it('emits attributes ONLY on the first measure (not measure 2+)', () => {
    const xml = scoreToMusicXml({
      ...singleNoteScore(),
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    expect(measures[0].querySelector('attributes')).not.toBeNull()
    expect(measures[1].querySelector('attributes')).toBeNull()
  })
})

describe('scoreToMusicXml — notes', () => {
  it('emits a C4 whole note with step/octave/duration', () => {
    const xml = scoreToMusicXml(singleNoteScore())
    const doc = parseXml(xml)
    const note = doc.querySelector('measure > note')!
    expect(note.querySelector('pitch > step')?.textContent).toBe('C')
    expect(note.querySelector('pitch > octave')?.textContent).toBe('4')
    expect(note.querySelector('duration')?.textContent).toBe('32') // whole = 32 divisions
    expect(note.querySelector('type')?.textContent).toBe('whole')
    expect(note.querySelector('dot')).toBeNull()
  })

  it('omits <alter> for natural pitches (no accidental → no alter element)', () => {
    const xml = scoreToMusicXml(singleNoteScore())
    const doc = parseXml(xml)
    expect(doc.querySelector('pitch > alter')).toBeNull()
  })

  it("emits <alter>1</alter> for a sharp pitch", () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        measures: [
          { events: [{ pitches: [{ step: 'F', octave: 4, accidental: 'sharp' }], duration: 'quarter' }] },
        ],
      }),
    )
    const doc = parseXml(xml)
    expect(doc.querySelector('pitch > alter')?.textContent).toBe('1')
    expect(doc.querySelector('accidental')?.textContent).toBe('sharp')
  })

  it("emits <alter>-2</alter> for a double-flat", () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        measures: [
          { events: [{ pitches: [{ step: 'B', octave: 4, accidental: 'dblflat' }], duration: 'quarter' }] },
        ],
      }),
    )
    const doc = parseXml(xml)
    expect(doc.querySelector('pitch > alter')?.textContent).toBe('-2')
    expect(doc.querySelector('accidental')?.textContent).toBe('flat-flat')
  })

  it('emits a <rest/> instead of <pitch> for a rest event', () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        measures: [
          { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
        ],
      }),
    )
    const doc = parseXml(xml)
    const note = doc.querySelector('note')!
    expect(note.querySelector('rest')).not.toBeNull()
    expect(note.querySelector('pitch')).toBeNull()
    expect(note.querySelector('duration')?.textContent).toBe('32')
  })

  it('emits a chord stack as multiple <note>s, with <chord/> on pitches after the first', () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        measures: [
          {
            events: [
              {
                pitches: [
                  { step: 'C', octave: 4 },
                  { step: 'E', octave: 4 },
                  { step: 'G', octave: 4 },
                ],
                duration: 'quarter',
              },
            ],
          },
        ],
      }),
    )
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    expect(notes.length).toBe(3)
    expect(notes[0].querySelector('chord')).toBeNull()
    expect(notes[1].querySelector('chord')).not.toBeNull()
    expect(notes[2].querySelector('chord')).not.toBeNull()
    expect(notes[0].querySelector('pitch > step')?.textContent).toBe('C')
    expect(notes[1].querySelector('pitch > step')?.textContent).toBe('E')
    expect(notes[2].querySelector('pitch > step')?.textContent).toBe('G')
  })

  it('emits <type>quarter</type> + <dot/> for dotted-quarter', () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'dotted-quarter' }] },
        ],
      }),
    )
    const doc = parseXml(xml)
    const note = doc.querySelector('note')!
    expect(note.querySelector('type')?.textContent).toBe('quarter')
    expect(note.querySelector('dot')).not.toBeNull()
    expect(note.querySelector('duration')?.textContent).toBe('12') // dotted-quarter = 12 divisions
  })

  it('maps each Duration enum to the correct <type> + divisions', () => {
    const cases: Array<{ d: string; type: string; div: string; dot: boolean }> = [
      { d: 'whole', type: 'whole', div: '32', dot: false },
      { d: 'half', type: 'half', div: '16', dot: false },
      { d: 'quarter', type: 'quarter', div: '8', dot: false },
      { d: 'eighth', type: 'eighth', div: '4', dot: false },
      { d: 'sixteenth', type: '16th', div: '2', dot: false },
      { d: '32nd', type: '32nd', div: '1', dot: false },
      { d: 'dotted-half', type: 'half', div: '24', dot: true },
      { d: 'dotted-quarter', type: 'quarter', div: '12', dot: true },
      { d: 'dotted-eighth', type: 'eighth', div: '6', dot: true },
    ]
    for (const c of cases) {
      const xml = scoreToMusicXml(
        singleNoteScore({
          meter: '32/32', // accommodate any duration in a single bar
          measures: [
            { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: c.d as never }] },
          ],
        }),
      )
      const doc = parseXml(xml)
      const note = doc.querySelector('note')!
      expect(note.querySelector('type')?.textContent, `type for ${c.d}`).toBe(c.type)
      expect(note.querySelector('duration')?.textContent, `divisions for ${c.d}`).toBe(c.div)
      expect(!!note.querySelector('dot'), `dot for ${c.d}`).toBe(c.dot)
    }
  })
})

describe('scoreToMusicXml — tempo', () => {
  it('emits <direction> with both <metronome> (engraver) and <sound tempo> (playback)', () => {
    const xml = scoreToMusicXml(singleNoteScore({ tempo_bpm: 132 }))
    const doc = parseXml(xml)
    const dir = doc.querySelector('measure > direction')!
    expect(dir.getAttribute('placement')).toBe('above')
    expect(dir.querySelector('sound')?.getAttribute('tempo')).toBe('132')
    const metro = dir.querySelector('metronome')!
    expect(metro).not.toBeNull()
    expect(metro.querySelector('beat-unit')?.textContent).toBe('quarter')
    expect(metro.querySelector('per-minute')?.textContent).toBe('132')
  })

  it('omits <direction> when tempo_bpm is unset', () => {
    const xml = scoreToMusicXml(singleNoteScore())
    const doc = parseXml(xml)
    expect(doc.querySelector('measure > direction')).toBeNull()
  })

  it('places tempo only on the first measure (not subsequent ones)', () => {
    const xml = scoreToMusicXml({
      ...singleNoteScore({ tempo_bpm: 100 }),
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    expect(measures[0].querySelectorAll('direction').length).toBe(1)
    expect(measures[1].querySelectorAll('direction').length).toBe(0)
  })
})

describe('scoreToMusicXml — measure numbering', () => {
  it('numbers measures starting at 1', () => {
    const xml = scoreToMusicXml({
      ...singleNoteScore(),
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    expect(measures[0].getAttribute('number')).toBe('1')
    expect(measures[1].getAttribute('number')).toBe('2')
    expect(measures[2].getAttribute('number')).toBe('3')
  })
})

describe('scoreToMusicXml — part-name', () => {
  it('always emits <part-name>Music</part-name>, not the score title', () => {
    // Part-name is an instrument label (shown in MuseScore's
    // instruments panel). The piece name belongs in <work-title>;
    // showing it as a fake instrument name is wrong.
    const xml = scoreToMusicXml(singleNoteScore({ title: 'Symphony No. 5' }))
    const doc = parseXml(xml)
    expect(doc.querySelector('score-part > part-name')?.textContent).toBe('Music')
  })
})

describe('scoreToMusicXml — input validation', () => {
  it('throws when measures is empty (would emit a DTD-invalid <part>)', () => {
    expect(() =>
      scoreToMusicXml({ ...singleNoteScore(), measures: [] }),
    ).toThrow(/at least one measure/)
  })

  it('throws when rest is mixed with pitched notes in a single event', () => {
    // A leading rest in a chord would silently leave subsequent
    // <chord/> notes without an anchor note (invalid MusicXML); a
    // trailing rest in a chord would silently change the chord shape.
    // The Score schema's rest_in_chord validation catches this
    // upstream, but scoreToMusicXml is exported directly, so harden
    // the boundary too.
    expect(() =>
      scoreToMusicXml(
        singleNoteScore({
          measures: [
            {
              events: [
                {
                  pitches: [
                    { step: 'rest', octave: 4 },
                    { step: 'C', octave: 4 },
                  ],
                  duration: 'quarter',
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/rest cannot be mixed/)
  })
})

describe('scoreToMusicXml — KEY_FIFTHS coverage', () => {
  // Spot-check that every Key enum value emits a parseable
  // key signature with the expected fifths count and mode.
  const cases: Array<[string, number, 'major' | 'minor']> = [
    // Sharp majors
    ['C', 0, 'major'],
    ['G', 1, 'major'],
    ['D', 2, 'major'],
    ['A', 3, 'major'],
    ['E', 4, 'major'],
    ['B', 5, 'major'],
    ['F#', 6, 'major'],
    ['C#', 7, 'major'],
    // Flat majors
    ['F', -1, 'major'],
    ['Bb', -2, 'major'],
    ['Eb', -3, 'major'],
    ['Ab', -4, 'major'],
    ['Db', -5, 'major'],
    ['Gb', -6, 'major'],
    ['Cb', -7, 'major'],
    // Sharp minors (share the relative MAJOR's fifth count)
    ['Am', 0, 'minor'],
    ['Em', 1, 'minor'],
    ['Bm', 2, 'minor'],
    ['F#m', 3, 'minor'],
    ['C#m', 4, 'minor'],
    ['G#m', 5, 'minor'],
    ['D#m', 6, 'minor'],
    ['A#m', 7, 'minor'],
    // Flat minors
    ['Dm', -1, 'minor'],
    ['Gm', -2, 'minor'],
    ['Cm', -3, 'minor'],
    ['Fm', -4, 'minor'],
    ['Bbm', -5, 'minor'],
    ['Ebm', -6, 'minor'],
    ['Abm', -7, 'minor'],
  ]
  for (const [key, fifths, mode] of cases) {
    it(`${key} → fifths=${fifths}, mode=${mode}`, () => {
      const xml = scoreToMusicXml(singleNoteScore({ key: key as never }))
      const doc = parseXml(xml)
      expect(doc.querySelector('key > fifths')?.textContent).toBe(String(fifths))
      expect(doc.querySelector('key > mode')?.textContent).toBe(mode)
    })
  }
})

describe('downloadMusicXml — browser download (M22-PR-3)', () => {
  it('creates an object URL with the MusicXML MIME type and clicks an <a download>', () => {
    const created: Array<{ blob: Blob; url: string }> = []
    const revoked: string[] = []
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    let urlCounter = 0
    URL.createObjectURL = vi.fn((blob: Blob) => {
      const url = `blob:mock/${++urlCounter}`
      created.push({ blob, url })
      return url
    })
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url)
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    try {
      downloadMusicXml(singleNoteScore({ title: 'Hello' }), 'hello.musicxml')

      expect(created.length).toBe(1)
      expect(created[0].blob.type).toBe('application/vnd.recordare.musicxml+xml')
      expect(clickSpy).toHaveBeenCalledTimes(1)
      // Object URL is revoked even on the happy path (try/finally).
      expect(revoked).toEqual([created[0].url])
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
      clickSpy.mockRestore()
    }
  })

  it('uses the provided filename on the <a download> attribute', () => {
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:mock/1')
    URL.revokeObjectURL = vi.fn()
    let observedDownloadAttr: string | undefined
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        observedDownloadAttr = this.getAttribute('download') ?? undefined
      })

    try {
      downloadMusicXml(singleNoteScore(), 'my-piece.musicxml')
      expect(observedDownloadAttr).toBe('my-piece.musicxml')
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
      clickSpy.mockRestore()
    }
  })

  it('revokes the object URL even when the synthetic <a> click throws', () => {
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:mock/leak-test')
    const revoked: string[] = []
    URL.revokeObjectURL = vi.fn((url: string) => revoked.push(url))
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('boom')
    })

    try {
      expect(() => downloadMusicXml(singleNoteScore(), 'x.musicxml')).toThrow(/boom/)
      // Even with the click throwing, the finally MUST run so the
      // object URL isn't leaked.
      expect(revoked).toEqual(['blob:mock/leak-test'])
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
      clickSpy.mockRestore()
    }
  })

  it('defaults filename to score.musicxml when not provided', () => {
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:mock/1')
    URL.revokeObjectURL = vi.fn()
    let observedDownloadAttr: string | undefined
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        observedDownloadAttr = this.getAttribute('download') ?? undefined
      })

    try {
      downloadMusicXml(singleNoteScore())
      expect(observedDownloadAttr).toBe('score.musicxml')
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
      clickSpy.mockRestore()
    }
  })
})

describe('scoreToMusicXml — ties (M22-PR-4)', () => {
  function twoNoteTied(): Score {
    return {
      title: 'Tied',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4, tied_to_next: true }], duration: 'half' },
            { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    }
  }

  it('emits BOTH <tie type="start"/> (sound) and <tied type="start"/> (notation) on the start note', () => {
    const xml = scoreToMusicXml(twoNoteTied())
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    const ties = notes[0].querySelectorAll('tie')
    const tieds = notes[0].querySelectorAll('notations > tied')
    expect(ties.length).toBe(1)
    expect(ties[0].getAttribute('type')).toBe('start')
    expect(tieds.length).toBe(1)
    expect(tieds[0].getAttribute('type')).toBe('start')
  })

  it('emits matching stop on the next note', () => {
    const xml = scoreToMusicXml(twoNoteTied())
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    expect(notes[1].querySelector('tie')?.getAttribute('type')).toBe('stop')
    expect(notes[1].querySelector('notations > tied')?.getAttribute('type')).toBe('stop')
  })

  it('does NOT emit a tie when no follower exists (last event of part)', () => {
    const xml = scoreToMusicXml({
      ...twoNoteTied(),
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4, tied_to_next: true }], duration: 'whole' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const note = doc.querySelector('note')!
    expect(note.querySelector('tie')).toBeNull()
    expect(note.querySelector('notations')).toBeNull()
  })

  it('emits both start AND stop on a middle event of a 3-note tied chain', () => {
    const xml = scoreToMusicXml({
      title: 'Chain',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4, tied_to_next: true }], duration: 'quarter' },
            { pitches: [{ step: 'C', octave: 4, tied_to_next: true }], duration: 'quarter' },
            { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    // Middle note carries BOTH a stop (from prev) and a start (to next).
    // Stop comes first (the tie completing) before start (the new tie).
    const middleTies = notes[1].querySelectorAll('tie')
    expect(middleTies.length).toBe(2)
    expect(middleTies[0].getAttribute('type')).toBe('stop')
    expect(middleTies[1].getAttribute('type')).toBe('start')
    const middleTieds = notes[1].querySelectorAll('notations > tied')
    expect(middleTieds.length).toBe(2)
    expect(middleTieds[0].getAttribute('type')).toBe('stop')
    expect(middleTieds[1].getAttribute('type')).toBe('start')
  })

  it('emits per-pitch ties in a chord (only the marked pitch is tied)', () => {
    // [C-E][CE]: C ties; E does not.
    const xml = scoreToMusicXml({
      title: 'Chord tie',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [
                { step: 'C', octave: 4, tied_to_next: true },
                { step: 'E', octave: 4 },
              ],
              duration: 'half',
            },
            {
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
              ],
              duration: 'half',
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    // Event 1: pitches[0]=C tied; pitches[1]=E not tied
    expect(notes[0].querySelector('tie')?.getAttribute('type')).toBe('start')
    expect(notes[1].querySelector('tie')).toBeNull()
    // Event 2: pitches[0]=C stops; pitches[1]=E no tie
    expect(notes[2].querySelector('tie')?.getAttribute('type')).toBe('stop')
    expect(notes[3].querySelector('tie')).toBeNull()
  })

  it('honors legacy event-wide tied_to_next when per-pitch flag is unset', () => {
    const xml = scoreToMusicXml({
      title: 'Legacy',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'half',
              tied_to_next: true,
            },
            { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    expect(notes[0].querySelector('tie')?.getAttribute('type')).toBe('start')
    expect(notes[1].querySelector('tie')?.getAttribute('type')).toBe('stop')
  })

  it('per-pitch tied_to_next:false overrides legacy event-wide true', () => {
    // Event-wide says "tied"; pitch explicitly says "not tied" — per-pitch wins.
    const xml = scoreToMusicXml({
      title: 'Override',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 4, tied_to_next: false }],
              duration: 'half',
              tied_to_next: true,
            },
            { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('note')?.querySelector('tie')).toBeNull()
  })

  it("does NOT emit a tie when the pitch is laissez vibrer (lv ties don't pair)", () => {
    // lv is open-ended — the ring decays naturally with no target
    // note. Emitting a tie-start here would dangle without a stop.
    const xml = scoreToMusicXml({
      title: 'LV',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 4, lv: true, tied_to_next: true }],
              duration: 'half',
            },
            { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    expect(notes[0].querySelector('tie')).toBeNull()
    expect(notes[1].querySelector('tie')).toBeNull()
  })

  it('emits ties that cross a measure boundary', () => {
    // Last note of measure 1 ties to first note of measure 2 — the
    // prev/next event lookup MUST cross the boundary, otherwise the
    // tie-stop on the new measure silently drops.
    const xml = scoreToMusicXml({
      title: 'Cross',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4, tied_to_next: true }], duration: 'whole' },
          ],
        },
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    expect(measures[0].querySelector('note > tie')?.getAttribute('type')).toBe('start')
    expect(measures[1].querySelector('note > tie')?.getAttribute('type')).toBe('stop')
  })

  it('emits no <notations> wrapper when the pitch carries no tie', () => {
    const xml = scoreToMusicXml(singleNoteScore())
    const doc = parseXml(xml)
    expect(doc.querySelector('note > notations')).toBeNull()
  })
})

describe('scoreToMusicXml — secondStaff (M22-PR-5)', () => {
  function grandStaffScore(overrides: Partial<Score> = {}): Score {
    return {
      title: 'Piano',
      key: 'C',
      meter: '4/4',
      clef: 'treble',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        ],
      },
      ...overrides,
    }
  }

  it('single-staff scores omit <staves> and <staff> for backwards compatibility', () => {
    // M22-PR-2 contract: a single-staff score's notes do NOT carry
    // a <staff> element. Pin that PR-5's multi-staff branch didn't
    // accidentally start stamping <staff>1 on every single-instrument
    // export (which would be ugly diff noise for downstream consumers).
    const xml = scoreToMusicXml(singleNoteScore())
    const doc = parseXml(xml)
    expect(doc.querySelector('attributes > staves')).toBeNull()
    expect(doc.querySelector('note > staff')).toBeNull()
  })

  it('grand-staff scores emit <staves>2</staves> in first-measure attributes', () => {
    const xml = scoreToMusicXml(grandStaffScore())
    const doc = parseXml(xml)
    expect(doc.querySelector('attributes > staves')?.textContent).toBe('2')
  })

  it('emits per-staff <clef number="1"> and <clef number="2"> for the two staves', () => {
    const xml = scoreToMusicXml(grandStaffScore())
    const doc = parseXml(xml)
    const clefs = doc.querySelectorAll('attributes > clef')
    expect(clefs.length).toBe(2)
    expect(clefs[0].getAttribute('number')).toBe('1')
    expect(clefs[0].querySelector('sign')?.textContent).toBe('G')
    expect(clefs[1].getAttribute('number')).toBe('2')
    expect(clefs[1].querySelector('sign')?.textContent).toBe('F')
  })

  it('stamps <staff>1</staff> on every primary-staff note and <staff>2</staff> on every secondStaff note', () => {
    const xml = scoreToMusicXml(grandStaffScore())
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    expect(notes.length).toBe(2)
    expect(notes[0].querySelector('staff')?.textContent).toBe('1')
    expect(notes[1].querySelector('staff')?.textContent).toBe('2')
  })

  it('emits a <backup> between the primary and second staff, with duration matching the measure', () => {
    // Whole note = 32 divisions (DIVISIONS=8, whole=32). The <backup>
    // MUST equal the cumulative duration of the primary staff so the
    // secondStaff's time cursor restarts at beat 1 of the measure.
    const xml = scoreToMusicXml(grandStaffScore())
    const doc = parseXml(xml)
    const backups = doc.querySelectorAll('measure > backup')
    expect(backups.length).toBe(1)
    expect(backups[0].querySelector('duration')?.textContent).toBe('32')
  })

  it('<backup> reflects multiple events (sum of durations, not just last)', () => {
    const xml = scoreToMusicXml({
      ...grandStaffScore(),
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 5 }], duration: 'half' },     // 16
            { pitches: [{ step: 'D', octave: 5 }], duration: 'quarter' },  // 8
            { pitches: [{ step: 'E', octave: 5 }], duration: 'quarter' },  // 8
          ],
        },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        ],
      },
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('backup > duration')?.textContent).toBe('32') // 16+8+8
  })

  it('ties only match within the same staff (no cross-staff tying)', () => {
    const xml = scoreToMusicXml({
      title: 'Cross-staff isolation',
      key: 'C',
      meter: '4/4',
      clef: 'treble',
      measures: [
        { events: [
          { pitches: [{ step: 'C', octave: 5, tied_to_next: true }], duration: 'half' },
          { pitches: [{ step: 'C', octave: 5 }], duration: 'half' },
        ]},
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [
            { pitches: [{ step: 'C', octave: 3, tied_to_next: true }], duration: 'half' },
            { pitches: [{ step: 'C', octave: 3 }], duration: 'half' },
          ]},
        ],
      },
    })
    const doc = parseXml(xml)
    const measure = doc.querySelector('measure')!
    // Treble notes (2) + backup + bass notes (2)
    const noteEls = measure.querySelectorAll('note')
    expect(noteEls.length).toBe(4)
    expect(noteEls[0].querySelector('staff')?.textContent).toBe('1')
    expect(noteEls[1].querySelector('staff')?.textContent).toBe('1')
    expect(noteEls[2].querySelector('staff')?.textContent).toBe('2')
    expect(noteEls[3].querySelector('staff')?.textContent).toBe('2')
    // Each staff's pair has a start→stop tie; staves don't tie across.
    expect(noteEls[0].querySelector('tie')?.getAttribute('type')).toBe('start')
    expect(noteEls[1].querySelector('tie')?.getAttribute('type')).toBe('stop')
    expect(noteEls[2].querySelector('tie')?.getAttribute('type')).toBe('start')
    expect(noteEls[3].querySelector('tie')?.getAttribute('type')).toBe('stop')
  })

  it('emits one backup per measure (not between measures)', () => {
    const xml = scoreToMusicXml({
      ...grandStaffScore(),
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'D', octave: 3 }], duration: 'whole' }] },
        ],
      },
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    expect(measures.length).toBe(2)
    expect(measures[0].querySelectorAll('backup').length).toBe(1)
    expect(measures[1].querySelectorAll('backup').length).toBe(1)
  })

  it('throws when secondStaff.measures.length does not match the primary', () => {
    // validateScore enforces bar-alignment upstream; the export
    // boundary hardens the contract for direct callers.
    expect(() =>
      scoreToMusicXml({
        ...grandStaffScore(),
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'whole' }] },
        ],
        secondStaff: {
          clef: 'bass',
          measures: [
            { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
            // missing measure 2
          ],
        },
      }),
    ).toThrow(/staff 2 voice 1 has 1 measures; primary has 2/)
  })

  it('rest events on either staff get the right <staff> tag', () => {
    const xml = scoreToMusicXml({
      ...grandStaffScore(),
      measures: [
        { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
        ],
      },
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    expect(notes[0].querySelector('rest')).not.toBeNull()
    expect(notes[0].querySelector('staff')?.textContent).toBe('1')
    expect(notes[1].querySelector('rest')).not.toBeNull()
    expect(notes[1].querySelector('staff')?.textContent).toBe('2')
  })
})

describe('scoreToMusicXml — extraVoices (M22-PR-A)', () => {
  function twoVoiceScore(overrides: Partial<Score> = {}): Score {
    // Voice 0 (primary): 4 quarter notes C4/D4/E4/F4 (32 divisions).
    // Voice 1 (extra):   2 half notes A3/G3                (32 divisions).
    return {
      title: 'Two-voice',
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
      ],
      extraVoices: [
        {
          measures: [
            {
              events: [
                { pitches: [{ step: 'A', octave: 3 }], duration: 'half' },
                { pitches: [{ step: 'G', octave: 3 }], duration: 'half' },
              ],
            },
          ],
        },
      ],
      ...overrides,
    }
  }

  it('emits all primary-voice notes, then a <backup>, then extra-voice notes', () => {
    const xml = scoreToMusicXml(twoVoiceScore())
    const doc = parseXml(xml)
    const measure = doc.querySelector('measure')!
    const children = Array.from(measure.children)
    // Strip <attributes> + first-measure direction (tempo absent here).
    const body = children.filter((c) => c.tagName === 'note' || c.tagName === 'backup')
    // 4 notes (voice 1) + backup + 2 notes (voice 2) = 7
    expect(body.length).toBe(7)
    for (let i = 0; i < 4; i++) {
      expect(body[i].tagName).toBe('note')
      expect((body[i] as Element).querySelector('voice')?.textContent).toBe('1')
    }
    expect(body[4].tagName).toBe('backup')
    expect((body[4] as Element).querySelector('duration')?.textContent).toBe('32')
    for (let i = 5; i < 7; i++) {
      expect(body[i].tagName).toBe('note')
      expect((body[i] as Element).querySelector('voice')?.textContent).toBe('2')
    }
  })

  it('does not emit <staff> on single-staff multi-voice scores', () => {
    // <staff> is only meaningful for grand-staff exports. A
    // single-staff SATB-on-one-staff score should keep notes free of
    // the <staff> element so diff-noise is minimized.
    const xml = scoreToMusicXml(twoVoiceScore())
    const doc = parseXml(xml)
    expect(doc.querySelector('note > staff')).toBeNull()
  })

  it('emits voice numbers 1, 2, 3, 4 for up to three extraVoices on the primary staff', () => {
    const xml = scoreToMusicXml({
      title: 'SATB on one staff',
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
      ],
      extraVoices: [
        {
          measures: [
            { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
          ],
        },
        {
          measures: [
            { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
          ],
        },
        {
          measures: [
            { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const voices = Array.from(doc.querySelectorAll('note > voice')).map(
      (v) => v.textContent,
    )
    expect(voices).toEqual(['1', '2', '3', '4'])
  })

  it('emits a <backup> between every pair of emitting voices (not just the last)', () => {
    // Three voices, each non-empty → expect exactly TWO backups in
    // the measure (voice1→voice2 and voice2→voice3).
    const xml = scoreToMusicXml({
      title: 'Three voices',
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
      ],
      extraVoices: [
        {
          measures: [
            { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
          ],
        },
        {
          measures: [
            { events: [{ pitches: [{ step: 'G', octave: 3 }], duration: 'whole' }] },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelectorAll('measure > backup').length).toBe(2)
  })

  it('omits <backup> when an extra voice has no events (skips the voice cleanly)', () => {
    // Voice 0 has 4 quarters; voice 1's only measure is empty.
    // Output should just emit voice 1's 4 quarters with NO trailing
    // backup (since voice 2 contributes nothing to rewind from).
    const xml = scoreToMusicXml({
      title: 'Empty extra voice',
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      ],
      extraVoices: [{ measures: [{ events: [] }] }],
    })
    const doc = parseXml(xml)
    expect(doc.querySelectorAll('measure > backup').length).toBe(0)
    const voices = Array.from(doc.querySelectorAll('note > voice')).map(
      (v) => v.textContent,
    )
    expect(voices).toEqual(['1'])
  })

  it("skipping the primary voice doesn't emit a leading <backup>", () => {
    // Primary voice has an empty measure; voice 1 has notes. Voice 1
    // is the first emitter, so no preceding backup is needed.
    const xml = scoreToMusicXml({
      title: 'Empty primary',
      key: 'C',
      meter: '4/4',
      measures: [{ events: [] }],
      extraVoices: [
        {
          measures: [
            { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelectorAll('measure > backup').length).toBe(0)
    const voices = Array.from(doc.querySelectorAll('note > voice')).map(
      (v) => v.textContent,
    )
    // Only voice 2 emits — voice 0/1 is empty, voice 2 keeps its
    // assigned mxlVoice number (2) rather than being remapped to 1.
    expect(voices).toEqual(['2'])
  })

  it('grand-staff with extraVoices on the primary staff: voices reset to 1 on the second staff', () => {
    // Staff 1: 2 voices (mxlVoice 1, 2 with <staff>1</staff>)
    // Staff 2: 1 voice  (mxlVoice 1 with <staff>2</staff>)
    // Per-staff voice numbering matches MuseScore's convention; <staff>
    // disambiguates voice 1 on staff 1 vs voice 1 on staff 2.
    const xml = scoreToMusicXml({
      title: 'Piano with countermelody',
      key: 'C',
      meter: '4/4',
      clef: 'treble',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
      ],
      extraVoices: [
        {
          measures: [
            { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
          ],
        },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        ],
      },
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    expect(notes.length).toBe(3)
    expect(notes[0].querySelector('voice')?.textContent).toBe('1')
    expect(notes[0].querySelector('staff')?.textContent).toBe('1')
    expect(notes[1].querySelector('voice')?.textContent).toBe('2')
    expect(notes[1].querySelector('staff')?.textContent).toBe('1')
    expect(notes[2].querySelector('voice')?.textContent).toBe('1')
    expect(notes[2].querySelector('staff')?.textContent).toBe('2')
    // Two backups: voice1→voice2 on staff 1, then staff1→staff2.
    expect(doc.querySelectorAll('measure > backup').length).toBe(2)
  })

  it('grand-staff with extraVoices on the secondStaff', () => {
    // secondStaff has its own extraVoices field; this is the
    // standard MusicXML pattern for piano LH with multiple voices
    // (e.g. left-hand chord + bassline as voice 2).
    const xml = scoreToMusicXml({
      title: 'Piano LH polyphony',
      key: 'C',
      meter: '4/4',
      clef: 'treble',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        ],
        extraVoices: [
          {
            measures: [
              { events: [{ pitches: [{ step: 'G', octave: 2 }], duration: 'whole' }] },
            ],
          },
        ],
      },
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    expect(notes.length).toBe(3)
    // Staff 1 voice 1
    expect(notes[0].querySelector('staff')?.textContent).toBe('1')
    expect(notes[0].querySelector('voice')?.textContent).toBe('1')
    // Staff 2 voice 1 (primary of secondStaff)
    expect(notes[1].querySelector('staff')?.textContent).toBe('2')
    expect(notes[1].querySelector('voice')?.textContent).toBe('1')
    // Staff 2 voice 2 (extraVoice on secondStaff)
    expect(notes[2].querySelector('staff')?.textContent).toBe('2')
    expect(notes[2].querySelector('voice')?.textContent).toBe('2')
  })

  it('ties match within the same voice — not across voices that share step+octave', () => {
    // Voice 0 has a C4 tied_to_next; voice 1 also has a C4 in the
    // matching event index. The voice 0 tie must stop on voice 0's
    // next C4, NOT bleed into voice 1's C4.
    const xml = scoreToMusicXml({
      title: 'Cross-voice tie isolation',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4, tied_to_next: true }], duration: 'half' },
            { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
          ],
        },
      ],
      extraVoices: [
        {
          measures: [
            {
              events: [
                { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
                { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
              ],
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    // 4 notes total: voice 1 [tie-start, tie-stop], voice 2 [no tie, no tie].
    expect(notes[0].querySelector('tie')?.getAttribute('type')).toBe('start')
    expect(notes[1].querySelector('tie')?.getAttribute('type')).toBe('stop')
    expect(notes[2].querySelector('tie')).toBeNull()
    expect(notes[3].querySelector('tie')).toBeNull()
  })

  it('emits <backup> with the prior voice duration when voices have different totals', () => {
    // Voice 0 emits 32 divisions (4 quarters); voice 1 emits 16
    // divisions (2 quarters). The backup between them must equal
    // voice 0's 32, not voice 1's 16.
    const xml = scoreToMusicXml({
      title: 'Uneven voice durations',
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
      ],
      extraVoices: [
        {
          measures: [
            {
              events: [
                { pitches: [{ step: 'G', octave: 3 }], duration: 'quarter' },
                { pitches: [{ step: 'A', octave: 3 }], duration: 'quarter' },
              ],
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const backup = doc.querySelector('measure > backup')!
    expect(backup.querySelector('duration')?.textContent).toBe('32')
  })

  it('throws when an extraVoice has fewer measures than the primary staff', () => {
    // validateScore enforces voice bar-alignment; this hardens the
    // export boundary so direct callers don't produce malformed XML.
    expect(() =>
      scoreToMusicXml({
        title: 'Misaligned voices',
        key: 'C',
        meter: '4/4',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
        ],
        extraVoices: [
          {
            measures: [
              { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
              // missing measure 2
            ],
          },
        ],
      }),
    ).toThrow(/staff 1 voice 2 has 1 measures; primary has 2/)
  })

  it('throws when an extraVoice has MORE measures than the primary staff', () => {
    // Symmetric to the under-count check: a longer extraVoice would
    // silently lose its trailing measures in the export.
    expect(() =>
      scoreToMusicXml({
        title: 'Over-long voice',
        key: 'C',
        meter: '4/4',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        ],
        extraVoices: [
          {
            measures: [
              { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
              { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
            ],
          },
        ],
      }),
    ).toThrow(/staff 1 voice 2 has 2 measures; primary has 1/)
  })

  it('throws when secondStaff.extraVoices is misaligned with the primary', () => {
    // The bar-alignment guard fires for any voice (including
    // extras on the secondStaff), not just the primary staff's.
    expect(() =>
      scoreToMusicXml({
        title: 'Misaligned secondStaff extra',
        key: 'C',
        meter: '4/4',
        clef: 'treble',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'whole' }] },
        ],
        secondStaff: {
          clef: 'bass',
          measures: [
            { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
            { events: [{ pitches: [{ step: 'D', octave: 3 }], duration: 'whole' }] },
          ],
          extraVoices: [
            {
              measures: [
                { events: [{ pitches: [{ step: 'G', octave: 2 }], duration: 'whole' }] },
                // missing measure 2 on secondStaff voice 2
              ],
            },
          ],
        },
      }),
    ).toThrow(/staff 2 voice 2 has 1 measures; primary has 2/)
  })

  it('ties on secondStaff.extraVoices do not bleed into secondStaff.voice0', () => {
    // Same tie-isolation contract as primary-staff extraVoices, but on
    // the secondStaff. Voice 0 on secondStaff has a C3 tied_to_next;
    // voice 1 on secondStaff also has a C3 in the matching position.
    // The voice 0 tie must stop on voice 0's next C3, NOT voice 1's.
    const xml = scoreToMusicXml({
      title: 'secondStaff cross-voice tie isolation',
      key: 'C',
      meter: '4/4',
      clef: 'treble',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          {
            events: [
              { pitches: [{ step: 'C', octave: 3, tied_to_next: true }], duration: 'half' },
              { pitches: [{ step: 'C', octave: 3 }], duration: 'half' },
            ],
          },
        ],
        extraVoices: [
          {
            measures: [
              {
                events: [
                  { pitches: [{ step: 'C', octave: 3 }], duration: 'half' },
                  { pitches: [{ step: 'C', octave: 3 }], duration: 'half' },
                ],
              },
            ],
          },
        ],
      },
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    // 1 staff-1 note + 2 staff-2 voice-0 notes + 2 staff-2 voice-1 notes = 5
    expect(notes.length).toBe(5)
    // staff 2 voice 0 (notes[1], notes[2]) carry the tie.
    expect(notes[1].querySelector('staff')?.textContent).toBe('2')
    expect(notes[1].querySelector('voice')?.textContent).toBe('1')
    expect(notes[1].querySelector('tie')?.getAttribute('type')).toBe('start')
    expect(notes[2].querySelector('tie')?.getAttribute('type')).toBe('stop')
    // staff 2 voice 1 (notes[3], notes[4]) do NOT carry the tie.
    expect(notes[3].querySelector('staff')?.textContent).toBe('2')
    expect(notes[3].querySelector('voice')?.textContent).toBe('2')
    expect(notes[3].querySelector('tie')).toBeNull()
    expect(notes[4].querySelector('tie')).toBeNull()
  })
})

describe('scoreToMusicXml — markers (M22-PR-B)', () => {
  function threeBarScore(overrides: Partial<Score> = {}): Score {
    return {
      title: 'Markers',
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
      ],
      ...overrides,
    }
  }

  it('emits a key-change <attributes> at the start of the target measure', () => {
    const xml = scoreToMusicXml(
      threeBarScore({
        markers: [{ measureIdx: 1, key: 'G' }],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    // Measure 1 (0-indexed) has the marker — find its inner attributes block.
    const measure2 = measures[1]
    const attrs = measure2.querySelector('attributes')
    expect(attrs).not.toBeNull()
    expect(attrs!.querySelector('key > fifths')?.textContent).toBe('1')
    expect(attrs!.querySelector('key > mode')?.textContent).toBe('major')
    // No clef / time in the marker → those should not appear.
    expect(attrs!.querySelector('clef')).toBeNull()
    expect(attrs!.querySelector('time')).toBeNull()
  })

  it('emits a meter-change <attributes>', () => {
    const xml = scoreToMusicXml(
      threeBarScore({
        markers: [{ measureIdx: 1, meter: '3/4' }],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    const attrs = measures[1].querySelector('attributes')!
    expect(attrs.querySelector('time > beats')?.textContent).toBe('3')
    expect(attrs.querySelector('time > beat-type')?.textContent).toBe('4')
  })

  it('emits a clef-change <attributes> (single staff: omits number=)', () => {
    const xml = scoreToMusicXml(
      threeBarScore({
        markers: [{ measureIdx: 1, clefs: [{ staffIdx: 0, clef: 'bass' }] }],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    const clef = measures[1].querySelector('attributes > clef')!
    // Single-staff scores don't carry the number attribute on clef
    // (mirrors first-measure attribute emission).
    expect(clef.getAttribute('number')).toBeNull()
    expect(clef.querySelector('sign')?.textContent).toBe('F')
    expect(clef.querySelector('line')?.textContent).toBe('4')
  })

  it('emits a clef-change <attributes> on a grand-staff (number= identifies staff)', () => {
    const xml = scoreToMusicXml({
      title: 'Grand-staff with clef change',
      key: 'C',
      meter: '4/4',
      clef: 'treble',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'D', octave: 3 }], duration: 'whole' }] },
        ],
      },
      markers: [
        // Change staff 2 to treble at measure 1 (cross-staff voicing).
        { measureIdx: 1, clefs: [{ staffIdx: 1, clef: 'treble' }] },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    const clef = measures[1].querySelector('attributes > clef')!
    expect(clef.getAttribute('number')).toBe('2')
    expect(clef.querySelector('sign')?.textContent).toBe('G')
    expect(clef.querySelector('line')?.textContent).toBe('2')
  })

  it('emits a tempo-change <direction> with both metronome and sound', () => {
    const xml = scoreToMusicXml(
      threeBarScore({
        markers: [{ measureIdx: 1, tempo_bpm: 144 }],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    const dir = measures[1].querySelector('direction')!
    expect(dir.getAttribute('placement')).toBe('above')
    expect(dir.querySelector('metronome > per-minute')?.textContent).toBe('144')
    expect(dir.querySelector('sound')?.getAttribute('tempo')).toBe('144')
  })

  it('emits a tempo_text marker as <words>', () => {
    const xml = scoreToMusicXml(
      threeBarScore({
        markers: [{ measureIdx: 1, tempo_text: 'Allegro' }],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    const dir = measures[1].querySelector('direction')!
    expect(dir.querySelector('words')?.textContent).toBe('Allegro')
    // No tempo_bpm → no metronome, no sound.
    expect(dir.querySelector('metronome')).toBeNull()
    expect(dir.querySelector('sound')).toBeNull()
  })

  it('combines tempo_text + tempo_bpm into a single <direction> with both direction-types', () => {
    const xml = scoreToMusicXml(
      threeBarScore({
        markers: [{ measureIdx: 1, tempo_text: 'Allegro', tempo_bpm: 120 }],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    const dirs = measures[1].querySelectorAll('direction')
    expect(dirs.length).toBe(1)
    const types = dirs[0].querySelectorAll('direction-type')
    expect(types.length).toBe(2)
    // Words come before metronome so readers render "Allegro ♩ = 120"
    // left-to-right.
    expect(types[0].querySelector('words')?.textContent).toBe('Allegro')
    expect(types[1].querySelector('metronome > per-minute')?.textContent).toBe('120')
  })

  it('escapes XML-special characters in tempo_text', () => {
    const xml = scoreToMusicXml(
      threeBarScore({
        markers: [{ measureIdx: 1, tempo_text: 'A & B <fast>' }],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    expect(measures[1].querySelector('words')?.textContent).toBe('A & B <fast>')
  })

  it('coalesces multiple markers on the same measureIdx into one attributes block', () => {
    // validateMarkers rejects same-field collisions, but different
    // fields on the same idx are allowed and should fold into one
    // attributes block.
    const xml = scoreToMusicXml(
      threeBarScore({
        markers: [
          { measureIdx: 1, key: 'G' },
          { measureIdx: 1, meter: '3/4' },
        ],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    const attrs = measures[1].querySelectorAll('attributes')
    expect(attrs.length).toBe(1)
    expect(attrs[0].querySelector('key > fifths')?.textContent).toBe('1')
    expect(attrs[0].querySelector('time > beats')?.textContent).toBe('3')
  })

  it('emits markers only on their target measure (other measures stay clean)', () => {
    const xml = scoreToMusicXml(
      threeBarScore({
        markers: [{ measureIdx: 1, key: 'G' }],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    // Measure 0 has score-level attributes (always); measure 2 has none.
    expect(measures[0].querySelector('attributes')).not.toBeNull()
    expect(measures[2].querySelector('attributes')).toBeNull()
  })

  it('measure-0 markers emit a SECOND attributes block after the score-level defaults', () => {
    // A measure-0 marker is unusual but legal — the schema's
    // measureIdx min is 0. The emit puts the marker's attributes
    // AFTER the score-level ones, so MusicXML attribute-stacking
    // semantics let the marker override.
    const xml = scoreToMusicXml(
      threeBarScore({
        key: 'C',
        markers: [{ measureIdx: 0, key: 'G' }],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    const attrBlocks = measures[0].querySelectorAll('attributes')
    expect(attrBlocks.length).toBe(2)
    expect(attrBlocks[0].querySelector('key > fifths')?.textContent).toBe('0') // score-level C
    expect(attrBlocks[1].querySelector('key > fifths')?.textContent).toBe('1') // marker G
  })

  it('emits markers BEFORE any voice notes in the same measure', () => {
    // The marker attribute change must apply to every note in this
    // measure, so it must appear before the first <note>. Verify
    // ordering against measure children.
    const xml = scoreToMusicXml(
      threeBarScore({
        markers: [{ measureIdx: 1, key: 'G' }],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    const children = Array.from(measures[1].children)
    const attrIdx = children.findIndex((c) => c.tagName === 'attributes')
    const firstNoteIdx = children.findIndex((c) => c.tagName === 'note')
    expect(attrIdx).toBeGreaterThanOrEqual(0)
    expect(firstNoteIdx).toBeGreaterThan(attrIdx)
  })

  it('omits the <attributes> block when only tempo changes (still emits <direction>)', () => {
    // A tempo-only marker shouldn't bring an empty attributes block.
    const xml = scoreToMusicXml(
      threeBarScore({
        markers: [{ measureIdx: 1, tempo_bpm: 90 }],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    expect(measures[1].querySelector('attributes')).toBeNull()
    expect(measures[1].querySelector('direction')).not.toBeNull()
  })

  it('multiple markers at different measures each emit their own blocks', () => {
    const xml = scoreToMusicXml(
      threeBarScore({
        markers: [
          { measureIdx: 1, key: 'G' },
          { measureIdx: 2, key: 'D' },
        ],
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('part > measure')
    expect(measures[1].querySelector('attributes > key > fifths')?.textContent).toBe('1')
    expect(measures[2].querySelector('attributes > key > fifths')?.textContent).toBe('2')
  })

  it('throws when a marker targets staffIdx=1 on a single-staff score', () => {
    // ClefChangeSchema bounds staffIdx 0..1 but doesn't know whether
    // the score actually has a secondStaff. The export boundary is
    // the safety net for this validation gap.
    expect(() =>
      scoreToMusicXml(
        threeBarScore({
          markers: [
            { measureIdx: 1, clefs: [{ staffIdx: 1, clef: 'bass' }] },
          ],
        }),
      ),
    ).toThrow(/marker clef targets staffIdx=1 but score has no secondStaff/)
  })
})

describe('scoreToMusicXml — dynamics / articulations / fermata / breath / caesura (M22-PR-C)', () => {
  function singleEvent(partial: Partial<Score['measures'][0]['events'][0]>): Score {
    return {
      title: 'Test',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'whole', ...partial },
          ],
        },
      ],
    }
  }

  // ── Dynamics ───────────────────────────────────────────────────────

  it('emits a legacy event.dynamic as <direction><dynamics><X/></dynamics></direction>', () => {
    const xml = scoreToMusicXml(singleEvent({ dynamic: 'mf' }))
    const doc = parseXml(xml)
    const dir = doc.querySelector('measure > direction[placement="below"]')!
    expect(dir).not.toBeNull()
    expect(dir.querySelector('dynamics > mf')).not.toBeNull()
  })

  it('emits the dynamic BEFORE the note (sibling order)', () => {
    // <direction> and <note> are siblings; the direction must appear
    // first so the dynamic attaches to the upcoming downbeat.
    const xml = scoreToMusicXml(singleEvent({ dynamic: 'f' }))
    const doc = parseXml(xml)
    const measure = doc.querySelector('measure')!
    const children = Array.from(measure.children)
    const dirIdx = children.findIndex((c) => c.tagName === 'direction' && c.querySelector('dynamics'))
    const noteIdx = children.findIndex((c) => c.tagName === 'note')
    expect(dirIdx).toBeGreaterThanOrEqual(0)
    expect(noteIdx).toBeGreaterThan(dirIdx)
  })

  it('emits a structured compound dynamic with prefix → dynamics → suffix as three direction-types', () => {
    const xml = scoreToMusicXml(
      singleEvent({
        dynamic_structured: { base: 'p', prefix: 'sub.', suffix: 'espressivo' },
      }),
    )
    const doc = parseXml(xml)
    const dirs = doc.querySelectorAll('measure > direction')
    // Only one <direction> for this event's dynamic (filter out other
    // directions like tempo — but this score has no tempo, so length=1).
    expect(dirs.length).toBe(1)
    const types = dirs[0].querySelectorAll('direction-type')
    expect(types.length).toBe(3)
    expect(types[0].querySelector('words')?.textContent).toBe('sub.')
    expect(types[1].querySelector('dynamics > p')).not.toBeNull()
    expect(types[2].querySelector('words')?.textContent).toBe('espressivo')
  })

  it('dynamic_structured without prefix or suffix emits just the dynamics direction-type', () => {
    const xml = scoreToMusicXml(
      singleEvent({ dynamic_structured: { base: 'ff' } }),
    )
    const doc = parseXml(xml)
    const dir = doc.querySelector('measure > direction')!
    const types = dir.querySelectorAll('direction-type')
    expect(types.length).toBe(1)
    expect(types[0].querySelector('dynamics > ff')).not.toBeNull()
  })

  it("dynamic_structured takes precedence over legacy dynamic when both are set", () => {
    const xml = scoreToMusicXml(
      singleEvent({
        dynamic: 'p',
        dynamic_structured: { base: 'mf', prefix: 'poco' },
      }),
    )
    const doc = parseXml(xml)
    const dir = doc.querySelector('measure > direction')!
    expect(dir.querySelector('dynamics > mf')).not.toBeNull()
    expect(dir.querySelector('dynamics > p')).toBeNull()
    expect(dir.querySelector('words')?.textContent).toBe('poco')
  })

  it("dynamic = 'none' emits no direction (sentinel for explicit 'no dynamic')", () => {
    const xml = scoreToMusicXml(singleEvent({ dynamic: 'none' }))
    const doc = parseXml(xml)
    expect(doc.querySelector('measure > direction > dynamics')).toBeNull()
  })

  it('non-standard dynamics (rfp, fzp) emit as <other-dynamics>', () => {
    for (const d of ['rfp', 'fzp'] as const) {
      const xml = scoreToMusicXml(singleEvent({ dynamic: d }))
      const doc = parseXml(xml)
      const od = doc.querySelector('dynamics > other-dynamics')
      expect(od, `for ${d}`).not.toBeNull()
      expect(od!.textContent).toBe(d)
    }
  })

  it('multi-character standard dynamics (pppp, ffff, sffz) emit as their named elements', () => {
    for (const d of ['pppp', 'ffff', 'sffz', 'sfpp', 'rfz'] as const) {
      const xml = scoreToMusicXml(singleEvent({ dynamic: d }))
      const doc = parseXml(xml)
      const el = doc.querySelector(`dynamics > ${d}`)
      expect(el, `for ${d}`).not.toBeNull()
    }
  })

  it('dynamic direction binds to the correct <staff> on grand-staff scores', () => {
    const xml = scoreToMusicXml({
      title: 'Grand-staff with bass dynamic',
      key: 'C',
      meter: '4/4',
      clef: 'treble',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          {
            events: [
              {
                pitches: [{ step: 'C', octave: 3 }],
                duration: 'whole',
                dynamic: 'f',
              },
            ],
          },
        ],
      },
    })
    const doc = parseXml(xml)
    // Find the <direction> with dynamics — it must carry <staff>2</staff>.
    const dirs = Array.from(doc.querySelectorAll('measure > direction'))
    const dynDir = dirs.find((d) => d.querySelector('dynamics'))!
    expect(dynDir.querySelector('staff')?.textContent).toBe('2')
  })

  // ── Articulations ──────────────────────────────────────────────────

  it('emits a legacy event.articulation as <notations><articulations><X/>', () => {
    const xml = scoreToMusicXml(singleEvent({ articulation: 'staccato' }))
    const doc = parseXml(xml)
    const note = doc.querySelector('note')!
    expect(note.querySelector('notations > articulations > staccato')).not.toBeNull()
  })

  it('emits the new event.articulations array (multiple stacked glyphs)', () => {
    const xml = scoreToMusicXml(
      singleEvent({ articulations: ['staccato', 'accent'] }),
    )
    const doc = parseXml(xml)
    const arts = doc.querySelector('notations > articulations')!
    expect(arts.querySelector('staccato')).not.toBeNull()
    expect(arts.querySelector('accent')).not.toBeNull()
  })

  it('maps marcato → <strong-accent/>', () => {
    const xml = scoreToMusicXml(singleEvent({ articulation: 'marcato' }))
    const doc = parseXml(xml)
    expect(doc.querySelector('articulations > strong-accent')).not.toBeNull()
  })

  it('maps portato → <detached-legato/> (MusicXML engraved form)', () => {
    const xml = scoreToMusicXml(singleEvent({ articulation: 'portato' }))
    const doc = parseXml(xml)
    expect(doc.querySelector('articulations > detached-legato')).not.toBeNull()
  })

  it("articulation 'none' emits no <notations>", () => {
    const xml = scoreToMusicXml(singleEvent({ articulation: 'none' }))
    const doc = parseXml(xml)
    expect(doc.querySelector('notations')).toBeNull()
  })

  it("event.articulations takes precedence over legacy event.articulation", () => {
    const xml = scoreToMusicXml(
      singleEvent({
        articulation: 'staccato',
        articulations: ['accent', 'tenuto'],
      }),
    )
    const doc = parseXml(xml)
    const arts = doc.querySelector('articulations')!
    expect(arts.querySelector('accent')).not.toBeNull()
    expect(arts.querySelector('tenuto')).not.toBeNull()
    expect(arts.querySelector('staccato')).toBeNull()
  })

  it('articulations attach to the FIRST chord note only (not every stacked pitch)', () => {
    const xml = scoreToMusicXml({
      title: 'Chord with staccato',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
                { step: 'G', octave: 4 },
              ],
              duration: 'quarter',
              articulation: 'staccato',
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    expect(notes.length).toBe(3)
    expect(notes[0].querySelector('articulations > staccato')).not.toBeNull()
    expect(notes[1].querySelector('articulations')).toBeNull()
    expect(notes[2].querySelector('articulations')).toBeNull()
  })

  // ── Fermata ────────────────────────────────────────────────────────

  it("standard fermata emits <fermata/> with no shape attribute", () => {
    const xml = scoreToMusicXml(singleEvent({ fermata: 'standard' }))
    const doc = parseXml(xml)
    const fer = doc.querySelector('notations > fermata')!
    expect(fer).not.toBeNull()
    expect(fer.getAttribute('shape')).toBeNull()
  })

  it("non-default fermata shapes map to MusicXML 4.0 shape attribute", () => {
    const cases: Array<['short' | 'long' | 'very-short' | 'very-long', string]> = [
      ['short', 'angled'],
      ['long', 'square'],
      ['very-short', 'double-angled'],
      ['very-long', 'double-square'],
    ]
    for (const [f, shape] of cases) {
      const xml = scoreToMusicXml(singleEvent({ fermata: f }))
      const doc = parseXml(xml)
      const fer = doc.querySelector('notations > fermata')!
      expect(fer.getAttribute('shape'), `for ${f}`).toBe(shape)
    }
  })

  it('fermata + articulation coexist in one <notations> block in spec order', () => {
    // MusicXML 4.0 notations content order: tied → articulations →
    // fermata. Verify articulations appears before fermata.
    const xml = scoreToMusicXml(
      singleEvent({ articulation: 'accent', fermata: 'standard' }),
    )
    const doc = parseXml(xml)
    const notations = doc.querySelector('notations')!
    const children = Array.from(notations.children)
    const artIdx = children.findIndex((c) => c.tagName === 'articulations')
    const ferIdx = children.findIndex((c) => c.tagName === 'fermata')
    expect(artIdx).toBeGreaterThanOrEqual(0)
    expect(ferIdx).toBeGreaterThan(artIdx)
  })

  it('fermata attaches to a rest (G.P. hold) when set on a rest event', () => {
    const xml = scoreToMusicXml(
      singleEvent({
        pitches: [{ step: 'rest', octave: 4 }],
        fermata: 'standard',
      }),
    )
    const doc = parseXml(xml)
    const note = doc.querySelector('note')!
    expect(note.querySelector('rest')).not.toBeNull()
    expect(note.querySelector('notations > fermata')).not.toBeNull()
  })

  // ── Breath mark / Caesura ──────────────────────────────────────────

  it("breath mark emits <breath-mark/> inside <articulations>", () => {
    const xml = scoreToMusicXml(singleEvent({ breathMark: true }))
    const doc = parseXml(xml)
    const bm = doc.querySelector('notations > articulations > breath-mark')!
    expect(bm).not.toBeNull()
  })

  it("caesura emits <caesura/> inside <articulations>", () => {
    const xml = scoreToMusicXml(singleEvent({ caesura: true }))
    const doc = parseXml(xml)
    expect(doc.querySelector('notations > articulations > caesura')).not.toBeNull()
  })

  it('breath-mark and caesura coexist with articulations in one <articulations> wrapper', () => {
    const xml = scoreToMusicXml(
      singleEvent({ articulation: 'staccato', breathMark: true, caesura: true }),
    )
    const doc = parseXml(xml)
    const arts = doc.querySelector('articulations')!
    expect(arts.querySelector('staccato')).not.toBeNull()
    expect(arts.querySelector('breath-mark')).not.toBeNull()
    expect(arts.querySelector('caesura')).not.toBeNull()
  })

  it('breathMark = false / undefined emits no breath-mark element', () => {
    const xml = scoreToMusicXml(singleEvent({}))
    const doc = parseXml(xml)
    expect(doc.querySelector('breath-mark')).toBeNull()
  })

  // ── Notations co-occurrence ────────────────────────────────────────

  it('tie + articulation + fermata all live in one <notations> block in spec order', () => {
    const xml = scoreToMusicXml({
      title: 'Combined notations',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 4, tied_to_next: true }],
              duration: 'half',
              articulation: 'accent',
              fermata: 'standard',
            },
            { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const firstNote = doc.querySelector('note')!
    const notations = firstNote.querySelector('notations')!
    const children = Array.from(notations.children)
    // Expect order: tied → articulations → fermata.
    expect(children[0].tagName).toBe('tied')
    expect(children[0].getAttribute('type')).toBe('start')
    expect(children[1].tagName).toBe('articulations')
    expect(children[2].tagName).toBe('fermata')
  })

  it('a plain note (no dynamics, no articulations, no fermata) emits no <notations> or <direction>', () => {
    const xml = scoreToMusicXml(singleEvent({}))
    const doc = parseXml(xml)
    expect(doc.querySelector('note > notations')).toBeNull()
    expect(doc.querySelector('measure > direction')).toBeNull()
  })

  // ── EngravingDefaults.dynamicsPosition wiring ──────────────────────

  it("dynamicsPosition='above' emits placement=above on the dynamics <direction>", () => {
    const xml = scoreToMusicXml({
      ...singleEvent({ dynamic: 'mf' }),
      engravingDefaults: { dynamicsPosition: 'above' },
    })
    const doc = parseXml(xml)
    const dirs = Array.from(doc.querySelectorAll('measure > direction'))
    const dynDir = dirs.find((d) => d.querySelector('dynamics'))!
    expect(dynDir.getAttribute('placement')).toBe('above')
  })

  it("dynamicsPosition='below' emits placement=below (default behavior is preserved)", () => {
    const xml = scoreToMusicXml({
      ...singleEvent({ dynamic: 'mf' }),
      engravingDefaults: { dynamicsPosition: 'below' },
    })
    const doc = parseXml(xml)
    const dirs = Array.from(doc.querySelectorAll('measure > direction'))
    const dynDir = dirs.find((d) => d.querySelector('dynamics'))!
    expect(dynDir.getAttribute('placement')).toBe('below')
  })

  it("dynamicsPosition='auto-by-staff' falls back to below (instrumental convention)", () => {
    const xml = scoreToMusicXml({
      ...singleEvent({ dynamic: 'mf' }),
      engravingDefaults: { dynamicsPosition: 'auto-by-staff' },
    })
    const doc = parseXml(xml)
    const dirs = Array.from(doc.querySelectorAll('measure > direction'))
    const dynDir = dirs.find((d) => d.querySelector('dynamics'))!
    expect(dynDir.getAttribute('placement')).toBe('below')
  })

  it("dynamicsPosition='hidden' suppresses the <direction> entirely", () => {
    // Schema-documented contract: 'hidden' means dynamic glyphs are
    // suppressed (the user expects them on a separate layer or in
    // a part extraction). Emit nothing rather than relying on the
    // reader to honor placement.
    const xml = scoreToMusicXml({
      ...singleEvent({ dynamic: 'ff' }),
      engravingDefaults: { dynamicsPosition: 'hidden' },
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('measure > direction > dynamics')).toBeNull()
    // No spurious empty <direction> blocks either.
    const dirs = doc.querySelectorAll('measure > direction')
    expect(dirs.length).toBe(0)
  })

  it('default (no engravingDefaults) still emits placement=below', () => {
    // No engravingDefaults set on the score — confirm the existing
    // default-below behavior survives the wire-up refactor.
    const xml = scoreToMusicXml(singleEvent({ dynamic: 'p' }))
    const doc = parseXml(xml)
    const dirs = Array.from(doc.querySelectorAll('measure > direction'))
    const dynDir = dirs.find((d) => d.querySelector('dynamics'))!
    expect(dynDir.getAttribute('placement')).toBe('below')
  })
})

describe('scoreToMusicXml — spans (M22-PR-D)', () => {
  // Helper: a 2-event score with stable ids so spans can reference them.
  function twoEventScoreWithIds(): Score {
    return {
      title: 'Spans',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: 'eventaaa1', pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
            { id: 'eventaaa2', pitches: [{ step: 'D', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    }
  }

  // ── Slurs ──────────────────────────────────────────────────────────

  it('emits <slur type="start"> on the first event and <slur type="stop"> on the last', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spanslur01',
          kind: 'slur',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    const startSlur = notes[0].querySelector('notations > slur')!
    expect(startSlur.getAttribute('type')).toBe('start')
    expect(startSlur.getAttribute('number')).toBe('1')
    const stopSlur = notes[1].querySelector('notations > slur')!
    expect(stopSlur.getAttribute('type')).toBe('stop')
    expect(stopSlur.getAttribute('number')).toBe('1')
  })

  it('honors placement=above on slurs', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spanslur02',
          kind: 'slur',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'above',
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('slur')?.getAttribute('placement')).toBe('above')
  })

  it("placement='default' omits the placement attribute (engraver decides)", () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spanslur03',
          kind: 'slur',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'default',
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('slur')?.getAttribute('placement')).toBeNull()
  })

  it('phrase-slur emits as <slur> (engraved identically to slur in MusicXML)', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spanslur04',
          kind: 'phrase-slur',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelectorAll('slur').length).toBe(2)
  })

  it('two overlapping slurs get distinct number= values', () => {
    // Three-event score so we can have two slurs that overlap on the middle.
    const xml = scoreToMusicXml({
      title: 'Overlapping slurs',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: 'evid00001', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
            { id: 'evid00002', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
            { id: 'evid00003', pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
          ],
        },
      ],
      spans: [
        {
          id: 'spannnn1',
          kind: 'slur',
          startEventId: 'evid00001',
          endEventId: 'evid00002',
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'spannnn2',
          kind: 'slur',
          startEventId: 'evid00002',
          endEventId: 'evid00003',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const slurs = Array.from(doc.querySelectorAll('slur'))
    const numbers = new Set(slurs.map((s) => s.getAttribute('number')))
    // Two slurs → two distinct numbers (1 and 2).
    expect(numbers.size).toBe(2)
    expect(numbers.has('1')).toBe(true)
    expect(numbers.has('2')).toBe(true)
  })

  it('a slur attaches to the FIRST chord note only', () => {
    const xml = scoreToMusicXml({
      title: 'Chord slur',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'evcccc01',
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
                { step: 'G', octave: 4 },
              ],
              duration: 'half',
            },
            { id: 'evcccc02', pitches: [{ step: 'F', octave: 4 }], duration: 'half' },
          ],
        },
      ],
      spans: [
        {
          id: 'spchord01',
          kind: 'slur',
          startEventId: 'evcccc01',
          endEventId: 'evcccc02',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    expect(notes.length).toBe(4) // 3 chord notes + 1 follower
    expect(notes[0].querySelector('slur')).not.toBeNull()
    expect(notes[1].querySelector('slur')).toBeNull()
    expect(notes[2].querySelector('slur')).toBeNull()
    expect(notes[3].querySelector('slur')).not.toBeNull()
  })

  // ── Hairpin wedges ─────────────────────────────────────────────────

  it('hairpin-cresc emits <wedge type="crescendo"/> at start and type="stop" at end', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spwedge01',
          kind: 'hairpin-cresc',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const wedges = Array.from(doc.querySelectorAll('direction > direction-type > wedge'))
    expect(wedges.length).toBe(2)
    expect(wedges[0].getAttribute('type')).toBe('crescendo')
    expect(wedges[0].getAttribute('number')).toBe('1')
    expect(wedges[1].getAttribute('type')).toBe('stop')
  })

  it('hairpin-dim emits <wedge type="diminuendo"/>', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spwedge02',
          kind: 'hairpin-dim',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const wedges = doc.querySelectorAll('wedge')
    expect(wedges[0].getAttribute('type')).toBe('diminuendo')
    expect(wedges[1].getAttribute('type')).toBe('stop')
  })

  it('wedge start AND stop directions both emit BEFORE their anchoring note', () => {
    // MusicXML convention: a <direction> attaches to the NEXT
    // <note> in the music-data sequence. For a wedge spanning
    // events 1 → 2, both the crescendo start AND the stop sit
    // before their target notes — start before note 1, stop
    // before note 2 — so the wedge ends AT note 2's position
    // rather than one note past it.
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spwedge03',
          kind: 'hairpin-cresc',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const measure = doc.querySelector('measure')!
    const children = Array.from(measure.children)
    const noteIdxs = children
      .map((c, i) => (c.tagName === 'note' ? i : -1))
      .filter((i) => i >= 0)
    const wedgeStartIdx = children.findIndex(
      (c) =>
        c.tagName === 'direction' &&
        c.querySelector('wedge')?.getAttribute('type') === 'crescendo',
    )
    const wedgeStopIdx = children.findIndex(
      (c) =>
        c.tagName === 'direction' &&
        c.querySelector('wedge')?.getAttribute('type') === 'stop',
    )
    // Wedge start sits between any pre-content and the first note.
    expect(wedgeStartIdx).toBeLessThan(noteIdxs[0])
    // Wedge stop sits between the first note and the second note —
    // i.e. BEFORE the second (last) note, not after.
    expect(wedgeStopIdx).toBeGreaterThan(noteIdxs[0])
    expect(wedgeStopIdx).toBeLessThan(noteIdxs[noteIdxs.length - 1])
  })

  it('back-to-back wedges: span A stop emits BEFORE span B start on the shared event', () => {
    // A natural engraver handoff: wedge A ends at event 2, wedge B
    // starts at event 2. Within event 2's direction block, the stop
    // for A must come first ("close the open wedge"), then the
    // start for B ("now open the new one").
    const xml = scoreToMusicXml({
      title: 'Wedge handoff',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: 'evhand001', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
            { id: 'evhand002', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
            { id: 'evhand003', pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
          ],
        },
      ],
      spans: [
        {
          id: 'sphand001',
          kind: 'hairpin-cresc',
          startEventId: 'evhand001',
          endEventId: 'evhand002',
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'sphand002',
          kind: 'hairpin-dim',
          startEventId: 'evhand002',
          endEventId: 'evhand003',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const wedges = Array.from(doc.querySelectorAll('wedge')).map((w) => w.getAttribute('type'))
    // Emit order: A start (crescendo) → A stop → B start (diminuendo) → B stop.
    expect(wedges).toEqual(['crescendo', 'stop', 'diminuendo', 'stop'])
  })

  // ── Octave shifts ──────────────────────────────────────────────────

  it("8va emits <octave-shift type='down' size='8'/> (direction follows printed line)", () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spocta001',
          kind: '8va',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const shifts = doc.querySelectorAll('octave-shift')
    expect(shifts[0].getAttribute('type')).toBe('down')
    expect(shifts[0].getAttribute('size')).toBe('8')
    expect(shifts[1].getAttribute('type')).toBe('stop')
  })

  it("8vb emits <octave-shift type='up' size='8'/>", () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spocta002',
          kind: '8vb',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const shifts = doc.querySelectorAll('octave-shift')
    expect(shifts[0].getAttribute('type')).toBe('up')
    expect(shifts[0].getAttribute('size')).toBe('8')
  })

  it("15ma emits size='15' / type='down'", () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spocta003',
          kind: '15ma',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('octave-shift')?.getAttribute('size')).toBe('15')
    expect(doc.querySelector('octave-shift')?.getAttribute('type')).toBe('down')
  })

  it("15mb emits size='15' / type='up'", () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spocta004',
          kind: '15mb',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('octave-shift')?.getAttribute('size')).toBe('15')
    expect(doc.querySelector('octave-shift')?.getAttribute('type')).toBe('up')
  })

  // ── Pedal ──────────────────────────────────────────────────────────

  it('pedal emits <pedal type="start"/> and <pedal type="stop"/> with line="yes"', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'sppedal01',
          kind: 'pedal',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const pedals = doc.querySelectorAll('pedal')
    expect(pedals.length).toBe(2)
    expect(pedals[0].getAttribute('type')).toBe('start')
    expect(pedals[0].getAttribute('line')).toBe('yes')
    expect(pedals[1].getAttribute('type')).toBe('stop')
  })

  // ── Multi-kind interaction ─────────────────────────────────────────

  it('slur and wedge on the same event pair coexist', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spmulti01',
          kind: 'slur',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'spmulti02',
          kind: 'hairpin-cresc',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelectorAll('slur').length).toBe(2)
    expect(doc.querySelectorAll('wedge').length).toBe(2)
    // Both kinds get number=1 (separate namespaces).
    expect(doc.querySelector('slur')?.getAttribute('number')).toBe('1')
    expect(doc.querySelector('wedge')?.getAttribute('number')).toBe('1')
  })

  it('spans on the secondStaff bind to <staff>2</staff>', () => {
    const xml = scoreToMusicXml({
      title: 'Grand-staff with bass pedal',
      key: 'C',
      meter: '4/4',
      clef: 'treble',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          {
            events: [
              { id: 'evbass001', pitches: [{ step: 'C', octave: 3 }], duration: 'half' },
              { id: 'evbass002', pitches: [{ step: 'D', octave: 3 }], duration: 'half' },
            ],
          },
        ],
      },
      spans: [
        {
          id: 'sppedal02',
          kind: 'pedal',
          startEventId: 'evbass001',
          endEventId: 'evbass002',
          staffIdx: 1,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const pedalDirs = Array.from(doc.querySelectorAll('direction')).filter((d) =>
      d.querySelector('pedal'),
    )
    expect(pedalDirs.length).toBe(2)
    expect(pedalDirs[0].querySelector('staff')?.textContent).toBe('2')
    expect(pedalDirs[1].querySelector('staff')?.textContent).toBe('2')
  })

  it('span with a dangling endpoint id is silently skipped (no throw, no emit)', () => {
    // validateCrossRefs rejects dangling spans upstream, but the
    // export boundary trusts that invariant — skip the span rather
    // than throw, so a partially-constructed score can still emit.
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spdangle1',
          kind: 'slur',
          startEventId: 'eventaaa1',
          endEventId: 'nonexistent',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('slur')).toBeNull()
  })

  it('all SpanKind values produce some emit (no silent drops after PR-F)', () => {
    // Every kind in SpanKindSchema now has a MusicXML emit path.
    // Sanity-check the four legacy "deferred" cases still produce
    // SOMETHING in the document. (Glyph specifics are covered by
    // dedicated tests in their respective describe blocks.)
    for (const kind of ['glissando', 'trill-line', 'tremolo-between', 'accel', 'rit'] as const) {
      const xml = scoreToMusicXml({
        ...twoEventScoreWithIds(),
        spans: [
          {
            id: 'spcovers1',
            kind,
            startEventId: 'eventaaa1',
            endEventId: 'eventaaa2',
            staffIdx: 0,
            voiceIdx: 0,
          },
        ],
      })
      const doc = parseXml(xml)
      const sentinel =
        doc.querySelector('glissando') ??
        doc.querySelector('wavy-line') ??
        doc.querySelector('tremolo') ??
        doc.querySelector('dashes')
      expect(sentinel, `${kind} should produce a span emit`).not.toBeNull()
    }
  })

  it('slur on the same chord as a tie + articulation: notations order is tied → slur → articulations', () => {
    const xml = scoreToMusicXml({
      title: 'Combined notations on chord',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'evnotn001',
              pitches: [
                { step: 'C', octave: 4, tied_to_next: true },
                { step: 'E', octave: 4 },
              ],
              duration: 'half',
              articulation: 'accent',
            },
            {
              id: 'evnotn002',
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
              ],
              duration: 'half',
            },
          ],
        },
      ],
      spans: [
        {
          id: 'spcombi01',
          kind: 'slur',
          startEventId: 'evnotn001',
          endEventId: 'evnotn002',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const firstNote = doc.querySelectorAll('note')[0]
    const notations = firstNote.querySelector('notations')!
    const children = Array.from(notations.children)
    // MusicXML 4.0 content order: tied → slur → articulations.
    const tagOrder = children.map((c) => c.tagName)
    const tiedIdx = tagOrder.indexOf('tied')
    const slurIdx = tagOrder.indexOf('slur')
    const artIdx = tagOrder.indexOf('articulations')
    expect(tiedIdx).toBeLessThan(slurIdx)
    expect(slurIdx).toBeLessThan(artIdx)
  })
})

describe('scoreToMusicXml — glissando / trill-line / tremolo-between spans (M22-PR-E)', () => {
  function twoEventScoreWithIds(): Score {
    return {
      title: 'Ornament spans',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: 'evgggg001', pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
            { id: 'evgggg002', pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    }
  }

  // ── Glissando ──────────────────────────────────────────────────────

  it('glissando emits <glissando type="start"> on the first event and "stop" on the last', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spgliss01',
          kind: 'glissando',
          startEventId: 'evgggg001',
          endEventId: 'evgggg002',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const glissandi = doc.querySelectorAll('glissando')
    expect(glissandi.length).toBe(2)
    expect(glissandi[0].getAttribute('type')).toBe('start')
    expect(glissandi[1].getAttribute('type')).toBe('stop')
  })

  it('glissStyle=wavy (default) emits line-type=wavy; glissStyle=straight emits line-type=solid', () => {
    for (const [style, lineType] of [
      ['wavy', 'wavy'],
      ['straight', 'solid'],
      [undefined, 'wavy'], // default
    ] as const) {
      const xml = scoreToMusicXml({
        ...twoEventScoreWithIds(),
        spans: [
          {
            id: 'spglissXX',
            kind: 'glissando',
            startEventId: 'evgggg001',
            endEventId: 'evgggg002',
            staffIdx: 0,
            voiceIdx: 0,
            ...(style !== undefined ? { glissStyle: style } : {}),
          },
        ],
      })
      const doc = parseXml(xml)
      expect(
        doc.querySelector('glissando')?.getAttribute('line-type'),
        `for glissStyle=${style ?? 'undefined'}`,
      ).toBe(lineType)
    }
  })

  it('glissText=true emits the "gliss." label as element text content', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spgliss02',
          kind: 'glissando',
          startEventId: 'evgggg001',
          endEventId: 'evgggg002',
          staffIdx: 0,
          voiceIdx: 0,
          glissText: true,
        },
      ],
    })
    const doc = parseXml(xml)
    // Both endpoints carry the label text per MusicXML readers
    // (engraver paints the label above the line; readers parse it
    // from either endpoint).
    const glissandi = doc.querySelectorAll('glissando')
    expect(glissandi[0].textContent).toBe('gliss.')
    expect(glissandi[1].textContent).toBe('gliss.')
  })

  it('glissText omitted/false emits no element text (self-closing)', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spgliss03',
          kind: 'glissando',
          startEventId: 'evgggg001',
          endEventId: 'evgggg002',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const glissandi = doc.querySelectorAll('glissando')
    expect(glissandi[0].textContent).toBe('')
  })

  it('glissando placement attribute propagates from span.placement', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spgliss04',
          kind: 'glissando',
          startEventId: 'evgggg001',
          endEventId: 'evgggg002',
          staffIdx: 0,
          voiceIdx: 0,
          placement: 'above',
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('glissando')?.getAttribute('placement')).toBe('above')
  })

  // ── Trill-line ─────────────────────────────────────────────────────

  it('trill-line emits <trill-mark/> + <wavy-line type="start"> on the first event', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'sptril001',
          kind: 'trill-line',
          startEventId: 'evgggg001',
          endEventId: 'evgggg002',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    const startOrnaments = notes[0].querySelector('notations > ornaments')!
    expect(startOrnaments.querySelector('trill-mark')).not.toBeNull()
    expect(startOrnaments.querySelector('wavy-line')?.getAttribute('type')).toBe('start')
  })

  it('trill-line emits <wavy-line type="stop"> WITHOUT <trill-mark/> on the last event', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'sptril002',
          kind: 'trill-line',
          startEventId: 'evgggg001',
          endEventId: 'evgggg002',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    const stopOrnaments = notes[1].querySelector('notations > ornaments')!
    expect(stopOrnaments.querySelector('trill-mark')).toBeNull()
    expect(stopOrnaments.querySelector('wavy-line')?.getAttribute('type')).toBe('stop')
  })

  // ── Tremolo-between ────────────────────────────────────────────────

  it('tremolo-between emits <tremolo type=start>3</tremolo> + matching stop', () => {
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'sptrem001',
          kind: 'tremolo-between',
          startEventId: 'evgggg001',
          endEventId: 'evgggg002',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const tremolos = doc.querySelectorAll('ornaments > tremolo')
    expect(tremolos.length).toBe(2)
    expect(tremolos[0].getAttribute('type')).toBe('start')
    expect(tremolos[0].textContent).toBe('3')
    expect(tremolos[1].getAttribute('type')).toBe('stop')
    expect(tremolos[1].textContent).toBe('3')
  })

  it('trill-line and tremolo-between share the <ornaments> wrapper when both apply to the same event', () => {
    // Both spans share start at evgggg001. Both should land inside
    // the same single <ornaments> wrapper (not two adjacent ones).
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spmix0001',
          kind: 'trill-line',
          startEventId: 'evgggg001',
          endEventId: 'evgggg002',
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'spmix0002',
          kind: 'tremolo-between',
          startEventId: 'evgggg001',
          endEventId: 'evgggg002',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    const ornaments = notes[0].querySelectorAll('ornaments')
    expect(ornaments.length).toBe(1)
    expect(ornaments[0].querySelector('trill-mark')).not.toBeNull()
    expect(ornaments[0].querySelector('wavy-line')).not.toBeNull()
    expect(ornaments[0].querySelector('tremolo')).not.toBeNull()
  })

  // ── Notation-class span numbering ──────────────────────────────────

  it('multiple glissandi get distinct number= values (1, 2)', () => {
    const xml = scoreToMusicXml({
      title: 'Two glissandi',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: 'evxxxx001', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
            { id: 'evxxxx002', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
            { id: 'evxxxx003', pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
          ],
        },
      ],
      spans: [
        {
          id: 'spovrlap01',
          kind: 'glissando',
          startEventId: 'evxxxx001',
          endEventId: 'evxxxx002',
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'spovrlap02',
          kind: 'glissando',
          startEventId: 'evxxxx002',
          endEventId: 'evxxxx003',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const numbers = new Set(
      Array.from(doc.querySelectorAll('glissando')).map((g) => g.getAttribute('number')),
    )
    expect(numbers.size).toBe(2)
    expect(numbers.has('1')).toBe(true)
    expect(numbers.has('2')).toBe(true)
  })

  it('glissando and slur on the same event pair use independent number namespaces', () => {
    // Two notation-class spans of different MusicXML element types
    // (slur vs glissando) live in independent <number=> namespaces;
    // both can be #1 without conflict.
    const xml = scoreToMusicXml({
      ...twoEventScoreWithIds(),
      spans: [
        {
          id: 'spcombi01',
          kind: 'slur',
          startEventId: 'evgggg001',
          endEventId: 'evgggg002',
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'spcombi02',
          kind: 'glissando',
          startEventId: 'evgggg001',
          endEventId: 'evgggg002',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('slur')?.getAttribute('number')).toBe('1')
    expect(doc.querySelector('glissando')?.getAttribute('number')).toBe('1')
  })

  // ── Notations element-order pinning ───────────────────────────────

  it('notations content order: tied → slur → glissando → ornaments → articulations → fermata', () => {
    // Saturate one event with every kind of notations child to verify
    // the spec-mandated content order.
    const xml = scoreToMusicXml({
      title: 'Saturated notations',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'evsatuuu1',
              pitches: [{ step: 'C', octave: 4, tied_to_next: true }],
              duration: 'half',
              articulation: 'accent',
              fermata: 'standard',
            },
            { id: 'evsatuuu2', pitches: [{ step: 'D', octave: 4 }], duration: 'half' },
          ],
        },
      ],
      spans: [
        {
          id: 'spsatslr1',
          kind: 'slur',
          startEventId: 'evsatuuu1',
          endEventId: 'evsatuuu2',
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'spsatgli1',
          kind: 'glissando',
          startEventId: 'evsatuuu1',
          endEventId: 'evsatuuu2',
          staffIdx: 0,
          voiceIdx: 0,
        },
        {
          id: 'spsattri1',
          kind: 'trill-line',
          startEventId: 'evsatuuu1',
          endEventId: 'evsatuuu2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const notations = doc.querySelectorAll('note')[0].querySelector('notations')!
    const children = Array.from(notations.children).map((c) => c.tagName)
    // Expect order: tied → slur → glissando → ornaments → articulations → fermata.
    expect(children.indexOf('tied')).toBeLessThan(children.indexOf('slur'))
    expect(children.indexOf('slur')).toBeLessThan(children.indexOf('glissando'))
    expect(children.indexOf('glissando')).toBeLessThan(children.indexOf('ornaments'))
    expect(children.indexOf('ornaments')).toBeLessThan(children.indexOf('articulations'))
    expect(children.indexOf('articulations')).toBeLessThan(children.indexOf('fermata'))
  })

  // ── Multi-staff binding ───────────────────────────────────────────

  it('ornament spans on secondStaff land on that staff (notations-class spans inherit by event location)', () => {
    // Glissando/trill/tremolo are inside <notations> on the note, so
    // they automatically follow the note's <staff> assignment — no
    // separate staff binding needed at the span layer.
    const xml = scoreToMusicXml({
      title: 'Bass-staff glissando',
      key: 'C',
      meter: '4/4',
      clef: 'treble',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          {
            events: [
              { id: 'evbasss01', pitches: [{ step: 'C', octave: 3 }], duration: 'half' },
              { id: 'evbasss02', pitches: [{ step: 'G', octave: 2 }], duration: 'half' },
            ],
          },
        ],
      },
      spans: [
        {
          id: 'spbgliss1',
          kind: 'glissando',
          startEventId: 'evbasss01',
          endEventId: 'evbasss02',
          staffIdx: 1,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    // notes[0] is treble; notes[1..2] are bass with the glissando.
    expect(notes[1].querySelector('staff')?.textContent).toBe('2')
    expect(notes[1].querySelector('notations > glissando')?.getAttribute('type')).toBe('start')
    expect(notes[2].querySelector('staff')?.textContent).toBe('2')
    expect(notes[2].querySelector('notations > glissando')?.getAttribute('type')).toBe('stop')
  })
})

describe('scoreToMusicXml — repeats / voltas / jumps (M22-PR-G)', () => {
  function fourBarScore(overrides: Partial<Score> = {}): Score {
    return {
      title: 'Repeats',
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
      ],
      ...overrides,
    }
  }

  // ── Repeat barlines ────────────────────────────────────────────────

  it("repeat-start emits <barline location='left'> with <repeat direction='forward'/>", () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      measures: [
        {
          events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
          startBarline: 'repeat-start',
        },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      ],
    })
    const doc = parseXml(xml)
    const measure = doc.querySelector('measure')!
    const leftBar = measure.querySelector('barline[location="left"]')!
    expect(leftBar.querySelector('bar-style')?.textContent).toBe('heavy-light')
    expect(leftBar.querySelector('repeat')?.getAttribute('direction')).toBe('forward')
  })

  it("repeat-end emits <barline location='right'> with <repeat direction='backward'/>", () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        {
          events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }],
          endBarline: 'repeat-end',
        },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('measure')
    const rightBar = measures[1].querySelector('barline[location="right"]')!
    expect(rightBar.querySelector('bar-style')?.textContent).toBe('light-heavy')
    expect(rightBar.querySelector('repeat')?.getAttribute('direction')).toBe('backward')
  })

  it('non-repeat barlines map to MusicXML bar-style values', () => {
    const cases: Array<[
      'double' | 'final' | 'dashed' | 'invisible',
      string,
    ]> = [
      ['double', 'light-light'],
      ['final', 'light-heavy'],
      ['dashed', 'dashed'],
      ['invisible', 'none'],
    ]
    for (const [barline, expected] of cases) {
      const xml = scoreToMusicXml({
        ...fourBarScore(),
        measures: [
          {
            events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
            endBarline: barline,
          },
        ],
      })
      const doc = parseXml(xml)
      const rightBar = doc.querySelector('barline[location="right"]')!
      expect(rightBar.querySelector('bar-style')?.textContent, `for ${barline}`).toBe(expected)
    }
  })

  it("thin barline (or unset) emits no <barline> block", () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      measures: [
        {
          events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
          endBarline: 'thin',
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('barline')).toBeNull()
  })

  // ── Voltas ─────────────────────────────────────────────────────────

  it('volta emits <ending type="start"> on left of startMeasureIdx and <ending type="stop"> on right of endMeasureIdx', () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      voltas: [
        {
          id: 'volta01aa',
          startMeasureIdx: 1,
          endMeasureIdx: 2,
          endings: [1],
        },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('measure')
    // Volta starts at measure idx 1 → its left barline carries ending start.
    const startEnding = measures[1]
      .querySelector('barline[location="left"] > ending')!
    expect(startEnding.getAttribute('type')).toBe('start')
    expect(startEnding.getAttribute('number')).toBe('1')
    // Volta ends at measure idx 2 → its right barline carries ending stop.
    const stopEnding = measures[2]
      .querySelector('barline[location="right"] > ending')!
    expect(stopEnding.getAttribute('type')).toBe('stop')
  })

  it('multi-pass endings (endings=[1,2]) emit a comma-separated number= attribute', () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      voltas: [
        {
          id: 'volta02aa',
          startMeasureIdx: 1,
          endMeasureIdx: 1,
          endings: [1, 2],
        },
      ],
    })
    const doc = parseXml(xml)
    const ending = doc.querySelector('ending')!
    expect(ending.getAttribute('number')).toBe('1,2')
  })

  it("endHook='open' emits type='discontinue' on the right ending", () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      voltas: [
        {
          id: 'volta03aa',
          startMeasureIdx: 1,
          endMeasureIdx: 1,
          endings: [1],
          endHook: 'open',
        },
      ],
    })
    const doc = parseXml(xml)
    const rightEnding = doc.querySelector(
      'barline[location="right"] > ending',
    )!
    expect(rightEnding.getAttribute('type')).toBe('discontinue')
  })

  it('volta text label propagates to ending text attribute', () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      voltas: [
        {
          id: 'volta04aa',
          startMeasureIdx: 1,
          endMeasureIdx: 1,
          endings: [1],
          text: 'First time',
        },
      ],
    })
    const doc = parseXml(xml)
    const startEnding = doc.querySelector(
      'barline[location="left"] > ending',
    )!
    expect(startEnding.getAttribute('text')).toBe('First time')
  })

  it('volta start AND repeat-end can coexist on the same measure boundary', () => {
    // Classic ballad pattern: bar 4 has a repeat-end (back to repeat-
    // start) AND opens the volta for the second-time alternate.
    // The left barline of bar 4 (volta start) and the right barline
    // of bar 3 (repeat-end) live in DIFFERENT measure children, so
    // both can express simultaneously.
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      measures: [
        {
          events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
          startBarline: 'repeat-start',
        },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
        {
          events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }],
          endBarline: 'repeat-end',
        },
        { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
      ],
      voltas: [
        {
          id: 'voltacomp',
          startMeasureIdx: 3,
          endMeasureIdx: 3,
          endings: [2],
        },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('measure')
    expect(
      measures[2].querySelector('barline[location="right"] > repeat')?.getAttribute('direction'),
    ).toBe('backward')
    expect(
      measures[3].querySelector('barline[location="left"] > ending')?.getAttribute('type'),
    ).toBe('start')
  })

  // ── Jump markers (D.C., D.S., Fine, To Coda) ──────────────────────

  it("D.C. al Fine emits <words> + <sound dacapo='yes'/>", () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      jumpMarkers: [
        {
          id: 'jumpdcaa1',
          measureIdx: 3,
          side: 'end',
          kind: 'D.C. al Fine',
        },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('measure')
    const dir = Array.from(measures[3].querySelectorAll('direction')).find(
      (d) => d.querySelector('words')?.textContent === 'D.C. al Fine',
    )!
    expect(dir).toBeDefined()
    expect(dir.querySelector('sound')?.getAttribute('dacapo')).toBe('yes')
  })

  it("D.S. al Coda with segnoRef emits <sound dalsegno='segno_<ref>'/>", () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      jumpMarkers: [
        {
          id: 'jumpds001',
          measureIdx: 3,
          side: 'end',
          kind: 'D.S. al Coda',
          segnoRef: 'whatever1',
        },
      ],
    })
    const doc = parseXml(xml)
    const dir = Array.from(doc.querySelectorAll('direction')).find(
      (d) => d.querySelector('words')?.textContent === 'D.S. al Coda',
    )!
    // segnoRef threads through as the dalsegno attribute, prefixed
    // to avoid collisions with coda IDs sharing the same string.
    expect(dir.querySelector('sound')?.getAttribute('dalsegno')).toBe('segno_whatever1')
  })

  it("D.S.* without segnoRef falls back to dalsegno='segno' (MuseScore default)", () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      jumpMarkers: [
        {
          id: 'jumpds002',
          measureIdx: 3,
          side: 'end',
          kind: 'D.S.',
        },
      ],
    })
    const doc = parseXml(xml)
    const dir = Array.from(doc.querySelectorAll('direction')).find(
      (d) => d.querySelector('words')?.textContent === 'D.S.',
    )!
    expect(dir.querySelector('sound')?.getAttribute('dalsegno')).toBe('segno')
  })

  it("Fine emits <sound fine='yes'/>", () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      jumpMarkers: [
        {
          id: 'jumpfin01',
          measureIdx: 1,
          side: 'end',
          kind: 'Fine',
        },
      ],
    })
    const doc = parseXml(xml)
    const dir = Array.from(doc.querySelectorAll('direction')).find(
      (d) => d.querySelector('words')?.textContent === 'Fine',
    )!
    expect(dir.querySelector('sound')?.getAttribute('fine')).toBe('yes')
  })

  it("To Coda with codaRef emits <sound tocoda='coda_<ref>'/>", () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      jumpMarkers: [
        {
          id: 'jumptoco1',
          measureIdx: 1,
          side: 'end',
          kind: 'To Coda',
          codaRef: 'whatever2',
        },
      ],
    })
    const doc = parseXml(xml)
    const dir = Array.from(doc.querySelectorAll('direction')).find(
      (d) => d.querySelector('words')?.textContent === 'To Coda',
    )!
    expect(dir.querySelector('sound')?.getAttribute('tocoda')).toBe('coda_whatever2')
  })

  it('segno glyph carries id=segno_<markerId>; D.S. dalsegno points at the same id (multi-segno round-trip)', () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      segnoMarkers: [
        { id: 'segno12ab', measureIdx: 1, side: 'start' },
      ],
      jumpMarkers: [
        {
          id: 'jumpmulti',
          measureIdx: 3,
          side: 'end',
          kind: 'D.S. al Fine',
          segnoRef: 'segno12ab',
        },
      ],
    })
    const doc = parseXml(xml)
    // The segno glyph carries the id; D.S. al Fine's dalsegno points
    // at the same id so multi-segno scores round-trip with unambiguous
    // jump targets.
    expect(doc.querySelector('segno')?.getAttribute('id')).toBe('segno_segno12ab')
    const dir = Array.from(doc.querySelectorAll('direction')).find(
      (d) => d.querySelector('words')?.textContent === 'D.S. al Fine',
    )!
    expect(dir.querySelector('sound')?.getAttribute('dalsegno')).toBe('segno_segno12ab')
  })

  it('jump marker with side=end emits AFTER notes but BEFORE right barline', () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      measures: [
        {
          events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
          endBarline: 'final',
        },
      ],
      jumpMarkers: [
        {
          id: 'jumporder',
          measureIdx: 0,
          side: 'end',
          kind: 'Fine',
        },
      ],
    })
    const doc = parseXml(xml)
    const measure = doc.querySelector('measure')!
    const children = Array.from(measure.children)
    const noteIdx = children.findIndex((c) => c.tagName === 'note')
    const jumpDirIdx = children.findIndex(
      (c) =>
        c.tagName === 'direction' && c.querySelector('words')?.textContent === 'Fine',
    )
    const barlineIdx = children.findIndex(
      (c) => c.tagName === 'barline' && c.getAttribute('location') === 'right',
    )
    expect(jumpDirIdx).toBeGreaterThan(noteIdx)
    expect(jumpDirIdx).toBeLessThan(barlineIdx)
  })

  // ── Segno / Coda glyphs ────────────────────────────────────────────

  it('segno marker emits <direction><segno/>', () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      segnoMarkers: [
        { id: 'segno0001', measureIdx: 1, side: 'start' },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('measure')
    expect(
      measures[1].querySelector('direction > direction-type > segno'),
    ).not.toBeNull()
  })

  it('coda marker emits <direction><coda/>', () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      codaMarkers: [
        { id: 'coda0001a', measureIdx: 2, side: 'start' },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('measure')
    expect(
      measures[2].querySelector('direction > direction-type > coda'),
    ).not.toBeNull()
  })

  it('segno + D.S. + coda together emit a complete jump structure', () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      segnoMarkers: [
        { id: 'segnoabc1', measureIdx: 1, side: 'start' },
      ],
      jumpMarkers: [
        {
          id: 'jumpds02b',
          measureIdx: 3,
          side: 'end',
          kind: 'D.S. al Coda',
          segnoRef: 'segnoabc1',
        },
      ],
      codaMarkers: [
        { id: 'codaaa01a', measureIdx: 2, side: 'start' },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('segno')).not.toBeNull()
    expect(doc.querySelector('coda')).not.toBeNull()
    const dsDir = Array.from(doc.querySelectorAll('direction')).find(
      (d) => d.querySelector('words')?.textContent === 'D.S. al Coda',
    )
    expect(dsDir).toBeDefined()
  })

  // ── repeat-both boundary spread ───────────────────────────────────

  it('endBarline=repeat-both emits backward repeat AND propagates a forward repeat to the next measure', () => {
    // A repeat-both glyph on the boundary between measures 0 and 1
    // means "this measure ends a repeat AND the next measure starts
    // a repeat." MusicXML expresses the close on bar 0's right edge
    // and the open on bar 1's left edge; most readers render them
    // as one visual ":|:" glyph.
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      measures: [
        {
          events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
          endBarline: 'repeat-both',
        },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('measure')
    // bar 0 right: light-heavy + backward repeat (the CLOSE half).
    const rightBar = measures[0].querySelector('barline[location="right"]')!
    expect(rightBar.querySelector('bar-style')?.textContent).toBe('light-heavy')
    expect(rightBar.querySelector('repeat')?.getAttribute('direction')).toBe('backward')
    // bar 1 left: forward repeat without an explicit bar-style — the
    // forward half is the only thing that spreads across the boundary
    // (bar-style stays on the source side).
    const leftBar = measures[1].querySelector('barline[location="left"]')!
    expect(leftBar.querySelector('repeat')?.getAttribute('direction')).toBe('forward')
  })

  it('startBarline=repeat-both propagates a backward repeat to the previous measure', () => {
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        {
          events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }],
          startBarline: 'repeat-both',
        },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('measure')
    // bar 0 right: backward repeat (the implicit CLOSE half).
    expect(
      measures[0].querySelector('barline[location="right"] > repeat')?.getAttribute('direction'),
    ).toBe('backward')
    // bar 1 left: heavy-light + forward repeat.
    const leftBar = measures[1].querySelector('barline[location="left"]')!
    expect(leftBar.querySelector('bar-style')?.textContent).toBe('heavy-light')
    expect(leftBar.querySelector('repeat')?.getAttribute('direction')).toBe('forward')
  })

  it('repeat-both on the first measure right does NOT emit a phantom forward repeat past the score end', () => {
    // Defensive: boundary spread checks for next-measure existence.
    const xml = scoreToMusicXml({
      ...fourBarScore(),
      measures: [
        {
          events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
          endBarline: 'repeat-both',
        },
      ],
    })
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('measure')
    expect(measures.length).toBe(1)
    // Backward repeat on the only measure's right; no extra phantom
    // measure or barline emitted past it.
    const rightBar = measures[0].querySelector('barline[location="right"]')!
    expect(rightBar.querySelector('repeat')?.getAttribute('direction')).toBe('backward')
  })
})

describe('scoreToMusicXml — tuplets + grace notes (M22-PR-I)', () => {
  // ── Tuplets ────────────────────────────────────────────────────────

  it('triplet of eighth notes emits adaptive divisions and tuplet-adjusted durations', () => {
    // Triplet of 3 eighths in time of 2 eighths = one quarter note's
    // worth. With base divisions=8 (per quarter) and triplet multiplier
    // of 3 → divisions=24. Each triplet eighth's duration = 8.
    const xml = scoreToMusicXml({
      title: 'Triplet',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('attributes > divisions')?.textContent).toBe('24')
    const notes = doc.querySelectorAll('note')
    // Triplet eighths: duration = 8 each
    expect(notes[0].querySelector('duration')?.textContent).toBe('8')
    expect(notes[1].querySelector('duration')?.textContent).toBe('8')
    expect(notes[2].querySelector('duration')?.textContent).toBe('8')
    // Non-tuplet quarter: duration = 24
    expect(notes[3].querySelector('duration')?.textContent).toBe('24')
    // Non-tuplet half: duration = 48
    expect(notes[4].querySelector('duration')?.textContent).toBe('48')
  })

  it('tuplet event emits <time-modification> with actual=N and normal=2 (triplet)', () => {
    const xml = scoreToMusicXml({
      title: 'Triplet time-mod',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    const timeMod = notes[0].querySelector('time-modification')!
    expect(timeMod.querySelector('actual-notes')?.textContent).toBe('3')
    expect(timeMod.querySelector('normal-notes')?.textContent).toBe('2')
    // Non-tuplet notes don't carry <time-modification>.
    expect(notes[3].querySelector('time-modification')).toBeNull()
  })

  it('5/6/7-tuplets map to normal=4', () => {
    for (const t of [5, 6, 7] as const) {
      const xml = scoreToMusicXml({
        title: 'tuplet variants',
        key: 'C',
        meter: '32/4', // big bar to accommodate
        measures: [
          {
            events: Array.from({ length: t }, () => ({
              pitches: [{ step: 'C' as const, octave: 4 }],
              duration: 'eighth' as const,
              tuplet: t,
            })),
          },
        ],
      })
      const doc = parseXml(xml)
      const tm = doc.querySelector('time-modification')!
      expect(tm.querySelector('actual-notes')?.textContent).toBe(String(t))
      expect(tm.querySelector('normal-notes')?.textContent, `for ${t}`).toBe('4')
    }
  })

  it('tuplet start/stop bracket markers emit on first and last tuplet events only', () => {
    const xml = scoreToMusicXml({
      title: 'Triplet bracket',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    // First triplet event: <tuplet type="start"/>
    expect(
      notes[0].querySelector('notations > tuplet')?.getAttribute('type'),
    ).toBe('start')
    // Middle event: no <tuplet> marker
    expect(notes[1].querySelector('notations > tuplet')).toBeNull()
    // Last triplet event: <tuplet type="stop"/>
    expect(
      notes[2].querySelector('notations > tuplet')?.getAttribute('type'),
    ).toBe('stop')
  })

  it('mixed triplet + quintuplet scores get multiplier = LCM(3, 5) = 15', () => {
    const xml = scoreToMusicXml({
      title: 'Mixed tuplets',
      key: 'C',
      meter: '32/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'F', octave: 4 }], duration: 'sixteenth', tuplet: 5 },
            { pitches: [{ step: 'G', octave: 4 }], duration: 'sixteenth', tuplet: 5 },
            { pitches: [{ step: 'A', octave: 4 }], duration: 'sixteenth', tuplet: 5 },
            { pitches: [{ step: 'B', octave: 4 }], duration: 'sixteenth', tuplet: 5 },
            { pitches: [{ step: 'C', octave: 5 }], duration: 'sixteenth', tuplet: 5 },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    // base 8 * LCM(3, 5) = 120
    expect(doc.querySelector('divisions')?.textContent).toBe('120')
    const notes = doc.querySelectorAll('note')
    // Triplet eighth at base=60 (eighth = quarter/2 = 120/2): each = 60 * 2 / 3 = 40
    expect(notes[0].querySelector('duration')?.textContent).toBe('40')
    // Quintuplet sixteenth at base=30 (16th = quarter/4 = 30): each = 30 * 4 / 5 = 24
    expect(notes[3].querySelector('duration')?.textContent).toBe('24')
  })

  it('non-tuplet scores preserve divisions=8 (no regression)', () => {
    // Backward compat: scores with no tuplets stay at the historical
    // divisions=8 emit shape.
    const xml = scoreToMusicXml({
      title: 'No tuplets',
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('divisions')?.textContent).toBe('8')
  })

  it('tuplet on a chord-stack: time-modification on every chord pitch but tuplet bracket only on chord-anchor', () => {
    const xml = scoreToMusicXml({
      title: 'Chord triplet',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
                { step: 'G', octave: 4 },
              ],
              duration: 'eighth',
              tuplet: 3,
            },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    // Each chord note carries <time-modification>...
    expect(notes[0].querySelector('time-modification')).not.toBeNull()
    expect(notes[1].querySelector('time-modification')).not.toBeNull()
    expect(notes[2].querySelector('time-modification')).not.toBeNull()
    // ...but only the chord-anchor (notes[0]) carries the tuplet bracket start.
    expect(notes[0].querySelector('notations > tuplet')?.getAttribute('type')).toBe('start')
    expect(notes[1].querySelector('notations > tuplet')).toBeNull()
    expect(notes[2].querySelector('notations > tuplet')).toBeNull()
  })

  // ── Grace notes ────────────────────────────────────────────────────

  it('a single grace note emits <note><grace/> before the principal', () => {
    const xml = scoreToMusicXml({
      title: 'Grace',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'D', octave: 4 }],
              duration: 'half',
              graceNotes: [
                { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth' },
              ],
            },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    // Grace + principal + follower = 3 notes
    expect(notes.length).toBe(3)
    // First is the grace
    expect(notes[0].querySelector('grace')).not.toBeNull()
    expect(notes[0].querySelector('pitch > step')?.textContent).toBe('C')
    // Grace has no <duration>
    expect(notes[0].querySelector('duration')).toBeNull()
    // Principal follows
    expect(notes[1].querySelector('grace')).toBeNull()
    expect(notes[1].querySelector('pitch > step')?.textContent).toBe('D')
  })

  it("acciaccatura (slashed=true) emits <grace slash='yes'/>", () => {
    const xml = scoreToMusicXml({
      title: 'Acciaccatura',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'D', octave: 4 }],
              duration: 'half',
              graceNotes: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'eighth',
                  slashed: true,
                },
              ],
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('grace')?.getAttribute('slash')).toBe('yes')
  })

  it('grace duration maps to <type>: sixteenth → 16th', () => {
    for (const [d, expected] of [
      ['eighth', 'eighth'],
      ['sixteenth', '16th'],
      ['32nd', '32nd'],
    ] as const) {
      const xml = scoreToMusicXml({
        title: 'Grace types',
        key: 'C',
        meter: '4/4',
        measures: [
          {
            events: [
              {
                pitches: [{ step: 'D', octave: 4 }],
                duration: 'half',
                graceNotes: [
                  { pitches: [{ step: 'C', octave: 4 }], duration: d },
                ],
              },
            ],
          },
        ],
      })
      const doc = parseXml(xml)
      expect(doc.querySelector('note')?.querySelector('type')?.textContent, `for ${d}`).toBe(expected)
    }
  })

  it('multiple grace notes (a grace RUN) emit in sequence before the principal', () => {
    const xml = scoreToMusicXml({
      title: 'Grace run',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'E', octave: 4 }],
              duration: 'half',
              graceNotes: [
                { pitches: [{ step: 'C', octave: 4 }], duration: 'sixteenth' },
                { pitches: [{ step: 'D', octave: 4 }], duration: 'sixteenth' },
              ],
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    expect(notes.length).toBe(3)
    expect(notes[0].querySelector('grace')).not.toBeNull()
    expect(notes[0].querySelector('pitch > step')?.textContent).toBe('C')
    expect(notes[1].querySelector('grace')).not.toBeNull()
    expect(notes[1].querySelector('pitch > step')?.textContent).toBe('D')
    expect(notes[2].querySelector('grace')).toBeNull()
    expect(notes[2].querySelector('pitch > step')?.textContent).toBe('E')
  })

  it('a grace CHORD emits multi-pitch grace with <chord/> on follow pitches', () => {
    const xml = scoreToMusicXml({
      title: 'Grace chord',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'F', octave: 4 }],
              duration: 'half',
              graceNotes: [
                {
                  pitches: [
                    { step: 'C', octave: 4 },
                    { step: 'E', octave: 4 },
                  ],
                  duration: 'eighth',
                },
              ],
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    // 2 grace pitches + 1 principal = 3 notes.
    expect(notes.length).toBe(3)
    expect(notes[0].querySelector('grace')).not.toBeNull()
    expect(notes[0].querySelector('chord')).toBeNull()
    expect(notes[1].querySelector('grace')).not.toBeNull()
    expect(notes[1].querySelector('chord')).not.toBeNull()
  })

  it('grace notes carry the principal\'s <voice> and <staff>', () => {
    const xml = scoreToMusicXml({
      title: 'Grace voice/staff',
      key: 'C',
      meter: '4/4',
      clef: 'treble',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          {
            events: [
              {
                pitches: [{ step: 'D', octave: 3 }],
                duration: 'half',
                graceNotes: [
                  { pitches: [{ step: 'C', octave: 3 }], duration: 'eighth' },
                ],
              },
              { pitches: [{ step: 'E', octave: 3 }], duration: 'half' },
            ],
          },
        ],
      },
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    // notes[0]=treble, notes[1]=bass grace, notes[2]=bass principal, notes[3]=bass follower.
    expect(notes[1].querySelector('grace')).not.toBeNull()
    expect(notes[1].querySelector('staff')?.textContent).toBe('2')
    expect(notes[1].querySelector('voice')?.textContent).toBe('1')
  })

  it('grace notes do NOT contribute to the voice walk\'s <backup> duration', () => {
    // Backup math used to sum durationToDivisions(e.duration); confirm
    // tuplet-aware tupletAdjustedDivisions doesn't accidentally pick
    // up the grace note's "type" duration and skew the backup.
    const xml = scoreToMusicXml({
      title: 'Grace + grand-staff backup',
      key: 'C',
      meter: '4/4',
      clef: 'treble',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 5 }],
              duration: 'whole',
              graceNotes: [
                { pitches: [{ step: 'D', octave: 5 }], duration: 'sixteenth' },
              ],
            },
          ],
        },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
        ],
      },
    })
    const doc = parseXml(xml)
    // Backup should equal the principal's full duration (32), not
    // 32 + sixteenth (= 34).
    expect(doc.querySelector('backup > duration')?.textContent).toBe('32')
  })

  // ── Bracket count for adjacent same-ratio tuplets ─────────────────

  it('two consecutive triplets emit TWO bracket starts (not one bracket of 6)', () => {
    // Six adjacent triplet eighths should engrave as TWO separate
    // brackets (3+3), not one 6-event bracket. The boundary detection
    // uses count-based group closing so we don't merge same-ratio
    // adjacent groups.
    const xml = scoreToMusicXml({
      title: 'Two triplets',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'G', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'A', octave: 4 }], duration: 'eighth', tuplet: 3 },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const brackets = Array.from(doc.querySelectorAll('notations > tuplet'))
    const starts = brackets.filter((b) => b.getAttribute('type') === 'start')
    const stops = brackets.filter((b) => b.getAttribute('type') === 'stop')
    // Two triplet groups → two starts + two stops.
    expect(starts.length).toBe(2)
    expect(stops.length).toBe(2)
  })

  it('incomplete tuplet run (4 triplet eighths) closes both groups gracefully', () => {
    // 4 triplet eighths: first 3 form a complete triplet, 4th is
    // an incomplete group of 1. Expected: 2 starts + 2 stops (the
    // single-event group still closes its own bracket).
    const xml = scoreToMusicXml({
      title: 'Incomplete triplet',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth', tuplet: 3 },
            // Plus filler so this is a complete measure visually.
            { pitches: [{ step: 'G', octave: 4 }], duration: 'eighth' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const brackets = Array.from(doc.querySelectorAll('notations > tuplet'))
    const starts = brackets.filter((b) => b.getAttribute('type') === 'start')
    const stops = brackets.filter((b) => b.getAttribute('type') === 'stop')
    expect(starts.length).toBe(2)
    expect(stops.length).toBe(2)
  })

  it('grace + tuplet: graces emit before the tuplet principal, principal still gets <time-modification>', () => {
    // Combined: a tuplet event whose principal carries graceNotes.
    // The graces emit before the tuplet principal (with NO
    // <time-modification> on the graces themselves); the principal
    // keeps its tuplet duration and time-modification.
    const xml = scoreToMusicXml({
      title: 'Grace + triplet',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'eighth',
              tuplet: 3,
              graceNotes: [
                { pitches: [{ step: 'B', octave: 3 }], duration: 'eighth' },
              ],
            },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
            { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    // notes[0]: grace; notes[1]: triplet principal (C, eighth, with time-modification)
    expect(notes[0].querySelector('grace')).not.toBeNull()
    expect(notes[0].querySelector('time-modification')).toBeNull()
    expect(notes[1].querySelector('grace')).toBeNull()
    expect(notes[1].querySelector('time-modification')).not.toBeNull()
    expect(notes[1].querySelector('notations > tuplet')?.getAttribute('type')).toBe('start')
  })
})

describe('scoreToMusicXml — chord symbols + lyrics (M22-PR-H)', () => {
  function singleEventScore(partial: Partial<Score['measures'][0]['events'][0]>): Score {
    return {
      title: 'Chord+Lyric',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'whole', ...partial },
          ],
        },
      ],
    }
  }

  // ── Chord symbols ──────────────────────────────────────────────────

  it('major triad emits <root> + <kind>major</kind>', () => {
    const xml = scoreToMusicXml(
      singleEventScore({
        chordSymbol: { root: 'C', quality: 'major', seventh: 'none' },
      }),
    )
    const doc = parseXml(xml)
    const harmony = doc.querySelector('harmony')!
    expect(harmony.querySelector('root > root-step')?.textContent).toBe('C')
    expect(harmony.querySelector('root > root-alter')).toBeNull()
    expect(harmony.querySelector('kind')?.textContent).toBe('major')
  })

  it('sharp/flat root emits <root-alter>', () => {
    const sharpXml = scoreToMusicXml(
      singleEventScore({
        chordSymbol: { root: 'F#', quality: 'major', seventh: 'none' },
      }),
    )
    const sharpDoc = parseXml(sharpXml)
    expect(sharpDoc.querySelector('root > root-step')?.textContent).toBe('F')
    expect(sharpDoc.querySelector('root > root-alter')?.textContent).toBe('1')

    const flatXml = scoreToMusicXml(
      singleEventScore({
        chordSymbol: { root: 'Bb', quality: 'major', seventh: 'none' },
      }),
    )
    const flatDoc = parseXml(flatXml)
    expect(flatDoc.querySelector('root > root-step')?.textContent).toBe('B')
    expect(flatDoc.querySelector('root > root-alter')?.textContent).toBe('-1')
  })

  it('quality + seventh combinations map to the right MusicXML kind', () => {
    const cases: Array<{
      quality: 'major' | 'minor' | 'diminished' | 'augmented' | 'sus2' | 'sus4'
      seventh: 'none' | 'maj7' | 'dom7' | 'min7' | 'dim7' | 'halfdim7'
      expected: string
    }> = [
      { quality: 'major', seventh: 'maj7', expected: 'major-seventh' },
      { quality: 'major', seventh: 'dom7', expected: 'dominant' },
      { quality: 'minor', seventh: 'min7', expected: 'minor-seventh' },
      { quality: 'minor', seventh: 'maj7', expected: 'major-minor' },
      { quality: 'diminished', seventh: 'dim7', expected: 'diminished-seventh' },
      { quality: 'diminished', seventh: 'halfdim7', expected: 'half-diminished' },
      { quality: 'augmented', seventh: 'none', expected: 'augmented' },
      { quality: 'sus2', seventh: 'none', expected: 'suspended-second' },
      { quality: 'sus4', seventh: 'none', expected: 'suspended-fourth' },
    ]
    for (const c of cases) {
      const xml = scoreToMusicXml(
        singleEventScore({
          chordSymbol: { root: 'C', quality: c.quality, seventh: c.seventh },
        }),
      )
      const doc = parseXml(xml)
      expect(
        doc.querySelector('kind')?.textContent,
        `for ${c.quality}/${c.seventh}`,
      ).toBe(c.expected)
    }
  })

  it('slash chord (bass=note) emits <bass>', () => {
    const xml = scoreToMusicXml(
      singleEventScore({
        chordSymbol: {
          root: 'C',
          quality: 'major',
          seventh: 'none',
          bass: { type: 'note', value: 'E' },
        },
      }),
    )
    const doc = parseXml(xml)
    expect(doc.querySelector('bass > bass-step')?.textContent).toBe('E')
  })

  it('display text overrides via the kind text= attribute', () => {
    const xml = scoreToMusicXml(
      singleEventScore({
        chordSymbol: {
          root: 'C',
          quality: 'major',
          seventh: 'dom7',
          display: 'C7♯9',
        },
      }),
    )
    const doc = parseXml(xml)
    expect(doc.querySelector('kind')?.getAttribute('text')).toBe('C7♯9')
  })

  it('extensions emit as <degree type="add">', () => {
    const xml = scoreToMusicXml(
      singleEventScore({
        chordSymbol: {
          root: 'C',
          quality: 'major',
          seventh: 'dom7',
          extensions: [9, 13],
        },
      }),
    )
    const doc = parseXml(xml)
    const degrees = doc.querySelectorAll('degree')
    expect(degrees.length).toBe(2)
    const values = Array.from(degrees).map((d) => d.querySelector('degree-value')?.textContent)
    expect(values).toContain('9')
    expect(values).toContain('13')
    for (const d of Array.from(degrees)) {
      expect(d.querySelector('degree-type')?.textContent).toBe('add')
    }
  })

  it('alterations emit as <degree type="alter"> with <degree-alter>', () => {
    const xml = scoreToMusicXml(
      singleEventScore({
        chordSymbol: {
          root: 'C',
          quality: 'major',
          seventh: 'dom7',
          alterations: ['b5', '#11'],
        },
      }),
    )
    const doc = parseXml(xml)
    const degrees = doc.querySelectorAll('degree')
    const altered = Array.from(degrees).filter(
      (d) => d.querySelector('degree-type')?.textContent === 'alter',
    )
    expect(altered.length).toBe(2)
    const b5 = altered.find(
      (d) => d.querySelector('degree-value')?.textContent === '5',
    )!
    expect(b5.querySelector('degree-alter')?.textContent).toBe('-1')
    const sharp11 = altered.find(
      (d) => d.querySelector('degree-value')?.textContent === '11',
    )!
    expect(sharp11.querySelector('degree-alter')?.textContent).toBe('1')
  })

  it('omit emits as <degree type="subtract">', () => {
    const xml = scoreToMusicXml(
      singleEventScore({
        chordSymbol: {
          root: 'C',
          quality: 'major',
          seventh: 'none',
          omit: [5],
        },
      }),
    )
    const doc = parseXml(xml)
    const omit = doc.querySelector('degree[type], degree')!
    expect(omit.querySelector('degree-value')?.textContent).toBe('5')
    expect(omit.querySelector('degree-type')?.textContent).toBe('subtract')
  })

  it('harmony emits BEFORE the note in measure-child order', () => {
    const xml = scoreToMusicXml(
      singleEventScore({
        chordSymbol: { root: 'C', quality: 'major', seventh: 'none' },
      }),
    )
    const doc = parseXml(xml)
    const measure = doc.querySelector('measure')!
    const children = Array.from(measure.children)
    const harmonyIdx = children.findIndex((c) => c.tagName === 'harmony')
    const noteIdx = children.findIndex((c) => c.tagName === 'note')
    expect(harmonyIdx).toBeGreaterThanOrEqual(0)
    expect(noteIdx).toBeGreaterThan(harmonyIdx)
  })

  it('no chordSymbol emits no <harmony>', () => {
    const xml = scoreToMusicXml(singleEventScore({}))
    const doc = parseXml(xml)
    expect(doc.querySelector('harmony')).toBeNull()
  })

  // ── Lyrics ─────────────────────────────────────────────────────────

  it('a single syllable emits <lyric><syllabic>single + <text>', () => {
    const xml = scoreToMusicXml(
      singleEventScore({
        lyrics: [{ verse: 1, syllable: 'la' }],
      }),
    )
    const doc = parseXml(xml)
    const lyric = doc.querySelector('lyric')!
    expect(lyric.getAttribute('number')).toBe('1')
    expect(lyric.querySelector('syllabic')?.textContent).toBe('single')
    expect(lyric.querySelector('text')?.textContent).toBe('la')
  })

  it('hyphenated syllables emit begin/middle/end syllabic values across events', () => {
    const xml = scoreToMusicXml({
      title: 'Lyric hyphens',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'quarter',
              lyrics: [{ verse: 1, syllable: 'Bea', hyphen: true }],
            },
            {
              pitches: [{ step: 'D', octave: 4 }],
              duration: 'quarter',
              lyrics: [{ verse: 1, syllable: 'u', hyphen: true }],
            },
            {
              pitches: [{ step: 'E', octave: 4 }],
              duration: 'quarter',
              lyrics: [{ verse: 1, syllable: 'ti', hyphen: true }],
            },
            {
              pitches: [{ step: 'F', octave: 4 }],
              duration: 'quarter',
              lyrics: [{ verse: 1, syllable: 'ful' }],
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const syllabics = Array.from(doc.querySelectorAll('lyric > syllabic')).map(
      (s) => s.textContent,
    )
    expect(syllabics).toEqual(['begin', 'middle', 'middle', 'end'])
  })

  it('multiple verses on one event emit multiple <lyric> elements', () => {
    const xml = scoreToMusicXml(
      singleEventScore({
        lyrics: [
          { verse: 1, syllable: 'one' },
          { verse: 2, syllable: 'eins' },
        ],
      }),
    )
    const doc = parseXml(xml)
    const lyrics = doc.querySelectorAll('lyric')
    expect(lyrics.length).toBe(2)
    expect(lyrics[0].getAttribute('number')).toBe('1')
    expect(lyrics[0].querySelector('text')?.textContent).toBe('one')
    expect(lyrics[1].getAttribute('number')).toBe('2')
    expect(lyrics[1].querySelector('text')?.textContent).toBe('eins')
  })

  it("extender=true emits <extend type='start'/> for a melisma", () => {
    const xml = scoreToMusicXml(
      singleEventScore({
        lyrics: [{ verse: 1, syllable: 'la', extender: true }],
      }),
    )
    const doc = parseXml(xml)
    expect(doc.querySelector('lyric > extend')?.getAttribute('type')).toBe('start')
  })

  it('lyrics attach to the FIRST chord note only', () => {
    const xml = scoreToMusicXml({
      title: 'Lyric chord',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
                { step: 'G', octave: 4 },
              ],
              duration: 'whole',
              lyrics: [{ verse: 1, syllable: 'Ah' }],
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('note')
    expect(notes.length).toBe(3)
    expect(notes[0].querySelector('lyric')).not.toBeNull()
    expect(notes[1].querySelector('lyric')).toBeNull()
    expect(notes[2].querySelector('lyric')).toBeNull()
  })

  it('lyric text is XML-escaped (no entity injection)', () => {
    const xml = scoreToMusicXml(
      singleEventScore({
        lyrics: [{ verse: 1, syllable: 'A&B' }],
      }),
    )
    const doc = parseXml(xml)
    expect(doc.querySelector('lyric > text')?.textContent).toBe('A&B')
  })

  it('no lyrics emits no <lyric>', () => {
    const xml = scoreToMusicXml(singleEventScore({}))
    const doc = parseXml(xml)
    expect(doc.querySelector('lyric')).toBeNull()
  })
})

describe('scoreToMusicXml — accel/rit tempo spans (M22-PR-F)', () => {
  function tempoSpanScore(span: {
    kind: 'accel' | 'rit'
    endTempoBpm?: number
    endTempoText?: string
    placement?: 'above' | 'below' | 'default'
  }): Score {
    return {
      title: 'Tempo span',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { id: 'evtempo01', pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
            { id: 'evtempo02', pitches: [{ step: 'D', octave: 4 }], duration: 'half' },
          ],
        },
      ],
      spans: [
        {
          id: 'sptempo01',
          kind: span.kind,
          startEventId: 'evtempo01',
          endEventId: 'evtempo02',
          staffIdx: 0,
          voiceIdx: 0,
          ...(span.endTempoBpm !== undefined ? { endTempoBpm: span.endTempoBpm } : {}),
          ...(span.endTempoText !== undefined ? { endTempoText: span.endTempoText } : {}),
          ...(span.placement !== undefined ? { placement: span.placement } : {}),
        },
      ],
    }
  }

  it("accel start emits <words>accel.</words> + <dashes type='start'/>", () => {
    const xml = scoreToMusicXml(tempoSpanScore({ kind: 'accel' }))
    const doc = parseXml(xml)
    const directions = Array.from(doc.querySelectorAll('measure > direction'))
    const startDir = directions.find((d) => d.querySelector('words')?.textContent === 'accel.')!
    expect(startDir).toBeDefined()
    const dashes = startDir.querySelector('dashes')!
    expect(dashes.getAttribute('type')).toBe('start')
  })

  it("rit start emits <words>rit.</words>", () => {
    const xml = scoreToMusicXml(tempoSpanScore({ kind: 'rit' }))
    const doc = parseXml(xml)
    const startWords = Array.from(doc.querySelectorAll('words')).find(
      (w) => w.textContent === 'rit.',
    )
    expect(startWords).toBeDefined()
  })

  it("dashes stop emits at the end event (BEFORE the end-event note)", () => {
    const xml = scoreToMusicXml(tempoSpanScore({ kind: 'accel' }))
    const doc = parseXml(xml)
    const measure = doc.querySelector('measure')!
    const children = Array.from(measure.children)
    const dashesStopIdx = children.findIndex(
      (c) =>
        c.tagName === 'direction' &&
        c.querySelector('dashes')?.getAttribute('type') === 'stop',
    )
    const notes = children
      .map((c, i) => (c.tagName === 'note' ? i : -1))
      .filter((i) => i >= 0)
    // Stops emit before the end-event note (same convention as wedges
    // from PR-D's review fix).
    expect(dashesStopIdx).toBeGreaterThan(notes[0])
    expect(dashesStopIdx).toBeLessThan(notes[notes.length - 1])
  })

  it("endTempoText on stop emits as <words>", () => {
    const xml = scoreToMusicXml(
      tempoSpanScore({ kind: 'rit', endTempoText: 'a tempo' }),
    )
    const doc = parseXml(xml)
    const aTempo = Array.from(doc.querySelectorAll('words')).find(
      (w) => w.textContent === 'a tempo',
    )
    expect(aTempo).toBeDefined()
  })

  it("endTempoBpm on stop emits <metronome> + <sound tempo>", () => {
    const xml = scoreToMusicXml(tempoSpanScore({ kind: 'rit', endTempoBpm: 60 }))
    const doc = parseXml(xml)
    // Find the stop direction (carries the <metronome>).
    const stopDir = Array.from(doc.querySelectorAll('measure > direction')).find(
      (d) => d.querySelector('dashes')?.getAttribute('type') === 'stop',
    )!
    expect(stopDir.querySelector('metronome > per-minute')?.textContent).toBe('60')
    expect(stopDir.querySelector('sound')?.getAttribute('tempo')).toBe('60')
  })

  it("both endTempoText AND endTempoBpm on the same stop emit both direction-types", () => {
    const xml = scoreToMusicXml(
      tempoSpanScore({ kind: 'rit', endTempoText: 'a tempo', endTempoBpm: 120 }),
    )
    const doc = parseXml(xml)
    const stopDir = Array.from(doc.querySelectorAll('measure > direction')).find(
      (d) => d.querySelector('dashes')?.getAttribute('type') === 'stop',
    )!
    expect(stopDir.querySelector('words')?.textContent).toBe('a tempo')
    expect(stopDir.querySelector('metronome > per-minute')?.textContent).toBe('120')
  })

  it("default placement is above (engraving convention)", () => {
    const xml = scoreToMusicXml(tempoSpanScore({ kind: 'accel' }))
    const doc = parseXml(xml)
    const directions = Array.from(doc.querySelectorAll('direction')).filter((d) =>
      d.querySelector('dashes'),
    )
    for (const d of directions) {
      expect(d.getAttribute('placement')).toBe('above')
    }
  })

  it("explicit placement='below' overrides the above default", () => {
    const xml = scoreToMusicXml(
      tempoSpanScore({ kind: 'accel', placement: 'below' }),
    )
    const doc = parseXml(xml)
    const startDir = Array.from(doc.querySelectorAll('direction')).find(
      (d) => d.querySelector('words')?.textContent === 'accel.',
    )!
    expect(startDir.getAttribute('placement')).toBe('below')
  })

  it("XML-escapes endTempoText (no entity injection)", () => {
    const xml = scoreToMusicXml(
      tempoSpanScore({ kind: 'rit', endTempoText: 'a < tempo > & beyond' }),
    )
    const doc = parseXml(xml)
    const stopDir = Array.from(doc.querySelectorAll('direction')).find(
      (d) => d.querySelector('dashes')?.getAttribute('type') === 'stop',
    )!
    expect(stopDir.querySelector('words')?.textContent).toBe('a < tempo > & beyond')
  })
})

describe('scoreToMusicXml — EngravingDefaults projection (M22-PR-J)', () => {
  // ── Absence cases ───────────────────────────────────────────────────

  it('omits <defaults> entirely when engravingDefaults is undefined', () => {
    const xml = scoreToMusicXml(singleNoteScore())
    const doc = parseXml(xml)
    expect(doc.querySelector('score-partwise > defaults')).toBeNull()
  })

  it('omits <defaults> when engravingDefaults has only non-projectable fields', () => {
    // dynamicsPosition is handled per-direction (not <defaults>), so a
    // score with ONLY dynamicsPosition set should still skip the wrapper.
    const xml = scoreToMusicXml(
      singleNoteScore({ engravingDefaults: { dynamicsPosition: 'above' } }),
    )
    const doc = parseXml(xml)
    expect(doc.querySelector('score-partwise > defaults')).toBeNull()
  })

  it("omits <defaults> when tempoTextFont='plain-roman' is the only set field (no non-default styling to project)", () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          tempoTextFont: 'plain-roman',
        },
      }),
    )
    const doc = parseXml(xml)
    expect(doc.querySelector('score-partwise > defaults')).toBeNull()
  })

  // ── word-font (tempoTextFont) ──────────────────────────────────────

  it("tempoTextFont='italic-bold' emits <word-font font-style=italic font-weight=bold>", () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          tempoTextFont: 'italic-bold',
        },
      }),
    )
    const doc = parseXml(xml)
    const wf = doc.querySelector('defaults > word-font')!
    expect(wf).not.toBeNull()
    expect(wf.getAttribute('font-style')).toBe('italic')
    expect(wf.getAttribute('font-weight')).toBe('bold')
  })

  it("tempoTextFont='italic-roman' emits <word-font font-style=italic> only", () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          tempoTextFont: 'italic-roman',
        },
      }),
    )
    const doc = parseXml(xml)
    const wf = doc.querySelector('defaults > word-font')!
    expect(wf.getAttribute('font-style')).toBe('italic')
    expect(wf.getAttribute('font-weight')).toBeNull()
  })

  it("tempoTextFont='bold-roman' emits <word-font font-weight=bold> only", () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          tempoTextFont: 'bold-roman',
        },
      }),
    )
    const doc = parseXml(xml)
    const wf = doc.querySelector('defaults > word-font')!
    expect(wf.getAttribute('font-style')).toBeNull()
    expect(wf.getAttribute('font-weight')).toBe('bold')
  })

  // ── lyric-font (lyricFontScale) ────────────────────────────────────

  it('lyricFontScale=100 emits <lyric-font font-size=10> (baseline)', () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          lyricFontScale: 100,
        },
      }),
    )
    const doc = parseXml(xml)
    const lf = doc.querySelector('defaults > lyric-font')!
    expect(lf.getAttribute('font-size')).toBe('10')
  })

  it('lyricFontScale=150 scales to 15pt', () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          lyricFontScale: 150,
        },
      }),
    )
    const doc = parseXml(xml)
    const lf = doc.querySelector('defaults > lyric-font')!
    expect(lf.getAttribute('font-size')).toBe('15')
  })

  it('lyricFontScale=50 scales to 5pt (lower bound)', () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          lyricFontScale: 50,
        },
      }),
    )
    const doc = parseXml(xml)
    const lf = doc.querySelector('defaults > lyric-font')!
    expect(lf.getAttribute('font-size')).toBe('5')
  })

  it('lyricFontScale=200 scales to 20pt (upper bound)', () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          lyricFontScale: 200,
        },
      }),
    )
    const doc = parseXml(xml)
    const lf = doc.querySelector('defaults > lyric-font')!
    expect(lf.getAttribute('font-size')).toBe('20')
  })

  it('lyricFontScale rounds to integer point sizes', () => {
    // 133 → 13.3 → 13 after Math.round
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          lyricFontScale: 133,
        },
      }),
    )
    const doc = parseXml(xml)
    const lf = doc.querySelector('defaults > lyric-font')!
    expect(lf.getAttribute('font-size')).toBe('13')
  })

  // ── appearance (slurThickness / tieThickness) ──────────────────────

  it('slurThickness=2 emits <appearance><line-width type="slur middle">20</line-width>', () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          slurThickness: 2,
        },
      }),
    )
    const doc = parseXml(xml)
    const lw = doc.querySelector('defaults > appearance > line-width')!
    expect(lw.getAttribute('type')).toBe('slur middle')
    expect(lw.textContent).toBe('20')
  })

  it('tieThickness=1.5 emits <appearance><line-width type="tie middle">15</line-width>', () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          tieThickness: 1.5,
        },
      }),
    )
    const doc = parseXml(xml)
    const lw = doc.querySelector('defaults > appearance > line-width')!
    expect(lw.getAttribute('type')).toBe('tie middle')
    expect(lw.textContent).toBe('15')
  })

  it('both slur+tie thickness emit two <line-width> entries in one <appearance>', () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          slurThickness: 2,
          tieThickness: 1,
        },
      }),
    )
    const doc = parseXml(xml)
    const appearances = doc.querySelectorAll('defaults > appearance')
    expect(appearances.length).toBe(1)
    const lws = appearances[0].querySelectorAll('line-width')
    expect(lws.length).toBe(2)
    expect(lws[0].getAttribute('type')).toBe('slur middle')
    expect(lws[0].textContent).toBe('20')
    expect(lws[1].getAttribute('type')).toBe('tie middle')
    expect(lws[1].textContent).toBe('10')
  })

  it('thickness values round to integer tenths', () => {
    // 1.25 * 10 = 12.5 → 13 after Math.round
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          slurThickness: 1.25,
        },
      }),
    )
    const doc = parseXml(xml)
    const lw = doc.querySelector('defaults > appearance > line-width')!
    expect(lw.textContent).toBe('13')
  })

  // ── Ordering / structure ────────────────────────────────────────────

  it('emits child elements in DTD order: appearance → word-font → lyric-font', () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          tempoTextFont: 'italic-bold',
          lyricFontScale: 120,
          slurThickness: 2,
        },
      }),
    )
    const doc = parseXml(xml)
    const defaults = doc.querySelector('defaults')!
    const children = Array.from(defaults.children).map((c) => c.tagName)
    expect(children).toEqual(['appearance', 'word-font', 'lyric-font'])
  })

  it("places <defaults> between </identification> and <part-list>", () => {
    const xml = scoreToMusicXml(
      singleNoteScore({
        composer: 'J.S. Bach',
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          tempoTextFont: 'italic-bold',
        },
      }),
    )
    // Use raw string indices to verify positional ordering — the XML
    // structural ordering matters for MusicXML 4.0 conformance.
    const idEnd = xml.indexOf('</identification>')
    const defStart = xml.indexOf('<defaults>')
    const partListStart = xml.indexOf('<part-list>')
    expect(idEnd).toBeGreaterThan(-1)
    expect(defStart).toBeGreaterThan(idEnd)
    expect(partListStart).toBeGreaterThan(defStart)
  })

  it("places <defaults> after </work> when <identification> is absent", () => {
    // No composer/arranger/lyricist/copyright → no <identification>.
    // <defaults> still has to sit before <part-list>; <work>/<work-title>
    // is the only earlier sibling here.
    const xml = scoreToMusicXml(
      singleNoteScore({
        title: 'Test Piece',
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          lyricFontScale: 120,
        },
      }),
    )
    expect(xml).not.toContain('<identification>')
    const workEnd = xml.indexOf('</work>')
    const defStart = xml.indexOf('<defaults>')
    const partListStart = xml.indexOf('<part-list>')
    expect(workEnd).toBeGreaterThan(-1)
    expect(defStart).toBeGreaterThan(workEnd)
    expect(partListStart).toBeGreaterThan(defStart)
  })

  it('preserves XML parseability with all projected fields set', () => {
    // Round-trip through the parser to catch unbalanced tags / bad
    // attribute syntax in the new emit path.
    const xml = scoreToMusicXml(
      singleNoteScore({
        engravingDefaults: {
          dynamicsPosition: 'auto-by-staff',
          tempoTextFont: 'italic-bold',
          lyricFontScale: 150,
          slurThickness: 2,
          tieThickness: 1.5,
        },
      }),
    )
    expect(() => parseXml(xml)).not.toThrow()
  })
})

describe('scoreToMusicXml — fingerings (M22-PR-K)', () => {
  function eventWithFingerings(overrides: Partial<Score['measures'][0]['events'][0]>): Score {
    return {
      title: 'Fingerings',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'whole', ...overrides },
          ],
        },
      ],
    }
  }

  // ── Piano ───────────────────────────────────────────────────────────

  it('piano fingering emits <fingering> inside <technical>', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'piano', value: '3' }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    expect(tech).not.toBeNull()
    const fingering = tech.querySelector('fingering')!
    expect(fingering.textContent).toBe('3')
    expect(fingering.getAttribute('substitution')).toBeNull()
  })

  it('piano fingering with substitution emits TWO <fingering> elements', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'piano', value: '2', substitution: '4' }],
      }),
    )
    const doc = parseXml(xml)
    const fingerings = doc.querySelectorAll('note > notations > technical > fingering')
    expect(fingerings.length).toBe(2)
    expect(fingerings[0].textContent).toBe('2')
    expect(fingerings[0].getAttribute('substitution')).toBeNull()
    expect(fingerings[1].textContent).toBe('4')
    expect(fingerings[1].getAttribute('substitution')).toBe('yes')
  })

  // ── String ──────────────────────────────────────────────────────────

  it('string fingering emits <fingering> with the finger number', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'string', finger: 2 }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    expect(tech.querySelector('fingering')?.textContent).toBe('2')
    expect(tech.querySelector('string')).toBeNull()
  })

  it('string fingering with stringRoman emits <string> with the Roman→int conversion', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'string', finger: 3, stringRoman: 'III' }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    expect(tech.querySelector('fingering')?.textContent).toBe('3')
    expect(tech.querySelector('string')?.textContent).toBe('3')
  })

  it('string fingering open string (0) emits <fingering>0</fingering>', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'string', finger: 0, stringRoman: 'IV' }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    expect(tech.querySelector('fingering')?.textContent).toBe('0')
    expect(tech.querySelector('string')?.textContent).toBe('4')
  })

  // ── Guitar LH ───────────────────────────────────────────────────────

  it('guitar-lh fingering emits <fingering>, optional <string>, optional <fret>', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'guitar-lh', value: 2, stringNum: 3, fret: 'V' }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    expect(tech.querySelector('fingering')?.textContent).toBe('2')
    expect(tech.querySelector('string')?.textContent).toBe('3')
    expect(tech.querySelector('fret')?.textContent).toBe('5')
  })

  it('guitar-lh fingering without optional fields emits <fingering> only', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'guitar-lh', value: 1 }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    expect(tech.querySelector('fingering')?.textContent).toBe('1')
    expect(tech.querySelector('string')).toBeNull()
    expect(tech.querySelector('fret')).toBeNull()
  })

  it('guitar-lh fingering converts compound Roman fret (XII) to integer 12', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'guitar-lh', value: 4, fret: 'XII' }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    expect(tech.querySelector('fret')?.textContent).toBe('12')
  })

  it('guitar-lh fingering converts subtractive Roman fret (IX) to integer 9', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'guitar-lh', value: 3, fret: 'IX' }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    expect(tech.querySelector('fret')?.textContent).toBe('9')
  })

  // ── Guitar RH ───────────────────────────────────────────────────────

  it('guitar-rh fingering emits <pluck> (NOT <fingering>)', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'guitar-rh', value: 'm' }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    expect(tech.querySelector('pluck')?.textContent).toBe('m')
    expect(tech.querySelector('fingering')).toBeNull()
  })

  it('guitar-rh fingering covers all 5 Spanish letters (p/i/m/a/c)', () => {
    for (const value of ['p', 'i', 'm', 'a', 'c'] as const) {
      const xml = scoreToMusicXml(
        eventWithFingerings({
          fingerings: [{ system: 'guitar-rh', value }],
        }),
      )
      const doc = parseXml(xml)
      expect(doc.querySelector('note > notations > technical > pluck')?.textContent).toBe(value)
    }
  })

  // ── Organ ──────────────────────────────────────────────────────────

  it('organ fingering emits <fingering> with the finger number', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'organ', value: '4' }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    expect(tech.querySelector('fingering')?.textContent).toBe('4')
    expect(tech.querySelector('heel')).toBeNull()
    expect(tech.querySelector('toe')).toBeNull()
  })

  it('organ fingering with foot=heel emits <heel/>', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'organ', value: '1', foot: 'heel' }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    expect(tech.querySelector('fingering')?.textContent).toBe('1')
    expect(tech.querySelector('heel')).not.toBeNull()
    expect(tech.querySelector('toe')).toBeNull()
  })

  it('organ fingering with foot=toe emits <toe/>', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'organ', value: '2', foot: 'toe' }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    expect(tech.querySelector('toe')).not.toBeNull()
    expect(tech.querySelector('heel')).toBeNull()
  })

  it('organ fingering thumbDirection is silently dropped (no clean MusicXML mapping)', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'organ', value: '1', thumbDirection: '(' }],
      }),
    )
    const doc = parseXml(xml)
    const tech = doc.querySelector('note > notations > technical')!
    // <fingering> still emits — only the thumbDirection signal is lost.
    expect(tech.querySelector('fingering')?.textContent).toBe('1')
    // Confirm no <other-technical> stub leaks through.
    expect(tech.querySelector('other-technical')).toBeNull()
  })

  // ── Per-pitch chord-stack fingerings ───────────────────────────────

  it('per-pitch fingerings emit on the corresponding chord-note <note>', () => {
    // Chord of C-E-G with three different fingers (1-3-5 — classic
    // major-triad fingering for the right hand).
    const xml = scoreToMusicXml({
      title: 'Chord',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
                { step: 'G', octave: 4 },
              ],
              duration: 'whole',
              fingerings: [
                { system: 'piano', value: '1' },
                { system: 'piano', value: '3' },
                { system: 'piano', value: '5' },
              ],
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('measure > note')
    expect(notes.length).toBe(3)
    expect(notes[0].querySelector('notations > technical > fingering')?.textContent).toBe('1')
    expect(notes[1].querySelector('notations > technical > fingering')?.textContent).toBe('3')
    expect(notes[2].querySelector('notations > technical > fingering')?.textContent).toBe('5')
  })

  it('null fingering slots in a chord skip <technical> on that pitch', () => {
    const xml = scoreToMusicXml({
      title: 'PartialChord',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
              ],
              duration: 'whole',
              fingerings: [
                { system: 'piano', value: '1' },
                null,
              ],
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('measure > note')
    expect(notes[0].querySelector('notations > technical > fingering')?.textContent).toBe('1')
    expect(notes[1].querySelector('notations > technical')).toBeNull()
  })

  // ── Negative cases ─────────────────────────────────────────────────

  it('no fingerings field emits no <technical> block', () => {
    const xml = scoreToMusicXml(eventWithFingerings({}))
    const doc = parseXml(xml)
    expect(doc.querySelector('note > notations > technical')).toBeNull()
  })

  it('empty fingerings array emits no <technical> block', () => {
    const xml = scoreToMusicXml(eventWithFingerings({ fingerings: [] }))
    const doc = parseXml(xml)
    expect(doc.querySelector('note > notations > technical')).toBeNull()
  })

  it('rest events skip fingering emission (per-pitch loop returns on rest)', () => {
    // Mixed-rest-and-pitch is caught upstream; this tests the all-rest
    // path doesn't try to emit fingerings even when the schema lets the
    // field carry a slot.
    const xml = scoreToMusicXml({
      title: 'RestWithFingerings',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ step: 'rest', octave: 4 }],
              duration: 'whole',
              // Defensive — the schema lets this through but it's
              // non-sensical. Emit should drop it.
              fingerings: [{ system: 'piano', value: '1' }],
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    expect(doc.querySelector('note > notations > technical')).toBeNull()
    expect(doc.querySelector('note > rest')).not.toBeNull()
  })

  // ── Position in <notations> content order ──────────────────────────

  it('<technical> emits after <ornaments> and before <articulations>', () => {
    // Score with a chord-anchor that carries ornament span, articulation,
    // and a fingering — confirm DTD order is honored.
    const xml = scoreToMusicXml({
      title: 'Ordering',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'eventaaa1',
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'half',
              articulations: ['staccato'],
              fingerings: [{ system: 'piano', value: '3' }],
            },
            {
              id: 'eventaaa2',
              pitches: [{ step: 'D', octave: 4 }],
              duration: 'half',
            },
          ],
        },
      ],
      spans: [
        {
          id: 'spangliss1',
          kind: 'glissando',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const notations = doc.querySelector('measure > note > notations')!
    const children = Array.from(notations.children).map((c) => c.tagName)
    // glissando sits between slur and ornaments per DTD; technical sits
    // between ornaments and articulations. Even without an explicit
    // ornaments wrapper present (glissando is a top-level notations
    // child), technical must still come AFTER glissando and BEFORE
    // articulations.
    const glissIdx = children.indexOf('glissando')
    const techIdx = children.indexOf('technical')
    const artsIdx = children.indexOf('articulations')
    expect(glissIdx).toBeGreaterThan(-1)
    expect(techIdx).toBeGreaterThan(-1)
    expect(artsIdx).toBeGreaterThan(-1)
    expect(techIdx).toBeGreaterThan(glissIdx)
    expect(artsIdx).toBeGreaterThan(techIdx)
  })

  it('round-trip parseable with full fingering combo on a multi-pitch chord', () => {
    const xml = scoreToMusicXml({
      title: 'FullCombo',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [
                { step: 'C', octave: 4 },
                { step: 'E', octave: 4 },
              ],
              duration: 'whole',
              articulations: ['accent'],
              fermata: 'standard',
              fingerings: [
                { system: 'piano', value: '1', substitution: '3' },
                { system: 'piano', value: '5' },
              ],
            },
          ],
        },
      ],
    })
    expect(() => parseXml(xml)).not.toThrow()
  })

  // ── Multi-staff / multi-voice coverage ─────────────────────────────

  it('fingerings emit on secondStaff notes', () => {
    // Piano LH plays on staff 2; expect <staff>2</staff> + fingering
    // on the LH note. Confirms the chord-stack walk routes fingerings
    // to whichever staff the voice lives on.
    const xml = scoreToMusicXml({
      title: 'GrandStaff',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 5 }], duration: 'whole' },
          ],
        },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          {
            events: [
              {
                pitches: [{ step: 'C', octave: 3 }],
                duration: 'whole',
                fingerings: [{ system: 'piano', value: '5' }],
              },
            ],
          },
        ],
      },
    })
    const doc = parseXml(xml)
    const notes = Array.from(doc.querySelectorAll('measure > note'))
    const lhNote = notes.find((n) => n.querySelector('staff')?.textContent === '2')!
    expect(lhNote).toBeDefined()
    expect(lhNote.querySelector('notations > technical > fingering')?.textContent).toBe('5')
  })

  it('fingerings emit on extraVoices', () => {
    // SATB-style — primary voice is soprano, extra voice is alto with
    // its own fingering. The voice-plan walk should route the alto
    // fingering to the alto's <note> (voice=2), not to soprano.
    const xml = scoreToMusicXml({
      title: 'TwoVoice',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 5 }], duration: 'whole' },
          ],
        },
      ],
      extraVoices: [
        {
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'E', octave: 4 }],
                  duration: 'whole',
                  fingerings: [{ system: 'piano', value: '2' }],
                },
              ],
            },
          ],
        },
      ],
    })
    const doc = parseXml(xml)
    const notes = Array.from(doc.querySelectorAll('measure > note'))
    const altoNote = notes.find((n) => n.querySelector('voice')?.textContent === '2')!
    expect(altoNote).toBeDefined()
    expect(altoNote.querySelector('notations > technical > fingering')?.textContent).toBe('2')
  })

  // ── XML escaping ───────────────────────────────────────────────────

  it('XML-escapes piano fingering substitution value (no entity injection)', () => {
    const xml = scoreToMusicXml(
      eventWithFingerings({
        fingerings: [{ system: 'piano', value: '2', substitution: '4 < & "' }],
      }),
    )
    const doc = parseXml(xml)
    const fingerings = doc.querySelectorAll('note > notations > technical > fingering')
    expect(fingerings.length).toBe(2)
    expect(fingerings[1].getAttribute('substitution')).toBe('yes')
    expect(fingerings[1].textContent).toBe('4 < & "')
  })

  // ── Coexistence with slurs (notations content order pin) ───────────

  it('<technical> sits BETWEEN <slur> and <articulations> when all three present', () => {
    const xml = scoreToMusicXml({
      title: 'SlurAndFingering',
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'eventaaa1',
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'half',
              articulations: ['staccato'],
              fingerings: [{ system: 'piano', value: '3' }],
            },
            {
              id: 'eventaaa2',
              pitches: [{ step: 'D', octave: 4 }],
              duration: 'half',
            },
          ],
        },
      ],
      spans: [
        {
          id: 'spanslur01',
          kind: 'slur',
          startEventId: 'eventaaa1',
          endEventId: 'eventaaa2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    })
    const doc = parseXml(xml)
    const notations = doc.querySelector('measure > note > notations')!
    const children = Array.from(notations.children).map((c) => c.tagName)
    const slurIdx = children.indexOf('slur')
    const techIdx = children.indexOf('technical')
    const artsIdx = children.indexOf('articulations')
    expect(slurIdx).toBeGreaterThan(-1)
    expect(techIdx).toBeGreaterThan(slurIdx)
    expect(artsIdx).toBeGreaterThan(techIdx)
  })
})

describe('scoreToMusicXml — metric modulation marker labels (M22-PR-L)', () => {
  function modScore(
    overrides: Partial<NonNullable<Score['markers']>[0]> = {},
  ): Score {
    return {
      title: 'MetricMod',
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      ],
      markers: [
        {
          id: 'markeraaaa',
          measureIdx: 1,
          metricModulation: { fromNote: 'quarter', toNote: 'eighth' },
          ...overrides,
        },
      ],
    }
  }

  it('emits a <direction><metronome> with complex form (two <metronome-note> + <metronome-relation>)', () => {
    const xml = scoreToMusicXml(modScore())
    const doc = parseXml(xml)
    // Modulation lives on measure 2 (1-indexed). Find that measure's
    // <direction> and confirm the metronome shape.
    const measures = doc.querySelectorAll('measure')
    const m2Directions = measures[1].querySelectorAll('direction')
    const modDir = Array.from(m2Directions).find((d) => d.querySelector('metronome-relation'))!
    expect(modDir).toBeDefined()
    const metronome = modDir.querySelector('direction-type > metronome')!
    expect(metronome).not.toBeNull()
    const notes = metronome.querySelectorAll('metronome-note')
    expect(notes.length).toBe(2)
    expect(notes[0].querySelector('metronome-type')?.textContent).toBe('quarter')
    expect(notes[1].querySelector('metronome-type')?.textContent).toBe('eighth')
    expect(metronome.querySelector('metronome-relation')?.textContent).toBe('equals')
  })

  it('emits placement="above" on the modulation direction (engraving convention)', () => {
    const xml = scoreToMusicXml(modScore())
    const doc = parseXml(xml)
    const modDir = Array.from(doc.querySelectorAll('direction')).find((d) =>
      d.querySelector('metronome-relation'),
    )!
    expect(modDir.getAttribute('placement')).toBe('above')
  })

  it("does not emit <sound tempo> on the modulation direction (visual-only)", () => {
    const xml = scoreToMusicXml(modScore())
    const doc = parseXml(xml)
    const modDir = Array.from(doc.querySelectorAll('direction')).find((d) =>
      d.querySelector('metronome-relation'),
    )!
    expect(modDir.querySelector('sound')).toBeNull()
  })

  // ── Dotted forms emit <metronome-dot/> ─────────────────────────────

  it("'dotted-quarter' on the from side emits <metronome-dot/>", () => {
    const xml = scoreToMusicXml(
      modScore({
        metricModulation: { fromNote: 'dotted-quarter', toNote: 'quarter' },
      }),
    )
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('metronome-note')
    expect(notes[0].querySelector('metronome-type')?.textContent).toBe('quarter')
    expect(notes[0].querySelector('metronome-dot')).not.toBeNull()
    expect(notes[1].querySelector('metronome-type')?.textContent).toBe('quarter')
    expect(notes[1].querySelector('metronome-dot')).toBeNull()
  })

  it("'dotted-half' and 'dotted-eighth' both emit dot siblings", () => {
    const xml = scoreToMusicXml(
      modScore({
        metricModulation: { fromNote: 'dotted-half', toNote: 'dotted-eighth' },
      }),
    )
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('metronome-note')
    expect(notes[0].querySelector('metronome-type')?.textContent).toBe('half')
    expect(notes[0].querySelector('metronome-dot')).not.toBeNull()
    expect(notes[1].querySelector('metronome-type')?.textContent).toBe('eighth')
    expect(notes[1].querySelector('metronome-dot')).not.toBeNull()
  })

  // ── 'sixteenth' canonical token mapping ────────────────────────────

  it("'sixteenth' maps to the canonical '16th' MusicXML token (NOT 'sixteenth')", () => {
    const xml = scoreToMusicXml(
      modScore({
        metricModulation: { fromNote: 'sixteenth', toNote: 'eighth' },
      }),
    )
    const doc = parseXml(xml)
    const notes = doc.querySelectorAll('metronome-note')
    expect(notes[0].querySelector('metronome-type')?.textContent).toBe('16th')
    // Defensive: confirm no permissive 'sixteenth' leaked through.
    expect(xml).not.toContain('>sixteenth<')
  })

  // ── Coexistence with tempo direction ───────────────────────────────

  it('emits BOTH modulation and tempo directions when both fields set, with modulation FIRST', () => {
    const xml = scoreToMusicXml(
      modScore({
        metricModulation: { fromNote: 'quarter', toNote: 'eighth' },
        tempo_bpm: 120,
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('measure')
    const m2Directions = Array.from(measures[1].querySelectorAll('direction'))
    expect(m2Directions.length).toBe(2)
    // Modulation comes first
    expect(m2Directions[0].querySelector('metronome-relation')).not.toBeNull()
    expect(m2Directions[0].querySelector('sound')).toBeNull()
    // Tempo direction comes second
    expect(m2Directions[1].querySelector('metronome > beat-unit')?.textContent).toBe('quarter')
    expect(m2Directions[1].querySelector('metronome > per-minute')?.textContent).toBe('120')
    expect(m2Directions[1].querySelector('sound')?.getAttribute('tempo')).toBe('120')
  })

  it('emits modulation + tempo_text + tempo_bpm together (modulation first, then a single tempo dir)', () => {
    const xml = scoreToMusicXml(
      modScore({
        metricModulation: { fromNote: 'quarter', toNote: 'eighth' },
        tempo_text: 'Più mosso',
        tempo_bpm: 140,
      }),
    )
    const doc = parseXml(xml)
    const measures = doc.querySelectorAll('measure')
    const m2Directions = Array.from(measures[1].querySelectorAll('direction'))
    expect(m2Directions.length).toBe(2)
    expect(m2Directions[0].querySelector('metronome-relation')).not.toBeNull()
    expect(m2Directions[1].querySelector('words')?.textContent).toBe('Più mosso')
    expect(m2Directions[1].querySelector('per-minute')?.textContent).toBe('140')
  })

  it('marker that ONLY sets metricModulation produces exactly one <direction> (no extras)', () => {
    const xml = scoreToMusicXml(modScore())
    const doc = parseXml(xml)
    const m2Directions = Array.from(
      doc.querySelectorAll('measure')[1].querySelectorAll('direction'),
    )
    expect(m2Directions.length).toBe(1)
    expect(m2Directions[0].querySelector('metronome-relation')).not.toBeNull()
  })

  // ── Coexistence with other marker fields ───────────────────────────

  it('coexists with key/meter change: <attributes> then modulation <direction>', () => {
    const xml = scoreToMusicXml(
      modScore({
        metricModulation: { fromNote: 'quarter', toNote: 'eighth' },
        meter: '3/4',
      }),
    )
    const doc = parseXml(xml)
    const m2 = doc.querySelectorAll('measure')[1]
    const children = Array.from(m2.children).map((c) => c.tagName)
    // <attributes> for the meter change must precede <direction> for
    // the modulation (the new meter applies to this measure's notes,
    // and the modulation marking sits visually above the bar).
    const attrIdx = children.indexOf('attributes')
    const dirIdx = children.indexOf('direction')
    expect(attrIdx).toBeGreaterThan(-1)
    expect(dirIdx).toBeGreaterThan(attrIdx)
  })

  // ── Round-trip parseability ────────────────────────────────────────

  it('parses cleanly with all dotted forms', () => {
    // Sweep every enum value through fromNote so the helper switch
    // is exercised end-to-end.
    const allNotes: Array<NonNullable<Score['markers']>[0]['metricModulation']> = [
      { fromNote: 'half', toNote: 'half' },
      { fromNote: 'dotted-half', toNote: 'half' },
      { fromNote: 'quarter', toNote: 'half' },
      { fromNote: 'dotted-quarter', toNote: 'half' },
      { fromNote: 'eighth', toNote: 'quarter' },
      { fromNote: 'dotted-eighth', toNote: 'quarter' },
      { fromNote: 'sixteenth', toNote: 'eighth' },
    ]
    for (const mm of allNotes) {
      const xml = scoreToMusicXml(modScore({ metricModulation: mm }))
      expect(() => parseXml(xml)).not.toThrow()
    }
  })

  it('measure-0 modulation marker emits AFTER the score-level <attributes>/<tempo>', () => {
    // emitFirstMeasureAttributes runs first; then emitTempo (the
    // score-level tempo_bpm direction); then emitMarkerBlocks. So a
    // markedIdx=0 modulation should sit AFTER the score-level tempo
    // direction, not interleaved with first-measure attributes. The
    // engraving result: "♩=120" (score tempo) then "♩=♪" (modulation
    // marker), both visually above measure 1.
    const xml = scoreToMusicXml({
      title: 'Measure0Mod',
      key: 'C',
      meter: '4/4',
      tempo_bpm: 120,
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      ],
      markers: [
        {
          id: 'markerm0aa',
          measureIdx: 0,
          metricModulation: { fromNote: 'quarter', toNote: 'eighth' },
        },
      ],
    })
    const doc = parseXml(xml)
    const m1 = doc.querySelector('measure')!
    const children = Array.from(m1.children).map((c) => c.tagName)
    const attrIdx = children.indexOf('attributes')
    expect(attrIdx).toBeGreaterThan(-1)
    // First <direction> after attributes is the score-level tempo
    // (carries <sound tempo>); the modulation direction (with
    // <metronome-relation>) comes after that.
    const dirIdxs = children.reduce<number[]>(
      (acc, tag, i) => (tag === 'direction' ? [...acc, i] : acc),
      [],
    )
    expect(dirIdxs.length).toBe(2)
    const dirs = Array.from(m1.querySelectorAll(':scope > direction'))
    // Tempo direction first
    expect(dirs[0].querySelector('sound')?.getAttribute('tempo')).toBe('120')
    expect(dirs[0].querySelector('metronome-relation')).toBeNull()
    // Modulation direction second
    expect(dirs[1].querySelector('metronome-relation')).not.toBeNull()
    expect(dirs[1].querySelector('sound')).toBeNull()
  })
})

