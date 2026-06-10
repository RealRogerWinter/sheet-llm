import { describe, it, expect } from 'vitest'
import { renderScoreTool, RENDER_SCORE_TOOL_NAME } from '@/lib/llm/renderScoreTool'
import { validateScore } from '@/lib/music/validateScore'

// The renderScoreTool wire schema is a plain JSON Schema. We don't ship
// an AJV runtime, so these tests inspect the schema's shape (which
// fields exist, which enums they expose) rather than executing a
// validator. Round-trip correctness — "a Score that conforms to this
// schema also passes validateScore" — is covered separately at the
// bottom of the file.

// Drill down into the schema for a per-event field. The schema mirrors
// across primary `measures`, `extraVoices`, `secondStaff.measures`, and
// `secondStaff.extraVoices`, so the per-event surface is identical on
// every staff/voice; testing the primary path is sufficient to catch
// regressions because they all reuse the same STAFF_MEASURE_PROPERTIES
// constant.
function eventFieldSchema(field: string): Record<string, unknown> | undefined {
  const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
  const measures = (properties.measures as { items: { properties: { events: { items: { properties: Record<string, unknown> } } } } }).items.properties.events.items.properties
  return measures[field] as Record<string, unknown> | undefined
}

function pitchFieldSchema(field: string): Record<string, unknown> | undefined {
  const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
  const pitchItems = (properties.measures as { items: { properties: { events: { items: { properties: { pitches: { items: { properties: Record<string, unknown> } } } } } } } }).items.properties.events.items.properties.pitches.items.properties
  return pitchItems[field] as Record<string, unknown> | undefined
}

function measureFieldSchema(field: string): Record<string, unknown> | undefined {
  const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
  return (properties.measures as { items: { properties: Record<string, unknown> } }).items.properties[field] as Record<string, unknown> | undefined
}

