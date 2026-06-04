import { describe, it, expect } from 'vitest'
import abcjs from 'abcjs'
import { scoreToAbcWithMap } from '@/lib/music/scoreToAbcWithMap'
import type { Pitch, Score } from '@/lib/music/types'

const C4: Pitch = { step: 'C', octave: 4 }
const E4: Pitch = { step: 'E', octave: 4 }
const G4: Pitch = { step: 'G', octave: 4 }

describe('scoreToAbcWithMap — per-pitch tie rendering (M13-PR-1)', () => {
  it('event-wide tied_to_next on a single pitch emits trailing -', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [C4], duration: 'half', tied_to_next: true }] },
        { events: [{ pitches: [C4], duration: 'half' }] },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toMatch(/C4-/)
  })

  it('per-pitch tied_to_next on a single pitch emits trailing -', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ ...C4, tied_to_next: true }], duration: 'half' },
          ],
        },
        { events: [{ pitches: [C4], duration: 'half' }] },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toMatch(/C4-/)
  })

  it('per-pitch tied_to_next: false on a single pitch suppresses tie even when event-wide is true', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ ...C4, tied_to_next: false }],
              duration: 'half',
              tied_to_next: true,
            },
          ],
        },
        { events: [{ pitches: [C4], duration: 'half' }] },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // The single-pitch event renders as C4 with no trailing dash.
    expect(abc).not.toMatch(/C4-/)
    expect(abc).toMatch(/C4/)
  })

  it('all-pitches-tied chord uses the chord-wide outer form [CEG]-', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [C4, E4, G4],
              duration: 'half',
              tied_to_next: true,
            },
          ],
        },
        { events: [{ pitches: [C4, E4, G4], duration: 'half' }] },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('[CEG]4-')
    // No inner per-pitch ties leak in.
    expect(abc).not.toContain('[C-E-G-]')
    expect(abc).not.toContain('[C-EG]')
  })

  it('partial-tie chord uses inner per-pitch form [C-EG] (only C ties)', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ ...C4, tied_to_next: true }, E4, G4],
              duration: 'half',
            },
          ],
        },
        { events: [{ pitches: [C4, E4, G4], duration: 'half' }] },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('[C-EG]4')
    // No outer chord-wide tie.
    expect(abc).not.toContain('[C-EG]4-')
  })

  it('partial-tie chord with multiple tied tones emits ties on each', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [
                { ...C4, tied_to_next: true },
                E4,
                { ...G4, tied_to_next: true },
              ],
              duration: 'half',
            },
          ],
        },
        { events: [{ pitches: [C4, E4, G4], duration: 'half' }] },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('[C-EG-]4')
  })

  it('per-pitch false override on a chord tone splits an event-wide tie', () => {
    // event-wide tied_to_next:true, but middle pitch overrides to false
    // → C and G should tie, E should not. The renderer should emit the
    // partial form, NOT [CEG]4-.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [C4, { ...E4, tied_to_next: false }, G4],
              duration: 'half',
              tied_to_next: true,
            },
          ],
        },
        { events: [{ pitches: [C4, E4, G4], duration: 'half' }] },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('[C-EG-]4')
    expect(abc).not.toContain('[CEG]4-')
  })

  it('lv emits "^l.v." annotation and SUPPRESSES the tie dash', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ ...C4, lv: true, tied_to_next: true }], duration: 'whole' },
          ],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^l.v."')
    // The lv overrides the tie — no trailing - even though tied_to_next is on.
    expect(abc).not.toMatch(/C8-/)
  })

  it('lv on a chord pitch emits one annotation and renders no tie for that pitch', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ ...C4, lv: true }, E4, G4],
              duration: 'whole',
            },
          ],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^l.v."')
    // No tie ought to appear since no tied_to_next.
    expect(abc).not.toContain('[CEG]8-')
    expect(abc).not.toContain('[C-EG]')
  })

  it('round-trips through abcjs: chord-wide tie produces startTie on all pitches', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [C4, E4, G4],
              duration: 'half',
              tied_to_next: true,
            },
          ],
        },
        { events: [{ pitches: [C4, E4, G4], duration: 'half' }] },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tune = abcjs.parseOnly(abc)[0]
    const allTiedFlags: boolean[][] = []
    for (const line of tune.lines) {
      for (const staff of line.staff ?? []) {
        for (const voice of staff.voices ?? []) {
          for (const el of voice) {
            if (el.el_type !== 'note' || !el.pitches) continue
            allTiedFlags.push(el.pitches.map((p: { startTie?: unknown }) => p.startTie !== undefined))
          }
        }
      }
    }
    // First emitted note: 3-pitch chord, all tied.
    expect(allTiedFlags[0]).toEqual([true, true, true])
    // Second note: 3-pitch chord, none tied.
    expect(allTiedFlags[1]).toEqual([false, false, false])
  })

  it('round-trips through abcjs: partial chord tie produces selective startTie', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [
                { ...C4, tied_to_next: true },
                E4,
                { ...G4, tied_to_next: true },
              ],
              duration: 'half',
            },
          ],
        },
        { events: [{ pitches: [C4, E4, G4], duration: 'half' }] },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tune = abcjs.parseOnly(abc)[0]
    const flags: boolean[][] = []
    for (const line of tune.lines) {
      for (const staff of line.staff ?? []) {
        for (const voice of staff.voices ?? []) {
          for (const el of voice) {
            if (el.el_type !== 'note' || !el.pitches) continue
            flags.push(el.pitches.map((p: { startTie?: unknown }) => p.startTie !== undefined))
          }
        }
      }
    }
    expect(flags[0]).toEqual([true, false, true])
  })

  it('sourcemap pitchRanges extend over the trailing inner - for tied chord tones', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ ...C4, tied_to_next: true }, E4, G4],
              duration: 'half',
            },
          ],
        },
        { events: [{ pitches: [C4, E4, G4], duration: 'half' }] },
      ],
    }
    const { abc, map } = scoreToAbcWithMap(sc)
    const ev0 = map.events[0]
    expect(ev0.pitchRanges).toHaveLength(3)
    // Pitch 0 (C, tied) → range covers "C-" (2 chars).
    expect(abc.slice(ev0.pitchRanges[0].startChar, ev0.pitchRanges[0].endChar)).toBe('C-')
    // Pitch 1 (E, not tied) → range covers "E" (1 char).
    expect(abc.slice(ev0.pitchRanges[1].startChar, ev0.pitchRanges[1].endChar)).toBe('E')
    // Pitch 2 (G, not tied) → range covers "G" (1 char).
    expect(abc.slice(ev0.pitchRanges[2].startChar, ev0.pitchRanges[2].endChar)).toBe('G')
  })

  it('sourcemap pitchRanges unchanged for the all-tied chord-wide form', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [C4, E4, G4],
              duration: 'half',
              tied_to_next: true,
            },
          ],
        },
        { events: [{ pitches: [C4, E4, G4], duration: 'half' }] },
      ],
    }
    const { abc, map } = scoreToAbcWithMap(sc)
    const ev0 = map.events[0]
    expect(ev0.pitchRanges).toHaveLength(3)
    // No inner ties; each pitch range covers exactly its pitch character.
    expect(abc.slice(ev0.pitchRanges[0].startChar, ev0.pitchRanges[0].endChar)).toBe('C')
    expect(abc.slice(ev0.pitchRanges[1].startChar, ev0.pitchRanges[1].endChar)).toBe('E')
    expect(abc.slice(ev0.pitchRanges[2].startChar, ev0.pitchRanges[2].endChar)).toBe('G')
  })

  it('preserves per-pitch tie when pitch carries an accidental (sharp)', () => {
    const Csharp4: Pitch = { step: 'C', octave: 4, accidental: 'sharp' }
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [{ ...Csharp4, tied_to_next: true }, E4, G4],
              duration: 'half',
            },
          ],
        },
        { events: [{ pitches: [Csharp4, E4, G4], duration: 'half' }] },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // `^C` is C-sharp; the trailing - sits after the pitch token.
    expect(abc).toContain('[^C-EG]4')
  })

  it('does not emit a tie when no pitch is tied and no event-wide flag', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [C4, E4, G4], duration: 'half' }] },
        { events: [{ pitches: [C4, E4, G4], duration: 'half' }] },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('-')
  })

  it('slur wrapping a per-pitch-tied chord parses cleanly through abcjs', () => {
    // Regression pin: slur opens emit `(` immediately before the pitch
    // token; the chord's inner `-` must not confuse abcjs's chord
    // parser into reading the slur paren as part of the chord.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'evtietest1',
              pitches: [{ ...C4, tied_to_next: true }, E4, G4],
              duration: 'half',
            },
            {
              id: 'evtietest2',
              pitches: [C4, E4, G4],
              duration: 'half',
            },
          ],
        },
      ],
      spans: [
        {
          id: 'slurtietst',
          kind: 'slur',
          startEventId: 'evtietest1',
          endEventId: 'evtietest2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toMatch(/\(\[C-EG\]4/)
    expect(abc).toMatch(/\[CEG\]4\)/)
    // abcjs round-trip: assert the slur lands on the first chord and
    // the partial tie still lands on pitch 0.
    const tune = abcjs.parseOnly(abc)[0]
    const flatNotes: Array<{ startSlur?: unknown; startTie?: unknown }[]> = []
    for (const line of tune.lines) {
      for (const staff of line.staff ?? []) {
        for (const voice of staff.voices ?? []) {
          for (const el of voice) {
            if (el.el_type !== 'note' || !el.pitches) continue
            flatNotes.push(el.pitches)
          }
        }
      }
    }
    // First chord has slur start AND pitch-0 startTie.
    expect((flatNotes[0][0] as { startTie?: unknown }).startTie).toBeDefined()
  })

  it('hairpin endpoint coinciding with a per-pitch-tied chord parses cleanly', () => {
    // Regression pin: hairpin's `!<(!` / `!<)!` decorations prepend to
    // the chain; the inner-chord `-` must not interfere with the
    // decoration block.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'evtiehp001',
              pitches: [{ ...C4, tied_to_next: true }, E4, G4],
              duration: 'half',
            },
            {
              id: 'evtiehp002',
              pitches: [C4, E4, G4],
              duration: 'half',
            },
          ],
        },
      ],
      spans: [
        {
          id: 'hairpintst',
          kind: 'hairpin-cresc',
          startEventId: 'evtiehp001',
          endEventId: 'evtiehp002',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // hairpin open `!<(!` sits in the prefix; tied chord follows.
    expect(abc).toContain('!<(!')
    expect(abc).toContain('[C-EG]4')
    expect(abc).toContain('!<)!')
    // abcjs round-trip — must not throw.
    expect(() => abcjs.parseOnly(abc)).not.toThrow()
  })

  it('lv on one tone of an event-wide-tied chord — middle pitch silently dropped from tie', () => {
    // Most subtle precedence case: event.tied_to_next:true, but the
    // middle E carries lv. Per the precedence rule
    // (`!p.lv && isPitchTiedToNext`), E never gets a tie glyph; C and
    // G still tie because they don't have lv. Result is the inner-tie
    // form `[C-EG-]` plus a `"^l.v."` annotation.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              pitches: [C4, { ...E4, lv: true }, G4],
              duration: 'half',
              tied_to_next: true,
            },
          ],
        },
        { events: [{ pitches: [C4, E4, G4], duration: 'half' }] },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^l.v."')
    expect(abc).toContain('[C-EG-]4')
    // No chord-wide outer `-` — only the inner per-pitch ties.
    expect(abc).not.toContain('[CEG]4-')
  })

  it('lv annotation does not include a tie glyph — positive equality assertion', () => {
    // Tighter contract than the earlier negative-match test: assert
    // the rendered substring exactly so future changes to the
    // decoration chain are forced to update the pin.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ ...C4, lv: true, tied_to_next: true }], duration: 'whole' },
          ],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toMatch(/"\^l\.v\."C8(?!-)/)
  })
})
