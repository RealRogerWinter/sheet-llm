import { getArticulations } from '../articulations'
import { getDynamicMarking } from '../dynamics'
import { isPitchTiedToNext } from '../pitchTies'
import { findEventLocationById } from '../scoreAccessors'
import type {
  Accidental,
  Articulation,
  Barline,
  ChordSymbol,
  Clef,
  CodaMarker,
  Duration,
  Dynamic,
  EngravingDefaults,
  Event,
  Fermata,
  Fingering,
  GraceNote,
  JumpKind,
  JumpMarker,
  Key,
  LyricSyllable,
  Marker,
  Measure,
  Meter,
  MetricModulation,
  MetricModulationNote,
  Pitch,
  Score,
  SegnoMarker,
  Span,
  Volta,
} from '../types'

/** Local alias for TupletSchema values. */
type Tuplet = 3 | 5 | 6 | 7

/**
 * MusicXML 4.0 score-partwise export (M22-PR-2 minimum-viable).
 *
 * Covers the subset that round-trips cleanly into notation readers
 * (MuseScore, Sibelius, Finale, abcjs's own parser):
 *
 *   - <score-partwise> root + <part-list> + a single <part>
 *   - First-measure <attributes>: divisions / key / time / clef
 *   - <note> with <pitch>{step,alter,octave} or <rest/>
 *   - Chord-stack notes (events with >1 pitch) emit one <note> per
 *     pitch; pitches after the first carry <chord/>
 *   - <type> + optional <dot/> derived from the Duration enum
 *   - <accidental> when an explicit accidental is set on the pitch
 *   - Tempo as <direction><sound tempo=N/></direction> on measure 1
 *   - Ties (M22-PR-4): per-pitch tied_to_next → <tie>+<tied>
 *     start/stop pairs on matching position; lv pitches excluded
 *   - Multi-staff (M22-PR-5): secondStaff emits as a second staff
 *     within the same <part> via <staves>2</staves>, per-staff <clef>,
 *     per-note <staff>1|2</staff>, and a <backup> between staves so
 *     the time cursor resets to the start of the measure.
 *   - Multi-voice (M22-PR-A): score.extraVoices and
 *     score.secondStaff.extraVoices each emit a separate `<voice>N`
 *     stream within the same measure, separated by `<backup>` so the
 *     time cursor restarts at beat 1 for each voice. Voice numbers
 *     are 1..4 per staff (disambiguated by `<staff>` for grand-staff),
 *     matching MuseScore's per-staff convention.
 *   - Mid-piece markers (M22-PR-B): score.markers entries emit at the
 *     start of their target measure. Key/meter/clef changes go in an
 *     `<attributes>` block; tempo (bpm and tempo_text) goes in a
 *     `<direction>` block. Metric modulation is deferred to a
 *     follow-up (visual-only, complex emit).
 *   - Dynamics / articulations / fermata / breath / caesura
 *     (M22-PR-C): per-event dynamic emits as a `<direction>` block
 *     before the note; articulations/fermata/breath-mark/caesura go
 *     inside the FIRST note's `<notations>` (chord-stack tail notes
 *     keep only their tied marks). Structured dynamic compounds
 *     ("sub. p espressivo") stack `<words>` + `<dynamics>` +
 *     `<words>` in one `<direction>`.
 *   - Spans (M22-PR-D): slurs, phrase-slurs, hairpin wedges,
 *     octave shifts (8va/8vb/15ma/15mb), and pedal lines emit
 *     start/stop markers around their endpoint events.
 *     - Slurs go inside `<notations><slur type=start|stop number=N>`
 *       on the first note of the start/stop event.
 *     - Wedges, octave-shifts, and pedals emit as `<direction>`
 *       blocks: starts BEFORE the start-event note, stops BEFORE
 *       the end-event note. `number=` (1..6) disambiguates
 *       overlapping spans within the same voice/kind.
 *   - Chord symbols + lyrics (M22-PR-H):
 *     - `event.chordSymbol` emits as a `<harmony>` block BEFORE the
 *       note: `<root>` + `<kind>` mapped from (quality, seventh), an
 *       optional `<bass>` for slash-chord notation, and `<degree>`
 *       elements for extensions / add / omit / alterations.
 *     - `event.lyrics` emit as per-verse `<lyric number=N>` elements
 *       INSIDE the chord-anchor `<note>` with `<syllabic>` (begin /
 *       middle / end / single, computed from hyphen flags) +
 *       `<text>` + optional `<extend>` for melismas.
 *   - Tuplets + grace notes (M22-PR-I):
 *     - Tuplets emit `<time-modification>` on every note of the
 *       tuplet group + `<notations><tuplet type=start|stop>` on
 *       the first/last note. Divisions auto-scale to keep tuplet
 *       durations integer — multiplier = LCM of tuplet types
 *       present (1 when no tuplets, preserving the historical
 *       divisions=8 shape).
 *     - Grace notes emit as separate `<note>` blocks BEFORE the
 *       principal with `<grace/>` (acciaccatura uses
 *       `<grace slash="yes"/>`). Grace pitches in one GraceNote
 *       form a chord (first without `<chord/>`, rest with).
 *   - Repeat structure (M22-PR-G):
 *     - Repeat barlines (startBarline/endBarline values 'repeat-
 *       start'/'repeat-end'/'repeat-both') emit as `<barline>` with
 *       `<bar-style>` and `<repeat direction=forward|backward>`.
 *       Non-repeat barline glyphs (final, double, dashed, invisible)
 *       also emit when set.
 *     - Voltas emit `<barline location="left">…<ending number=N
 *       type=start>` on the start measure's left barline and
 *       `<barline location="right">…<ending type=stop|discontinue>`
 *       on the end measure's right barline. Multi-pass endings
 *       (endings=[1,2]) emit a comma-separated number=.
 *     - Jump markers (D.C./D.S./al-Coda variants and Fine) emit as
 *       `<direction>` blocks with `<words>` text + a `<sound>`
 *       element carrying dacapo/dalsegno/tocoda/fine semantics for
 *       playback fidelity.
 *     - Segno and Coda markers emit as `<direction>` blocks with
 *       `<segno/>` / `<coda/>` glyphs.
 *   - Ornament spans (M22-PR-E):
 *     - glissando → `<notations><glissando type=start|stop
 *       number=N line-type=solid|wavy>` (top-level notations child).
 *       glissText=true emits "gliss." as the element text.
 *     - trill-line → `<notations><ornaments><trill-mark/>` (start only)
 *       + `<wavy-line type=start|stop number=N>` on both endpoints.
 *     - tremolo-between → `<notations><ornaments><tremolo
 *       type=start|stop number=N>3</tremolo>` on both endpoints.
 *       (Slash count defaults to 3 since the span schema doesn't
 *       carry a per-span slashes value.)
 *   - accel/rit tempo spans (M22-PR-F):
 *     - On the start event: `<direction><words>accel.|rit.</words>
 *       <dashes type="start" number="N"/></direction>`. The dashed
 *       line tells engravers to extend a horizontal dashed continuation
 *       to the stop event.
 *     - On the stop event: `<direction><dashes type="stop" number="N"/>
 *       </direction>` plus optional terminal text (span.endTempoText
 *       like "a tempo") and/or new tempo (span.endTempoBpm via
 *       <metronome> + <sound tempo=>).
 *   - EngravingDefaults projection (M22-PR-J):
 *     - Score-level `<defaults>` block (between `</identification>`
 *       and `<part-list>`) projects the subset of EngravingDefaults
 *       fields that have clean MusicXML 4.0 mappings:
 *       - `tempoTextFont` → `<word-font font-style font-weight>` (the
 *         default font for `<words>` text — tempo, jump markers, etc.).
 *       - `lyricFontScale` → `<lyric-font font-size>` (percentage
 *         scaled around a 10pt engraving baseline).
 *       - `slurThickness` / `tieThickness` → `<appearance><line-width
 *         type="slur middle"|"tie middle">` (in tenths of a staff
 *         space, matching MusicXML's line-width unit).
 *     - Other EngravingDefaults fields project through per-element
 *       paths already wired (dynamicsPosition via `<direction
 *       placement>`, etc.) or have no clean MusicXML equivalent.
 *     - `<defaults>` is omitted entirely when no projectable fields
 *       are set, so minimal scores stay compact.
 *   - Fingerings (M22-PR-K):
 *     - Per-pitch fingerings emit inside each chord-note's
 *       `<notations><technical>` block (NOT just on the chord-anchor —
 *       different fingers on different chord tones is the whole point).
 *       Position: after `<ornaments>`, before `<articulations>` per the
 *       MusicXML 4.0 `<notations>` content model.
 *     - Per-system mappings:
 *       - Piano: `<fingering>VALUE</fingering>` (0-5) plus an optional
 *         second `<fingering substitution="yes">SUB</fingering>` for
 *         substitution fingerings.
 *       - String: `<fingering>FINGER</fingering>` (0-4) plus
 *         `<string>N</string>` for the Roman string indicator (I→1).
 *       - Guitar LH: `<fingering>VALUE</fingering>` (1-4) plus
 *         `<string>STRINGNUM</string>` and `<fret>N</fret>` (Roman→int).
 *       - Guitar RH: `<pluck>LETTER</pluck>` (p/i/m/a/c).
 *       - Organ: `<fingering>VALUE</fingering>` (0-5) plus optional
 *         `<heel/>` or `<toe/>` for foot indication. Thumb-direction
 *         is currently dropped (no clean MusicXML element exists).
 *     - Rest events skip fingering emission entirely — fingerings on
 *       rests are non-sensical and the per-pitch loop in `emitEvent`
 *       only fires on pitched notes.
 *   - Metric-modulation marker labels (M22-PR-L):
 *     - When a Marker has `metricModulation` set, emit a separate
 *       `<direction>` block carrying the complex-form `<metronome>`
 *       with two `<metronome-note>` children separated by
 *       `<metronome-relation>equals</metronome-relation>`. Each
 *       metronome-note carries `<metronome-type>` (the rhythmic value)
 *       plus optional `<metronome-dot/>` for dotted forms.
 *     - When both metricModulation AND tempo_bpm are set on the same
 *       marker, the modulation direction emits FIRST, then the tempo
 *       direction (engraving convention: pivot marking precedes the
 *       new bpm clarification — "♩=♪ (♩=120)" reads left-to-right).
 *     - Sixteenth maps to MusicXML's canonical "16th" token (not
 *       "sixteenth"). All other MetricModulationNote enum values
 *       pass through verbatim with dotted forms producing the
 *       `<metronome-dot/>` sibling.
 *
 * Output is a plain UTF-8 string; the caller (download handler /
 * future ExportBar wiring) is responsible for serialization to a
 * file or HTTP body.
 */
