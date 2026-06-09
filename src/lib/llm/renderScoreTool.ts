/**
 * Tool definition for Claude's render_score tool.
 *
 * Wire schema deliberately omits constraints that strict tool use does
 * not support (maxLength, minimum, maximum; minItems > 1). `maxItems`
 * is included where it's small and informative since Anthropic
 * tolerates it as a hint outside strict mode. The post-call zod
 * validator in lib/music/validateScore.ts enforces all real bounds
 * and surfaces violations through the retry pipeline.
 *
 * Enums match the closed sets in lib/music/types.ts — keep them in sync.
 */
import { BARLINE_KINDS } from '@/lib/music/types'
import { JUMP_KINDS } from '@/lib/music/spans'
// Closed enums reused across the schema. Centralized so a change here
// updates both the per-event and per-pitch surfaces and stays in sync
// with the zod schemas in lib/music/types.ts.
const ARTICULATION_ENUM = [
  'staccato',
  'accent',
  'tenuto',
  'marcato',
  'portato',
  'none',
] as const

const FERMATA_ENUM = ['very-short', 'short', 'standard', 'long', 'very-long'] as const

const ORNAMENT_ENUM = [
  'trill',
  'pralltriller',
  'mordent',
  'upper-mordent',
  'lower-mordent',
  'schneller',
  'turn',
  'inverted-turn',
  'delayed-turn',
  'slide',
  'arpeggio-up',
  'arpeggio-down',
  'non-arpeggio',
  'grace',
  'none',
] as const

const TRILL_UPPER_PITCH_ENUM = ['natural', 'sharp', 'flat', 'dblsharp', 'dblflat'] as const

// Grace note durations are deliberately limited to the short values
// that actually appear as grace gestures. Mirrors GraceDurationSchema
// in lib/music/types.ts.
const GRACE_DURATION_ENUM = ['eighth', 'sixteenth', '32nd'] as const

const DYNAMIC_ENUM = [
  'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff',
  'n',
  'fp', 'fz', 'sfz', 'sffz', 'sfp', 'sfpp', 'rfz', 'rfp', 'fzp',
  'none',
] as const

const DYNAMIC_PREFIX_ENUM = ['sub.', 'poco', 'meno', 'più'] as const

const JAZZ_INFLECTION_ENUM = ['fall', 'doit', 'scoop', 'plop', 'ghost'] as const

const BOWING_ENUM = ['up', 'down'] as const

// Fingering tagged-union enums. Mirrors the per-system schemas in
// lib/music/types.ts. The tool exposes one entry per pitch in a chord;
// the array's `null` slots mark "no fingering at this pitch".
const PIANO_FINGER_ENUM = ['0', '1', '2', '3', '4', '5'] as const
const STRING_FINGER_ENUM = [0, 1, 2, 3, 4] as const
const STRING_ROMAN_ENUM = ['I', 'II', 'III', 'IV'] as const
const GUITAR_LH_FINGER_ENUM = [1, 2, 3, 4] as const
const GUITAR_LH_STRING_ENUM = [1, 2, 3, 4, 5, 6] as const
const GUITAR_RH_LETTER_ENUM = ['p', 'i', 'm', 'a', 'c'] as const
const ORGAN_FINGER_ENUM = ['0', '1', '2', '3', '4', '5'] as const
const ORGAN_FOOT_ENUM = ['heel', 'toe'] as const
const ORGAN_THUMB_DIRECTION_ENUM = ['(', ')'] as const

// Performance-technique state vocabulary. Mirrors TechniqueKindSchema
// in lib/music/types.ts. State-changing: a pizz. at m.5 persists on the
// voice until cancelled by arco (or another technique). Use these on
// Score.techniqueStates, NOT as a per-note articulation.
const TECHNIQUE_KIND_ENUM = [
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
] as const

const CHORD_QUALITY_ENUM = ['major', 'minor', 'diminished', 'augmented', 'sus2', 'sus4'] as const
const CHORD_SEVENTH_ENUM = ['none', 'maj7', 'dom7', 'min7', 'dim7', 'halfdim7'] as const
const CHORD_MODAL_ENUM = [
  'Ionian',
  'Dorian',
  'Phrygian',
  'Lydian',
  'Mixolydian',
  'Aeolian',
  'Locrian',
] as const

/**
 * Build the JSON-schema property for a ChordSymbol. Recursive because
 * polychord bass is itself a ChordSymbol (`{type:'chord', value:...}`).
 *
 * Depth-limit: the nested-chord recursion bottoms out at depth 1 — a
 * polychord with a polychord IN its bass is exotic and would explode
 * the schema size. Past depth 1, we describe the bass shape without
 * recursing again (LLM still emits a valid shape; deep nesting just
 * loses the inline schema docs).
 */
