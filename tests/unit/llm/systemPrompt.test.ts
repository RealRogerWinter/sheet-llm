import { describe, it, expect } from 'vitest'
import {
  SYSTEM_PROMPT,
  ANNOTATIONS_REFERENCE,
  CHORD_SYMBOLS_REFERENCE,
  HAIRPINS_REFERENCE,
  MARKERS_REFERENCE,
  MULTI_STAFF_REFERENCE,
  PER_NOTE_MARKINGS_REFERENCE,
  SLURS_REFERENCE,
  TECHNIQUE_STATES_REFERENCE,
  TIES_REFERENCE,
  FINGERINGS_REFERENCE,
} from '@/lib/llm/systemPrompt'

describe('systemPrompt', () => {
  it('SYSTEM_PROMPT includes the MULTI_STAFF_REFERENCE block verbatim', () => {
    // The legacy generateSimple path uses SYSTEM_PROMPT as a single
    // string; the multi-block handlers use MULTI_STAFF_REFERENCE as
    // its own cache block. Both paths must teach byte-identical
    // schema guidance so the model behaves consistently across routes.
    expect(SYSTEM_PROMPT).toContain(MULTI_STAFF_REFERENCE)
  })

  it('SYSTEM_PROMPT includes the PER_NOTE_MARKINGS_REFERENCE block verbatim', () => {
    // The legacy single-string path bundles all reference blocks. The
    // multi-block path caches PER_NOTE_MARKINGS_REFERENCE in its own
    // slot; both must carry identical byte content so the model sees
    // the same marking guidance regardless of which entry it took.
    expect(SYSTEM_PROMPT).toContain(PER_NOTE_MARKINGS_REFERENCE)
  })

  it('SYSTEM_PROMPT includes the TECHNIQUE_STATES_REFERENCE block verbatim', () => {
    // Same dual-path invariant as the markings block: the legacy
    // single-string SYSTEM_PROMPT must carry the same technique
    // guidance as the multi-block compose / generateComplex layouts.
    expect(SYSTEM_PROMPT).toContain(TECHNIQUE_STATES_REFERENCE)
  })

  it('SYSTEM_PROMPT includes the FINGERINGS_REFERENCE block verbatim', () => {
    expect(SYSTEM_PROMPT).toContain(FINGERINGS_REFERENCE)
  })

  it('SYSTEM_PROMPT includes the ANNOTATIONS_REFERENCE block verbatim (M8-PR-2)', () => {
    expect(SYSTEM_PROMPT).toContain(ANNOTATIONS_REFERENCE)
  })

  it('SYSTEM_PROMPT includes the MARKERS_REFERENCE block verbatim (M9-PR-2)', () => {
    expect(SYSTEM_PROMPT).toContain(MARKERS_REFERENCE)
  })

  it('SYSTEM_PROMPT includes the CHORD_SYMBOLS_REFERENCE block verbatim (M10-PR-3)', () => {
    expect(SYSTEM_PROMPT).toContain(CHORD_SYMBOLS_REFERENCE)
  })

  it('SYSTEM_PROMPT includes the TIES_REFERENCE block verbatim (M13-PR-2)', () => {
    // render_score exposes per-pitch tied_to_next / lv / enharmonicTie
    // on every Pitch object, so the tie vocabulary is bundled into
    // compose / generateComplex / legacy generateSimple paths — unlike
    // HAIRPINS_REFERENCE and SLURS_REFERENCE, which only land in
    // editIntraMeasure because render_score does not expose `spans`.
    expect(SYSTEM_PROMPT).toContain(TIES_REFERENCE)
  })

  it('SYSTEM_PROMPT does NOT contain HAIRPINS_REFERENCE (render_score has no spans)', () => {
    // Pin the dual-asymmetry of the bundle decision: hairpin spans
    // can only be acted on via editIntraMeasure, so describing them
    // in generateSimple's SYSTEM_PROMPT would lead to silent
    // schema-rejected emissions. Same rationale as the
    // composeHandlers test fixture.
    expect(SYSTEM_PROMPT).not.toContain(HAIRPINS_REFERENCE)
  })

  it('SYSTEM_PROMPT does NOT contain SLURS_REFERENCE (render_score has no spans)', () => {
    expect(SYSTEM_PROMPT).not.toContain(SLURS_REFERENCE)
  })

  it('MULTI_STAFF_REFERENCE teaches the secondStaff field', () => {
    expect(MULTI_STAFF_REFERENCE).toContain('secondStaff')
    expect(MULTI_STAFF_REFERENCE).toContain('extraVoices')
    expect(MULTI_STAFF_REFERENCE).toContain('clef')
  })

  it('MULTI_STAFF_REFERENCE includes the grand-staff worked example', () => {
    expect(MULTI_STAFF_REFERENCE).toContain('Twinkle Twinkle (piano)')
  })

  it('MULTI_STAFF_REFERENCE includes the SATB worked example', () => {
    expect(MULTI_STAFF_REFERENCE).toContain('SATB cadence in C')
  })
})