export function scoreToMusicXml(score: Score): string {
  if (score.measures.length === 0) {
    // The Score schema enforces min(1) measure, but scoreToMusicXml
    // is exported and can be called directly. Hard-fail here so the
    // emit doesn't produce a doc that the MusicXML 4.0 DTD rejects:
    // `<!ELEMENT part (measure+)>` requires at least one measure.
    throw new Error('scoreToMusicXml: score must contain at least one measure')
  }
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>')
  lines.push(
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
  )
  lines.push('<score-partwise version="4.0">')

  if (score.title) {
    lines.push('  <work>')
    lines.push(`    <work-title>${escapeXml(score.title)}</work-title>`)
    lines.push('  </work>')
  }

  if (score.composer || score.arranger || score.lyricist || score.copyright) {
    lines.push('  <identification>')
    if (score.composer) {
      lines.push(`    <creator type="composer">${escapeXml(score.composer)}</creator>`)
    }
    if (score.arranger) {
      lines.push(`    <creator type="arranger">${escapeXml(score.arranger)}</creator>`)
    }
    if (score.lyricist) {
      lines.push(`    <creator type="lyricist">${escapeXml(score.lyricist)}</creator>`)
    }
    if (score.copyright) {
      lines.push(`    <rights>${escapeXml(score.copyright)}</rights>`)
    }
    lines.push('  </identification>')
  }

  // M22-PR-J: score-level <defaults> from EngravingDefaults. Must sit
  // between </identification> and <part-list> per the partwise content
  // model. Skipped entirely when nothing projects, so minimal scores
  // stay compact.
  emitDefaults(lines, score.engravingDefaults)

  lines.push('  <part-list>')
  lines.push('    <score-part id="P1">')
  // <part-name> is the instrument label (shown in MuseScore's
  // instruments panel). Don't pipe score.title here — the piece name
  // already lives in <work-title>. A generic 'Music' label avoids
  // showing the piece name as a fake instrument name.
  lines.push('      <part-name>Music</part-name>')
  lines.push('    </score-part>')
  lines.push('  </part-list>')

  const hasSecondStaff = score.secondStaff !== undefined
  const plan = buildVoicePlan(score)
  const markersByMeasure = groupMarkersByMeasure(score.markers)
  const spanMarkersByEvent = buildSpanMarkers(score)
  const repeatStructure = buildRepeatStructure(score)
  // M22-PR-I: adaptive divisions for tuplets. multiplier = 1 when
  // no tuplets are present (preserves the historical divisions=8
  // emit shape); scales by LCM of present tuplet types otherwise.
  const divisionsMultiplier = computeDivisionsMultiplier(score)

  // Bar-alignment: every voice on every staff must have the same
  // measures.length as the primary. validateScore enforces this, but
  // scoreToMusicXml is exported and can be called directly — hard-fail
  // here so an over-length extra voice doesn't silently truncate its
  // trailing measures, and an under-length one doesn't produce a
  // malformed <part>. One up-front check covers both directions.
  for (const entry of plan) {
    const m = voiceMeasuresOf(score, entry.staffIdx, entry.voiceIdx)
    if (m && m.length !== score.measures.length) {
      throw new Error(
        `scoreToMusicXml: staff ${entry.staffIdx + 1} voice ${entry.voiceIdx + 1} has ${m.length} measures; primary has ${score.measures.length}. All voices must be bar-aligned.`,
      )
    }
  }

  lines.push('  <part id="P1">')
  score.measures.forEach((_measure, idx) => {
    lines.push(`    <measure number="${idx + 1}">`)
    if (idx === 0) {
      emitFirstMeasureAttributes(lines, score, divisionsMultiplier)
      if (score.tempo_bpm !== undefined) {
        emitTempo(lines, score.tempo_bpm)
      }
    }

    // Mid-piece markers (M22-PR-B). Emit AFTER the first-measure
    // score-level attributes (so a measure-0 marker overrides those
    // values — last-block-wins per MusicXML attributes semantics)
    // and BEFORE any voice notes (so the new key/meter/clef applies
    // to every note in this measure).
    const markersHere = markersByMeasure.get(idx)
    if (markersHere) {
      emitMarkerBlocks(lines, markersHere, hasSecondStaff)
    }

    // M22-PR-G: left-edge barline (repeat-start, volta start, or a
    // non-thin left barline glyph). Order within measure children:
    //   <attributes> → <direction tempo> → <barline location="left">
    //   → <direction segno/coda/jump> → <note>s → <direction at end>
    //   → <barline location="right">.
    emitLeftBarline(
      lines,
      score.measures[idx]?.startBarline,
      repeatStructure.voltaStartsByMeasure.get(idx),
      repeatStructure.forwardRepeatBeforeMeasure[idx],
    )
    // Segno / Coda markers at side='start' on this measure (before
    // notes — they're "jump-target" glyphs visible at the start).
    emitSegnoCodaDirections(
      lines,
      repeatStructure.segnoStartsByMeasure.get(idx),
      repeatStructure.codaStartsByMeasure.get(idx),
    )
    // D.C. / D.S. / Fine / To Coda at side='start' (rare — typically
    // these sit at the END of a measure to trigger a jump after it,
    // but the schema allows side='start' for "jump fires before
    // this measure's contents").
    const jumpsAtStart = repeatStructure.jumpMarkersByMeasure.get(idx)?.filter(
      (j) => j.side === 'start',
    )
    if (jumpsAtStart) {
      for (const j of jumpsAtStart) {
        emitJumpMarkerDirection(lines, j)
      }
    }

    // Walk the voice plan, emitting each voice's events in order with
    // a <backup> rewind between adjacent emitting voices. The rewind
    // amount equals the previous voice's total duration (which is
    // also the cursor position after that voice, because the prior
    // backup put the cursor at 0 before it started). Empty voices
    // (events.length === 0 in this measure) are skipped — they
    // contribute nothing to the cursor and need no backup.
    //
    // <staff> stamping is only meaningful when the score actually has
    // two staves; single-staff scores omit the element so MusicXML
    // readers default to staff 1 without diff noise.
    let prevEmittedDivisions = 0
    let firstEmitted = true
    for (const entry of plan) {
      const voiceMeasures = voiceMeasuresOf(score, entry.staffIdx, entry.voiceIdx)
      if (!voiceMeasures) continue // unreachable: plan only includes voices that exist
      const voiceMeasure = voiceMeasures[idx]
      // The up-front bar-alignment check above guarantees this is set;
      // the guard is defense-in-depth in case the plan diverges from
      // voiceMeasuresOf's lookup (e.g. a future refactor adding voices
      // outside the plan walk).
      if (!voiceMeasure) continue
      if (voiceMeasure.events.length === 0) continue

      if (!firstEmitted && prevEmittedDivisions > 0) {
        // <backup> sits between voices/staves within a measure; the
        // duration must match the rewind amount in divisions.
        lines.push('      <backup>')
        lines.push(`        <duration>${prevEmittedDivisions}</duration>`)
        lines.push('      </backup>')
      }

      const staffNumber = hasSecondStaff
        ? entry.staffIdx === 1
          ? 2
          : 1
        : undefined
      voiceMeasure.events.forEach((event, eventIdx) => {
        const prevEvent = prevEventOf(
          score,
          idx,
          eventIdx,
          entry.staffIdx,
          entry.voiceIdx,
        )
        const nextEvent = nextEventOf(
          score,
          idx,
          eventIdx,
          entry.staffIdx,
          entry.voiceIdx,
        )
        // M22-PR-I: tuplet group boundary detection. Adjacent events
        // with the same tuplet value form a run; the visual bracket
        // closes every N events (where N = tuplet value), so 6 events
        // of tuplet=3 emit as TWO triplet brackets, not one bracket
        // of 6. Walk back within this measure to find run length,
        // mod by tuplet value to get position in the current group.
        let tupletGroupPos = 0
        if (event.tuplet !== undefined) {
          let runBack = 0
          for (let j = eventIdx - 1; j >= 0; j--) {
            if (voiceMeasure.events[j].tuplet === event.tuplet) runBack++
            else break
          }
          tupletGroupPos = runBack % event.tuplet
        }
        const tupletStart = event.tuplet !== undefined && tupletGroupPos === 0
        const tupletReachedFullGroup =
          event.tuplet !== undefined && tupletGroupPos === event.tuplet - 1
        const tupletEndOfRun =
          event.tuplet !== undefined &&
          (nextEvent === undefined || nextEvent.tuplet !== event.tuplet)
        const tupletStop =
          event.tuplet !== undefined && (tupletReachedFullGroup || tupletEndOfRun)

        // M22-PR-D: span markers anchored to this event. Direction-
        // based spans (wedges, octave-shifts, pedals) emit BEFORE
        // the note for starts and AFTER for stops; slur markers
        // thread into the note's <notations>.
        const eventSpanMarkers = event.id
          ? spanMarkersByEvent.get(event.id) ?? []
          : []
        const startDirectionMarkers = eventSpanMarkers.filter(
          (m) => m.type === 'start' && isDirectionSpanKind(m.span.kind),
        )
        const stopDirectionMarkers = eventSpanMarkers.filter(
          (m) => m.type === 'stop' && isDirectionSpanKind(m.span.kind),
        )
        const slurMarkers = eventSpanMarkers.filter((m) => isSlurKind(m.span.kind))
        // M22-PR-E: notation-class ornament spans — glissando emits as
        // a top-level <notations> child; trill-line and tremolo-between
        // emit inside <notations><ornaments>.
        const glissandoMarkers = eventSpanMarkers.filter(
          (m) => m.span.kind === 'glissando',
        )
        const trillLineMarkers = eventSpanMarkers.filter(
          (m) => m.span.kind === 'trill-line',
        )
        const tremoloBetweenMarkers = eventSpanMarkers.filter(
          (m) => m.span.kind === 'tremolo-between',
        )

        // Order around the note:
        //   stop-direction markers  (close prior wedge/oct/pedal at THIS event)
        //   start-direction markers (open new wedge/oct/pedal at THIS event)
        //   <direction> for dynamics (PR-C)
        //   <note>...<notations>...slurs...</notations></note>
        //
        // Wedge/octave/pedal stops are positioned at the END event's
        // timing slot — which means the stop `<direction>` must
        // appear BEFORE that event's `<note>`, so the wedge ends AT
        // the stop-event note rather than one note past it. Stops
        // precede starts on the same event so an A-then-B handoff
        // ("close A, open B") reads cleanly to engraver tools.
        for (const m of stopDirectionMarkers) {
          emitSpanDirection(lines, m, staffNumber)
        }
        for (const m of startDirectionMarkers) {
          emitSpanDirection(lines, m, staffNumber)
        }
        // M22-PR-C: dynamics emit as a <direction> block BEFORE the
        // note(s), so MusicXML readers attach the dynamic to the
        // upcoming downbeat. `<direction>` and `<note>` are siblings
        // inside `<measure>`, so emit order matters here.
        emitDynamicsDirection(lines, event, staffNumber, score.engravingDefaults?.dynamicsPosition)
        // M22-PR-H: chord symbols emit as a <harmony> block BEFORE the
        // note. MusicXML readers attach the chord symbol to the next
        // <note> downbeat — same sibling-ordering principle as <direction>.
        if (event.chordSymbol) {
          emitChordSymbol(lines, event.chordSymbol)
        }
        emitEvent(lines, event, prevEvent, nextEvent, staffNumber, entry.mxlVoice, {
          slurs: slurMarkers,
          glissandi: glissandoMarkers,
          trillLines: trillLineMarkers,
          tremoloBetween: tremoloBetweenMarkers,
        }, divisionsMultiplier, { tupletStart, tupletStop })
      })

      prevEmittedDivisions = voiceMeasure.events.reduce(
        (sum, e) => sum + tupletAdjustedDivisions(e.duration, e.tuplet, divisionsMultiplier),
        0,
      )
      firstEmitted = false
    }

    // M22-PR-G: end-of-measure structures emit AFTER all voice notes
    // and BEFORE </measure>. Order:
    //   <direction segno/coda at end> → <direction jump-marker at end>
    //   → <barline location="right">
    emitSegnoCodaDirections(
      lines,
      repeatStructure.segnoEndsByMeasure.get(idx),
      repeatStructure.codaEndsByMeasure.get(idx),
    )
    const jumpsAtEnd = repeatStructure.jumpMarkersByMeasure.get(idx)?.filter(
      (j) => j.side === 'end',
    )
    if (jumpsAtEnd) {
      for (const j of jumpsAtEnd) {
        emitJumpMarkerDirection(lines, j)
      }
    }
    emitRightBarline(
      lines,
      score.measures[idx]?.endBarline,
      repeatStructure.voltaEndsByMeasure.get(idx),
      repeatStructure.backwardRepeatAfterMeasure[idx],
    )

    lines.push('    </measure>')
  })
  lines.push('  </part>')

  lines.push('</score-partwise>')
  return lines.join('\n')
}

// ── First-measure <attributes> ──────────────────────────────────────

function emitFirstMeasureAttributes(
  lines: string[],
  score: Score,
  divisionsMultiplier: number,
): void {
  lines.push('      <attributes>')
  lines.push(`        <divisions>${DIVISIONS_BASE * divisionsMultiplier}</divisions>`)
  const { fifths, mode } = keyToFifths(score.key)
  lines.push('        <key>')
  lines.push(`          <fifths>${fifths}</fifths>`)
  lines.push(`          <mode>${mode}</mode>`)
  lines.push('        </key>')
  const time = meterToTime(score.meter)
  if (time.symbol) {
    lines.push(`        <time symbol="${time.symbol}">`)
  } else {
    lines.push('        <time>')
  }
  lines.push(`          <beats>${time.beats}</beats>`)
  lines.push(`          <beat-type>${time.beatType}</beat-type>`)
  lines.push('        </time>')
  const hasSecondStaff = score.secondStaff !== undefined
  if (hasSecondStaff) {
    lines.push('        <staves>2</staves>')
  }
  // <clef number=N> identifies which staff this clef belongs to. The
  // attribute is REQUIRED when <staves> > 1; omitted when only one
  // staff exists (which is the common case for single-instrument
  // scores).
  const primaryClef = clefToSignLine(score.clef ?? 'treble')
  if (hasSecondStaff) {
    lines.push('        <clef number="1">')
  } else {
    lines.push('        <clef>')
  }
  lines.push(`          <sign>${primaryClef.sign}</sign>`)
  lines.push(`          <line>${primaryClef.line}</line>`)
  lines.push('        </clef>')
  if (hasSecondStaff) {
    const secondClef = clefToSignLine(score.secondStaff!.clef)
    lines.push('        <clef number="2">')
    lines.push(`          <sign>${secondClef.sign}</sign>`)
    lines.push(`          <line>${secondClef.line}</line>`)
    lines.push('        </clef>')
  }
  lines.push('      </attributes>')
}

function emitTempo(lines: string[], bpm: number): void {
  // Two halves of MusicXML tempo:
  //   <metronome> is the engraver-readable form (MuseScore / Sibelius
  //   render this as a "♩ = N" marking using their own music font, so
  //   we don't depend on the consumer's text font containing U+2669).
  //   <sound tempo="N"/> is the machine-readable side that drives
  //   playback in MuseScore's mixer and any MIDI export pipeline.
  lines.push('      <direction placement="above">')
  lines.push('        <direction-type>')
  lines.push('          <metronome>')
  lines.push('            <beat-unit>quarter</beat-unit>')
  lines.push(`            <per-minute>${bpm}</per-minute>`)
  lines.push('          </metronome>')
  lines.push('        </direction-type>')
  lines.push(`        <sound tempo="${bpm}"/>`)
  lines.push('      </direction>')
}

// ── Markers (M22-PR-B mid-piece key/meter/clef/tempo) ───────────────

/**
 * Group markers by their target measureIdx. Multiple markers at the
 * same idx (each changing a different field — validateMarkers catches
 * same-field collisions) coalesce into one bucket so the emit can
 * fold their fields into a single `<attributes>` block.
 */
function groupMarkersByMeasure(
  markers: readonly Marker[] | undefined,
): Map<number, Marker[]> {
  const out = new Map<number, Marker[]>()
  if (!markers) return out
  for (const m of markers) {
    const list = out.get(m.measureIdx)
    if (list) list.push(m)
    else out.set(m.measureIdx, [m])
  }
  return out
}

/**
 * Emit `<attributes>` + `<direction>` blocks for every marker that
 * targets the current measure. Order within the measure:
 *   1. `<attributes>` with any new key / time / clef
 *   2. `<direction>` with any new tempo (bpm and/or text)
 * Both blocks are emitted only when the marker set actually has the
 * relevant fields; an empty marker contributes nothing (and validateScore
 * forbids fully-empty markers anyway).
 *
 * Multiple markers at the same idx are folded: their fields union
 * into one attributes block (last writer wins on same field, but
 * validateMarkers rejects same-field collisions upstream).
 */
