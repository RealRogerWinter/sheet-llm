import { describe, it, expect } from 'vitest'
import abcjs from 'abcjs'
import { scoreToAbcWithMap } from '@/lib/music/scoreToAbcWithMap'
import type { Score } from '@/lib/music/types'

function fourBars(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
    ],
  }
}

describe('scoreToAbcWithMap — volta rendering (M17-PR-2)', () => {
  it('emits a 1st-ending opener at the start of a mid-piece measure', () => {
    const sc: Score = {
      ...fourBars(),
      voltas: [
        {
          id: 'voltaaaaa1',
          startMeasureIdx: 2,
          endMeasureIdx: 2,
          endings: [1],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // After the m=1 endBarline (default `|`), digits `1` open
    // the volta on m=2. Pattern: `D8|1E8|`.
    expect(abc).toContain('|1E8')
  })

  it('emits comma-separated endings list (`1,2`)', () => {
    const sc: Score = {
      ...fourBars(),
      voltas: [
        {
          id: 'voltabbbb2',
          startMeasureIdx: 1,
          endMeasureIdx: 1,
          endings: [1, 2],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('|1,2D8')
  })

  it('emits a 2nd-ending opener', () => {
    const sc: Score = {
      ...fourBars(),
      voltas: [
        {
          id: 'voltacccc3',
          startMeasureIdx: 3,
          endMeasureIdx: 3,
          endings: [2],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('|2F8')
  })

  it('m=0 volta with no startBarline emits leading [N (invisible bar + digits)', () => {
    const sc: Score = {
      ...fourBars(),
      voltas: [
        {
          id: 'voltam0nob',
          startMeasureIdx: 0,
          endMeasureIdx: 0,
          endings: [1],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // No preceding barline, so emit `[1` (abcjs parses `[` + digit
    // as bar_invisible + ending 1).
    expect(abc).toMatch(/K:C\n\[1C8/)
  })

  it('m=0 volta WITH startBarline:repeat-start emits |: then 1 (no bracket)', () => {
    const sc: Score = {
      ...fourBars(),
      voltas: [
        {
          id: 'voltam0wb',
          startMeasureIdx: 0,
          endMeasureIdx: 0,
          endings: [1],
        },
      ],
    }
    sc.measures[0].startBarline = 'repeat-start'
    const { abc } = scoreToAbcWithMap(sc)
    // The repeat-start `|:` precedes the digit `1` — no `[` needed.
    expect(abc).toContain('|:1C8')
  })

  it('canonical 1st/2nd-ending pair survives abcjs round-trip with no warnings', () => {
    // Classic dance form: |: ... |1 ... :|2 ... ||
    const sc: Score = {
      ...fourBars(),
      voltas: [
        {
          id: 'voltapair1',
          startMeasureIdx: 2,
          endMeasureIdx: 2,
          endings: [1],
        },
        {
          id: 'voltapair2',
          startMeasureIdx: 3,
          endMeasureIdx: 3,
          endings: [2],
        },
      ],
    }
    sc.measures[0].startBarline = 'repeat-start'
    sc.measures[2].endBarline = 'repeat-end'
    sc.measures[3].endBarline = 'final'
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('|1E8')
    expect(abc).toContain(':|2F8')
    const tunes = abcjs.parseOnly(abc)
    expect(tunes.length).toBeGreaterThan(0)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('emits no volta opener when score.voltas is undefined or empty', () => {
    const sc = fourBars()
    const { abc } = scoreToAbcWithMap(sc)
    // Pre-M17 baseline: no extra digits between barlines.
    expect(abc).not.toMatch(/\|\d/)
  })

  it('silently skips a volta with out-of-range startMeasureIdx', () => {
    const sc: Score = {
      ...fourBars(),
      voltas: [
        {
          id: 'voltaooobs',
          startMeasureIdx: 99,
          endMeasureIdx: 99,
          endings: [1],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // No volta opener anywhere.
    expect(abc).not.toMatch(/\|1/)
  })

  it('multi-voice score: volta opener emits ONLY on the primary voice', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'whole' }] },
      ],
      extraVoices: [
        {
          measures: [
            { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
            { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
          ],
        },
      ],
      voltas: [
        {
          id: 'voltav1on',
          startMeasureIdx: 1,
          endMeasureIdx: 1,
          endings: [1],
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Primary voice V:1 carries `|1`. Secondary V:2 does NOT.
    const v1Section = abc.match(/V:1[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    const v2Section = abc.match(/V:2[\s\S]*?(?=V:|$)/)?.[0] ?? ''
    expect(v1Section).toContain('|1')
    expect(v2Section).not.toContain('|1')
  })

  it('round-trips through abcjs: emitted ABC parses the ending correctly', () => {
    const sc: Score = {
      ...fourBars(),
      voltas: [
        {
          id: 'voltaround',
          startMeasureIdx: 2,
          endMeasureIdx: 2,
          endings: [1],
        },
      ],
    }
    sc.measures[0].startBarline = 'repeat-start'
    sc.measures[2].endBarline = 'repeat-end'
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
    // Walk the parsed tune for an endings marker on the bar token.
    let foundEnding = false
    for (const line of tunes[0].lines) {
      for (const staff of line.staff ?? []) {
        for (const voice of staff.voices ?? []) {
          for (const el of voice) {
            // abcjs's VoiceItemBar has startEnding (number string)
            // when an ending opener was parsed; cast to a permissive
            // shape since the bundled type omits it.
            const bar = el as { el_type: string; startEnding?: string; endings?: unknown }
            if (bar.el_type === 'bar' && (bar.startEnding !== undefined || bar.endings !== undefined)) {
              foundEnding = true
            }
          }
        }
      }
    }
    expect(foundEnding).toBe(true)
  })

  it('volta at m=4 (the line-wrap boundary) survives without being dropped — HIGH regression pin', () => {
    // CRITICAL: pre-fix the emitter wrote `\n` BEFORE the volta
    // opener at m=4 (% 4 === 0), so abcjs saw the digit `1` at
    // column 0 and silently dropped the volta with "Unknown
    // character ignored". Fix: emit opener BEFORE the `\n`.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: Array.from({ length: 6 }, () => ({
        events: [
          { pitches: [{ step: 'C' as const, octave: 4 }], duration: 'whole' as const },
        ],
      })),
      voltas: [
        {
          id: 'voltawrap1',
          startMeasureIdx: 4,
          endMeasureIdx: 4,
          endings: [1],
        },
      ],
    }
    sc.measures[4].endBarline = 'repeat-end'
    const { abc } = scoreToAbcWithMap(sc)
    // The opener `1` must appear BEFORE the `\n` boundary, not
    // at the start of the next line.
    expect(abc).toMatch(/\|1\n/) // `|1` followed by newline
    expect(abc).not.toMatch(/\n1C/) // NEVER `\n` then `1`
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('volta coexists with hairpins / slurs / lyrics without parse errors', () => {
    const sc: Score = {
      ...fourBars(),
      voltas: [
        {
          id: 'voltacoex1',
          startMeasureIdx: 2,
          endMeasureIdx: 2,
          endings: [1],
        },
      ],
    }
    sc.measures[0].startBarline = 'repeat-start'
    sc.measures[2].endBarline = 'repeat-end'
    sc.measures[0].events[0].lyrics = [{ verse: 1, syllable: 'one' }]
    sc.measures[1].events[0].lyrics = [{ verse: 1, syllable: 'two' }]
    sc.measures[2].events[0].lyrics = [{ verse: 1, syllable: 'three' }]
    sc.measures[3].events[0].lyrics = [{ verse: 1, syllable: 'four' }]
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('|1E8')
    // Lyric line is bar-aligned with `|` separators between
    // syllables per the M15-PR-2 emit pattern.
    expect(abc).toContain('w:one | two | three | four')
    const tunes = abcjs.parseOnly(abc)
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})