describe('PER_NOTE_MARKINGS_REFERENCE', () => {
  it('teaches articulation stacking and the engraving rejections', () => {
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('articulations')
    // The two engraving conventions that block invalid stacks
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('marcato')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('portato')
  })

  it('teaches all 5 fermata forms and the barlineFermata measure-level field', () => {
    for (const form of ['very-short', 'short', 'standard', 'long', 'very-long']) {
      expect(PER_NOTE_MARKINGS_REFERENCE).toContain(form)
    }
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('barlineFermata')
  })

  it('teaches breath marks and caesura with the correct distinction', () => {
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('breathMark')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('caesura')
  })

  it('teaches structured dynamics with the compound vocabulary', () => {
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('dynamic_structured')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('sub.')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('espressivo')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('niente')
  })

  it('teaches Baroque ornament vocabulary and the trill upper-pitch indicator', () => {
    for (const orn of [
      'pralltriller',
      'upper-mordent',
      'lower-mordent',
      'inverted-turn',
      'delayed-turn',
      'arpeggio-up',
      'arpeggio-down',
      'non-arpeggio',
    ]) {
      expect(PER_NOTE_MARKINGS_REFERENCE).toContain(orn)
    }
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('trillUpperPitch')
  })

  it('teaches structured graceNotes with acciaccatura vs appoggiatura distinction (M7-PR-3)', () => {
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('graceNotes')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('acciaccatura')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('appoggiatura')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('slashed')
    // Explicitly teaches that grace pitches cannot be rests — the
    // refine bites if the LLM emits a rest grace.
    expect(PER_NOTE_MARKINGS_REFERENCE).toMatch(/grace.*cannot|cannot.*rest/i)
    // Mentions the legacy ornament:"grace" coexistence so a re-trained
    // model that learned the old shape understands the upgrade path.
    expect(PER_NOTE_MARKINGS_REFERENCE).toMatch(/legacy.*grace|ornament.*"grace"/i)
  })

  it('teaches tremolo, bowing (string-only), and jazz inflections', () => {
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('tremolo')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('slashes')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('bowing')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('jazzInflection')
    for (const inflection of ['fall', 'doit', 'scoop', 'plop', 'ghost']) {
      expect(PER_NOTE_MARKINGS_REFERENCE).toContain(inflection)
    }
  })

  it('teaches per-pitch ties, lv, and enharmonicTie with the chord-stack guidance', () => {
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('tied_to_next')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('lv')
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('enharmonicTie')
    // Critical guidance: per-pitch vs event-level distinction
    expect(PER_NOTE_MARKINGS_REFERENCE).toMatch(/chord/i)
  })

  it('includes a worked example illustrating multiple markings on one passage', () => {
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('Bach style phrase')
  })

  it('the embedded Bach example validates through validateScore', async () => {
    // Extract the JSON object from the reference text — defends against
    // the example drifting away from schema validity (which would teach
    // the LLM bad shapes).
    const { validateScore } = await import('@/lib/music/validateScore')
    const start = PER_NOTE_MARKINGS_REFERENCE.indexOf('{\n  "title": "Bach style phrase"')
    expect(start).toBeGreaterThan(-1)
    // Slice forward and find the matching closing brace.
    const rest = PER_NOTE_MARKINGS_REFERENCE.slice(start)
    let depth = 0
    let end = -1
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    expect(end).toBeGreaterThan(0)
    const json = rest.slice(0, end + 1)
    const parsed = JSON.parse(json)
    expect(() => validateScore(parsed)).not.toThrow()
  })

  it('explains the renderer wire-up status so the model knows which fields render today vs. persist-only', () => {
    expect(PER_NOTE_MARKINGS_REFERENCE).toContain('Renderer wire-up status')
  })

  it('claims per-pitch tied_to_next and lv now render (M13-PR-1 wire-up)', () => {
    // After M13-PR-1, per-pitch ties and lv emit visual glyphs. The
    // wire-up status paragraph must reflect this so the LLM does not
    // suppress the fields under the assumption that they "do not yet
    // appear in the rendered output."
    expect(PER_NOTE_MARKINGS_REFERENCE).toMatch(/per-pitch tied_to_next/i)
    expect(PER_NOTE_MARKINGS_REFERENCE).toMatch(/lv.*renders|renders.*lv|l\.v\./i)
  })
})