function emitMarkerBlocks(
  lines: string[],
  markers: readonly Marker[],
  hasSecondStaff: boolean,
): void {
  let key: Key | undefined
  let meter: Meter | undefined
  // Clef list dedupe is unnecessary here because validateMarkers
  // rejects same-field collisions (any two markers at the same idx
  // that both set `clefs` collide on the `clefs` field). The
  // accumulation below trusts that invariant.
  const clefs: Array<{ staffIdx: number; clef: Clef }> = []
  let tempoBpm: number | undefined
  let tempoText: string | undefined
  // M22-PR-L: metricModulation emits as its own <direction> with the
  // complex <metronome> form (two <metronome-note> separated by
  // <metronome-relation>equals</metronome-relation>). Distinct from
  // the tempo direction so a marker with BOTH modulation and bpm emits
  // two siblings — modulation first, then tempo (the engraving
  // convention: pivot precedes new-bpm clarification).
  let metricMod: MetricModulation | undefined
  for (const m of markers) {
    if (m.key !== undefined) key = m.key
    if (m.meter !== undefined) meter = m.meter
    if (m.clefs) {
      for (const c of m.clefs) clefs.push({ staffIdx: c.staffIdx, clef: c.clef })
    }
    if (m.tempo_bpm !== undefined) tempoBpm = m.tempo_bpm
    if (m.tempo_text !== undefined) tempoText = m.tempo_text
    if (m.metricModulation !== undefined) metricMod = m.metricModulation
  }

  // ClefChangeSchema bounds staffIdx 0..1, but doesn't know whether
  // the score actually has a secondStaff. Reject staffIdx=1 on a
  // single-staff score here so we don't silently miswire the clef
  // change onto the primary staff. A future cross-ref validator
  // could enforce this upstream; until then, the export boundary is
  // the safety net.
  for (const c of clefs) {
    if (c.staffIdx === 1 && !hasSecondStaff) {
      throw new Error(
        `scoreToMusicXml: marker clef targets staffIdx=1 but score has no secondStaff`,
      )
    }
  }

  if (key !== undefined || meter !== undefined || clefs.length > 0) {
    lines.push('      <attributes>')
    if (key !== undefined) {
      const { fifths, mode } = keyToFifths(key)
      lines.push('        <key>')
      lines.push(`          <fifths>${fifths}</fifths>`)
      lines.push(`          <mode>${mode}</mode>`)
      lines.push('        </key>')
    }
    if (meter !== undefined) {
      const time = meterToTime(meter)
      if (time.symbol) {
        lines.push(`        <time symbol="${time.symbol}">`)
      } else {
        lines.push('        <time>')
      }
      lines.push(`          <beats>${time.beats}</beats>`)
      lines.push(`          <beat-type>${time.beatType}</beat-type>`)
      lines.push('        </time>')
    }
    for (const c of clefs) {
      // <clef number=N> is only meaningful when the score has
      // multiple staves; single-staff scores omit the attribute (same
      // contract as first-measure attributes).
      const signLine = clefToSignLine(c.clef)
      if (hasSecondStaff) {
        lines.push(`        <clef number="${c.staffIdx + 1}">`)
      } else {
        lines.push('        <clef>')
      }
      lines.push(`          <sign>${signLine.sign}</sign>`)
      lines.push(`          <line>${signLine.line}</line>`)
      lines.push('        </clef>')
    }
    lines.push('      </attributes>')
  }

  // M22-PR-L: metric-modulation direction comes BEFORE the tempo
  // direction. Visual order in the engraved score: "♩ = ♪. (♩=120)"
  // — pivot first, parenthetical bpm second. Two siblings is cleaner
  // than trying to share one <direction> because the modulation uses
  // the complex <metronome> form (with metronome-note + metronome-
  // relation) while the simple bpm uses beat-unit + per-minute; they
  // can't co-occur inside one <metronome>.
  if (metricMod !== undefined) {
    emitMetricModulationDirection(lines, metricMod)
  }

  if (tempoBpm !== undefined || tempoText !== undefined) {
    // Tempo direction. Text and metronome can share one <direction>
    // block — readers (MuseScore, Sibelius) render them as a single
    // marking like "Allegro ♩ = 120". Stack <direction-type>s in the
    // order text → metronome so the words sit visually before the
    // bpm marking.
    lines.push('      <direction placement="above">')
    if (tempoText !== undefined) {
      lines.push('        <direction-type>')
      lines.push(`          <words>${escapeXml(tempoText)}</words>`)
      lines.push('        </direction-type>')
    }
    if (tempoBpm !== undefined) {
      lines.push('        <direction-type>')
      lines.push('          <metronome>')
      lines.push('            <beat-unit>quarter</beat-unit>')
      lines.push(`            <per-minute>${tempoBpm}</per-minute>`)
      lines.push('          </metronome>')
      lines.push('        </direction-type>')
      lines.push(`        <sound tempo="${tempoBpm}"/>`)
    }
    lines.push('      </direction>')
  }
}

/**
 * Emit a `<direction>` carrying the metric-modulation visual marking.
 * Shape per MusicXML 4.0:
 *
 *   <direction placement="above">
 *     <direction-type>
 *       <metronome>
 *         <metronome-note>
 *           <metronome-type>quarter</metronome-type>
 *           <metronome-dot/>      <!-- optional, for dotted forms -->
 *         </metronome-note>
 *         <metronome-relation>equals</metronome-relation>
 *         <metronome-note>
 *           <metronome-type>eighth</metronome-type>
 *         </metronome-note>
 *       </metronome>
 *     </direction-type>
 *   </direction>
 *
 * No `<sound tempo>` sibling — the modulation is visual only; the
 * actual playback tempo comes from the marker's sibling `tempo_bpm`
 * (which emits its own direction with a `<sound>`).
 */
function emitMetricModulationDirection(
  lines: string[],
  mod: MetricModulation,
): void {
  lines.push('      <direction placement="above">')
  lines.push('        <direction-type>')
  lines.push('          <metronome>')
  emitMetronomeNote(lines, mod.fromNote)
  lines.push('            <metronome-relation>equals</metronome-relation>')
  emitMetronomeNote(lines, mod.toNote)
  lines.push('          </metronome>')
  lines.push('        </direction-type>')
  lines.push('      </direction>')
}

/**
 * Emit a `<metronome-note>` for one side of a modulation. Maps the
 * schema's MetricModulationNote enum to MusicXML's `<metronome-type>`
 * token vocabulary — most pass through verbatim, but 'sixteenth' must
 * convert to MusicXML's canonical '16th' (the note-type values are
 * "1024th, ..., 32nd, 16th, eighth, quarter, half, whole" — never
 * "sixteenth").
 *
 * Dotted forms emit a sibling `<metronome-dot/>` after `<metronome-
 * type>`. MusicXML permits multiple dots; our schema only supports
 * single-dot forms, so one `<metronome-dot/>` is enough.
 */
function emitMetronomeNote(lines: string[], note: MetricModulationNote): void {
  const baseType = metronomeBaseType(note)
  const dotted = isDottedMetricModulationNote(note)
  lines.push('            <metronome-note>')
  lines.push(`              <metronome-type>${baseType}</metronome-type>`)
  if (dotted) lines.push('              <metronome-dot/>')
  lines.push('            </metronome-note>')
}

function metronomeBaseType(note: MetricModulationNote): string {
  switch (note) {
    case 'half':
    case 'dotted-half':
      return 'half'
    case 'quarter':
    case 'dotted-quarter':
      return 'quarter'
    case 'eighth':
    case 'dotted-eighth':
      return 'eighth'
    case 'sixteenth':
      // MusicXML's canonical token is "16th" — readers that accept
      // "sixteenth" do so as a permissive extension. Emit the canonical
      // form so output validates against the strict DTD.
      return '16th'
  }
}

function isDottedMetricModulationNote(note: MetricModulationNote): boolean {
  return note === 'dotted-half' || note === 'dotted-quarter' || note === 'dotted-eighth'
}

// ── Voice plan (M22-PR-A multi-voice) ────────────────────────────────

interface VoicePlanEntry {
  staffIdx: 0 | 1
  /** 0 = primary voice; 1..3 = extraVoices[0..2]. */
  voiceIdx: number
  /**
   * MusicXML <voice> number. Per MusicXML, voice numbers only need to
   * be unique within a measure; <staff> disambiguates voices across
   * staves. We use 1..4 PER staff (matching MuseScore's convention),
   * so a grand-staff piano can have voices 1..4 on the treble staff
   * AND voices 1..4 on the bass staff, with <staff>1|2</staff>
   * keeping them apart.
   */
  mxlVoice: number
}

/**
 * Enumerate every (staff, voice) on the score in emit order: all
 * voices of staff 1 first, then all voices of staff 2 (if any). Used
 * by the measure loop to drive `<backup>`-separated voice streams
 * within a single `<measure>`.
 */
function buildVoicePlan(score: Score): VoicePlanEntry[] {
  const plan: VoicePlanEntry[] = []
  const primaryVoiceCount = 1 + (score.extraVoices?.length ?? 0)
  for (let v = 0; v < primaryVoiceCount; v++) {
    plan.push({ staffIdx: 0, voiceIdx: v, mxlVoice: v + 1 })
  }
  if (score.secondStaff) {
    const secondVoiceCount = 1 + (score.secondStaff.extraVoices?.length ?? 0)
    for (let v = 0; v < secondVoiceCount; v++) {
      plan.push({ staffIdx: 1, voiceIdx: v, mxlVoice: v + 1 })
    }
  }
  return plan
}

// ── Adjacent-event lookup (M22-PR-4 ties / M22-PR-5 multi-staff) ────

/**
 * Returns the measures array for the requested (staff, voice).
 * staffIdx 0 = primary, 1 = secondStaff. voiceIdx 0 = primary voice,
 * 1..3 = extraVoices[0..2]. Ties only match within the SAME
 * (staff, voice) pair — a tied pitch on the bass staff doesn't
 * connect to a treble note, and a soprano tie doesn't bleed into an
 * alto note that happens to share step+octave.
 */
function voiceMeasuresOf(
  score: Score,
  staffIdx: 0 | 1,
  voiceIdx: number,
): readonly Measure[] | undefined {
  if (staffIdx === 1) {
    const s = score.secondStaff
    if (!s) return undefined
    if (voiceIdx === 0) return s.measures
    return s.extraVoices?.[voiceIdx - 1]?.measures
  }
  if (voiceIdx === 0) return score.measures
  return score.extraVoices?.[voiceIdx - 1]?.measures
}

/**
 * Returns the event immediately before (measureIdx, eventIdx) on the
 * given (staff, voice), walking back into the previous measure if
 * needed. undefined when this is the first event of the voice or the
 * voice doesn't exist on the score.
 */
function prevEventOf(
  score: Score,
  measureIdx: number,
  eventIdx: number,
  staffIdx: 0 | 1,
  voiceIdx: number,
): Event | undefined {
  const measures = voiceMeasuresOf(score, staffIdx, voiceIdx)
  if (!measures) return undefined
  if (eventIdx > 0) return measures[measureIdx].events[eventIdx - 1]
  if (measureIdx === 0) return undefined
  const prev = measures[measureIdx - 1]
  return prev.events[prev.events.length - 1]
}

/**
 * Returns the event immediately after (measureIdx, eventIdx) on the
 * given (staff, voice), walking forward into the next measure if
 * needed. undefined when this is the last event of the voice or the
 * voice doesn't exist on the score.
 */
function nextEventOf(
  score: Score,
  measureIdx: number,
  eventIdx: number,
  staffIdx: 0 | 1,
  voiceIdx: number,
): Event | undefined {
  const measures = voiceMeasuresOf(score, staffIdx, voiceIdx)
  if (!measures) return undefined
  const m = measures[measureIdx]
  if (eventIdx < m.events.length - 1) return m.events[eventIdx + 1]
  if (measureIdx === measures.length - 1) return undefined
  return measures[measureIdx + 1].events[0]
}

// ── Per-event <note> emission ────────────────────────────────────────