function buildChordSymbolPropertySchema(depth: number): Record<string, unknown> {
  const recursiveBass =
    depth < 1
      ? {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'value'],
              properties: {
                type: { type: 'string', enum: ['note'] },
                value: { type: 'string', pattern: '^[A-G](#|b)?$' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'value'],
              properties: {
                type: { type: 'string', enum: ['chord'] },
                value: buildChordSymbolPropertySchema(depth + 1),
              },
            },
          ],
        }
      : {
          // Past depth 1 — accept either bass shape without recursing
          // further into the chord schema (polychord-in-polychord is
          // vanishingly rare; the post-call Zod validator still
          // enforces shape correctness).
          type: 'object',
        }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['root', 'quality', 'seventh'],
    description:
      depth === 0
        ? 'Lead-sheet chord symbol attached to this event (e.g. "Cmaj7", "F#m7b5", "C/E", "Cadd9"). Structured: root + quality + seventh + optional extensions / alterations / add / omit / bass / modal. The post-call validator enforces NoteNameSchema on root and the alterations regex; downstream renderers paint the canonical formatted string above the staff. Distinct from notes themselves (the pitches array carries the actual pitched content of the event; chordSymbol is the harmony label).'
        : 'Nested ChordSymbol for polychord bass — same shape as the top-level chordSymbol.',
    properties: {
      root: {
        type: 'string',
        pattern: '^[A-G](#|b)?$',
        description: 'Note name: A-G with optional accidental # or b. e.g. "C", "F#", "Bb".',
      },
      quality: {
        type: 'string',
        enum: CHORD_QUALITY_ENUM,
        description: 'Triad quality. sus2 / sus4 replace the 3rd with a 2nd / 4th respectively.',
      },
      seventh: {
        type: 'string',
        enum: CHORD_SEVENTH_ENUM,
        description:
          '"none" = triad only, "dom7" = bare 7 (C7), "maj7" = major-7 (Cmaj7), "min7" = minor-7 (Cm7), "dim7" = fully-diminished, "halfdim7" = m7b5.',
      },
      extensions: {
        type: 'array',
        maxItems: 3,
        items: { type: 'integer', enum: [9, 11, 13] },
        description:
          'Stacked extensions on top of a 7th. Highest extension implies the lower ones (C13 implies 9 + 11 + 13).',
      },
      alterations: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'string',
          // Mirrors the Zod schema regex (types.ts:367) so the LLM
          // gets schema-level rejection for bad alteration strings
          // instead of a post-call validation retry.
          pattern: '^(b|#)?\\d{1,2}$|^alt$',
        },
        description:
          'Per-tone chromatic alterations. Each entry is e.g. "b9", "#11", "b13", or the special keyword "alt" (jazz "altered dominant" shorthand). Bare numbers like "9" mean "natural 9 added explicitly" — rare; alterations usually carry b or #.',
      },
      add: {
        type: 'array',
        maxItems: 4,
        items: { type: 'integer', enum: [2, 4, 6, 9, 11, 13] },
        description:
          'Tones added WITHOUT implying a 7th. "Cadd9" carries add:[9] and seventh:"none"; distinct from "C9" which is dom7 + extension 9.',
      },
      omit: {
        type: 'array',
        maxItems: 3,
        items: { type: 'integer', enum: [3, 5, 7] },
        description:
          'Tones omitted from the chord. Renders as "(no3)" / "(no5)" / "(no7)" in formatted output.',
      },
      bass: {
        ...recursiveBass,
        description:
          'Slash chord or polychord bass. Use type:"note" for a single bass note ("C/E"); type:"chord" for a polychord stack ("C|G" = C major over G major).',
      },
      modal: {
        type: 'string',
        enum: CHORD_MODAL_ENUM,
        description:
          'Modal tag ("C Mixolydian", "F# Dorian"). Renders as the root + space + modal name. Distinct from a chord with a 7th — modal symbols imply a scale, not a triad-stack.',
      },
      display: {
        type: 'string',
        description:
          "Optional cache of the original input string for round-trip fidelity. Server-side helpers maintain this; the LLM generally doesn't need to emit it.",
      },
    },
  }
}