describe('TIES_REFERENCE (M13-PR-2)', () => {
  it('teaches tie vs slur disambiguation — the most common LLM error', () => {
    expect(TIES_REFERENCE).toMatch(/tie.*slur|slur.*tie/i)
    expect(TIES_REFERENCE).toMatch(/same.*pitch/i)
    expect(TIES_REFERENCE).toMatch(/different pitches/i)
  })

  it('teaches event-wide vs per-pitch tie semantics', () => {
    expect(TIES_REFERENCE).toContain('tied_to_next')
    expect(TIES_REFERENCE).toMatch(/event-wide|EVENT-level|legacy/i)
    expect(TIES_REFERENCE).toMatch(/per-pitch/i)
    expect(TIES_REFERENCE).toMatch(/OVERRIDES?/i)
  })

  it('teaches the splitting pattern (event-wide:true + per-pitch:false)', () => {
    expect(TIES_REFERENCE).toMatch(/false.*release|release.*false/i)
  })

  it('teaches lv semantics with the "no successor" rule', () => {
    expect(TIES_REFERENCE).toContain('lv')
    expect(TIES_REFERENCE).toMatch(/laissez vibrer/i)
    expect(TIES_REFERENCE).toMatch(/harp|vibraphone/i)
    expect(TIES_REFERENCE).toMatch(/no .*target|open-ended/i)
  })

  it('teaches enharmonicTie with cross-bar respell examples', () => {
    expect(TIES_REFERENCE).toContain('enharmonicTie')
    expect(TIES_REFERENCE).toMatch(/C#.*Db|Db.*C#|enharmonic.*respell/i)
  })

  it('teaches the validator-rejection patterns (so the LLM avoids them)', () => {
    expect(TIES_REFERENCE).toMatch(/last event|successor/i)
    expect(TIES_REFERENCE).toMatch(/rest/i)
    expect(TIES_REFERENCE).toMatch(/REJECTED/)
  })

  it('teaches the 4 edit ops (setPitchTie, setLv, setEnharmonicTie, toggleTie)', () => {
    expect(TIES_REFERENCE).toContain('setPitchTie')
    expect(TIES_REFERENCE).toContain('setLv')
    expect(TIES_REFERENCE).toContain('setEnharmonicTie')
    expect(TIES_REFERENCE).toContain('toggleTie')
  })

  it('includes worked examples for the four scenarios', () => {
    // Monophonic over the bar
    expect(TIES_REFERENCE).toMatch(/sustains over a barline/i)
    // Chord [C,E,G] partial tie
    expect(TIES_REFERENCE).toMatch(/only C ties/i)
    // lv at end of piece
    expect(TIES_REFERENCE).toMatch(/rings out|final.*chord/i)
    // Enharmonic respell
    expect(TIES_REFERENCE).toMatch(/enharmonic respell|Db4/i)
  })

  it('reports the M13-PR-1 renderer wire-up status accurately', () => {
    expect(TIES_REFERENCE).toMatch(/M13-PR-1/)
    expect(TIES_REFERENCE).toMatch(/per-pitch.*tied_to_next/i)
  })
})

describe('TECHNIQUE_STATES_REFERENCE', () => {
  it('teaches the full performance-technique vocabulary', () => {
    for (const kind of [
      'pizz',
      'arco',
      'col-legno-battuto',
      'col-legno-tratto',
      'sul-ponticello',
      'sul-tasto',
      'flautando',
      'ord',
      'snap-pizz',
      'LH-pizz',
      'tremolo',
      'mute-on',
      'mute-off',
    ]) {
      expect(TECHNIQUE_STATES_REFERENCE).toContain(kind)
    }
  })

  it('teaches the state-vs-articulation distinction', () => {
    // Critical: the LLM must NOT use pizz as a per-note articulation.
    expect(TECHNIQUE_STATES_REFERENCE).toMatch(/state/i)
    expect(TECHNIQUE_STATES_REFERENCE).toMatch(/persist/i)
    expect(TECHNIQUE_STATES_REFERENCE).toContain('articulation')
  })

  it('teaches the cancellation pairs (arco cancels pizz, ord cancels sul-ponticello / sul-tasto / flautando)', () => {
    // Spot-check by looking for explicit cancellation phrasing.
    expect(TECHNIQUE_STATES_REFERENCE).toMatch(/arco.*cancels.*pizz|Cancelled by .arco./i)
    expect(TECHNIQUE_STATES_REFERENCE).toMatch(/ord/i)
  })

  it('teaches the shape: measureIdx, staffIdx, voiceIdx, kind, optional eventIdx (and no id)', () => {
    expect(TECHNIQUE_STATES_REFERENCE).toContain('measureIdx')
    expect(TECHNIQUE_STATES_REFERENCE).toContain('staffIdx')
    expect(TECHNIQUE_STATES_REFERENCE).toContain('voiceIdx')
    expect(TECHNIQUE_STATES_REFERENCE).toContain('eventIdx')
    expect(TECHNIQUE_STATES_REFERENCE).toContain('kind')
    // The block must explicitly tell the LLM NOT to mint ids
    expect(TECHNIQUE_STATES_REFERENCE).toMatch(/don't emit an id|do not emit an id/i)
  })

  it('warns against using techniqueStates on piano / vocal / wind parts', () => {
    expect(TECHNIQUE_STATES_REFERENCE).toMatch(/piano|wind|vocal/i)
  })

  it('includes a worked example illustrating a pizz/arco switch', () => {
    expect(TECHNIQUE_STATES_REFERENCE).toContain('Cello pizz/arco')
  })

  it('the embedded worked example validates through validateScore', async () => {
    const { validateScore } = await import('@/lib/music/validateScore')
    const start = TECHNIQUE_STATES_REFERENCE.indexOf('{\n  "title": "Cello pizz/arco"')
    expect(start).toBeGreaterThan(-1)
    const rest = TECHNIQUE_STATES_REFERENCE.slice(start)
    let depth = 0
    let end = -1
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    expect(end).toBeGreaterThan(0)
    const json = rest.slice(0, end + 1)
    const parsed = JSON.parse(json)
    expect(() => validateScore(parsed)).not.toThrow()
  })

  it('explains the renderer wire-up status (technique markers persist; visual rendering follow-up)', () => {
    expect(TECHNIQUE_STATES_REFERENCE).toContain('Renderer wire-up status')
  })
})

describe('FINGERINGS_REFERENCE', () => {
  it('teaches all five instrument families', () => {
    for (const system of ['piano', 'string', 'guitar-lh', 'guitar-rh', 'organ']) {
      expect(FINGERINGS_REFERENCE).toContain(system)
    }
  })

  it('teaches the per-pitch indexing convention and the null skip-slot sentinel', () => {
    expect(FINGERINGS_REFERENCE).toContain('pitches')
    // The block must explicitly call out the null-for-skip convention.
    expect(FINGERINGS_REFERENCE).toMatch(/null/)
    expect(FINGERINGS_REFERENCE).toMatch(/skip/i)
  })

  it('teaches the piano 0-5 vocabulary including thumb-crossing and pinky', () => {
    expect(FINGERINGS_REFERENCE).toMatch(/thumb/i)
    expect(FINGERINGS_REFERENCE).toMatch(/pinky/i)
  })

  it('teaches the string 0-4 + Roman numeral indicator', () => {
    expect(FINGERINGS_REFERENCE).toContain('stringRoman')
    expect(FINGERINGS_REFERENCE).toMatch(/I.*II.*III.*IV/)
  })

  it('teaches the guitar-rh Spanish letter system', () => {
    for (const letter of ['p', 'i', 'm', 'a', 'c']) {
      expect(FINGERINGS_REFERENCE).toContain(`"${letter}"`)
    }
    expect(FINGERINGS_REFERENCE).toMatch(/pulgar|índice|medio|anular|chiquito/i)
  })

  it('teaches the organ heel/toe + thumb-direction modifiers', () => {
    expect(FINGERINGS_REFERENCE).toContain('heel')
    expect(FINGERINGS_REFERENCE).toContain('toe')
    expect(FINGERINGS_REFERENCE).toContain('thumbDirection')
  })

  it('explains the renderer wire-up status (schema accepts; rendering follow-up)', () => {
    expect(FINGERINGS_REFERENCE).toContain('Renderer wire-up status')
  })

  it('includes a worked example for a piano 1-3-5 chord', () => {
    expect(FINGERINGS_REFERENCE).toContain('Piano C major chord fingered')
  })

  it('the embedded worked example validates through validateScore', async () => {
    const { validateScore } = await import('@/lib/music/validateScore')
    const start = FINGERINGS_REFERENCE.indexOf('{\n  "title": "Piano C major chord fingered"')
    expect(start).toBeGreaterThan(-1)
    const rest = FINGERINGS_REFERENCE.slice(start)
    let depth = 0
    let end = -1
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    expect(end).toBeGreaterThan(0)
    const json = rest.slice(0, end + 1)
    const parsed = JSON.parse(json)
    expect(() => validateScore(parsed)).not.toThrow()
  })
})

describe('ANNOTATIONS_REFERENCE (M8-PR-2)', () => {
  it('teaches the two distinct surfaces (score metadata + annotations array)', () => {
    expect(ANNOTATIONS_REFERENCE).toMatch(/score-level/i)
    for (const field of ['composer', 'arranger', 'lyricist', 'copyright']) {
      expect(ANNOTATIONS_REFERENCE).toContain(field)
    }
    expect(ANNOTATIONS_REFERENCE).toContain('annotations')
  })

  it('teaches the full AnnotationStyleSchema vocabulary', () => {
    for (const style of [
      'plain',
      'italic',
      'bold',
      'rehearsal-mark',
      'tempo-text',
      'expression',
    ]) {
      expect(ANNOTATIONS_REFERENCE).toContain(style)
    }
  })

  it('teaches the disambiguation against dynamics, technique state, ornaments', () => {
    expect(ANNOTATIONS_REFERENCE).toMatch(/dynamic_structured|dynamic.*event/i)
    expect(ANNOTATIONS_REFERENCE).toContain('techniqueStates')
    expect(ANNOTATIONS_REFERENCE).toMatch(/ornament/)
  })

  it('teaches line-extending spanEnd for rit./accel./cresc.', () => {
    expect(ANNOTATIONS_REFERENCE).toContain('spanEnd')
    expect(ANNOTATIONS_REFERENCE).toMatch(/rit\.|accel\.|cresc\./)
    expect(ANNOTATIONS_REFERENCE).toMatch(/forward/i)
  })

  it('includes a worked example with composer + rehearsal mark + tempo text + expression', () => {
    expect(ANNOTATIONS_REFERENCE).toContain('Two-Part Invention No. 1')
    expect(ANNOTATIONS_REFERENCE).toContain('rehearsal-mark')
    expect(ANNOTATIONS_REFERENCE).toContain('Allegro')
    expect(ANNOTATIONS_REFERENCE).toContain('dolce')
  })

  it('the embedded worked example validates through validateScore', async () => {
    const { validateScore } = await import('@/lib/music/validateScore')
    const start = ANNOTATIONS_REFERENCE.indexOf('{\n  "title": "Two-Part Invention No. 1"')
    expect(start).toBeGreaterThan(-1)
    const rest = ANNOTATIONS_REFERENCE.slice(start)
    let depth = 0
    let end = -1
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    expect(end).toBeGreaterThan(0)
    const json = rest.slice(0, end + 1)
    const parsed = JSON.parse(json)
    expect(() => validateScore(parsed)).not.toThrow()
  })
})

describe('MARKERS_REFERENCE (M9-PR-2)', () => {
  it('teaches the marker shape with all 6 mutable fields', () => {
    for (const f of [
      'measureIdx',
      'key',
      'meter',
      'tempo_bpm',
      'tempo_text',
      'clefs',
      'metricModulation',
    ]) {
      expect(MARKERS_REFERENCE).toContain(f)
    }
  })

  it('teaches the metric-modulation pivot values + composer attribution', () => {
    expect(MARKERS_REFERENCE).toMatch(/quarter|dotted-quarter|eighth/)
    expect(MARKERS_REFERENCE).toMatch(/Carter|Reich|Adams/)
  })

  it('disambiguates against score-wide tempo + annotations', () => {
    expect(MARKERS_REFERENCE).toMatch(/score-wide|SCORE-WIDE/i)
    expect(MARKERS_REFERENCE).toContain('annotations')
    expect(MARKERS_REFERENCE).toContain('tempo_bpm')
  })

  it('teaches tempo_bpm + tempo_text combining on one marker', () => {
    expect(MARKERS_REFERENCE).toMatch(/together|same marker|one event/i)
  })

  it('includes both a mid-piece tempo example AND a metric modulation example', () => {
    expect(MARKERS_REFERENCE).toContain('Allegro')
    expect(MARKERS_REFERENCE).toMatch(/metricModulation/)
    expect(MARKERS_REFERENCE).toMatch(/fromNote.*quarter|"fromNote":/)
  })
})

describe('CHORD_SYMBOLS_REFERENCE (M10-PR-3)', () => {
  it('teaches the structured-shape vocabulary', () => {
    for (const field of [
      'root',
      'quality',
      'seventh',
      'extensions',
      'alterations',
      'add',
      'omit',
      'bass',
      'modal',
    ]) {
      expect(CHORD_SYMBOLS_REFERENCE).toContain(field)
    }
  })

  it('disambiguates chordSymbol from pitches AND from annotations', () => {
    // chordSymbol is the LABEL, not the harmony content; annotations
    // are for non-harmony text (tempo / expression).
    expect(CHORD_SYMBOLS_REFERENCE).toMatch(/pitches array/i)
    expect(CHORD_SYMBOLS_REFERENCE).toMatch(/annotation/i)
  })

  it('shows worked examples for common chord types', () => {
    for (const example of ['Cmaj7', 'Cm7', 'C9', 'Cadd9', 'F#m7b5', 'C/E', 'C|G', 'C Mixolydian']) {
      expect(CHORD_SYMBOLS_REFERENCE).toContain(example)
    }
  })

  it('distinguishes Cadd9 from C9 (common LLM confusion)', () => {
    expect(CHORD_SYMBOLS_REFERENCE).toMatch(/distinct from C9|Cadd9.*distinct/i)
  })
})