function emitEvent(
  lines: string[],
  event: Event,
  prevEvent: Event | undefined,
  nextEvent: Event | undefined,
  /**
   * MusicXML <staff> number (1 = primary, 2 = secondStaff). undefined
   * means single-staff score — omit the <staff> element entirely
   * (the reader defaults to 1).
   */
  staffNumber: 1 | 2 | undefined,
  /**
   * MusicXML <voice> number. 1 for the primary voice; 2..4 for extra
   * voices on the same staff. Per-staff numbering — staff 2's primary
   * also uses <voice>1</voice>, disambiguated by <staff>2</staff>.
   */
  mxlVoice: number,
  /**
   * M22-PR-D / -E: notation-class span markers anchored to this event.
   * All thread into the chord-anchor's `<notations>` block:
   *   - slurs/phrase-slurs → `<slur>`
   *   - glissandi → `<glissando>` (top-level)
   *   - trill-lines → `<ornaments><trill-mark/>` (start only) +
   *     `<wavy-line>` (both endpoints)
   *   - tremoloBetween → `<ornaments><tremolo>3</tremolo>` (both
   *     endpoints; slash count defaulted)
   *
   * Direction-based spans (wedges, octave-shifts, pedals) are
   * handled outside emitEvent (siblings of <note>).
   */
  notationSpans: {
    slurs: SpanMarker[]
    glissandi: SpanMarker[]
    trillLines: SpanMarker[]
    tremoloBetween: SpanMarker[]
  },
  /**
   * M22-PR-I: divisions multiplier for tuplet support. Used to scale
   * the per-note `<duration>` value AND select the tuplet-adjusted
   * value for events with `tuplet` set. 1 = no tuplets present.
   */
  divisionsMultiplier: number,
  /**
   * M22-PR-I: tuplet group boundary flags. Computed by the per-voice
   * walk using run-length analysis with a modulo-N close (so 6 events
   * of tuplet=3 emit as two triplet brackets, not one).
   */
  tupletBoundary: { tupletStart: boolean; tupletStop: boolean },
): void {
  // M22-PR-I: grace notes emit as separate <note> blocks BEFORE the
  // principal — they have no <duration> and don't consume time.
  // Multiple GraceNote entries (a beamed grace run) emit in sequence;
  // a single GraceNote with multi-pitch is a grace chord.
  if (event.graceNotes && event.graceNotes.length > 0) {
    for (const grace of event.graceNotes) {
      emitGraceNotes(lines, grace, staffNumber, mxlVoice)
    }
  }

  // M22-PR-I: tuplet duration adjustment. For tuplet events, the
  // <duration> is `(base * normal) / actual` — e.g. a triplet eighth
  // at divisionsMultiplier=3 has base=12 → tuplet duration 8.
  const divisions = tupletAdjustedDivisions(event.duration, event.tuplet, divisionsMultiplier)
  const type = durationToType(event.duration)
  const isDotted = isDottedDuration(event.duration)

  // M22-PR-I: tuplet bracket boundary — computed by the per-voice
  // walk with a count-based close (every N events for tuplet=N), so
  // adjacent same-ratio groups get separate brackets.
  const tupletStart = tupletBoundary.tupletStart
  const tupletStop = tupletBoundary.tupletStop

  // A rest is exactly one pitch with step='rest'. Mixed rest + pitch
  // events are malformed (matches the renderer's rest_in_chord
  // validation) and would produce invalid MusicXML: a leading-rest
  // skipped via `continue` would leave subsequent <chord/> notes with
  // no anchor note, and a trailing rest in a chord would silently
  // change the chord shape. Throw at the boundary instead of emitting
  // bad XML.
  const restCount = event.pitches.filter((p) => p.step === 'rest').length
  if (restCount > 0 && restCount !== event.pitches.length) {
    throw new Error(
      'scoreToMusicXml: rest cannot be mixed with pitched notes in a single event',
    )
  }
  // M22-PR-C: articulations / fermata / breath-mark / caesura attach
  // to the FIRST note of a chord-stack (engraving convention — a
  // staccato over a chord adds one dot, not one per pitch). Compute
  // them once per event and inject inside the first note's
  // <notations> block (which already holds tie markers).
  const articulations = getArticulations(event)
  const fermata = event.fermata
  const breathMark = event.breathMark === true
  const caesura = event.caesura === true

  if (restCount === event.pitches.length) {
    lines.push('      <note>')
    lines.push('        <rest/>')
    lines.push(`        <duration>${divisions}</duration>`)
    lines.push(`        <voice>${mxlVoice}</voice>`)
    lines.push(`        <type>${type}</type>`)
    if (isDotted) lines.push('        <dot/>')
    // <time-modification> sits between <accidental> and <staff> per
    // MusicXML 4.0 note content model. Emitted for any tuplet event.
    if (event.tuplet !== undefined) {
      emitTimeModification(lines, event.tuplet)
    }
    if (staffNumber !== undefined) lines.push(`        <staff>${staffNumber}</staff>`)
    // A rest can carry a fermata (G.P. with a hold) or a breath /
    // caesura (rare but legal — a caesura after a rest at the end of
    // a phrase). Articulations on rests are non-standard but the
    // schema doesn't forbid them; emit them defensively.
    // Slurs / glissandi / ornament spans on rests are unusual but
    // also legal — readers handle them gracefully.
    emitNotations(lines, {
      ties: [],
      slurs: notationSpans.slurs,
      glissandi: notationSpans.glissandi,
      trillLines: notationSpans.trillLines,
      tremoloBetween: notationSpans.tremoloBetween,
      articulations,
      fermata,
      breathMark,
      caesura,
      tuplet: event.tuplet !== undefined
        ? { actual: event.tuplet, start: tupletStart, stop: tupletStop }
        : undefined,
    })
    // M22-PR-H: lyrics on a rest are extremely unusual but legal —
    // a phrased "ah" sustaining over a rest as a melisma. Emit
    // defensively; readers handle them.
    if (event.lyrics && event.lyrics.length > 0) {
      emitLyrics(lines, event.lyrics, prevEvent)
    }
    lines.push('      </note>')
    return
  }

  // Chord-stack: emit one <note> per pitch; pitches after the first
  // carry <chord/> which tells the reader they sound at the same time
  // as the prior note (so cumulative <duration> doesn't double-count).
  //
  // MusicXML tie shape: the <tie> element (note content) drives
  // playback (sound); <tied> inside <notations> drives the engraved
  // glyph. Most readers expect BOTH to be present on tied notes.
  //
  // Element order matters per the MusicXML 4.0 note content model:
  //   <pitch>/<rest> < <tie> < <duration> < <voice> < <type>/<dot> <
  //   <accidental> < <staff> < <notations>. Misordering causes some
  //   readers (e.g. older MuseScore) to drop content silently.
  event.pitches.forEach((pitch, i) => {
    if (pitch.step === 'rest') return // unreachable after the mixed-rest guard
    const tieStart = !pitch.lv && nextEvent !== undefined && isPitchTiedToNext(pitch, event)
    const tieStop = isTieStopAt(prevEvent, i)
    lines.push('      <note>')
    if (i > 0) lines.push('        <chord/>')
    emitPitch(lines, pitch)
    if (tieStop) lines.push('        <tie type="stop"/>')
    if (tieStart) lines.push('        <tie type="start"/>')
    lines.push(`        <duration>${divisions}</duration>`)
    lines.push(`        <voice>${mxlVoice}</voice>`)
    lines.push(`        <type>${type}</type>`)
    if (isDotted) lines.push('        <dot/>')
    const accidentalName = pitchAccidentalToMusicXml(pitch.accidental)
    if (accidentalName) {
      lines.push(`        <accidental>${accidentalName}</accidental>`)
    }
    // M22-PR-I: <time-modification> sits between <accidental> and
    // <staff>. Emitted on every note of a tuplet chord-stack so the
    // reader knows the duration is tuplet-adjusted on each pitch.
    if (event.tuplet !== undefined) {
      emitTimeModification(lines, event.tuplet)
    }
    if (staffNumber !== undefined) lines.push(`        <staff>${staffNumber}</staff>`)
    const ties: Array<'stop' | 'start'> = []
    if (tieStop) ties.push('stop')
    if (tieStart) ties.push('start')
    // M22-PR-K: per-pitch fingerings attach to THIS chord pitch's
    // <note>. Aligned by index to event.pitches[] — null slots and
    // out-of-range indices skip emission. Distinct from articulations
    // / slurs / fermata which only attach to the chord-anchor.
    const fingering = event.fingerings?.[i] ?? null
    // The chord-anchor (i === 0) gets the event-level notations;
    // following chord pitches keep only their own tie markers (so a
    // staccato dot doesn't repeat per stacked pitch). Slurs and
    // ornament spans also attach to the chord-anchor only — a slur
    // or glissando on a chord is one curve / one line, not one per
    // stacked pitch. The <tuplet> start/stop bracket is engraver-
    // visible (only emitted on the anchor) so chord pitches don't
    // each spawn a bracket.
    if (i === 0) {
      emitNotations(lines, {
        ties,
        slurs: notationSpans.slurs,
        glissandi: notationSpans.glissandi,
        trillLines: notationSpans.trillLines,
        tremoloBetween: notationSpans.tremoloBetween,
        articulations,
        fermata,
        breathMark,
        caesura,
        tuplet: event.tuplet !== undefined
          ? { actual: event.tuplet, start: tupletStart, stop: tupletStop }
          : undefined,
        fingering,
      })
      // M22-PR-H: <lyric> elements sit AFTER <notations> per the
      // MusicXML 4.0 note content model. Lyrics attach only to the
      // chord-anchor — multi-pitch chord notes don't repeat the
      // syllable per pitch.
      if (event.lyrics && event.lyrics.length > 0) {
        emitLyrics(lines, event.lyrics, prevEvent)
      }
    } else {
      emitNotations(lines, { ties, fingering })
    }
    lines.push('      </note>')
  })
}

// ── Notations (per-note hub: ties / slurs / tuplets / glissandi /
//    ornaments / technical / articulations / fermata) ────────────────

/**
 * Emit a `<notations>` block consolidating every notation-class element
 * the score model can carry on a single note: ties + slurs + tuplets +
 * glissandi + ornaments (trill-line, tremolo-between) + technical
 * (fingerings, M22-PR-K) + articulations + fermata + breath-mark +
 * caesura. The block is omitted when nothing applies.
 *
 * Element order inside `<notations>` follows the MusicXML 4.0 content
 * model:
 *   tied → slur → tuplet → glissando → ornaments → technical →
 *   articulations → fermata.
 *
 * Breath-mark and caesura are MusicXML-classed as articulations (they
 * appear as siblings inside the `<articulations>` wrapper), so they're
 * folded into that group rather than emitting their own. Dynamics live
 * outside `<notations>` (they're a sibling `<direction>` per M22-PR-C).
 */
function emitNotations(
  lines: string[],
  spec: {
    ties: Array<'stop' | 'start'>
    /** M22-PR-D: slur start/stop markers attached to this note. */
    slurs?: SpanMarker[]
    /** M22-PR-E: glissando span markers (top-level notations child). */
    glissandi?: SpanMarker[]
    /** M22-PR-E: trill-line span markers (inside <ornaments>). */
    trillLines?: SpanMarker[]
    /** M22-PR-E: tremolo-between span markers (inside <ornaments>). */
    tremoloBetween?: SpanMarker[]
    articulations?: Articulation[]
    fermata?: Fermata
    breathMark?: boolean
    caesura?: boolean
    /**
     * M22-PR-I: tuplet bracket marker. start/stop flag whether this
     * note opens / closes the visual bracket; the actual count is
     * the Tuplet enum value (used only for the <tuplet> attribute,
     * NOT for <time-modification> which lives elsewhere on the note).
     */
    tuplet?: { actual: Tuplet; start: boolean; stop: boolean }
    /**
     * M22-PR-K: per-pitch fingering. Attaches to the chord pitch's
     * own `<note>` (not just the chord-anchor — different fingers on
     * different chord tones is the point). Null/undefined skips the
     * `<technical>` block. Discriminated by `system` so the emit
     * picks the right MusicXML element vocabulary.
     */
    fingering?: Fingering | null
  },
): void {
  const arts = spec.articulations ?? []
  const slurs = spec.slurs ?? []
  const glissandi = spec.glissandi ?? []
  const trillLines = spec.trillLines ?? []
  const tremoloBetween = spec.tremoloBetween ?? []
  const hasTupletBracket =
    spec.tuplet !== undefined && (spec.tuplet.start || spec.tuplet.stop)
  const hasArticulationsChildren =
    arts.length > 0 || spec.breathMark === true || spec.caesura === true
  const hasOrnamentsChildren = trillLines.length > 0 || tremoloBetween.length > 0
  const hasTechnical = spec.fingering !== null && spec.fingering !== undefined
  const hasAnything =
    spec.ties.length > 0 ||
    slurs.length > 0 ||
    glissandi.length > 0 ||
    hasTupletBracket ||
    hasOrnamentsChildren ||
    hasTechnical ||
    hasArticulationsChildren ||
    spec.fermata !== undefined
  if (!hasAnything) return

  // MusicXML 4.0 <notations> content order:
  //   tied → slur → tuplet → glissando → slide → ornaments → technical
  //   → articulations → dynamics → fermata.
  lines.push('        <notations>')
  for (const t of spec.ties) {
    lines.push(`          <tied type="${t}"/>`)
  }
  for (const s of slurs) {
    emitSlur(lines, s)
  }
  if (hasTupletBracket && spec.tuplet) {
    // Number="1" — our schema disallows nested/overlapping tuplets
    // within a single event, so the visual bracket numbering is
    // always 1 within a voice. Bracket="yes" makes the bracket
    // explicit (readers vary on the default).
    if (spec.tuplet.start) {
      lines.push(`          <tuplet type="start" number="1" bracket="yes"/>`)
    }
    if (spec.tuplet.stop) {
      lines.push(`          <tuplet type="stop" number="1"/>`)
    }
  }
  for (const g of glissandi) {
    emitGlissando(lines, g)
  }
  if (hasOrnamentsChildren) {
    lines.push('          <ornaments>')
    for (const m of trillLines) {
      // <trill-mark/> attaches once on the START event — the line
      // emerges FROM the trill glyph. The stop event gets only the
      // <wavy-line type="stop"/>.
      if (m.type === 'start') {
        lines.push('            <trill-mark/>')
      }
      lines.push(`            <wavy-line type="${m.type}" number="${m.number}"/>`)
    }
    for (const m of tremoloBetween) {
      // <tremolo> for between-note tremolo carries the slash count
      // as text content. The Span schema doesn't expose a per-span
      // slashes value, so default to 3 (the unmeasured between-note
      // engraving default, common in late-Romantic / 20c orchestral).
      lines.push(`            <tremolo type="${m.type}" number="${m.number}">3</tremolo>`)
    }
    lines.push('          </ornaments>')
  }
  if (hasTechnical && spec.fingering) {
    emitTechnical(lines, spec.fingering)
  }
  if (hasArticulationsChildren) {
    lines.push('          <articulations>')
    for (const a of arts) {
      const el = articulationToMusicXmlElement(a)
      if (el) lines.push(`            ${el}`)
    }
    if (spec.breathMark === true) lines.push('            <breath-mark/>')
    if (spec.caesura === true) lines.push('            <caesura/>')
    lines.push('          </articulations>')
  }
  if (spec.fermata !== undefined) {
    const shape = fermataShapeFor(spec.fermata)
    if (shape === 'normal') {
      lines.push('          <fermata/>')
    } else {
      lines.push(`          <fermata shape="${shape}"/>`)
    }
  }
  lines.push('        </notations>')
}

function articulationToMusicXmlElement(a: Articulation): string | null {
  switch (a) {
    case 'staccato':
      return '<staccato/>'
    case 'accent':
      return '<accent/>'
    case 'tenuto':
      return '<tenuto/>'
    case 'marcato':
      return '<strong-accent/>'
    case 'portato':
      // MusicXML's <detached-legato/> is the engraved portato glyph
      // (staccato dot + tenuto line). Equivalent of the score
      // schema's 'portato' single value.
      return '<detached-legato/>'
    case 'none':
    default:
      return null
  }
}

/**
 * Map our 5-form Fermata enum to the MusicXML 4.0 fermata `shape`
 * attribute. 'normal' is the default; the others need the explicit
 * attribute. Reader support for non-default shapes varies (MuseScore
 * 4+ honors them; older Sibelius may render them as the default
 * semicircle).
 */
function fermataShapeFor(f: Fermata): string {
  switch (f) {
    case 'standard':
      return 'normal'
    case 'short':
      return 'angled'
    case 'long':
      return 'square'
    case 'very-short':
      return 'double-angled'
    case 'very-long':
      return 'double-square'
  }
}

// ── Technical / fingerings (M22-PR-K) ────────────────────────────────

/**
 * Emit a `<technical>` block carrying the engraver's fingering
 * indication. Position in `<notations>` is after `<ornaments>` and
 * before `<articulations>` per the MusicXML 4.0 content model.
 *
 * Per-system content mapping:
 *   - Piano: `<fingering>VALUE</fingering>` (0..5) plus an optional
 *     second `<fingering substitution="yes">SUB</fingering>` for the
 *     substitution finger (publishers use the `2-3` notation pattern
 *     for "play with 2, then re-finger to 3 while holding").
 *   - String: `<fingering>FINGER</fingering>` (0..4; 0 = open string)
 *     plus optional `<string>N</string>` (Roman I..IV → 1..4 — the
 *     finger and string are orthogonal axes that both engrave).
 *   - Guitar LH: `<fingering>VALUE</fingering>` (1..4) plus optional
 *     `<string>STRINGNUM</string>` (1..6) and `<fret>N</fret>` (Roman
 *     position → integer fret).
 *   - Guitar RH: `<pluck>LETTER</pluck>` (p/i/m/a/c — Spanish letter
 *     pluck system). No numeric fingering.
 *   - Organ: `<fingering>VALUE</fingering>` (0..5) plus optional
 *     `<heel/>` or `<toe/>` for foot indication. `thumbDirection`
 *     (`(` / `)`) is dropped — MusicXML has no clean element for
 *     thumb-direction; readers infer from context.
 *
 * `<technical>` children can appear in any order per the spec
 * (`<xs:choice maxOccurs="unbounded">`); we use a stable emit order
 * (fingering → pluck → string → fret → heel/toe) so output is
 * deterministic for tests and diff inspection.
 */