describe('renderScoreTool', () => {
  it('keeps the tool name stable', () => {
    expect(RENDER_SCORE_TOOL_NAME).toBe('render_score')
    expect(renderScoreTool.name).toBe('render_score')
  })

  describe('per-event articulations (stacking)', () => {
    it('exposes an articulations array field alongside the singular articulation', () => {
      const arr = eventFieldSchema('articulations')
      expect(arr).toBeDefined()
      expect((arr as { type: string }).type).toBe('array')
      const items = (arr as { items: { enum: string[] } }).items
      expect(items.enum).toContain('staccato')
      expect(items.enum).toContain('portato')
    })

    it('extends the singular articulation enum with portato', () => {
      const art = eventFieldSchema('articulation')
      expect((art as { enum: string[] }).enum).toContain('portato')
    })
  })

  describe('per-event fermata', () => {
    it('exposes all 5 fermata duration forms', () => {
      const fermata = eventFieldSchema('fermata')
      const forms = (fermata as { enum: string[] }).enum
      expect(forms).toEqual(
        expect.arrayContaining(['very-short', 'short', 'standard', 'long', 'very-long']),
      )
    })
  })

  describe('measure-level barlineFermata', () => {
    it('exposes barlineFermata with the same 5-form enum as event fermata', () => {
      const bf = measureFieldSchema('barlineFermata')
      expect(bf).toBeDefined()
      const forms = (bf as { enum: string[] }).enum
      expect(forms).toEqual(
        expect.arrayContaining(['very-short', 'short', 'standard', 'long', 'very-long']),
      )
    })
  })

  describe('per-event breath mark and caesura', () => {
    it('exposes breathMark as a boolean', () => {
      const br = eventFieldSchema('breathMark')
      expect((br as { type: string }).type).toBe('boolean')
    })

    it('exposes caesura as a boolean', () => {
      const c = eventFieldSchema('caesura')
      expect((c as { type: string }).type).toBe('boolean')
    })
  })

  describe('per-event tremolo', () => {
    it('exposes tremolo as an object with slashes 1-5 and optional measured boolean', () => {
      const tremolo = eventFieldSchema('tremolo')
      expect(tremolo).toBeDefined()
      const props = (tremolo as { properties: { slashes: { enum: number[] }; measured: { type: string } } }).properties
      expect(props.slashes.enum).toEqual([1, 2, 3, 4, 5])
      expect(props.measured.type).toBe('boolean')
      expect((tremolo as { required: string[] }).required).toEqual(['slashes'])
    })
  })

  describe('per-event bowing', () => {
    it('exposes bowing with up and down', () => {
      const bowing = eventFieldSchema('bowing')
      expect((bowing as { enum: string[] }).enum).toEqual(['up', 'down'])
    })
  })

  describe('per-event jazz inflections', () => {
    it('exposes jazzInflection with the 5 canonical inflections', () => {
      const j = eventFieldSchema('jazzInflection')
      expect((j as { enum: string[] }).enum).toEqual(['fall', 'doit', 'scoop', 'plop', 'ghost'])
    })
  })

  describe('per-event ornaments (Baroque vocabulary)', () => {
    it('exposes the 15-value Baroque ornament vocabulary', () => {
      const orn = eventFieldSchema('ornament')
      const values = (orn as { enum: string[] }).enum
      // Spot-check the additions vs. the legacy 4-value enum
      for (const v of [
        'pralltriller',
        'upper-mordent',
        'lower-mordent',
        'schneller',
        'inverted-turn',
        'delayed-turn',
        'slide',
        'arpeggio-up',
        'arpeggio-down',
        'non-arpeggio',
      ]) {
        expect(values).toContain(v)
      }
      // Legacy values still present
      expect(values).toContain('trill')
      expect(values).toContain('mordent')
      expect(values).toContain('turn')
      expect(values).toContain('grace')
      expect(values).toContain('none')
    })

    it('exposes trillUpperPitch for Bach-style tr♯ / tr♭', () => {
      const tup = eventFieldSchema('trillUpperPitch')
      const values = (tup as { enum: string[] }).enum
      expect(values).toEqual(['natural', 'sharp', 'flat', 'dblsharp', 'dblflat'])
    })

    it('exposes graceNotes as an array of grace moments (M7-PR-3)', () => {
      const gn = eventFieldSchema('graceNotes')
      expect(gn).toBeDefined()
      const schema = gn as {
        type: string
        maxItems: number
        items: {
          required: string[]
          properties: {
            pitches: { type: string; minItems: number; maxItems: number; items: unknown }
            duration: { enum: string[] }
            slashed: { type: string }
          }
        }
      }
      expect(schema.type).toBe('array')
      expect(schema.maxItems).toBe(8)
      expect(schema.items.required).toEqual(['pitches', 'duration'])
      expect(schema.items.properties.pitches.minItems).toBe(1)
      expect(schema.items.properties.pitches.maxItems).toBe(6)
      expect(schema.items.properties.duration.enum).toEqual(['eighth', 'sixteenth', '32nd'])
      expect(schema.items.properties.slashed.type).toBe('boolean')
    })

    it('GRACE_DURATION_ENUM is in sync with GraceDurationSchema (source of truth)', async () => {
      // The wire-schema enum at renderScoreTool.ts:50 is a manual copy
      // of GraceDurationSchema in lib/music/types.ts. File header
      // requires they stay in sync. This pin test fails loudly if a
      // future PR adds/removes values from one without the other.
      const { GraceDurationSchema } = await import('@/lib/music/types')
      const sourceOfTruth = GraceDurationSchema.options
      const gn = eventFieldSchema('graceNotes')
      const wireEnum = (
        gn as { items: { properties: { duration: { enum: string[] } } } }
      ).items.properties.duration.enum
      expect(wireEnum).toEqual([...sourceOfTruth])
    })

    it('grace pitch step enum EXCLUDES rest (no-rest invariant at the schema boundary)', () => {
      // Mirrors the GraceNoteSchema refine: rest pitches in graces are
      // an engraving incoherence. The wire schema should not even
      // suggest 'rest' as an option.
      const gn = eventFieldSchema('graceNotes')
      const stepSchema = (
        gn as {
          items: {
            properties: { pitches: { items: { properties: { step: { enum: string[] } } } } }
          }
        }
      ).items.properties.pitches.items.properties.step
      expect(stepSchema.enum).not.toContain('rest')
      expect(stepSchema.enum).toEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B'])
    })
  })

  describe('per-event dynamics', () => {
    it('exposes the full single-glyph dynamic enum (pppp..ffff, niente, sfz family)', () => {
      const dyn = eventFieldSchema('dynamic')
      const values = (dyn as { enum: string[] }).enum
      for (const v of ['pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff']) {
        expect(values).toContain(v)
      }
      expect(values).toContain('n') // niente
      for (const v of ['fp', 'sfz', 'sffz', 'sfp']) {
        expect(values).toContain(v)
      }
    })

    it('exposes dynamic_structured for compound dynamics (sub. p espressivo)', () => {
      const ds = eventFieldSchema('dynamic_structured')
      expect(ds).toBeDefined()
      const props = (ds as { properties: { base: { enum: string[] }; prefix: { enum: string[] }; suffix: { type: string } } }).properties
      expect(props.base.enum).toContain('p')
      expect(props.prefix.enum).toEqual(['sub.', 'poco', 'meno', 'più'])
      expect(props.suffix.type).toBe('string')
      expect((ds as { required: string[] }).required).toEqual(['base'])
    })
  })

  describe('per-pitch markings', () => {
    it('exposes per-pitch tied_to_next, lv, and enharmonicTie on each pitch object', () => {
      const tied = pitchFieldSchema('tied_to_next')
      expect((tied as { type: string }).type).toBe('boolean')

      const lv = pitchFieldSchema('lv')
      expect((lv as { type: string }).type).toBe('boolean')

      const eht = pitchFieldSchema('enharmonicTie')
      expect((eht as { type: string }).type).toBe('boolean')
    })

    it('requires only step + octave on a pitch — accidental is optional (natural when omitted)', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const pitchItems = (properties.measures as { items: { properties: { events: { items: { properties: { pitches: { items: { required: string[] } } } } } } } }).items.properties.events.items.properties.pitches.items
      expect(pitchItems.required).toEqual(['step', 'octave'])
    })
  })

  describe('top-level techniqueStates', () => {
    it('exposes techniqueStates as a top-level array', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const ts = properties.techniqueStates as Record<string, unknown> | undefined
      expect(ts).toBeDefined()
      expect((ts as { type: string }).type).toBe('array')
    })

    it('exposes the full performance-technique vocabulary on kind', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const items = (properties.techniqueStates as { items: { properties: { kind: { enum: string[] } } } }).items
      const kinds = items.properties.kind.enum
      for (const k of [
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
        expect(kinds).toContain(k)
      }
    })

    it('requires only measureIdx + staffIdx + voiceIdx + kind (id and eventIdx optional)', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const items = (properties.techniqueStates as { items: { required: string[]; properties: Record<string, unknown> } }).items
      expect(items.required).toEqual(['measureIdx', 'staffIdx', 'voiceIdx', 'kind'])
      // id is not in the required list — the LLM doesn't mint ids
      expect(items.required).not.toContain('id')
      // eventIdx is exposed but not required
      expect(items.properties.eventIdx).toBeDefined()
      expect(items.required).not.toContain('eventIdx')
    })

    it('constrains staffIdx to 0..1 and voiceIdx to 0..3 (matches schema bounds)', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const props = (properties.techniqueStates as { items: { properties: { staffIdx: { enum: number[] }; voiceIdx: { enum: number[] } } } }).items.properties
      expect(props.staffIdx.enum).toEqual([0, 1])
      expect(props.voiceIdx.enum).toEqual([0, 1, 2, 3])
    })
  })

  describe('top-level annotations + score metadata (M8-PR-2)', () => {
    it('exposes annotations as a top-level array (max 100)', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const ann = properties.annotations as Record<string, unknown> | undefined
      expect(ann).toBeDefined()
      expect((ann as { type: string }).type).toBe('array')
      expect((ann as { maxItems: number }).maxItems).toBe(100)
    })

    it('requires target + text + style (id minted server-side, eventIdx + spanEnd optional)', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const items = (
        properties.annotations as { items: { required: string[]; properties: Record<string, unknown> } }
      ).items
      expect(items.required).toEqual(['target', 'text', 'style'])
      expect(items.required).not.toContain('id')
      expect(items.properties.spanEnd).toBeDefined()
    })

    it('exposes the full AnnotationStyleSchema vocabulary', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const styleEnum = (
        properties.annotations as { items: { properties: { style: { enum: string[] } } } }
      ).items.properties.style.enum
      for (const s of [
        'plain',
        'italic',
        'bold',
        'rehearsal-mark',
        'tempo-text',
        'expression',
      ]) {
        expect(styleEnum).toContain(s)
      }
    })

    it('target.position is constrained to above/below/left/right', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const posEnum = (
        properties.annotations as {
          items: { properties: { target: { properties: { position: { enum: string[] } } } } }
        }
      ).items.properties.target.properties.position.enum
      expect(posEnum).toEqual(['above', 'below', 'left', 'right'])
    })

    it('annotation target requires measureIdx + position (eventIdx optional)', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const targetSchema = (
        properties.annotations as {
          items: { properties: { target: { required: string[]; properties: Record<string, unknown> } } }
        }
      ).items.properties.target
      expect(targetSchema.required).toEqual(['measureIdx', 'position'])
      expect(targetSchema.required).not.toContain('eventIdx')
      expect(targetSchema.properties.eventIdx).toBeDefined()
    })

    it('spanEnd requires measureIdx (eventIdx optional) — matches "rit. ____" semantics', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const spanEnd = (
        properties.annotations as {
          items: { properties: { spanEnd: { required: string[]; properties: Record<string, unknown> } } }
        }
      ).items.properties.spanEnd
      expect(spanEnd.required).toEqual(['measureIdx'])
      expect(spanEnd.properties.eventIdx).toBeDefined()
    })

    it('exposes score-level metadata fields (composer / arranger / lyricist / copyright) as top-level strings', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      for (const field of ['composer', 'arranger', 'lyricist', 'copyright']) {
        const f = properties[field] as Record<string, unknown> | undefined
        expect(f).toBeDefined()
        expect((f as { type: string }).type).toBe('string')
      }
    })

    it('metadata fields stay OPTIONAL (not added to required)', () => {
      const required = renderScoreTool.input_schema.required as readonly string[]
      for (const field of ['composer', 'arranger', 'lyricist', 'copyright', 'annotations']) {
        expect(required).not.toContain(field)
      }
    })
  })

  describe('top-level markers (M9-PR-2)', () => {
    it('exposes markers as a top-level array (max 200)', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const mk = properties.markers as Record<string, unknown> | undefined
      expect(mk).toBeDefined()
      expect((mk as { type: string }).type).toBe('array')
      expect((mk as { maxItems: number }).maxItems).toBe(200)
    })

    it('requires only measureIdx (all change fields optional — refine enforces at-least-one)', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const items = (
        properties.markers as { items: { required: string[]; properties: Record<string, unknown> } }
      ).items
      expect(items.required).toEqual(['measureIdx'])
      for (const f of [
        'key',
        'meter',
        'tempo_bpm',
        'tempo_text',
        'clefs',
        'metricModulation',
      ]) {
        expect(items.properties[f]).toBeDefined()
      }
    })

    it('metricModulation requires fromNote + toNote with the 7 pivot values', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const mm = (
        properties.markers as {
          items: {
            properties: {
              metricModulation: {
                required: string[]
                properties: { fromNote: { enum: string[] }; toNote: { enum: string[] } }
              }
            }
          }
        }
      ).items.properties.metricModulation
      expect(mm.required).toEqual(['fromNote', 'toNote'])
      const expected = [
        'half',
        'dotted-half',
        'quarter',
        'dotted-quarter',
        'eighth',
        'dotted-eighth',
        'sixteenth',
      ]
      expect(mm.properties.fromNote.enum).toEqual(expected)
      expect(mm.properties.toNote.enum).toEqual(expected)
    })

    it('clefs entry requires staffIdx + clef with the same enums as the top-level clef field', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const clefs = (
        properties.markers as {
          items: {
            properties: {
              clefs: {
                items: {
                  required: string[]
                  properties: { staffIdx: { enum: number[] }; clef: { enum: string[] } }
                }
              }
            }
          }
        }
      ).items.properties.clefs
      expect(clefs.items.required).toEqual(['staffIdx', 'clef'])
      expect(clefs.items.properties.staffIdx.enum).toEqual([0, 1])
      expect(clefs.items.properties.clef.enum).toEqual(['treble', 'bass'])
    })

    it('markers stays OPTIONAL (not added to required)', () => {
      const required = renderScoreTool.input_schema.required as readonly string[]
      expect(required).not.toContain('markers')
    })
  })

  describe('per-event chordSymbol (M10-PR-3)', () => {
    it('exposes the structured ChordSymbol shape with root + quality + seventh required', () => {
      const cs = eventFieldSchema('chordSymbol')
      expect(cs).toBeDefined()
      const schema = cs as {
        type: string
        required: string[]
        properties: Record<string, { type?: string; enum?: string[]; pattern?: string }>
      }
      expect(schema.type).toBe('object')
      expect(schema.required).toEqual(['root', 'quality', 'seventh'])
      expect(schema.properties.root.pattern).toBe('^[A-G](#|b)?$')
    })

    it('quality / seventh / modal enums stay in sync with the source-of-truth Zod schemas', async () => {
      const { ChordQualitySchema, ChordSeventhSchema, ChordModalSchema } = await import(
        '@/lib/music/types'
      )
      const cs = eventFieldSchema('chordSymbol') as {
        properties: {
          quality: { enum: string[] }
          seventh: { enum: string[] }
          modal: { enum: string[] }
        }
      }
      expect(cs.properties.quality.enum).toEqual([...ChordQualitySchema.options])
      expect(cs.properties.seventh.enum).toEqual([...ChordSeventhSchema.options])
      expect(cs.properties.modal.enum).toEqual([...ChordModalSchema.options])
    })

    it('extensions / add / omit are integer-array enums', () => {
      const cs = eventFieldSchema('chordSymbol') as {
        properties: {
          extensions: { type: string; items: { enum: number[] } }
          add: { items: { enum: number[] } }
          omit: { items: { enum: number[] } }
        }
      }
      expect(cs.properties.extensions.type).toBe('array')
      expect(cs.properties.extensions.items.enum).toEqual([9, 11, 13])
      expect(cs.properties.add.items.enum).toEqual([2, 4, 6, 9, 11, 13])
      expect(cs.properties.omit.items.enum).toEqual([3, 5, 7])
    })

    it('bass slot accepts both note + nested-chord shapes via oneOf', () => {
      const cs = eventFieldSchema('chordSymbol') as {
        properties: {
          bass: {
            oneOf?: Array<{
              required: string[]
              properties: { type: { enum: string[] }; value: unknown }
            }>
          }
        }
      }
      expect(cs.properties.bass.oneOf).toBeDefined()
      const variants = cs.properties.bass.oneOf!
      expect(variants).toHaveLength(2)
      const types = variants.map((v) => v.properties.type.enum[0])
      expect(types.sort()).toEqual(['chord', 'note'])
    })

    it('marker.metricModulation pivot values stay in sync with MetricModulationNoteSchema (source of truth)', async () => {
      // Same pin-test pattern as GRACE_DURATION_ENUM sync (M7-PR-3
      // review fix). Asserts the inline marker.metricModulation.fromNote
      // enum equals MetricModulationNoteSchema's underlying values.
      const { MetricModulationNoteSchema } = await import('@/lib/music/types')
      const sourceOfTruth = MetricModulationNoteSchema.options
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const fromEnum = (
        properties.markers as {
          items: { properties: { metricModulation: { properties: { fromNote: { enum: string[] } } } } }
        }
      ).items.properties.metricModulation.properties.fromNote.enum
      const toEnum = (
        properties.markers as {
          items: { properties: { metricModulation: { properties: { toNote: { enum: string[] } } } } }
        }
      ).items.properties.metricModulation.properties.toNote.enum
      expect(fromEnum).toEqual([...sourceOfTruth])
      expect(toEnum).toEqual([...sourceOfTruth])
    })

    it('marker.key enum stays in sync with KeySchema (source of truth)', async () => {
      const { KeySchema } = await import('@/lib/music/types')
      const sourceOfTruth = KeySchema.options
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const keyEnum = (
        properties.markers as { items: { properties: { key: { enum: string[] } } } }
      ).items.properties.key.enum
      expect(keyEnum).toEqual([...sourceOfTruth])
    })
  })

  describe('per-event fingerings', () => {
    it('exposes fingerings as an array of tagged-union or null items', () => {
      const fg = eventFieldSchema('fingerings')
      expect(fg).toBeDefined()
      expect((fg as { type: string }).type).toBe('array')
      const items = (fg as { items: { oneOf: Array<{ type?: string; properties?: { system?: { enum: string[] } } }> } }).items
      expect(items.oneOf).toBeDefined()
      // Five system variants + one null variant
      expect(items.oneOf.length).toBe(6)
      const systems = items.oneOf
        .filter((v) => v.type !== 'null')
        .map((v) => v.properties!.system!.enum[0])
      expect(systems).toEqual(
        expect.arrayContaining(['piano', 'string', 'guitar-lh', 'guitar-rh', 'organ']),
      )
      const hasNull = items.oneOf.some((v) => v.type === 'null')
      expect(hasNull).toBe(true)
    })

    it('piano variant exposes value 0-5 and optional substitution', () => {
      const fg = eventFieldSchema('fingerings')
      const piano = ((fg as { items: { oneOf: Array<{ properties?: { system?: { enum: string[] }; value?: { enum: string[] }; substitution?: unknown } }> } }).items.oneOf).find(
        (v) => v.properties?.system?.enum?.[0] === 'piano',
      )
      expect(piano).toBeDefined()
      expect(piano!.properties!.value!.enum).toEqual(['0', '1', '2', '3', '4', '5'])
      expect(piano!.properties!.substitution).toBeDefined()
    })

    it('guitar-rh variant exposes the p/i/m/a/c Spanish letter system', () => {
      const fg = eventFieldSchema('fingerings')
      const rh = ((fg as { items: { oneOf: Array<{ properties?: { system?: { enum: string[] }; value?: { enum: string[] } } }> } }).items.oneOf).find(
        (v) => v.properties?.system?.enum?.[0] === 'guitar-rh',
      )
      expect(rh).toBeDefined()
      expect(rh!.properties!.value!.enum).toEqual(['p', 'i', 'm', 'a', 'c'])
    })

    it('a Score with fingerings on a piano chord validates', () => {
      const score = {
        title: 'Piano chord fingered',
        key: 'C' as const,
        meter: '4/4',
        measures: [
          {
            events: [
              {
                pitches: [
                  { step: 'C' as const, octave: 4, accidental: 'none' as const },
                  { step: 'E' as const, octave: 4, accidental: 'none' as const },
                  { step: 'G' as const, octave: 4, accidental: 'none' as const },
                ],
                duration: 'whole' as const,
                fingerings: [
                  { system: 'piano' as const, value: '1' as const },
                  { system: 'piano' as const, value: '3' as const },
                  { system: 'piano' as const, value: '5' as const },
                ],
              },
            ],
          },
        ],
      }
      expect(() => validateScore(score)).not.toThrow()
    })

    it('a Score with null fingering slots (skip pitch) validates', () => {
      const score = {
        title: 'Top-only fingering',
        key: 'C' as const,
        meter: '4/4',
        measures: [
          {
            events: [
              {
                pitches: [
                  { step: 'C' as const, octave: 4, accidental: 'none' as const },
                  { step: 'E' as const, octave: 4, accidental: 'none' as const },
                  { step: 'G' as const, octave: 4, accidental: 'none' as const },
                ],
                duration: 'whole' as const,
                fingerings: [null, null, { system: 'piano' as const, value: '5' as const }],
              },
            ],
          },
        ],
      }
      expect(() => validateScore(score)).not.toThrow()
    })
  })

  describe('per-event lyrics (M15-PR-3)', () => {
    it('exposes the lyrics field on every event surface', () => {
      const lyrics = eventFieldSchema('lyrics') as { type: string; maxItems: number; items: { properties: Record<string, { type: string }> } } | undefined
      expect(lyrics).toBeDefined()
      expect(lyrics!.type).toBe('array')
      expect(lyrics!.maxItems).toBe(50)
    })

    it('LyricSyllable item exposes verse (1..50), syllable (1..40), hyphen, extender', () => {
      const lyrics = eventFieldSchema('lyrics') as {
        items: {
          properties: {
            verse: { type: string; minimum: number; maximum: number }
            syllable: { type: string; minLength: number; maxLength: number }
            hyphen: { type: string }
            extender: { type: string }
          }
          required: string[]
        }
      }
      const item = lyrics.items
      expect(item.properties.verse.type).toBe('integer')
      expect(item.properties.verse.minimum).toBe(1)
      expect(item.properties.verse.maximum).toBe(50)
      expect(item.properties.syllable.type).toBe('string')
      expect(item.properties.syllable.minLength).toBe(1)
      expect(item.properties.syllable.maxLength).toBe(40)
      expect(item.properties.hyphen.type).toBe('boolean')
      expect(item.properties.extender.type).toBe('boolean')
      // Verse + syllable are required; hyphen + extender are optional.
      expect(item.required).toEqual(['verse', 'syllable'])
    })

    it('lyrics field is mirrored onto every staff/voice surface (primary + secondStaff + both extraVoices)', () => {
      // A future refactor that drops STAFF_MEASURE_PROPERTIES in
      // favor of per-callsite spread would silently strip lyrics
      // from some surfaces. The serialized schema text must
      // contain `"lyrics"` four times — once per nested events
      // block (primary, extraVoices, secondStaff, secondStaff
      // extraVoices).
      const serialized = JSON.stringify(renderScoreTool.input_schema)
      const occurrences = serialized.split('"lyrics"').length - 1
      expect(occurrences).toBeGreaterThanOrEqual(4)
    })
  })

  describe('secondStaff parity', () => {
    it('mirrors the per-event marking surface onto the secondStaff', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const ssEventProps = (properties.secondStaff as { properties: { measures: { items: { properties: { events: { items: { properties: Record<string, unknown> } } } } } } }).properties.measures.items.properties.events.items.properties
      for (const field of [
        'articulations',
        'fermata',
        'breathMark',
        'caesura',
        'tremolo',
        'bowing',
        'jazzInflection',
        'trillUpperPitch',
        'dynamic_structured',
        'fingerings',
        'graceNotes',
        'lyrics',
      ]) {
        expect(ssEventProps[field]).toBeDefined()
      }
    })

    it('mirrors barlineFermata onto secondStaff measures too', () => {
      const properties = renderScoreTool.input_schema.properties as Record<string, unknown>
      const ssMeasureProps = (properties.secondStaff as { properties: { measures: { items: { properties: Record<string, unknown> } } } }).properties.measures.items.properties
      expect(ssMeasureProps.barlineFermata).toBeDefined()
    })
  })

  describe('round-trip — Score conforming to the wire schema validates', () => {
    it('a kitchen-sink Score with the new fields passes validateScore', () => {
      // Construct a Score that uses every newly exposed per-note marking.
      // Two bars in G major / 4/4 with two beats of activity per bar.
      const score = {
        title: 'Per-note markings round-trip',
        key: 'G' as const,
        meter: '4/4',
        measures: [
          {
            events: [
              {
                pitches: [
                  { step: 'G' as const, octave: 4, accidental: 'none' as const },
                ],
                duration: 'quarter' as const,
                articulation: 'staccato' as const,
                dynamic: 'p' as const,
                breathMark: true,
              },
              {
                pitches: [
                  { step: 'A' as const, octave: 4, accidental: 'none' as const },
                ],
                duration: 'eighth' as const,
                articulations: ['staccato' as const, 'accent' as const],
              },
              {
                pitches: [
                  { step: 'B' as const, octave: 4, accidental: 'none' as const },
                ],
                duration: 'eighth' as const,
                ornament: 'upper-mordent' as const,
              },
              {
                pitches: [
                  { step: 'C' as const, octave: 5, accidental: 'none' as const },
                ],
                duration: 'quarter' as const,
                tremolo: { slashes: 2 as const, measured: true },
                bowing: 'down' as const,
              },
              {
                pitches: [
                  { step: 'D' as const, octave: 5, accidental: 'none' as const },
                ],
                duration: 'quarter' as const,
                ornament: 'trill' as const,
                trillUpperPitch: 'sharp' as const,
                dynamic_structured: {
                  base: 'f' as const,
                  prefix: 'sub.' as const,
                  suffix: 'espressivo',
                },
                jazzInflection: 'fall' as const,
                graceNotes: [
                  {
                    pitches: [{ step: 'C' as const, octave: 5, accidental: 'none' as const }],
                    duration: 'sixteenth' as const,
                    slashed: true,
                  },
                  {
                    pitches: [{ step: 'D' as const, octave: 5, accidental: 'none' as const }],
                    duration: 'sixteenth' as const,
                  },
                ],
              },
            ],
          },
          {
            events: [
              {
                pitches: [
                  { step: 'E' as const, octave: 5, accidental: 'none' as const, tied_to_next: true },
                ],
                duration: 'half' as const,
                fermata: 'standard' as const,
                caesura: true,
              },
              {
                pitches: [
                  { step: 'E' as const, octave: 5, accidental: 'none' as const, lv: true },
                ],
                duration: 'half' as const,
              },
            ],
            barlineFermata: 'long' as const,
          },
        ],
      }
      expect(() => validateScore(score)).not.toThrow()
    })

    it('a Score with techniqueStates (LLM-shaped, no ids) passes validateScore', () => {
      // The LLM emits techniqueStates without ids; the schema accepts
      // this and ensureTechniqueIds backfills lazily downstream.
      const score = {
        title: 'Cello pizz/arco',
        key: 'G' as const,
        meter: '4/4',
        clef: 'bass' as const,
        measures: [
          {
            events: [
              { pitches: [{ step: 'G' as const, octave: 2, accidental: 'none' as const }], duration: 'whole' as const },
            ],
          },
          {
            events: [
              { pitches: [{ step: 'G' as const, octave: 2, accidental: 'none' as const }], duration: 'whole' as const },
            ],
          },
        ],
        techniqueStates: [
          { measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' as const },
          { measureIdx: 1, staffIdx: 0, voiceIdx: 0, kind: 'arco' as const },
        ],
      }
      expect(() => validateScore(score)).not.toThrow()
    })

    it('a Score with per-pitch enharmonicTie validates (escape hatch)', () => {
      const score = {
        title: 'Enharmonic tie across bar',
        key: 'C' as const,
        meter: '4/4',
        measures: [
          {
            events: [
              {
                pitches: [
                  {
                    step: 'C' as const,
                    octave: 5,
                    accidental: 'sharp' as const,
                    tied_to_next: true,
                    enharmonicTie: true,
                  },
                ],
                duration: 'whole' as const,
              },
            ],
          },
          {
            events: [
              {
                pitches: [{ step: 'D' as const, octave: 5, accidental: 'flat' as const }],
                duration: 'whole' as const,
              },
            ],
          },
        ],
      }
      expect(() => validateScore(score)).not.toThrow()
    })
  })
})