// The grand-staff secondStaff sub-schema is reused inline below.
// Kept as a const so adding new fields (voices in PR 4, per-note
// markings in M2-PR-2) only touches one place.
export const STAFF_MEASURE_PROPERTIES = {
  events: {
    type: 'array',
    minItems: 1,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['pitches', 'duration'],
      properties: {
        pitches: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            // `accidental` is intentionally NOT required — it is optional in the
            // canonical Zod PitchSchema (music/types.ts) and an omitted value means
            // natural. Forcing it in `required` made providers that validate tool
            // args against this JSON schema server-side (Groq: strictJsonSchema)
            // 400 when a model legitimately omitted it for an unaltered pitch.
            required: ['step', 'octave'],
            properties: {
              step: { type: 'string', enum: ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'rest'] },
              octave: { type: 'integer' },
              accidental: {
                type: 'string',
                enum: ['natural', 'sharp', 'flat', 'dblsharp', 'dblflat', 'none'],
                description: 'Optional; emit "sharp"/"flat"/etc. for altered pitches. Omit (or "none") for unaltered pitches and key-signature defaults.',
              },
              tied_to_next: {
                type: 'boolean',
                description:
                  'Tie this specific pitch to the same step+octave in the next event. Use this on chord tones when only SOME pitches tie across the bar; for monophonic ties set the EVENT-level tied_to_next instead. (Per-pitch ties are validated and persisted today; the renderer surfaces the event-level field — selective chord-tone rendering lands in a follow-up PR.)',
              },
              lv: {
                type: 'boolean',
                description:
                  'Laissez vibrer — open-ended tie with no termination target. Use for harp, vibraphone, or piano with damper conventions where the pitch rings until natural decay. (Validated and persisted today; visual rendering lands in a follow-up PR.)',
              },
              enharmonicTie: {
                type: 'boolean',
                description:
                  'Escape hatch for ties where the next event respells the pitch enharmonically (C# tied across to Db). Relaxes the validateScore step+octave match requirement so the tie validates.',
              },
            },
          },
        },
        duration: {
          type: 'string',
          enum: [
            'whole', 'half', 'quarter', 'eighth', 'sixteenth', '32nd',
            'dotted-half', 'dotted-quarter', 'dotted-eighth',
          ],
        },
        tuplet: { type: 'integer', enum: [3, 5, 6, 7] },
        articulation: {
          type: 'string',
          enum: ARTICULATION_ENUM,
          description:
            'Legacy single-articulation field. For two or more articulations on one note, use the "articulations" array instead — the helper layer (articulations.ts) enforces stacking conventions: it rejects marcato+accent and auto-coerces staccato+tenuto into the portato glyph.',
        },
        articulations: {
          type: 'array',
          maxItems: 4,
          items: { type: 'string', enum: ARTICULATION_ENUM },
          description:
            'Stack of articulations attached to this note. Use when more than one glyph is needed (e.g. ["staccato","accent"]). For a single articulation, the "articulation" field is equivalent. Render order is innermost staccato to outermost marcato when the helpers normalize the array.',
        },
        fermata: {
          type: 'string',
          enum: FERMATA_ENUM,
          description:
            'Fermata over the note. "standard" is the usual semicircle; "short" / "very-short" are triangular variants (shorter hold); "long" / "very-long" are square/double-square variants (longer hold). Default to "standard" unless the user specifies a duration. Renders today as the standard semicircle for every variant; the 5-form visual distinction lands in a follow-up PR.',
        },
        breathMark: {
          type: 'boolean',
          description:
            'Comma-shaped breath mark above the staff between this note and the next. Common in vocal and wind writing.',
        },
        caesura: {
          type: 'boolean',
          description:
            'Caesura ("railroad tracks") between this note and the next. A hard pause; longer and more emphatic than a breath mark.',
        },
        tremolo: {
          type: 'object',
          additionalProperties: false,
          required: ['slashes'],
          properties: {
            slashes: {
              type: 'integer',
              enum: [1, 2, 3, 4, 5],
              description:
                'Number of slashes through the stem indicating subdivision: 1=eighth-tremolo, 2=sixteenth, 3=32nd, 4=64th, 5=very rare contemporary.',
            },
            measured: {
              type: 'boolean',
              description:
                'true (or omitted) = measured tremolo (counted subdivisions, Schubert). false = unmeasured / bowed tremolo (as-fast-as-possible, Beethoven 5 strings).',
            },
          },
          description:
            'Single-note tremolo. For between-note tremolo (z-tremolo spanning two notes) a span is required — not yet exposed in this tool. Renders 1-4 slashes today; 5 clamps to 4 (abcjs limit). The measured / unmeasured distinction round-trips through the score JSON but is visually identical today.',
        },
        bowing: {
          type: 'string',
          enum: BOWING_ENUM,
          description:
            'String-instrument bow direction: "up" (V symbol) or "down" (∏ symbol). Use on string-instrument lines. For state-changing techniques like pizz/arco a separate marker is needed — not yet exposed in this tool.',
        },
        jazzInflection: {
          type: 'string',
          enum: JAZZ_INFLECTION_ENUM,
          description:
            'Single-note pitch-bend annotation for jazz / big-band notation. fall = line dropping after the note; doit = line rising after; scoop = curve up INTO the note; plop = curve down INTO the note; ghost = note in parentheses (soft, deemphasized). Distinct from articulations (which affect length) and ornaments (decorative). (Schema accepts and persists today; visual rendering lands in a follow-up PR.)',
        },
        ornament: {
          type: 'string',
          enum: ORNAMENT_ENUM,
          description:
            'Ornament glyph above the note. The renderer paints trill / pralltriller / mordent / upper-mordent / lower-mordent / schneller (as pralltriller, same glyph family) / turn / inverted-turn / delayed-turn (as turn — delay positioning deferred) / slide / arpeggio-up / arpeggio-down (both as the wavy bracket; arrow direction deferred) / grace today. non-arpeggio is accepted by the schema but currently renders no glyph — abcjs has no "do-not-roll" bracket; tracked for a follow-up PR. Always emit the most specific name the user implies — the data captures intent even before the glyph variation lands.',
        },
        trillUpperPitch: {
          type: 'string',
          enum: TRILL_UPPER_PITCH_ENUM,
          description:
            'For trill-family ornaments, the accidental of the upper auxiliary note (Bach-style tr♯ / tr♭ / tr♮). Only meaningful with ornament = trill / pralltriller / upper-mordent / etc. (Schema accepts and persists today; visual rendering lands in a follow-up PR.)',
        },
        graceNotes: {
          type: 'array',
          maxItems: 8,
          description:
            'Structured grace notes attached BEFORE this principal event. A sequence of grace MOMENTS — one entry per moment. A single grace with multiple noteheads (grace CHORD) is one entry with multiple pitches; a beamed grace RUN is multiple entries. slashed = true on a single grace marks an acciaccatura (crushed, no time taken from principal); omitted/false is the appoggiatura (takes time from principal). After-grace (nachschlag) is deferred. Replaces the legacy ornament:"grace" placeholder — when this array is present + non-empty, the renderer prefers structured graceNotes. (Schema accepts and persists today; the renderer wires up in a follow-up PR.)',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['pitches', 'duration'],
            properties: {
              pitches: {
                type: 'array',
                minItems: 1,
                maxItems: 6,
                description:
                  'Pitches at this grace moment. Multiple pitches = grace chord. Rests are rejected by the post-call validator — grace pitches must be real notes.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  // See note above — `accidental` optional (natural when omitted).
                  required: ['step', 'octave'],
                  properties: {
                    step: { type: 'string', enum: ['C', 'D', 'E', 'F', 'G', 'A', 'B'] },
                    octave: { type: 'integer' },
                    accidental: {
                      type: 'string',
                      enum: ['natural', 'sharp', 'flat', 'dblsharp', 'dblflat', 'none'],
                    },
                  },
                },
              },
              duration: {
                type: 'string',
                enum: GRACE_DURATION_ENUM,
                description:
                  'Eighth (one flag), sixteenth (two flags), or 32nd (three flags). No longer values; grace notes are by definition short.',
              },
              slashed: {
                type: 'boolean',
                description:
                  'true = acciaccatura (diagonal slash through the stem, "crushed"); omitted/false = appoggiatura (takes time from the principal). Typically true on single-note before-graces in Classical/Romantic writing.',
              },
            },
          },
        },
        chordSymbol: buildChordSymbolPropertySchema(/* depth */ 0),
        dynamic: {
          type: 'string',
          enum: DYNAMIC_ENUM,
          description:
            'Single-glyph dynamic. For compounds like "sub. p espressivo" use dynamic_structured instead. The "n" value is niente (silence as a dynamic, late-20th-century writing).',
        },
        dynamic_structured: {
          type: 'object',
          additionalProperties: false,
          required: ['base'],
          properties: {
            base: { type: 'string', enum: DYNAMIC_ENUM },
            prefix: {
              type: 'string',
              enum: DYNAMIC_PREFIX_ENUM,
              description: 'sub. = suddenly (subito); poco = a little; meno / più = less / more.',
            },
            suffix: {
              type: 'string',
              description:
                'Italicized word AFTER the dynamic ("espressivo", "marcato", "cantabile", "dolce"). 40 char max — the post-call validator enforces this.',
            },
          },
          description:
            'Structured compound dynamic. Use for "sub. p" (subito piano), "poco f", "p espressivo", etc. The renderer surfaces the base loudness today; the prefix/suffix text round-trips through the score JSON and a follow-up PR adds the compound text rendering.',
        },
        tied_to_next: {
          type: 'boolean',
          description:
            'Tie EVERY pitch in this event to the corresponding pitch in the next event. For chord stacks where only SOME pitches tie, set per-pitch tied_to_next on the individual pitch objects instead.',
        },
        fingerings: {
          type: 'array',
          maxItems: 6,
          description:
            'Per-pitch fingerings — one entry per pitch in this event, indexed the same way as the pitches array. Each entry is a tagged-union object discriminated by `system` (piano / string / guitar-lh / guitar-rh / organ) or `null` for "no fingering at this pitch" (use to skip lower pitches of a chord while still fingering the top). Trailing pitches without an entry remain unfingered, so for single notes a one-element array is fine.',
          items: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['system', 'value'],
                description:
                  'Piano fingering 0-5 (0 = thumb crossing under, 1 = thumb, 5 = pinky). Optional substitution string ("3-2" slide, "1>2" cross-under).',
                properties: {
                  system: { type: 'string', enum: ['piano'] },
                  value: { type: 'string', enum: PIANO_FINGER_ENUM },
                  substitution: { type: 'string' },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['system', 'finger'],
                description:
                  'String fingering 0-4 (0 = open string). Optional Roman string indicator I-IV.',
                properties: {
                  system: { type: 'string', enum: ['string'] },
                  finger: { type: 'integer', enum: STRING_FINGER_ENUM },
                  stringRoman: { type: 'string', enum: STRING_ROMAN_ENUM },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['system', 'value'],
                description:
                  'Guitar left-hand 1-4. Optional stringNum 1-6 (1 = high E, classical numbering); optional fret as Roman numeral position ("V" = fifth position).',
                properties: {
                  system: { type: 'string', enum: ['guitar-lh'] },
                  value: { type: 'integer', enum: GUITAR_LH_FINGER_ENUM },
                  stringNum: { type: 'integer', enum: GUITAR_LH_STRING_ENUM },
                  fret: { type: 'string', pattern: '^[IVX]+$' },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['system', 'value'],
                description:
                  'Guitar right-hand: Spanish letter system. p (pulgar/thumb), i (índice), m (medio), a (anular), c (chiquito/pinky).',
                properties: {
                  system: { type: 'string', enum: ['guitar-rh'] },
                  value: { type: 'string', enum: GUITAR_RH_LETTER_ENUM },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['system', 'value'],
                description:
                  'Organ 0-5 with optional pedal indicator (heel / toe) and optional thumb-direction parenthesis-glyph (over `)` / under `(`).',
                properties: {
                  system: { type: 'string', enum: ['organ'] },
                  value: { type: 'string', enum: ORGAN_FINGER_ENUM },
                  foot: { type: 'string', enum: ORGAN_FOOT_ENUM },
                  thumbDirection: { type: 'string', enum: ORGAN_THUMB_DIRECTION_ENUM },
                },
              },
              { type: 'null' },
            ],
          },
        },
        // Lyrics (M15-PR-3). Per-event, per-verse syllable array.
        // Per-voice automatically: each voice's events array
        // carries its own LyricSyllables, so SATB divisi (soprano
        // + alto on the same beat) falls out without cross-voice
        // merge logic. verse 1..50; syllable 1..40 chars; optional
        // hyphen / extender flags.
        lyrics: {
          type: 'array',
          maxItems: 50,
          description:
            'Lyric syllables attached to this event, one entry per verse. Verse 1 is the primary line; verses 2-50 stack below for multi-verse hymns / psalter settings. For per-VOICE lyrics (SATB divisi), each voice carries its own events with independent LyricSyllable entries — no cross-voice merging required. Hyphenated continuations: set hyphen:true on every syllable EXCEPT the last of a multi-syllable word ("Glo"+hyphen, "ri"+hyphen, "a") — renderer draws hyphens between. Melismas: set extender:true on the syllable that holds across following notes — renderer draws an underscore line; subsequent events for that verse should have no syllable. lyrics on rests round-trip through save/load but are not visually rendered (abcjs limitation; Anglican psalter is a known deferred case).',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['verse', 'syllable'],
            properties: {
              verse: {
                type: 'integer',
                minimum: 1,
                maximum: 50,
                description:
                  'Verse number (1-indexed). Verse 1 is the primary line; verse 2..N stack below.',
              },
              syllable: {
                type: 'string',
                minLength: 1,
                maxLength: 40,
                description:
                  'The syllable text — never a literal hyphen. Use the hyphen:true flag for multi-syllable word continuations instead of typing "Glo-".',
              },
              hyphen: {
                type: 'boolean',
                description:
                  'true = this syllable continues to the next syllable of the same word (renderer draws a hyphen). Mutually exclusive with extender — a syllable continues OR extends, not both.',
              },
              extender: {
                type: 'boolean',
                description:
                  'true = this syllable extends as a melisma across following notes (renderer draws an underscore line). Subsequent events on the same verse should have no syllable. Mutually exclusive with hyphen.',
              },
            },
          },
        },
      },
    },
  },
  barlineFermata: {
    type: 'string',
    enum: FERMATA_ENUM,
    description:
      'Fermata on the CLOSING barline of this measure — the "general pause" fermata (G.P.) common in symphonic literature. Distinct from a fermata on a note. Default to "standard" duration. (Schema accepts and persists today; visual rendering lands in a follow-up PR.)',
  },
  // Barlines (M16-PR-3). LEFT-edge + RIGHT-edge per-measure glyphs
  // from BarlineSchema (8 kinds). Defaults to thin when absent.
  // M16-PR-2 emits the canonical abcjs tokens via barlineToAbc.
  // Enum references BARLINE_KINDS (the single source of truth) so a
  // future 9th BarlineSchema value fails the sync-pin tests in
  // renderScoreTool.barlines.test.ts instead of silently skipping.
  startBarline: {
    type: 'string',
    enum: [...BARLINE_KINDS],
    description:
      'Barline glyph at the LEFT (start) edge of this measure. Use \'repeat-start\' to open a repeat block at this measure. Omit (or set "thin") for the default single-line barline.',
  },
  endBarline: {
    type: 'string',
    enum: [...BARLINE_KINDS],
    description:
      'Barline glyph at the RIGHT (end) edge of this measure. Use \'repeat-end\' to close a repeat block, \'final\' for the end of the piece, \'double\' between sections. For back-to-back repeat blocks sharing a barline, use \'repeat-both\' on the END of the closing measure.',
  },
  isPickup: {
    type: 'boolean',
    description:
      'Mark this measure as a partial PICKUP / anacrusis (typically m=0 of a piece that starts with fewer beats than the meter). validateScore loosens the duration check when this flag is true. Setting the flag on a full-bar measure has no behavioral effect.',
  },
  isFinalPartial: {
    type: 'boolean',
    description:
      'Mark this measure as a closing partial that balances the pickup. Same duration-check loosening as isPickup; conventional in hymn-tune writing where pickup + final-partial sum to a full bar.',
  },
} as const