function emitTechnical(lines: string[], fingering: Fingering): void {
  lines.push('          <technical>')
  switch (fingering.system) {
    case 'piano': {
      lines.push(`            <fingering>${fingering.value}</fingering>`)
      if (fingering.substitution !== undefined) {
        lines.push(
          `            <fingering substitution="yes">${escapeXml(fingering.substitution)}</fingering>`,
        )
      }
      break
    }
    case 'string': {
      lines.push(`            <fingering>${fingering.finger}</fingering>`)
      if (fingering.stringRoman !== undefined) {
        lines.push(
          `            <string>${romanToInt(fingering.stringRoman)}</string>`,
        )
      }
      break
    }
    case 'guitar-lh': {
      lines.push(`            <fingering>${fingering.value}</fingering>`)
      if (fingering.stringNum !== undefined) {
        lines.push(`            <string>${fingering.stringNum}</string>`)
      }
      if (fingering.fret !== undefined) {
        lines.push(`            <fret>${romanToInt(fingering.fret)}</fret>`)
      }
      break
    }
    case 'guitar-rh': {
      lines.push(`            <pluck>${fingering.value}</pluck>`)
      break
    }
    case 'organ': {
      lines.push(`            <fingering>${fingering.value}</fingering>`)
      if (fingering.foot === 'heel') {
        lines.push('            <heel/>')
      } else if (fingering.foot === 'toe') {
        lines.push('            <toe/>')
      }
      // thumbDirection ('(' / ')') has no clean MusicXML mapping —
      // <other-technical> is too generic and readers don't engrave it
      // as the thumb-rotation glyph. Silently dropped; the data still
      // round-trips through the JSON model.
      break
    }
  }
  lines.push('          </technical>')
}

/**
 * Parse a Roman-numeral string (I, II, III, IV, V, VI, VII, VIII, IX,
 * X, XI, XII, ...) to integer. Returns the parsed number; assumes
 * well-formed input matching the schema regex `^[IVX]+$`.
 *
 * StringFingering.stringRoman is constrained to I..IV (always 4-string
 * instruments per the violin/viola/cello convention), but
 * GuitarLHFingering.fret is unbounded under `^[IVX]+$` so it can
 * represent positions up to XXX (30). Handle both with a single
 * implementation rather than carving I..IV out as a special case.
 */
function romanToInt(roman: string): number {
  const VALUES: Record<string, number> = { I: 1, V: 5, X: 10 }
  let total = 0
  for (let i = 0; i < roman.length; i++) {
    const cur = VALUES[roman[i]] ?? 0
    const next = i + 1 < roman.length ? VALUES[roman[i + 1]] ?? 0 : 0
    // Subtractive form (IV=4, IX=9, XL=40): if current < next, subtract;
    // otherwise add. Schema regex `[IVX]+` admits the standard
    // I..XII+ vocabulary used by fret positions and string indicators.
    if (cur < next) total -= cur
    else total += cur
  }
  return total
}

// ── Dynamics direction (M22-PR-C) ───────────────────────────────────

/**
 * Emit a `<direction>` block carrying the event's dynamic (plain
 * `event.dynamic` or structured `event.dynamic_structured`). Sibling
 * of `<note>` inside `<measure>` — placed BEFORE the upcoming note(s)
 * so MusicXML readers attach the dynamic to that downbeat.
 *
 * Structured compounds emit as multiple `<direction-type>` blocks
 * inside one `<direction>`: prefix words → dynamics glyph → suffix
 * words. This lets MuseScore/Sibelius render "sub. p espressivo"
 * as a single grouped marking.
 *
 * staffNumber threads the score's <staff> assignment through so the
 * direction binds to the correct staff on grand-staff scores.
 *
 * `dynamicsPosition` (from EngravingDefaults) drives the `placement`
 * attribute and — for `'hidden'` — suppresses the emit entirely.
 * 'auto-by-staff' and undefined fall back to `'below'` (the
 * instrumental-line convention).
 */
function emitDynamicsDirection(
  lines: string[],
  event: Event,
  staffNumber: 1 | 2 | undefined,
  dynamicsPosition: 'above' | 'below' | 'auto-by-staff' | 'hidden' | undefined,
): void {
  // 'hidden' is a documented contract on EngravingDefaults: dynamic
  // glyphs are suppressed (the user expects them rendered on a
  // separate layer, or in a part extraction where dynamics live
  // elsewhere). Skip the whole emit rather than emitting and hoping
  // the reader honors the placement attribute.
  if (dynamicsPosition === 'hidden') return
  const marking = getDynamicMarking(event)
  if (!marking) return
  if (marking.base === 'none') return

  const placement = dynamicsPosition === 'above' ? 'above' : 'below'
  lines.push(`      <direction placement="${placement}">`)
  if (marking.prefix !== undefined) {
    lines.push('        <direction-type>')
    lines.push(`          <words>${escapeXml(marking.prefix)}</words>`)
    lines.push('        </direction-type>')
  }
  lines.push('        <direction-type>')
  lines.push('          <dynamics>')
  lines.push(`            ${dynamicElementFor(marking.base)}`)
  lines.push('          </dynamics>')
  lines.push('        </direction-type>')
  if (marking.suffix !== undefined && marking.suffix !== '') {
    lines.push('        <direction-type>')
    lines.push(`          <words>${escapeXml(marking.suffix)}</words>`)
    lines.push('        </direction-type>')
  }
  if (staffNumber !== undefined) {
    lines.push(`        <staff>${staffNumber}</staff>`)
  }
  lines.push('      </direction>')
}

/**
 * Map our Dynamic enum to a MusicXML 4.0 <dynamics> child element.
 * Most values map 1:1 to a same-name element; the rare ones not in
 * the MusicXML enum (rfp, fzp) fall through to <other-dynamics>.
 */
function dynamicElementFor(d: Dynamic): string {
  switch (d) {
    case 'pppp':
    case 'ppp':
    case 'pp':
    case 'p':
    case 'mp':
    case 'mf':
    case 'f':
    case 'ff':
    case 'fff':
    case 'ffff':
    case 'n':
    case 'fp':
    case 'fz':
    case 'sfz':
    case 'sffz':
    case 'sfp':
    case 'sfpp':
    case 'rfz':
      return `<${d}/>`
    case 'rfp':
    case 'fzp':
      // Not in the MusicXML 4.0 group-dynamics list. <other-dynamics>
      // is the spec-mandated escape hatch for these (Schumann-era
      // markings that didn't make the standard cut).
      return `<other-dynamics>${d}</other-dynamics>`
    case 'none':
      // Filtered above; defensive return to keep the switch exhaustive.
      return ''
  }
}

// ── Spans (M22-PR-D slurs / hairpins / octave shifts / pedal) ────────

/**
 * A resolved span endpoint marker. The `type` is whether THIS event
 * is the span's start or its stop; `number` is the MusicXML 1..6
 * disambiguator for nested/overlapping spans within the same voice
 * and kind-family.
 */
interface SpanMarker {
  span: Span
  type: 'start' | 'stop'
  number: number
}

/**
 * Span kinds that emit as a `<direction>` block (sibling of `<note>`):
 * hairpin wedges, octave shifts, pedal lines, and accel/rit tempo
 * lines (M22-PR-F).
 */
function isDirectionSpanKind(kind: Span['kind']): boolean {
  return (
    kind === 'hairpin-cresc' ||
    kind === 'hairpin-dim' ||
    kind === '8va' ||
    kind === '8vb' ||
    kind === '15ma' ||
    kind === '15mb' ||
    kind === 'pedal' ||
    kind === 'accel' ||
    kind === 'rit'
  )
}

/**
 * Span kinds that emit inside `<notations>` on the note: slur and
 * phrase-slur. Phrase-slur is engraved identically to a slur in
 * MusicXML 4.0; readers differentiate via score-level styling.
 */
function isSlurKind(kind: Span['kind']): boolean {
  return kind === 'slur' || kind === 'phrase-slur'
}

/**
 * M22-PR-E: Span kinds that emit as ornament-class `<notations>`
 * children — glissando (top-level), trill-line and tremolo-between
 * (inside `<ornaments>`).
 */
function isOrnamentSpanKind(kind: Span['kind']): boolean {
  return kind === 'glissando' || kind === 'trill-line' || kind === 'tremolo-between'
}

/**
 * Build a lookup of span markers keyed by event id. For each emitted
 * span, two entries are produced: one for the start event ('start')
 * and one for the stop event ('stop'). Spans whose endpoints can't
 * be resolved are silently skipped — validateCrossRefs catches
 * dangling endpoints upstream; the export trusts that invariant.
 *
 * Numbering scheme: within each kind-family (slur, wedge, octave-
 * shift, pedal, glissando, wavyLine, tremolo, dashes) and voice,
 * spans are assigned 1..6 (cycling on collision). MusicXML 4.0 caps
 * `number` at 6, and overlapping spans of the same family need
 * distinct numbers to disambiguate; for >6 overlapping spans of a
 * single family in a single voice the collision is intentional —
 * vanishingly rare in real scores.
 *
 * All Span kinds defined by the schema now produce MusicXML emit
 * through this dispatch.
 */
function buildSpanMarkers(score: Score): Map<string, SpanMarker[]> {
  const out = new Map<string, SpanMarker[]>()
  const spans = score.spans
  if (!spans || spans.length === 0) return out

  // Per-(voice, kind-family) counter for MusicXML <number=>. The
  // family key consolidates 8va/8vb/15ma/15mb into one octave-shift
  // namespace since MusicXML's `<octave-shift number=>` shares one
  // pool across sizes. Each notation-level element with a `number=`
  // attribute (slur, glissando, wavy-line, tremolo) has its own
  // pool — they don't collide across element types.
  const counters = new Map<string, number>()
  const familyOf = (kind: Span['kind']): string => {
    if (isSlurKind(kind)) return 'slur'
    if (kind === 'hairpin-cresc' || kind === 'hairpin-dim') return 'wedge'
    if (kind === '8va' || kind === '8vb' || kind === '15ma' || kind === '15mb') return 'octave'
    if (kind === 'pedal') return 'pedal'
    if (kind === 'glissando') return 'glissando'
    if (kind === 'trill-line') return 'wavyLine'
    if (kind === 'tremolo-between') return 'tremolo'
    if (kind === 'accel' || kind === 'rit') return 'dashes'
    return 'other'
  }

  for (const span of spans) {
    if (
      !isDirectionSpanKind(span.kind) &&
      !isSlurKind(span.kind) &&
      !isOrnamentSpanKind(span.kind)
    ) continue
    const startLoc = findEventLocationById(score, span.startEventId)
    const endLoc = findEventLocationById(score, span.endEventId)
    if (!startLoc || !endLoc) continue

    const key = `${startLoc.staffIdx}:${startLoc.voiceIdx}:${familyOf(span.kind)}`
    const prior = counters.get(key) ?? 0
    // Numbers 1..6 cycle; MusicXML caps at 6 (the spec is conservative,
    // readers handle higher but spec-conformant emit is the goal).
    const number = (prior % 6) + 1
    counters.set(key, prior + 1)

    const startMarker: SpanMarker = { span, type: 'start', number }
    const stopMarker: SpanMarker = { span, type: 'stop', number }

    const startList = out.get(span.startEventId)
    if (startList) startList.push(startMarker)
    else out.set(span.startEventId, [startMarker])

    const stopList = out.get(span.endEventId)
    if (stopList) stopList.push(stopMarker)
    else out.set(span.endEventId, [stopMarker])
  }
  return out
}

/**
 * Emit a `<slur>` element inside `<notations>`. Placement (above /
 * below / default) propagates via the `placement` attribute when set
 * explicitly. The MusicXML 4.0 default lets the engraver decide.
 */
function emitSlur(lines: string[], m: SpanMarker): void {
  const placement = spanPlacementAttr(m.span)
  lines.push(`          <slur number="${m.number}" type="${m.type}"${placement}/>`)
}

/**
 * M22-PR-E: emit a `<glissando>` element as a top-level child of
 * `<notations>`. `line-type` follows `span.glissStyle`:
 *   - 'wavy' or undefined → `line-type="wavy"` (engraver default
 *     for rapid sliding; common notation for pitched glissando)
 *   - 'straight' → `line-type="solid"` (portamento-style continuous
 *     slide; readers render as a straight diagonal line)
 * `span.glissText` (when true) emits "gliss." as the element's text
 * content; MusicXML readers paint that label above the line.
 */
function emitGlissando(lines: string[], m: SpanMarker): void {
  const placement = spanPlacementAttr(m.span)
  const lineType = m.span.glissStyle === 'straight' ? 'solid' : 'wavy'
  const text = m.span.glissText === true ? 'gliss.' : ''
  const open = `<glissando number="${m.number}" type="${m.type}" line-type="${lineType}"${placement}>`
  if (text !== '') {
    lines.push(`          ${open}${escapeXml(text)}</glissando>`)
  } else {
    // Self-closing form when there's no label text; MusicXML accepts
    // both <glissando .../> and <glissando ...></glissando>, but the
    // self-closing form is more compact and matches MuseScore exports.
    lines.push(`          ${open.replace(/>$/, '/>')}`)
  }
}

/**
 * Emit a `<direction>` block for a direction-class span marker
 * (wedge, octave-shift, or pedal). The element shape depends on
 * the span kind; `staffNumber` threads through to bind the
 * direction to the correct staff on grand-staff scores.
 */
function emitSpanDirection(
  lines: string[],
  m: SpanMarker,
  staffNumber: 1 | 2 | undefined,
): void {
  // M22-PR-F: accel/rit have a distinct multi-direction-type shape
  // (words + dashes on start, dashes-stop + optional terminal
  // text/tempo on stop) — split into a dedicated helper.
  if (m.span.kind === 'accel' || m.span.kind === 'rit') {
    emitTempoSpanDirection(lines, m, staffNumber)
    return
  }
  const placement = spanPlacementAttr(m.span)
  lines.push(`      <direction${placement}>`)
  lines.push('        <direction-type>')
  if (m.span.kind === 'hairpin-cresc' || m.span.kind === 'hairpin-dim') {
    // <wedge>: type=crescendo for start of cresc, diminuendo for
    // start of dim, stop for the end (kind-agnostic on stop).
    const wedgeType =
      m.type === 'stop'
        ? 'stop'
        : m.span.kind === 'hairpin-cresc'
          ? 'crescendo'
          : 'diminuendo'
    lines.push(`          <wedge type="${wedgeType}" number="${m.number}"/>`)
  } else if (
    m.span.kind === '8va' ||
    m.span.kind === '8vb' ||
    m.span.kind === '15ma' ||
    m.span.kind === '15mb'
  ) {
    // <octave-shift>: size=8|15; type=down for 8va/15ma (notes
    // sound an octave/15ma higher than written, so the SHIFT is
    // DOWN from sounding to written) and up for 8vb/15mb. MusicXML
    // convention: type follows the printed line direction, not
    // sounding direction.
    const size = m.span.kind === '8va' || m.span.kind === '8vb' ? 8 : 15
    const direction =
      m.type === 'stop'
        ? 'stop'
        : m.span.kind === '8va' || m.span.kind === '15ma'
          ? 'down'
          : 'up'
    lines.push(
      `          <octave-shift type="${direction}" size="${size}" number="${m.number}"/>`,
    )
  } else if (m.span.kind === 'pedal') {
    // <pedal>: line=yes preferred (line + bracket notation; the
    // older Ped./* notation can be opted into by readers' display
    // preferences).
    lines.push(`          <pedal type="${m.type}" line="yes" number="${m.number}"/>`)
  } else {
    // Unsupported direction-class kind reached emitSpanDirection
    // without buildSpanMarkers gating it. This is a code-path bug
    // (someone added to isDirectionSpanKind but not to this switch);
    // throw rather than emitting an empty <direction-type> block
    // (which would be invalid MusicXML — the spec requires at least
    // one child).
    throw new Error(
      `emitSpanDirection: unsupported span kind '${m.span.kind}' — update isDirectionSpanKind or this dispatch`,
    )
  }
  lines.push('        </direction-type>')
  if (staffNumber !== undefined) {
    lines.push(`        <staff>${staffNumber}</staff>`)
  }
  lines.push('      </direction>')
}

/**
 * M22-PR-F: emit a `<direction>` for an accel/rit tempo span.
 * Distinct shape from the other direction-class spans:
 *
 * Start event:
 *   <direction placement=above>
 *     <direction-type><words>accel.|rit.</words></direction-type>
 *     <direction-type><dashes type=start number=N/></direction-type>
 *     <staff>?
 *   </direction>
 *
 * Stop event:
 *   <direction placement=above>
 *     <direction-type><dashes type=stop number=N/></direction-type>
 *     <direction-type><words>endTempoText</words>?</direction-type>
 *     <direction-type><metronome><beat-unit>quarter<per-minute>N
 *       </metronome></direction-type>?
 *     <staff>?
 *     <sound tempo=N/>?  (when endTempoBpm is set, drives playback)
 *   </direction>
 *
 * span.endTempoText (e.g. "a tempo") and span.endTempoBpm (the new
 * pulse the tempo settles into) both flow from the M14 tempo-span
 * schema; either, both, or neither may be set.
 */
function emitTempoSpanDirection(
  lines: string[],
  m: SpanMarker,
  staffNumber: 1 | 2 | undefined,
): void {
  // accel/rit conventionally sit above the staff; respect explicit
  // span.placement otherwise.
  const placement =
    m.span.placement === 'below' ? ' placement="below"' : ' placement="above"'
  lines.push(`      <direction${placement}>`)
  if (m.type === 'start') {
    const text = m.span.kind === 'accel' ? 'accel.' : 'rit.'
    lines.push('        <direction-type>')
    lines.push(`          <words>${text}</words>`)
    lines.push('        </direction-type>')
    lines.push('        <direction-type>')
    lines.push(`          <dashes type="start" number="${m.number}"/>`)
    lines.push('        </direction-type>')
    if (staffNumber !== undefined) {
      lines.push(`        <staff>${staffNumber}</staff>`)
    }
  } else {
    // type === 'stop'
    lines.push('        <direction-type>')
    lines.push(`          <dashes type="stop" number="${m.number}"/>`)
    lines.push('        </direction-type>')
    if (m.span.endTempoText !== undefined) {
      lines.push('        <direction-type>')
      lines.push(`          <words>${escapeXml(m.span.endTempoText)}</words>`)
      lines.push('        </direction-type>')
    }
    if (m.span.endTempoBpm !== undefined) {
      lines.push('        <direction-type>')
      lines.push('          <metronome>')
      lines.push('            <beat-unit>quarter</beat-unit>')
      lines.push(`            <per-minute>${m.span.endTempoBpm}</per-minute>`)
      lines.push('          </metronome>')
      lines.push('        </direction-type>')
    }
    if (staffNumber !== undefined) {
      lines.push(`        <staff>${staffNumber}</staff>`)
    }
    if (m.span.endTempoBpm !== undefined) {
      lines.push(`        <sound tempo="${m.span.endTempoBpm}"/>`)
    }
  }
  lines.push('      </direction>')
}

/**
 * Build the ` placement="X"` attribute string for a span emit, or
 * empty string when the placement is 'default' / unset. Used by
 * both slur and direction emits.
 */
function spanPlacementAttr(span: Span): string {
  if (span.placement === 'above') return ' placement="above"'
  if (span.placement === 'below') return ' placement="below"'
  return ''
}

// ── Repeat structure (M22-PR-G voltas / repeats / jumps) ────────────

/**
 * Pre-built lookup of per-measure repeat structures: voltas (by
 * start/end measure index), jump markers, segno/coda markers.
 * Computed once before the measure loop so the inner emit can
 * do constant-time lookups.
 */
interface RepeatStructure {
  voltaStartsByMeasure: Map<number, Volta>
  voltaEndsByMeasure: Map<number, Volta>
  jumpMarkersByMeasure: Map<number, JumpMarker[]>
  segnoStartsByMeasure: Map<number, SegnoMarker[]>
  segnoEndsByMeasure: Map<number, SegnoMarker[]>
  codaStartsByMeasure: Map<number, CodaMarker[]>
  codaEndsByMeasure: Map<number, CodaMarker[]>
  /**
   * True when measure idx's LEFT barline needs a forward repeat. Set
   * when the measure's startBarline is repeat-start OR when the
   * PREVIOUS measure's endBarline is repeat-both (whose forward half
   * spreads across the boundary into this measure's left edge).
   */
  forwardRepeatBeforeMeasure: boolean[]
  /**
   * True when measure idx's RIGHT barline needs a backward repeat. Set
   * when the measure's endBarline is repeat-end OR when the NEXT
   * measure's startBarline is repeat-both (whose backward half spreads
   * across the boundary onto this measure's right edge).
   */
  backwardRepeatAfterMeasure: boolean[]
}

function buildRepeatStructure(score: Score): RepeatStructure {
  const voltaStartsByMeasure = new Map<number, Volta>()
  const voltaEndsByMeasure = new Map<number, Volta>()
  for (const v of score.voltas ?? []) {
    voltaStartsByMeasure.set(v.startMeasureIdx, v)
    voltaEndsByMeasure.set(v.endMeasureIdx, v)
  }
  const jumpMarkersByMeasure = new Map<number, JumpMarker[]>()
  for (const j of score.jumpMarkers ?? []) {
    const list = jumpMarkersByMeasure.get(j.measureIdx)
    if (list) list.push(j)
    else jumpMarkersByMeasure.set(j.measureIdx, [j])
  }
  const segnoStartsByMeasure = new Map<number, SegnoMarker[]>()
  const segnoEndsByMeasure = new Map<number, SegnoMarker[]>()
  for (const s of score.segnoMarkers ?? []) {
    const bucket = s.side === 'start' ? segnoStartsByMeasure : segnoEndsByMeasure
    const list = bucket.get(s.measureIdx)
    if (list) list.push(s)
    else bucket.set(s.measureIdx, [s])
  }
  const codaStartsByMeasure = new Map<number, CodaMarker[]>()
  const codaEndsByMeasure = new Map<number, CodaMarker[]>()
  for (const c of score.codaMarkers ?? []) {
    const bucket = c.side === 'start' ? codaStartsByMeasure : codaEndsByMeasure
    const list = bucket.get(c.measureIdx)
    if (list) list.push(c)
    else bucket.set(c.measureIdx, [c])
  }
  // M22-PR-G fix: spread `repeat-both` across measure boundaries.
  // A repeat-both glyph means BOTH "close the prior block" AND
  // "open the next block" at the same boundary. MusicXML expresses
  // this as a backward-repeat on the prior measure's right barline
  // + a forward-repeat on the next measure's left barline (most
  // readers merge them into one visual `:|:` glyph). Without this
  // pass, `repeat-both` on one side silently drops the other half.
  const N = score.measures.length
  const forwardRepeatBeforeMeasure: boolean[] = new Array(N).fill(false)
  const backwardRepeatAfterMeasure: boolean[] = new Array(N).fill(false)
  for (let i = 0; i < N; i++) {
    const startB = score.measures[i].startBarline
    const endB = score.measures[i].endBarline
    if (startB === 'repeat-start' || startB === 'repeat-both') {
      forwardRepeatBeforeMeasure[i] = true
    }
    if (startB === 'repeat-both' && i > 0) {
      backwardRepeatAfterMeasure[i - 1] = true
    }
    if (endB === 'repeat-end' || endB === 'repeat-both') {
      backwardRepeatAfterMeasure[i] = true
    }
    if (endB === 'repeat-both' && i + 1 < N) {
      forwardRepeatBeforeMeasure[i + 1] = true
    }
  }
  return {
    voltaStartsByMeasure,
    voltaEndsByMeasure,
    jumpMarkersByMeasure,
    segnoStartsByMeasure,
    segnoEndsByMeasure,
    codaStartsByMeasure,
    codaEndsByMeasure,
    forwardRepeatBeforeMeasure,
    backwardRepeatAfterMeasure,
  }
}

/**
 * Map our Barline enum to a MusicXML `<bar-style>` value, given which
 * side of the measure the barline lives on. Returns undefined for
 * kinds that don't need a custom bar-style (regular thin barlines
 * are the engraver default and omitted).
 *
 * - thin / undefined → none (engraver default)
 * - double → light-light
 * - final → light-heavy
 * - dashed → dashed
 * - invisible → none
 * - repeat-start → heavy-light
 * - repeat-end → light-heavy
 * - repeat-both → side-dependent: left=heavy-light, right=light-heavy.
 *   The OTHER half (the forward/backward repeat across the boundary)
 *   propagates via forwardRepeatBeforeMeasure / backwardRepeatAfter
 *   Measure flags in RepeatStructure — see buildRepeatStructure.
 */
function barlineToBarStyle(
  b: Barline | undefined,
  side: 'left' | 'right',
): string | undefined {
  switch (b) {
    case 'thin':
    case undefined:
      return undefined
    case 'double':
      return 'light-light'
    case 'final':
      return 'light-heavy'
    case 'dashed':
      return 'dashed'
    case 'invisible':
      return 'none'
    case 'repeat-start':
      return 'heavy-light'
    case 'repeat-end':
      return 'light-heavy'
    case 'repeat-both':
      return side === 'left' ? 'heavy-light' : 'light-heavy'
  }
}

/**
 * Emit a `<barline location="left">` block when the measure has any
 * left-edge structure: a non-default startBarline glyph, a volta
 * start, or both. When neither applies, the function emits nothing.
 *
 * Order of `<barline>` children: `<bar-style>` → `<repeat>` →
 * `<ending>` (per MusicXML 4.0 content model).
 */
function emitLeftBarline(
  lines: string[],
  startBarline: Barline | undefined,
  voltaStart: Volta | undefined,
  hasForwardRepeat: boolean,
): void {
  const barStyle = barlineToBarStyle(startBarline, 'left')
  if (barStyle === undefined && !hasForwardRepeat && !voltaStart) return
  lines.push('      <barline location="left">')
  if (barStyle !== undefined) {
    lines.push(`        <bar-style>${barStyle}</bar-style>`)
  }
  if (hasForwardRepeat) {
    lines.push('        <repeat direction="forward"/>')
  }
  if (voltaStart) {
    const endingNumber = voltaStart.endings.join(',')
    const text = voltaStart.text ? ` text="${escapeXml(voltaStart.text)}"` : ''
    lines.push(`        <ending number="${endingNumber}" type="start"${text}/>`)
  }
  lines.push('      </barline>')
}

/**
 * Emit a `<barline location="right">` block when the measure has any
 * right-edge structure: a non-default endBarline glyph, a volta
 * stop, or both. When neither applies, the function emits nothing.
 *
 * Volta endHook: 'closed' (default) → type="stop" (line drops down
 * at the right); 'open' → type="discontinue" (line continues without
 * hook into the next ending).
 */
function emitRightBarline(
  lines: string[],
  endBarline: Barline | undefined,
  voltaEnd: Volta | undefined,
  hasBackwardRepeat: boolean,
): void {
  const barStyle = barlineToBarStyle(endBarline, 'right')
  if (barStyle === undefined && !hasBackwardRepeat && !voltaEnd) return
  lines.push('      <barline location="right">')
  if (barStyle !== undefined) {
    lines.push(`        <bar-style>${barStyle}</bar-style>`)
  }
  if (voltaEnd) {
    const endingNumber = voltaEnd.endings.join(',')
    const endingType = voltaEnd.endHook === 'open' ? 'discontinue' : 'stop'
    lines.push(`        <ending number="${endingNumber}" type="${endingType}"/>`)
  }
  if (hasBackwardRepeat) {
    lines.push('        <repeat direction="backward"/>')
  }
  lines.push('      </barline>')
}

/**
 * Emit `<direction>` blocks containing `<segno/>` and `<coda/>`
 * glyphs at this measure-position. Both glyph elements live inside
 * a `<direction-type>` and are emitted as engraver "jump-target"
 * markers — paired with a D.S. or al-Coda direction for playback.
 */
function emitSegnoCodaDirections(
  lines: string[],
  segnoMarkers: SegnoMarker[] | undefined,
  codaMarkers: CodaMarker[] | undefined,
): void {
  // Carry the marker's id into the MusicXML `<segno id=...>` and
  // matching `<sound segno=...>` so multi-segno scores (Brahms,
  // Sousa) round-trip with each D.S. pointing at its target. ID
  // format: `segno_${markerId}`. nanoid (MarkerIdSchema, 8-16 chars
  // A-Za-z0-9_-) is already xs:NMTOKEN-safe, so no escaping needed.
  if (segnoMarkers) {
    for (const s of segnoMarkers) {
      const refId = segnoRefId(s.id)
      lines.push('      <direction placement="above">')
      lines.push('        <direction-type>')
      lines.push(`          <segno id="${refId}"/>`)
      lines.push('        </direction-type>')
      lines.push(`        <sound segno="${refId}"/>`)
      lines.push('      </direction>')
    }
  }
  if (codaMarkers) {
    for (const c of codaMarkers) {
      const refId = codaRefId(c.id)
      lines.push('      <direction placement="above">')
      lines.push('        <direction-type>')
      lines.push(`          <coda id="${refId}"/>`)
      lines.push('        </direction-type>')
      lines.push(`        <sound coda="${refId}"/>`)
      lines.push('      </direction>')
    }
  }
}