export const renderScoreTool = {
  name: 'render_score',
  description:
    'Emit a single-staff or grand-staff (piano) score. Use for any musical render — new generation, structural change, or refinement of a prior score. When refining, copy every unchanged measure verbatim from the prior tool_use input rather than re-authoring it; the schema requires the complete shape but the content of unchanged measures should be identical to before.',
  // strict mode used to grammar-constrain output to the schema's enums,
  // but Anthropic now rejects this schema as "compiled grammar too large".
  // Validation happens post-call in lib/music/validateScore.ts and the
  // retry pipeline in lib/llm/messages.ts feeds zod errors back to the
  // model. If "Bb"-in-step (or similar enum-merge mistakes) reappear,
  // tighten the system prompt rather than re-adding strict.
  input_schema: {
    type: 'object' as const,
    additionalProperties: false,
    required: ['title', 'key', 'meter', 'tempo_bpm', 'clef', 'measures'],
    properties: {
      title: { type: 'string' },
      key: {
        type: 'string',
        enum: [
          'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#',
          'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb',
          'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m',
          'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm',
        ],
      },
      meter: {
        type: 'string',
        pattern: '^(C\\|?|(?:[1-9]|[12][0-9]|3[0-2])\\/(?:1|2|4|8|16|32))$',
        description:
          'Time signature. Either "C" (common time, = 4/4), "C|" (cut time, = 2/2), or "n/d" where n is 1-32 and d is one of 1, 2, 4, 8, 16, 32. Examples: "4/4", "3/4", "6/8", "5/4", "7/8", "11/8", "5/16".',
      },
      tempo_bpm: { type: 'integer' },
      clef: {
        type: 'string',
        enum: ['treble', 'bass'],
        description:
          'Optional staff clef. Defaults to "treble". Use "bass" for low-register instruments (bass guitar, cello, tuba, left-hand piano figures sitting below middle C).',
      },
      measures: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['events'],
          properties: STAFF_MEASURE_PROPERTIES,
        },
      },
      extraVoices: {
        type: 'array',
        description:
          'Optional polyphony on the primary staff (e.g. SATB Alto on the same staff as Soprano). At most 3 entries. Each entry has its own bar-aligned measures.length. Use sparingly — only when the user asks for true multi-voice writing.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['measures'],
          properties: {
            measures: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['events'],
                properties: STAFF_MEASURE_PROPERTIES,
              },
            },
          },
        },
      },
      secondStaff: {
        type: 'object',
        additionalProperties: false,
        required: ['clef', 'measures'],
        description:
          'Optional second staff for grand-staff (piano two-hand) or SATB scores. Its measures.length MUST equal the primary measures.length. Typical pairing: primary clef=treble (right hand / SA), secondStaff.clef=bass (left hand / TB).',
        properties: {
          clef: { type: 'string', enum: ['treble', 'bass'] },
          measures: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['events'],
              properties: STAFF_MEASURE_PROPERTIES,
            },
          },
          extraVoices: {
            type: 'array',
            description:
              'Polyphony on the second staff (e.g. SATB Bass on the same staff as Tenor). At most 3 entries.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['measures'],
              properties: {
                measures: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['events'],
                    properties: STAFF_MEASURE_PROPERTIES,
                  },
                },
              },
            },
          },
        },
      },
      // ─── Score-level metadata (M8-PR-2) ───────────────────────────
      composer: {
        type: 'string',
        description:
          'Score composer. Plain text; rendered as a credit line near the title. Omit when unknown — do NOT fabricate.',
      },
      arranger: {
        type: 'string',
        description:
          'Arranger credit, for transcriptions / arrangements. Omit when not applicable.',
      },
      lyricist: {
        type: 'string',
        description:
          'Lyricist / librettist credit. Use for vocal music with text. Omit otherwise.',
      },
      copyright: {
        type: 'string',
        description:
          'Copyright line ("© 2026 Name. All rights reserved." / "Public Domain" / etc.). Rendered at page bottom.',
      },
      annotations: {
        type: 'array',
        maxItems: 100,
        description:
          'Score-level text annotations: rehearsal marks (boxed A/B/C section letters), tempo text ("Allegro", "Andante con moto"), expression markings ("cantabile", "dolce"), and plain comments. Anchor each to a measure (measure-level) or a specific event within a measure (event-level), with above/below/left/right placement. For line-extending forms like "rit. ____" or "accel. ____", set spanEnd to the terminating event/measure — the renderer draws a dashed line to that endpoint. Distinct from dynamics (use `dynamic` / `dynamic_structured` on the event) and from techniqueStates (use the top-level array for pizz/arco state changes). Omit id — one is minted server-side.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['target', 'text', 'style'],
          properties: {
            target: {
              type: 'object',
              additionalProperties: false,
              required: ['measureIdx', 'position'],
              properties: {
                measureIdx: { type: 'integer' },
                eventIdx: {
                  type: 'integer',
                  description:
                    'Optional. Omit to anchor at the measure level (e.g. a rehearsal mark at the start of a section). Set to anchor at a specific event (e.g. an expression marking on a particular note).',
                },
                position: {
                  type: 'string',
                  enum: ['above', 'below', 'left', 'right'],
                  description:
                    '"above" is the default for rehearsal marks, tempo text, and most expression markings. "below" is conventional for dynamics-style annotations on vocal music. "left" / "right" are unusual; reserve for special editorial notes.',
                },
              },
            },
            text: {
              type: 'string',
              description: 'Annotation text content. Max 120 chars enforced post-call.',
            },
            style: {
              type: 'string',
              enum: ['plain', 'italic', 'bold', 'rehearsal-mark', 'tempo-text', 'expression'],
              description:
                'plain — roman text; italic — italicized comment; bold — emphatic note; rehearsal-mark — boxed letter/number at section starts (e.g. "A", "B", "C" or "1", "2", "3"); tempo-text — bold roman tempo word ("Allegro", "Adagio"); expression — italic mood / character word ("cantabile", "dolce", "espressivo"). Use the most specific style — the renderer picks fonts/frames accordingly.',
            },
            spanEnd: {
              type: 'object',
              additionalProperties: false,
              required: ['measureIdx'],
              properties: {
                measureIdx: { type: 'integer' },
                eventIdx: { type: 'integer' },
              },
              description:
                'Optional endpoint for line-extending annotations. Use for "rit. ____" / "accel. ____" / "cresc. ____" forms where the verbal instruction continues across a passage. The renderer draws a dashed line from the target to the spanEnd. Must extend FORWARD (spanEnd.measureIdx >= target.measureIdx).',
            },
          },
        },
      },
      markers: {
        type: 'array',
        maxItems: 200,
        description:
          'Mid-piece markers at measure boundaries: tempo changes (tempo_bpm + tempo_text), key changes, meter changes, clef changes, metric modulation ("♩ = ♩."). Each marker carries at least ONE of those fields (the schema rejects empty markers). For a tempo change with a verbal label, set both tempo_bpm and tempo_text on the same marker — they describe one event. For metric modulation, set metricModulation { fromNote, toNote } (visual label only) plus tempo_bpm (playback). Omit id — one is minted server-side. Distinct from score-level title/composer (use the top-level fields) and from per-event tempo annotations (use the annotations array with style:"tempo-text" when you ONLY want the label without a tempo change).',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['measureIdx'],
          properties: {
            measureIdx: {
              type: 'integer',
              description: '0-indexed measure where the marker takes effect.',
            },
            key: {
              type: 'string',
              enum: [
                'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#',
                'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb',
                'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m',
                'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm',
              ],
              description: 'Mid-piece key change. Affects accidentals from this measure forward.',
            },
            meter: {
              type: 'string',
              pattern: '^(C\\|?|(?:[1-9]|[12][0-9]|3[0-2])\\/(?:1|2|4|8|16|32))$',
              description: 'Mid-piece time-signature change. Same format as the score-level meter ("4/4", "3/8", "C", "C|").',
            },
            tempo_bpm: {
              type: 'integer',
              description: 'New tempo in beats per minute. Range 30..240 (post-call validator enforces).',
            },
            tempo_text: {
              type: 'string',
              description: 'Tempo word (e.g. "Allegro", "Andante con moto", "Più mosso"). Usually paired with tempo_bpm.',
            },
            clefs: {
              type: 'array',
              maxItems: 2,
              description: 'Per-staff clef changes at this measure boundary. Each entry { staffIdx: 0|1, clef: "treble"|"bass" }.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['staffIdx', 'clef'],
                properties: {
                  staffIdx: { type: 'integer', enum: [0, 1] },
                  clef: { type: 'string', enum: ['treble', 'bass'] },
                },
              },
            },
            metricModulation: {
              type: 'object',
              additionalProperties: false,
              required: ['fromNote', 'toNote'],
              description:
                'Metric modulation notation: fromNote (in OLD tempo) = toNote (in NEW tempo). Renders as "♩ = ♩." at the bar line, signaling tempo equivalence in subdivision terms across a meter or pulse change. Common in 20th-century music (Carter, Reich, Adams). The actual NEW playback tempo lives on the sibling tempo_bpm — metric modulation is the visual label, not the playback semantic.',
              properties: {
                fromNote: {
                  type: 'string',
                  enum: ['half', 'dotted-half', 'quarter', 'dotted-quarter', 'eighth', 'dotted-eighth', 'sixteenth'],
                },
                toNote: {
                  type: 'string',
                  enum: ['half', 'dotted-half', 'quarter', 'dotted-quarter', 'eighth', 'dotted-eighth', 'sixteenth'],
                },
              },
            },
          },
        },
      },
      // Voltas (M17-PR-3). 1st/2nd/Nth-time endings spanning a
      // measure range. Pair with repeat-start / repeat-end barlines
      // via setStartBarline / setEndBarline ops. abcjs draws the
      // bracket above the staff in dance forms, folk tunes, hymn-
      // tune choruses. See VOLTAS_REFERENCE for the full vocabulary
      // and the rendering gotcha (non-thin endBarline required to
      // close the bracket).
      voltas: {
        type: 'array',
        maxItems: 50,
        description:
          'Voltas: 1st/2nd/Nth-time endings on repeat blocks. Each entry brackets a measure range and lists the pass numbers that play through it. ALWAYS pair with repeat-start + repeat-end barlines on the surrounding measures (via setStartBarline / setEndBarline ops). The closing endBarline on the volta\'s endMeasureIdx must be NON-THIN (repeat-end, double, final) — abcjs needs a non-thin barline to close the bracket visually. id REQUIRED (mint a 10-char alphanumeric like "volta00001"; referenced by the editor UI for update/remove ops).',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'startMeasureIdx', 'endMeasureIdx', 'endings'],
          properties: {
            id: {
              type: 'string',
              minLength: 8,
              maxLength: 16,
              description: 'Stable id (8-16 chars, lowercase alphanumeric). Required — must be minted by the LLM; the editor UI references this id for update/remove ops.',
            },
            startMeasureIdx: {
              type: 'integer',
              description: '0-indexed measure where the volta bracket begins (the opening barline of this measure carries the [1, [2, etc. opener).',
            },
            endMeasureIdx: {
              type: 'integer',
              description: '0-indexed measure where the volta bracket ends (inclusive). Pair with a non-thin endBarline for proper closing.',
            },
            endings: {
              type: 'array',
              minItems: 1,
              maxItems: 9,
              description: 'Pass numbers (1..9) that play this bracket. Common forms: [1] (1st time only), [2] (2nd time only), [1,2] (both passes — rare). No duplicates.',
              items: {
                type: 'integer',
                minimum: 1,
                maximum: 9,
              },
            },
            endHook: {
              type: 'string',
              enum: ['closed', 'open'],
              description: 'Whether the bracket\'s right end has a closing hook (closed) or flows into the next without termination (open). Default closed; use open for the last volta of a sequence.',
            },
            text: {
              type: 'string',
              maxLength: 40,
              description: 'Optional label printed above the digit (e.g. "First time only"). Rarely needed; abcjs auto-renders "1." / "2." from the endings array.',
            },
          },
        },
      },
      // Jump markers (M18-PR-4). Score-level repeat-and-jump
      // instructions: D.C., D.S., Fine, To Coda, *.al-Coda, *.al-Fine.
      // Linked by ID with segnoMarkers + codaMarkers + other
      // jumpMarkers (toCodaRef) for multi-coda pieces. See
      // JUMP_MARKERS_REFERENCE for the full vocabulary + the
      // expand() resolver semantics.
      jumpMarkers: {
        type: 'array',
        maxItems: 50,
        description:
          'Jump markers: D.C. / D.S. / Fine / Coda / Segno / To Coda / D.C. al Coda / D.S. al Coda / D.C. al Fine / D.S. al Fine. One entry per landmark or instruction attached to a measure edge. Use segnoRef to point D.S.* at a SegnoMarker, codaRef for *.al-Coda → CodaMarker target, toCodaRef for multi-coda gating. id REQUIRED (mint a 10-char alphanumeric like "jump000001"; other jumpMarkers may reference this one via toCodaRef).',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'measureIdx', 'side', 'kind'],
          properties: {
            id: {
              type: 'string',
              minLength: 8,
              maxLength: 16,
              description: 'Stable id (8-16 chars). Required because other jumpMarkers may reference this one via toCodaRef for multi-coda gating; also referenced by the editor UI for update/remove ops.',
            },
            measureIdx: {
              type: 'integer',
              description: '0-indexed measure where the instruction sits.',
            },
            side: {
              type: 'string',
              enum: ['start', 'end'],
              description: 'Anchor at the start or end of the measure. Use "end" for terminal instructions (D.C., D.S., Fine, To Coda fire at the end of a measure); "start" is rare.',
            },
            kind: {
              type: 'string',
              enum: [...JUMP_KINDS],
              description: 'D.C. = da capo (jump to start). D.S. = dal segno (jump to Segno). Fine = end here. To Coda = jump target gate. *.al Coda = jump back, then take the Coda branch at next To Coda. *.al Fine = jump back, then stop at next Fine.',
            },
            segnoRef: {
              type: 'string',
              description: 'For D.S.* kinds: id of the SegnoMarker entry the jump returns to. Required for D.S./D.S. al Coda/D.S. al Fine.',
            },
            codaRef: {
              type: 'string',
              description: 'For *.al-Coda kinds: id of the CodaMarker entry that playback lands on after the To Coda hop. Optional but recommended.',
            },
            toCodaRef: {
              type: 'string',
              description: 'For *.al-Coda kinds in multi-coda scores: id of the specific To Coda jumpMarker that gates this al-Coda hop. When omitted, the FIRST To Coda encountered after the jump fires (single-coda common case).',
            },
          },
        },
      },
      segnoMarkers: {
        type: 'array',
        maxItems: 20,
        description:
          'Segno landmarks ($) — visual glyphs at a measure edge that D.S.* jumpMarkers reference via segnoRef. The id field is REQUIRED here (the LLM must mint one or copy from existing input — the schema rejects missing ids). Use lowercase alphanumerics 8-16 chars (e.g. "segno00001").',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'measureIdx', 'side'],
          properties: {
            id: {
              type: 'string',
              minLength: 8,
              maxLength: 16,
              description: 'Stable id referenced by D.S.* jumpMarkers via segnoRef.',
            },
            measureIdx: {
              type: 'integer',
              description: '0-indexed measure carrying the Segno glyph.',
            },
            side: {
              type: 'string',
              enum: ['start', 'end'],
              description: 'Almost always "start" (the Segno marks the BEGINNING of the section a D.S. returns to).',
            },
          },
        },
      },
      codaMarkers: {
        type: 'array',
        maxItems: 20,
        description:
          'Coda landmarks — visual glyphs at the start of a Coda section that *.al-Coda jumpMarkers reference via codaRef. id REQUIRED.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'measureIdx', 'side'],
          properties: {
            id: {
              type: 'string',
              minLength: 8,
              maxLength: 16,
              description: 'Stable id referenced by *.al-Coda jumpMarkers via codaRef.',
            },
            measureIdx: {
              type: 'integer',
              description: '0-indexed measure carrying the Coda glyph (typically the START of the Coda section).',
            },
            side: {
              type: 'string',
              enum: ['start', 'end'],
              description: 'Almost always "start" (the Coda glyph marks the BEGINNING of the destination section).',
            },
          },
        },
      },
      techniqueStates: {
        type: 'array',
        description:
          'State-changing performance technique markers (pizz., arco, col legno, sul ponticello, etc.). Each entry switches the active technique on a specific voice from its position forward until cancelled. Distinct from per-note articulations: a "pizz" placed at measureIdx 4 means voice plays pizzicato from m.5 (1-indexed) onward until an "arco" or other cancel marker. Place markers sparingly — one at each technique change. Use the same voice / staff indices as the events themselves (staffIdx 0 = primary, 1 = secondStaff; voiceIdx 0 = primary measures, 1..3 = extraVoices[0..2]).',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['measureIdx', 'staffIdx', 'voiceIdx', 'kind'],
          properties: {
            measureIdx: {
              type: 'integer',
              description: '0-indexed measure where the technique change takes effect.',
            },
            eventIdx: {
              type: 'integer',
              description:
                'Optional 0-indexed event position within the measure where the technique change takes effect. Omit to apply at the start of the measure (the common case).',
            },
            staffIdx: {
              type: 'integer',
              enum: [0, 1],
              description: '0 = primary staff (measures), 1 = secondStaff.',
            },
            voiceIdx: {
              type: 'integer',
              enum: [0, 1, 2, 3],
              description:
                '0 = primary voice on that staff (measures); 1..3 = extraVoices[0..2] on that staff.',
            },
            kind: {
              type: 'string',
              enum: TECHNIQUE_KIND_ENUM,
              description:
                'pizz / arco / col-legno-battuto / col-legno-tratto / sul-ponticello / sul-tasto / flautando / ord / snap-pizz / LH-pizz / tremolo / mute-on / mute-off. Use "ord" to return to normal bowing from sul-ponticello / sul-tasto / flautando; "arco" specifically cancels pizz; "mute-off" cancels mute-on.',
            },
          },
        },
      },
    },
  },
} as const

export const RENDER_SCORE_TOOL_NAME = renderScoreTool.name