/**
 * Normalize a SegnoMarker.id into the MusicXML identifier we emit
 * on both the `<segno>` glyph and the matching `<sound segno=>`
 * attribute. Prefixing scopes the id so a same-string codaMarker.id
 * couldn't collide with a segno reference.
 */
function segnoRefId(id: string): string {
  return `segno_${id}`
}

function codaRefId(id: string): string {
  return `coda_${id}`
}

/**
 * Emit a `<direction>` block for a jump marker (D.C., D.S., To Coda,
 * Fine). Combines a `<words>` engraver label with a `<sound>`
 * playback semantic (dacapo/dalsegno/tocoda/fine).
 *
 * The JumpKind enum's textual values map directly to engraver
 * conventions ("D.C.", "D.S. al Coda" etc.). For Fine, the words
 * are a literal "Fine" + `<sound fine="yes"/>`.
 */
function emitJumpMarkerDirection(lines: string[], jump: JumpMarker): void {
  const text = jumpKindText(jump.kind)
  const soundAttr = jumpKindSoundAttr(jump)
  lines.push('      <direction placement="above">')
  lines.push('        <direction-type>')
  lines.push(`          <words>${escapeXml(text)}</words>`)
  lines.push('        </direction-type>')
  if (soundAttr !== undefined) {
    lines.push(`        <sound ${soundAttr}/>`)
  }
  lines.push('      </direction>')
}

/** Engraver-text mapping for jump-marker kinds. The text becomes
 * the `<words>` payload visible at the marker position. */
function jumpKindText(kind: JumpKind): string {
  switch (kind) {
    case 'D.C.':
      return 'D.C.'
    case 'D.S.':
      return 'D.S.'
    case 'D.C. al Coda':
      return 'D.C. al Coda'
    case 'D.S. al Coda':
      return 'D.S. al Coda'
    case 'D.C. al Fine':
      return 'D.C. al Fine'
    case 'D.S. al Fine':
      return 'D.S. al Fine'
    case 'To Coda':
      return 'To Coda'
    case 'Fine':
      return 'Fine'
  }
}

/**
 * Map a jump-marker to the matching `<sound>` attribute that MusicXML
 * readers use to drive playback. For D.S.* / To Coda kinds, the
 * attribute value is the SegnoMarker / CodaMarker id (prefixed by
 * segnoRefId / codaRefId so it matches the emitted `<segno id=>` /
 * `<coda id=>` glyphs). When the jump marker has no segnoRef/codaRef
 * set, fall back to the literal "segno"/"coda" string — MuseScore's
 * default emit shape; readers handle it as the default jump target.
 */
function jumpKindSoundAttr(jump: JumpMarker): string | undefined {
  switch (jump.kind) {
    case 'D.C.':
    case 'D.C. al Coda':
    case 'D.C. al Fine':
      return 'dacapo="yes"'
    case 'D.S.':
    case 'D.S. al Coda':
    case 'D.S. al Fine': {
      const refId = jump.segnoRef !== undefined ? segnoRefId(jump.segnoRef) : 'segno'
      return `dalsegno="${refId}"`
    }
    case 'To Coda': {
      const refId = jump.codaRef !== undefined ? codaRefId(jump.codaRef) : 'coda'
      return `tocoda="${refId}"`
    }
    case 'Fine':
      return 'fine="yes"'
  }
}

/**
 * True when the pitch at index `i` in the previous event was tied
 * forward to this event (and was not laissez-vibrer). Mirrors the
 * tiedFlags computation in scoreToAbcWithMap: lv pitches DON'T emit
 * a tie glyph — their open-ended ring is its own annotation.
 *
 * Tie matching is by position (pitches[i] → pitches[i] in the next
 * event); the Score schema doesn't carry an explicit tie-target id,
 * and validateScore enforces step+octave match (with the
 * `enharmonicTie` flag as an escape hatch for pivot-modulation
 * respells). The export trusts those upstream invariants.
 */
function isTieStopAt(prevEvent: Event | undefined, i: number): boolean {
  if (!prevEvent) return false
  const prev = prevEvent.pitches[i]
  if (!prev || prev.step === 'rest') return false
  if (prev.lv) return false
  return isPitchTiedToNext(prev, prevEvent)
}

function emitPitch(lines: string[], pitch: Pitch): void {
  if (pitch.step === 'rest') return
  lines.push('        <pitch>')
  lines.push(`          <step>${pitch.step}</step>`)
  const alter = accidentalToAlter(pitch.accidental)
  if (alter !== 0) {
    lines.push(`          <alter>${alter}</alter>`)
  }
  lines.push(`          <octave>${pitch.octave}</octave>`)
  lines.push('        </pitch>')
}

// ── Tuplet / time-modification (M22-PR-I) ────────────────────────────

/**
 * Emit `<time-modification>` for a tuplet event. Sits between
 * `<accidental>` and `<staff>` per MusicXML 4.0 note content model.
 * actual = the tuplet value (3 / 5 / 6 / 7); normal = the count of
 * notes that would otherwise fit in the tuplet's space.
 */
function emitTimeModification(lines: string[], tuplet: Tuplet): void {
  const normal = tupletNormalCount(tuplet)
  lines.push('        <time-modification>')
  lines.push(`          <actual-notes>${tuplet}</actual-notes>`)
  lines.push(`          <normal-notes>${normal}</normal-notes>`)
  lines.push('        </time-modification>')
}

// ── Grace notes (M22-PR-I) ───────────────────────────────────────────

/**
 * Emit one grace moment (`<note>` with `<grace/>`) before the principal
 * note. Multi-pitch grace MOMENTS are a grace CHORD: the first pitch
 * emits `<grace/>` then `<pitch>`; subsequent pitches add `<chord/>`
 * after `<grace/>` to indicate they sound at the same grace moment.
 *
 * Grace notes carry NO `<duration>` element — they don't consume
 * timeline space. `slashed: true` → acciaccatura (`<grace slash="yes"/>`).
 *
 * Order within a grace `<note>`: `<grace/>` → `<chord/>` (if any) →
 * `<pitch>` → `<voice>` → `<type>` → `<accidental>` → `<staff>`. The
 * spec puts <grace/> before <chord/>; readers depend on it.
 */
function emitGraceNotes(
  lines: string[],
  grace: GraceNote,
  staffNumber: 1 | 2 | undefined,
  mxlVoice: number,
): void {
  const type = grace.duration === 'sixteenth' ? '16th' : grace.duration
  grace.pitches.forEach((pitch, i) => {
    if (pitch.step === 'rest') return // schema refuses rests in grace pitches
    lines.push('      <note>')
    if (grace.slashed === true) {
      lines.push('        <grace slash="yes"/>')
    } else {
      lines.push('        <grace/>')
    }
    if (i > 0) lines.push('        <chord/>')
    emitPitch(lines, pitch)
    lines.push(`        <voice>${mxlVoice}</voice>`)
    lines.push(`        <type>${type}</type>`)
    const accidentalName = pitchAccidentalToMusicXml(pitch.accidental)
    if (accidentalName) {
      lines.push(`        <accidental>${accidentalName}</accidental>`)
    }
    if (staffNumber !== undefined) lines.push(`        <staff>${staffNumber}</staff>`)
    lines.push('      </note>')
  })
}

// ── Chord symbols (M22-PR-H) ─────────────────────────────────────────

/**
 * Emit a `<harmony>` block for a chord symbol. Positioned BEFORE the
 * note it attaches to in the measure-children sequence, so MusicXML
 * readers paint the chord at the upcoming downbeat.
 *
 * Element shape:
 *   <harmony>
 *     <root> <root-step> <root-alter?> </root>
 *     <kind> (mapped from quality + seventh; falls back to 'other'
 *            for non-standard combinations)
 *     <bass>?  (slash-chord notation; only the 'note' bass type is
 *               emitted — 'chord' bass is polychord, not standard MX)
 *     <degree>* (one per extension / add / omit / alteration)
 *   </harmony>
 */
function emitChordSymbol(lines: string[], chord: ChordSymbol): void {
  lines.push('      <harmony>')
  // Root: split the NoteName into step + alter.
  const rootStep = chord.root[0]
  const rootAlter = chord.root.length > 1 ? (chord.root[1] === '#' ? 1 : -1) : 0
  lines.push('        <root>')
  lines.push(`          <root-step>${rootStep}</root-step>`)
  if (rootAlter !== 0) {
    lines.push(`          <root-alter>${rootAlter}</root-alter>`)
  }
  lines.push('        </root>')
  // Kind: combine quality + seventh into the MusicXML vocabulary.
  // Display text (when provided) overrides the engraver's default
  // formatting via the kind's `text` attribute.
  const kind = chordKindFor(chord.quality, chord.seventh)
  if (chord.display !== undefined) {
    lines.push(`        <kind text="${escapeXml(chord.display)}">${kind}</kind>`)
  } else {
    lines.push(`        <kind>${kind}</kind>`)
  }
  // Slash-chord bass: emit only for note-typed bass (polychord
  // bass.type='chord' is rare and MusicXML doesn't have a clean
  // representation; deferred).
  if (chord.bass && chord.bass.type === 'note') {
    const bassStep = chord.bass.value[0]
    const bassAlter =
      chord.bass.value.length > 1 ? (chord.bass.value[1] === '#' ? 1 : -1) : 0
    lines.push('        <bass>')
    lines.push(`          <bass-step>${bassStep}</bass-step>`)
    if (bassAlter !== 0) {
      lines.push(`          <bass-alter>${bassAlter}</bass-alter>`)
    }
    lines.push('        </bass>')
  }
  // Degrees: extensions (9/11/13), add (chord additions), omit
  // (subtractions), alterations (sharp/flat on existing intervals).
  if (chord.extensions) {
    for (const ext of chord.extensions) {
      lines.push('        <degree>')
      lines.push(`          <degree-value>${ext}</degree-value>`)
      lines.push('          <degree-alter>0</degree-alter>')
      lines.push('          <degree-type>add</degree-type>')
      lines.push('        </degree>')
    }
  }
  if (chord.add) {
    for (const a of chord.add) {
      lines.push('        <degree>')
      lines.push(`          <degree-value>${a}</degree-value>`)
      lines.push('          <degree-alter>0</degree-alter>')
      lines.push('          <degree-type>add</degree-type>')
      lines.push('        </degree>')
    }
  }
  if (chord.omit) {
    for (const o of chord.omit) {
      lines.push('        <degree>')
      lines.push(`          <degree-value>${o}</degree-value>`)
      lines.push('          <degree-alter>0</degree-alter>')
      lines.push('          <degree-type>subtract</degree-type>')
      lines.push('        </degree>')
    }
  }
  if (chord.alterations) {
    for (const alt of chord.alterations) {
      // Alteration strings look like 'b5', '#11', 'alt'. 'alt' is
      // jazz shorthand ("any alteration") — MusicXML doesn't model
      // it cleanly; emit as a degree with degree-value=5 and
      // type=alter (engraver text usually carries the visual).
      if (alt === 'alt') {
        lines.push('        <degree>')
        lines.push('          <degree-value>5</degree-value>')
        lines.push('          <degree-alter>0</degree-alter>')
        lines.push('          <degree-type>alter</degree-type>')
        lines.push('        </degree>')
        continue
      }
      const match = alt.match(/^([b#])?(\d+)$/)
      if (!match) continue
      const alter = match[1] === '#' ? 1 : match[1] === 'b' ? -1 : 0
      const degValue = Number(match[2])
      lines.push('        <degree>')
      lines.push(`          <degree-value>${degValue}</degree-value>`)
      lines.push(`          <degree-alter>${alter}</degree-alter>`)
      lines.push('          <degree-type>alter</degree-type>')
      lines.push('        </degree>')
    }
  }
  lines.push('      </harmony>')
}

/**
 * Map our (quality, seventh) combination to a MusicXML `<kind>`
 * vocabulary value. Standard cases get the canonical name; rare or
 * non-standard combinations fall through to 'other' (readers paint
 * a generic glyph, and the chord's `display` text — when provided —
 * carries the engraver-visible label via the kind's text attribute).
 */
function chordKindFor(
  quality: ChordSymbol['quality'],
  seventh: ChordSymbol['seventh'],
): string {
  if (quality === 'major' && seventh === 'none') return 'major'
  if (quality === 'major' && seventh === 'maj7') return 'major-seventh'
  if (quality === 'major' && seventh === 'dom7') return 'dominant'
  if (quality === 'minor' && seventh === 'none') return 'minor'
  if (quality === 'minor' && seventh === 'min7') return 'minor-seventh'
  if (quality === 'minor' && seventh === 'maj7') return 'major-minor'
  if (quality === 'minor' && seventh === 'halfdim7') return 'half-diminished'
  if (quality === 'diminished' && seventh === 'none') return 'diminished'
  if (quality === 'diminished' && seventh === 'dim7') return 'diminished-seventh'
  if (quality === 'diminished' && seventh === 'halfdim7') return 'half-diminished'
  if (quality === 'augmented' && seventh === 'none') return 'augmented'
  if (quality === 'augmented' && seventh === 'dom7') return 'augmented-seventh'
  if (quality === 'sus2' && seventh === 'none') return 'suspended-second'
  if (quality === 'sus4' && seventh === 'none') return 'suspended-fourth'
  if (quality === 'sus4' && seventh === 'dom7') return 'suspended-fourth'
  // Non-standard combinations: 'other' is the MusicXML escape hatch
  // for chord shapes that don't map to the canonical vocabulary.
  return 'other'
}

// ── Lyrics (M22-PR-H) ────────────────────────────────────────────────

/**
 * Emit `<lyric>` elements for each verse in an event's lyrics array.
 * Sits inside `<note>` AFTER `<notations>` per MusicXML 4.0 content
 * model. `<syllabic>` (begin/middle/end/single) is computed from the
 * current syllable's `hyphen` flag and the previous event's matching
 * verse syllable. `extender: true` adds an `<extend type="start"/>`
 * inside the same `<lyric>` so engravers render a melisma underscore.
 */
function emitLyrics(
  lines: string[],
  syllables: readonly LyricSyllable[],
  prevEvent: Event | undefined,
): void {
  for (const s of syllables) {
    const prevSyllable = prevEvent?.lyrics?.find((l) => l.verse === s.verse)
    const prevWasHyphenated = prevSyllable?.hyphen === true
    let syllabic: 'begin' | 'middle' | 'end' | 'single'
    if (s.hyphen) {
      // This syllable continues into the next event's syllable.
      // If the prev was also hyphenated, we're in the MIDDLE of a
      // multi-syllable word; otherwise this is the BEGIN.
      syllabic = prevWasHyphenated ? 'middle' : 'begin'
    } else {
      // This syllable does NOT continue. If the prev was hyphenated,
      // we're the END of the word; otherwise standalone (SINGLE).
      syllabic = prevWasHyphenated ? 'end' : 'single'
    }
    lines.push(`        <lyric number="${s.verse}">`)
    lines.push(`          <syllabic>${syllabic}</syllabic>`)
    lines.push(`          <text>${escapeXml(s.syllable)}</text>`)
    if (s.extender === true) {
      lines.push('          <extend type="start"/>')
    }
    lines.push('        </lyric>')
  }
}

// ── Enum / value tables ──────────────────────────────────────────────

/**
 * Subdivisions per quarter note. 8 covers every Duration enum value
 * (32nd through dotted-half) as a positive integer. Tuplets scale
 * this by an additional multiplier so 3/5/6/7-tuplet note durations
 * also stay integer — see computeDivisionsMultiplier.
 */
const DIVISIONS_BASE = 8

const DURATION_DIVISIONS: Record<Duration, number> = {
  '32nd': 1,
  sixteenth: 2,
  eighth: 4,
  quarter: 8,
  half: 16,
  whole: 32,
  'dotted-eighth': 6,
  'dotted-quarter': 12,
  'dotted-half': 24,
}

function durationToDivisions(d: Duration, multiplier: number = 1): number {
  return DURATION_DIVISIONS[d] * multiplier
}

/**
 * For a tuplet event, the duration written to `<duration>` is the
 * tuplet-adjusted value: `(base * normal) / actual`. With the
 * divisions multiplier set by computeDivisionsMultiplier, this is
 * always an integer.
 *
 * tupletNormalCount maps each Tuplet value to its "normal" count —
 * the count of notes that would fit in the tuplet's space if not
 * tupled. Convention: triplet (3) in time of 2, quintuplet (5) and
 * sextuplet (6) and septuplet (7) all in time of 4 (modern engraver
 * default; older sources sometimes use 6 for septuplets but 4 is
 * what MuseScore/Sibelius assume).
 */
function tupletAdjustedDivisions(
  d: Duration,
  tuplet: Tuplet | undefined,
  multiplier: number,
): number {
  const base = durationToDivisions(d, multiplier)
  if (tuplet === undefined) return base
  const normal = tupletNormalCount(tuplet)
  return (base * normal) / tuplet
}

function tupletNormalCount(t: Tuplet): number {
  switch (t) {
    case 3:
      return 2
    case 5:
    case 6:
    case 7:
      return 4
  }
}

/**
 * Scan the score for any tuplet events and compute the LCM-based
 * multiplier needed to keep every tuplet's adjusted duration as an
 * integer in MusicXML's `<duration>`. Without tuplets the multiplier
 * is 1 (preserves the historical divisions=8 emit shape).
 *
 *   - Triplet (3) or sextuplet (6): factor of 3
 *   - Quintuplet (5): factor of 5
 *   - Septuplet (7): factor of 7
 *
 * Mixed score with both 3- and 5-tuplets gets multiplier = 15;
 * with 3, 5, and 7 → 105. Real scores rarely combine more than
 * one tuplet kind.
 */
function computeDivisionsMultiplier(score: Score): number {
  let m = 1
  const visit = (events: readonly Event[]) => {
    for (const e of events) {
      const t = e.tuplet
      if (t === 3 || t === 6) m = lcm(m, 3)
      else if (t === 5) m = lcm(m, 5)
      else if (t === 7) m = lcm(m, 7)
    }
  }
  for (const measure of score.measures) visit(measure.events)
  for (const v of score.extraVoices ?? []) {
    for (const measure of v.measures) visit(measure.events)
  }
  if (score.secondStaff) {
    for (const measure of score.secondStaff.measures) visit(measure.events)
    for (const v of score.secondStaff.extraVoices ?? []) {
      for (const measure of v.measures) visit(measure.events)
    }
  }
  return m
}

function lcm(a: number, b: number): number {
  return (a * b) / gcd(a, b)
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

const DURATION_TYPE: Record<Duration, string> = {
  whole: 'whole',
  half: 'half',
  quarter: 'quarter',
  eighth: 'eighth',
  sixteenth: '16th',
  '32nd': '32nd',
  'dotted-half': 'half',
  'dotted-quarter': 'quarter',
  'dotted-eighth': 'eighth',
}

function durationToType(d: Duration): string {
  return DURATION_TYPE[d]
}

function isDottedDuration(d: Duration): boolean {
  return d === 'dotted-half' || d === 'dotted-quarter' || d === 'dotted-eighth'
}

const KEY_FIFTHS: Record<Key, { fifths: number; mode: 'major' | 'minor' }> = {
  // Sharp majors
  C: { fifths: 0, mode: 'major' },
  G: { fifths: 1, mode: 'major' },
  D: { fifths: 2, mode: 'major' },
  A: { fifths: 3, mode: 'major' },
  E: { fifths: 4, mode: 'major' },
  B: { fifths: 5, mode: 'major' },
  'F#': { fifths: 6, mode: 'major' },
  'C#': { fifths: 7, mode: 'major' },
  // Flat majors
  F: { fifths: -1, mode: 'major' },
  Bb: { fifths: -2, mode: 'major' },
  Eb: { fifths: -3, mode: 'major' },
  Ab: { fifths: -4, mode: 'major' },
  Db: { fifths: -5, mode: 'major' },
  Gb: { fifths: -6, mode: 'major' },
  Cb: { fifths: -7, mode: 'major' },
  // Sharp minors (relative to their parallel sharp majors → same fifths
  // count as the relative MAJOR, i.e. A minor shares C major's 0 fifths)
  Am: { fifths: 0, mode: 'minor' },
  Em: { fifths: 1, mode: 'minor' },
  Bm: { fifths: 2, mode: 'minor' },
  'F#m': { fifths: 3, mode: 'minor' },
  'C#m': { fifths: 4, mode: 'minor' },
  'G#m': { fifths: 5, mode: 'minor' },
  'D#m': { fifths: 6, mode: 'minor' },
  'A#m': { fifths: 7, mode: 'minor' },
  // Flat minors
  Dm: { fifths: -1, mode: 'minor' },
  Gm: { fifths: -2, mode: 'minor' },
  Cm: { fifths: -3, mode: 'minor' },
  Fm: { fifths: -4, mode: 'minor' },
  Bbm: { fifths: -5, mode: 'minor' },
  Ebm: { fifths: -6, mode: 'minor' },
  Abm: { fifths: -7, mode: 'minor' },
}

function keyToFifths(key: Key): { fifths: number; mode: 'major' | 'minor' } {
  return KEY_FIFTHS[key]
}

interface MusicXmlTime {
  beats: number
  beatType: number
  symbol?: 'common' | 'cut'
}

function meterToTime(meter: string): MusicXmlTime {
  if (meter === 'C') return { beats: 4, beatType: 4, symbol: 'common' }
  if (meter === 'C|') return { beats: 2, beatType: 2, symbol: 'cut' }
  const m = meter.match(/^(\d+)\/(\d+)$/)
  if (m) return { beats: Number(m[1]), beatType: Number(m[2]) }
  // MeterSchema's refine catches malformed values upstream; default to
  // 4/4 here only as a typecheck-friendly fallthrough.
  return { beats: 4, beatType: 4 }
}

function clefToSignLine(clef: Clef): { sign: string; line: number } {
  if (clef === 'bass') return { sign: 'F', line: 4 }
  return { sign: 'G', line: 2 }
}

function accidentalToAlter(a: Accidental | undefined): number {
  switch (a) {
    case 'sharp': return 1
    case 'flat': return -1
    case 'dblsharp': return 2
    case 'dblflat': return -2
    default: return 0
  }
}

/**
 * MusicXML <accidental> element shows the engraver's choice of
 * accidental glyph; it's redundant with <alter> but readers like
 * MuseScore use it to render the explicit accidental rather than
 * relying on key-signature inference. Emit only when the score
 * explicitly carries a non-default accidental on the pitch — 'natural'
 * triggers an explicit ♮ glyph (the user is asking for a cautionary or
 * the key signature would imply something else).
 */
function pitchAccidentalToMusicXml(a: Accidental | undefined): string | undefined {
  switch (a) {
    case 'sharp': return 'sharp'
    case 'flat': return 'flat'
    case 'natural': return 'natural'
    case 'dblsharp': return 'double-sharp'
    case 'dblflat': return 'flat-flat'
    default: return undefined
  }
}

// ── EngravingDefaults projection to <defaults> (M22-PR-J) ────────────

/**
 * Project the subset of score.engravingDefaults that has clean
 * MusicXML 4.0 equivalents into a `<defaults>` block. Fields that
 * only make sense per-element (rehearsalMarkStyle, editorialAccidental-
 * Brackets, tupletBracketStyle, courtesyTimeSignatures, etc.) stay on
 * those code paths and are NOT projected here. Fields without any
 * MusicXML representation (beamSlopeRule, dynamicsStyle, tempoTerms-
 * Language, etc.) are silently dropped — readers infer their own
 * styling.
 *
 * Currently projects:
 *   - `tempoTextFont` → `<word-font font-style font-weight>` (default
 *     font for `<words>` text — tempo, jump markers, accel/rit).
 *   - `lyricFontScale` (50..200%) → `<lyric-font font-size>` scaled
 *     around a 10pt engraving baseline (so 100 → 10pt, 150 → 15pt).
 *   - `slurThickness` (0.5..3) → `<appearance><line-width type="slur
 *     middle">` (in tenths of a staff space).
 *   - `tieThickness` (0.5..3) → `<appearance><line-width type="tie
 *     middle">`.
 *
 * MusicXML 4.0 forbids an empty `<defaults>`, and emitting a stub
 * block on every score would be noise — so if no projectable field
 * is set, the entire block is omitted.
 *
 * Content order inside `<defaults>` is strict per the DTD: scaling →
 * page-layout → system-layout → staff-layout → appearance → music-font
 * → word-font → lyric-font → lyric-language. We currently emit only
 * appearance → word-font → lyric-font.
 */
function emitDefaults(lines: string[], ed: EngravingDefaults | undefined): void {
  if (!ed) return

  const wordFontAttrs = tempoTextFontToWordFontAttrs(ed.tempoTextFont)
  const lyricFontAttrs = lyricFontScaleToLyricFontAttrs(ed.lyricFontScale)
  const lineWidths = collectAppearanceLineWidths(ed.slurThickness, ed.tieThickness)

  if (lineWidths.length === 0 && !wordFontAttrs && !lyricFontAttrs) return

  lines.push('  <defaults>')
  if (lineWidths.length > 0) {
    lines.push('    <appearance>')
    for (const lw of lineWidths) {
      lines.push(`      <line-width type="${lw.type}">${lw.value}</line-width>`)
    }
    lines.push('    </appearance>')
  }
  if (wordFontAttrs) {
    lines.push(`    <word-font ${wordFontAttrs}/>`)
  }
  if (lyricFontAttrs) {
    lines.push(`    <lyric-font ${lyricFontAttrs}/>`)
  }
  lines.push('  </defaults>')
}

/**
 * Map tempoTextFont to <word-font> attributes. 'plain-roman' has no
 * non-default styling — return undefined so the element is omitted
 * (rather than emitting a bare `<word-font/>` that says "use the
 * reader's defaults"; we already use the reader's defaults by omitting
 * the element). 'italic-roman' adds italics only, 'bold-roman' adds
 * weight only, 'italic-bold' adds both. font-family is intentionally
 * not set: the schema doesn't carry a family choice, and readers like
 * MuseScore have decent defaults for words text.
 */
function tempoTextFontToWordFontAttrs(
  font: EngravingDefaults['tempoTextFont'],
): string | undefined {
  if (font === undefined) return undefined
  const attrs: string[] = []
  if (font === 'italic-bold' || font === 'italic-roman') {
    attrs.push('font-style="italic"')
  }
  if (font === 'italic-bold' || font === 'bold-roman') {
    attrs.push('font-weight="bold"')
  }
  if (attrs.length === 0) return undefined
  return attrs.join(' ')
}

/**
 * Map lyricFontScale (50..200 percent) to <lyric-font font-size>.
 * 10pt is the conventional engraving baseline for lyric text — so
 * scale=100 → 10pt, scale=150 → 15pt, scale=200 → 20pt. Round to
 * the nearest integer; sub-point font sizes look ragged in readers.
 */
function lyricFontScaleToLyricFontAttrs(
  scale: number | undefined,
): string | undefined {
  if (scale === undefined) return undefined
  const fontSize = Math.round((scale / 100) * 10)
  return `font-size="${fontSize}"`
}

/**
 * Map slurThickness / tieThickness (0.5..3 staff-space units in the
 * schema) to MusicXML <line-width> values in tenths. 1 tenth = 1/10 of
 * a staff space — so the schema range maps directly to 5..30 tenths,
 * the conventional engraving range for slur/tie middle widths.
 *
 * Returned in DTD order: line-width entries within <appearance> may
 * appear in any order, but stable order keeps emit deterministic for
 * tests and diff inspection.
 */
function collectAppearanceLineWidths(
  slurThickness: number | undefined,
  tieThickness: number | undefined,
): Array<{ type: 'slur middle' | 'tie middle'; value: number }> {
  const out: Array<{ type: 'slur middle' | 'tie middle'; value: number }> = []
  if (slurThickness !== undefined) {
    out.push({ type: 'slur middle', value: Math.round(slurThickness * 10) })
  }
  if (tieThickness !== undefined) {
    out.push({ type: 'tie middle', value: Math.round(tieThickness * 10) })
  }
  return out
}

// ── XML escaping ─────────────────────────────────────────────────────

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c)
}

// ── Browser download (M22-PR-3) ─────────────────────────────────────

/**
 * Uncompressed MusicXML MIME type. The compressed `.mxl` variant uses
 * `application/vnd.recordare.musicxml`; that needs zipping and isn't
 * shipped here. MuseScore / Sibelius / Finale all accept the plain
 * type.
 */
const MUSICXML_MIME = 'application/vnd.recordare.musicxml+xml'

/**
 * Trigger a browser download of `score` serialized as MusicXML. Mirrors
 * the shape of `downloadPdf` (synthetic <a download> click + object-URL
 * cleanup in `finally`). Browser-only — touches document.
 */
export function downloadMusicXml(score: Score, filename = 'score.musicxml'): void {
  const xml = scoreToMusicXml(score)
  const blob = new Blob([xml], { type: MUSICXML_MIME })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } finally {
    URL.revokeObjectURL(url)
  }
}
