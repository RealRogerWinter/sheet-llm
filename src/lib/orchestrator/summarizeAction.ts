import type { Operation } from '@/lib/music/editOperations'
import { formatChordSymbol } from '@/lib/music/chordSymbols'
import type { Score } from '@/lib/music/types'
import type { Classification, OrchestratorResult, ScoreLevelOperation } from './types'

/**
 * Server-side, deterministic, single-line confirmation text for a
 * score-producing assistant turn. Used by `respondWithOrchestratorResult`
 * as the fallback when the model itself did not emit a pre-tool-use
 * `introText` block.
 *
 * No LLM cost: the string is derived entirely from structured info that
 * the handler already produced — `classification.score_level_ops` for
 * `edit_score_level`, `appliedOps` for `edit_intra_measure`, and the
 * resulting `Score`'s metadata for the compose/generate family.
 */
export function summarizeAction(result: OrchestratorResult): string {
  const kind = result.classification.kind
  if (kind === 'edit_score_level') {
    return summarizeScoreLevelOps(result.classification.score_level_ops ?? [])
  }
  if (kind === 'edit_intra_measure') {
    return summarizeAppliedOps(result.appliedOps ?? [])
  }
  if (kind === 'compose' || kind === 'generate_complex' || kind === 'generate_simple') {
    return summarizeNewScore(result.score, kind)
  }
  return summarizeFallback(result.score)
}

function summarizeScoreLevelOps(ops: ReadonlyArray<ScoreLevelOperation>): string {
  if (ops.length === 0) return 'Score updated'
  if (ops.length === 1) return describeScoreLevelOp(ops[0])
  if (ops.length === 2) {
    return `${describeScoreLevelOp(ops[0])}; ${decapitalize(describeScoreLevelOp(ops[1]))}`
  }
  return `Made ${ops.length} score-level changes`
}

function describeScoreLevelOp(op: ScoreLevelOperation): string {
  switch (op.kind) {
    case 'changeKey':
      return `Changed key to ${formatKey(op.key)}`
    case 'changeMeter':
      return `Changed meter to ${op.meter}`
    case 'changeTempo':
      return `Changed tempo to ♪ = ${op.tempo_bpm}`
    case 'changeTitle':
      return op.title ? `Changed title to “${op.title}”` : 'Changed title'
    case 'changeClef':
      return op.staffIdx === 1
        ? `Changed the second staff’s clef to ${op.clef}`
        : `Changed clef to ${op.clef}`
  }
}

function formatKey(key: string): string {
  // Keys come through as canonical strings like "C", "F#", "Bb", "A minor".
  // No format change needed — pass through verbatim.
  return key
}

interface OpBucket {
  insertMeasure: number
  deleteMeasure: number
  duplicateMeasure: number
  insertEvent: number
  deleteEvent: number
  reorderEvent: number
  changePitch: number
  changeDuration: number
  setAccidental: number
  setArticulation: number
  toggleTie: number
  addPitchToChord: number
  removePitchFromChord: number
  setEventPitches: number
  changeClef: number
  addStaff: number
  removeStaff: number
  scoreLevel: number
  other: number
}

function emptyBuckets(): OpBucket {
  return {
    insertMeasure: 0,
    deleteMeasure: 0,
    duplicateMeasure: 0,
    insertEvent: 0,
    deleteEvent: 0,
    reorderEvent: 0,
    changePitch: 0,
    changeDuration: 0,
    setAccidental: 0,
    setArticulation: 0,
    toggleTie: 0,
    addPitchToChord: 0,
    removePitchFromChord: 0,
    setEventPitches: 0,
    changeClef: 0,
    addStaff: 0,
    removeStaff: 0,
    scoreLevel: 0,
    other: 0,
  }
}

function bucketOps(ops: ReadonlyArray<Operation>): OpBucket {
  const b = emptyBuckets()
  for (const op of ops) {
    switch (op.kind) {
      case 'insertMeasureAfter':
        b.insertMeasure++
        break
      case 'deleteMeasure':
        b.deleteMeasure++
        break
      case 'duplicateMeasure':
        b.duplicateMeasure++
        break
      case 'insertEventAfter':
        b.insertEvent++
        break
      case 'deleteEvent':
        b.deleteEvent++
        break
      case 'reorderEvent':
        b.reorderEvent++
        break
      case 'changePitch':
        b.changePitch++
        break
      case 'changeDuration':
        b.changeDuration++
        break
      case 'setAccidental':
        b.setAccidental++
        break
      case 'setArticulation':
        b.setArticulation++
        break
      case 'toggleTie':
        b.toggleTie++
        break
      case 'addPitchToChord':
        b.addPitchToChord++
        break
      case 'removePitchFromChord':
        b.removePitchFromChord++
        break
      case 'setEventPitches':
        b.setEventPitches++
        break
      case 'changeClef':
        b.changeClef++
        break
      case 'addStaff':
        b.addStaff++
        break
      case 'removeStaff':
        b.removeStaff++
        break
      case 'changeKey':
      case 'changeMeter':
      case 'changeTempo':
      case 'changeTitle':
        b.scoreLevel++
        break
      default:
        b.other++
    }
  }
  return b
}

function summarizeAppliedOps(ops: ReadonlyArray<Operation>): string {
  if (ops.length === 0) return 'Score updated'
  const b = bucketOps(ops)

  // Single-op fast paths produce more natural phrasing than the
  // bucket-aggregate form.
  if (ops.length === 1) return describeSingleEditOp(ops[0])

  // Structural changes (whole measures added/removed) read better as
  // a measure count than as an op count.
  const measureDelta = b.insertMeasure + b.duplicateMeasure - b.deleteMeasure
  if (
    measureDelta !== 0 &&
    b.changePitch === 0 &&
    b.changeDuration === 0 &&
    b.setAccidental === 0 &&
    b.setArticulation === 0 &&
    b.toggleTie === 0 &&
    b.insertEvent === 0 &&
    b.deleteEvent === 0 &&
    b.reorderEvent === 0 &&
    b.addPitchToChord === 0 &&
    b.removePitchFromChord === 0 &&
    b.setEventPitches === 0
  ) {
    if (measureDelta > 0) {
      return `Added ${measureDelta} ${measureDelta === 1 ? 'measure' : 'measures'}`
    }
    const removed = -measureDelta
    return `Removed ${removed} ${removed === 1 ? 'measure' : 'measures'}`
  }

  // Note-level aggregate: collapse the pitch/duration/accidental/etc. ops
  // into a single "notes" count. Insertions and deletions stay separate
  // since they're structurally different.
  const noteEdits =
    b.changePitch +
    b.changeDuration +
    b.setAccidental +
    b.setArticulation +
    b.toggleTie +
    b.addPitchToChord +
    b.removePitchFromChord +
    b.setEventPitches +
    b.reorderEvent
  if (noteEdits === ops.length) {
    return `Edited ${noteEdits} ${noteEdits === 1 ? 'note' : 'notes'}`
  }
  if (b.insertEvent === ops.length) {
    return `Inserted ${b.insertEvent} ${b.insertEvent === 1 ? 'note' : 'notes'}`
  }
  if (b.deleteEvent === ops.length) {
    return `Deleted ${b.deleteEvent} ${b.deleteEvent === 1 ? 'note' : 'notes'}`
  }
  return `Made ${ops.length} edits`
}

function describeSingleEditOp(op: Operation): string {
  switch (op.kind) {
    case 'changePitch':
      return 'Edited 1 note'
    case 'changeDuration':
      return `Changed a note's duration to ${op.duration}`
    case 'setAccidental':
      return op.accidental === 'none' ? 'Cleared an accidental' : `Set an accidental (${op.accidental})`
    case 'setArticulation':
      return op.articulation === 'none' ? 'Cleared an articulation' : `Set an articulation (${op.articulation})`
    case 'toggleTie':
      return 'Toggled a tie'
    case 'deleteEvent':
      return 'Deleted a note'
    case 'insertEventAfter':
      return 'Inserted a note'
    case 'addPitchToChord':
      return 'Added a pitch to a chord'
    case 'removePitchFromChord':
      return 'Removed a pitch from a chord'
    case 'setEventPitches':
      return 'Replaced a note'
    case 'reorderEvent':
      return `Moved a note ${op.direction}`
    case 'insertMeasureAfter':
      return 'Inserted a measure'
    case 'deleteMeasure':
      return 'Deleted a measure'
    case 'duplicateMeasure':
      return 'Duplicated a measure'
    case 'changeClef':
      return `Changed clef to ${op.clef}`
    case 'addStaff':
      return 'Added a staff'
    case 'removeStaff':
      return 'Removed a staff'
    case 'addVoice':
      return 'Added a voice'
    case 'removeVoice':
      return 'Removed a voice'
    case 'changeKey':
      return `Changed key to ${formatKey(op.key)}`
    case 'changeMeter':
      return `Changed meter to ${op.meter}`
    case 'changeTempo':
      return `Changed tempo to ♪ = ${op.tempo_bpm}`
    case 'changeTitle':
      return op.title ? `Changed title to “${op.title}”` : 'Changed title'
    // Per-note markings (M2-PR-3) — concise phrasings that read naturally
    // when surfaced as a single-op confirmation.
    case 'setArticulations':
      return op.articulations.length === 0
        ? 'Cleared articulations'
        : `Set articulations (${op.articulations.join(', ')})`
    case 'setOrnament':
      return op.ornament === 'none' ? 'Cleared an ornament' : `Set an ornament (${op.ornament})`
    case 'setTrillUpperPitch':
      return op.trillUpperPitch === undefined
        ? 'Cleared trill upper pitch'
        : `Set trill upper pitch (${op.trillUpperPitch})`
    case 'setGraceNotes':
      return op.graceNotes.length === 0
        ? 'Cleared grace notes'
        : `Set ${op.graceNotes.length} grace note${op.graceNotes.length === 1 ? '' : 's'}`
    case 'setDynamic':
      return op.dynamic === 'none' ? 'Cleared a dynamic' : `Set a dynamic (${op.dynamic})`
    case 'setDynamicStructured':
      return op.dynamic_structured === undefined
        ? 'Cleared a compound dynamic'
        : `Set a compound dynamic (${op.dynamic_structured.base})`
    case 'setFermata':
      return op.fermata === undefined ? 'Cleared a fermata' : `Set a fermata (${op.fermata})`
    case 'setBarlineFermata':
      return op.barlineFermata === undefined
        ? 'Cleared a barline fermata'
        : `Set a barline fermata (${op.barlineFermata})`
    case 'setStartBarline':
      return op.barline === undefined
        ? `Cleared start barline (m${op.measureIdx + 1})`
        : `Set start barline (m${op.measureIdx + 1}: ${op.barline})`
    case 'setEndBarline':
      return op.barline === undefined
        ? `Cleared end barline (m${op.measureIdx + 1})`
        : `Set end barline (m${op.measureIdx + 1}: ${op.barline})`
    case 'setPickup':
      return op.isPickup
        ? `Marked m${op.measureIdx + 1} as pickup (anacrusis)`
        : `Unmarked m${op.measureIdx + 1} pickup flag`
    case 'setFinalPartial':
      return op.isFinalPartial
        ? `Marked m${op.measureIdx + 1} as final-partial measure`
        : `Unmarked m${op.measureIdx + 1} final-partial flag`
    case 'setBreathMark':
      return op.breathMark ? 'Set a breath mark' : 'Cleared a breath mark'
    case 'setCaesura':
      return op.caesura ? 'Set a caesura' : 'Cleared a caesura'
    case 'setTremolo':
      return op.tremolo === undefined
        ? 'Cleared a tremolo'
        : `Set a tremolo (${op.tremolo.slashes} slash${op.tremolo.slashes === 1 ? '' : 'es'})`
    case 'setBowing':
      return op.bowing === undefined ? 'Cleared a bowing' : `Set bowing (${op.bowing})`
    case 'setJazzInflection':
      return op.jazzInflection === undefined
        ? 'Cleared a jazz inflection'
        : `Set a jazz inflection (${op.jazzInflection})`
    case 'setChordSymbol': {
      if (op.chordSymbol === undefined) return 'Cleared a chord symbol'
      // Use the formatter's canonical string for the phrasing —
      // normalized whatever the user typed (e.g. "cmaj 7" → "Cmaj7").
      // Falls back to root alone if the formatter throws on a
      // malformed shape (defensive — Zod normally rejects upstream).
      try {
        return `Set chord symbol (${formatChordSymbol(op.chordSymbol)})`
      } catch {
        return `Set chord symbol (${op.chordSymbol.root})`
      }
    }
    case 'setPitchTie':
      return op.tied_to_next ? 'Tied a pitch' : 'Untied a pitch'
    case 'setLv':
      return op.lv ? 'Set laissez vibrer' : 'Cleared laissez vibrer'
    case 'setEnharmonicTie':
      return op.enharmonicTie ? 'Set enharmonic tie' : 'Cleared enharmonic tie'
    case 'insertTechniqueChange':
      return `Added a ${op.techniqueChange.kind} marker`
    case 'removeTechniqueChange':
      return 'Removed a technique marker'
    case 'setFingering':
      return `Set a fingering (${op.fingering.system})`
    case 'removeFingering':
      return 'Cleared a fingering'
    case 'setLyric':
      // JSON.stringify gives us safe quoting + escape for any user-
      // typed syllable that ends up in server logs / activity panel
      // / clipboard copies. React's JSX path also escapes, but the
      // raw summary string flows through other surfaces too.
      return `Set lyric v${op.verse}: ${JSON.stringify(op.syllable)}`
    case 'removeLyric':
      return `Removed lyric v${op.verse}`
    case 'clearLyrics':
      return 'Cleared lyrics'
    case 'insertAnnotation':
      return op.annotation.style === 'rehearsal-mark'
        ? `Added a rehearsal mark "${op.annotation.text}"`
        : op.annotation.style === 'tempo-text'
          ? `Added tempo text "${op.annotation.text}"`
          : `Added an annotation "${op.annotation.text}"`
    case 'removeAnnotation':
      return 'Removed an annotation'
    case 'updateAnnotation':
      return 'Updated an annotation'
    case 'setScoreMetadata': {
      // Iterate the canonical static field order so the summary is
      // deterministic across runs — Object.entries is insertion-order
      // and a {composer, title} patch would summarize differently
      // than {title, composer} otherwise.
      const FIELDS = ['title', 'composer', 'arranger', 'lyricist', 'copyright'] as const
      const set = FIELDS.filter((f) => op.patch[f] !== undefined)
      if (set.length === 0) return 'Score metadata (no-op)'
      if (set.length === 1) return `Set score ${set[0]}`
      return `Set score metadata (${set.join(', ')})`
    }
    case 'insertMarker': {
      const m = op.marker
      // Tempo changes are the common case; meter / key follow; metric
      // modulation has its own phrasing. Combined tempo (bpm + text)
      // collapses to one phrase.
      if (m.tempo_bpm !== undefined && m.tempo_text !== undefined) {
        return `Added tempo "${m.tempo_text}" (${m.tempo_bpm} bpm)`
      }
      if (m.tempo_text !== undefined) return `Added tempo text "${m.tempo_text}"`
      if (m.tempo_bpm !== undefined) return `Added tempo ${m.tempo_bpm} bpm`
      if (m.metricModulation !== undefined) {
        return `Added metric modulation (${m.metricModulation.fromNote} = ${m.metricModulation.toNote})`
      }
      if (m.meter !== undefined) return `Added meter change to ${m.meter}`
      if (m.key !== undefined) return `Added key change to ${m.key}`
      if (m.clefs !== undefined && m.clefs.length > 0) return 'Added mid-piece clef change'
      return 'Added a marker'
    }
    case 'removeMarker':
      return 'Removed a marker'
    case 'updateMarker':
      return 'Updated a marker'
    case 'insertVolta': {
      const v = op.volta
      return `Added volta (endings ${v.endings.join(',')}, m${v.startMeasureIdx + 1}-m${v.endMeasureIdx + 1})`
    }
    case 'removeVolta':
      return 'Removed a volta'
    case 'updateVolta':
      return 'Updated a volta'
    case 'insertJumpMarker': {
      const j = op.jumpMarker
      return `Added ${j.kind} (m${j.measureIdx + 1})`
    }
    case 'removeJumpMarker':
      return 'Removed a jump marker'
    case 'updateJumpMarker':
      return 'Updated a jump marker'
    case 'insertHairpin': {
      const h = op.hairpin
      const word = h.kind === 'hairpin-cresc' ? 'crescendo' : 'diminuendo'
      if (h.startDynamic !== undefined && h.endDynamic !== undefined) {
        const arrow = h.kind === 'hairpin-cresc' ? '<' : '>'
        return `Added ${word} (${h.startDynamic}${arrow}${h.endDynamic})`
      }
      return `Added a ${word}`
    }
    case 'removeHairpin':
      return 'Removed a hairpin'
    case 'updateHairpin':
      return 'Updated a hairpin'
    case 'insertSlur': {
      const sl = op.slur
      return sl.kind === 'phrase-slur' ? 'Added a phrase slur' : 'Added a slur'
    }
    case 'removeSlur':
      return 'Removed a slur'
    case 'updateSlur':
      return 'Updated a slur'
    case 'insertTempoSpan': {
      const t = op.tempoSpan
      const word = t.kind === 'accel' ? 'accelerando' : 'ritardando'
      if (t.endTempoBpm !== undefined) {
        return `Added ${word} (→ ♩=${t.endTempoBpm})`
      }
      return `Added a ${word}`
    }
    case 'removeTempoSpan':
      return 'Removed a tempo span'
    case 'updateTempoSpan':
      return 'Updated a tempo span'
    case 'insertOctaveSpan':
      // Italian abbreviation (8va / 8vb / 15ma / 15mb) is the
      // publisher-grade label; emit as-is.
      return `Added ${op.octaveSpan.kind}`
    case 'removeOctaveSpan':
      return 'Removed an octave span'
    case 'updateOctaveSpan':
      return 'Updated an octave span'
    case 'insertGlissando':
      return 'Added a glissando'
    case 'removeGlissando':
      return 'Removed a glissando'
    case 'updateGlissando':
      return 'Updated a glissando'
    case 'insertTrillLine':
      return 'Added a trill line'
    case 'removeTrillLine':
      return 'Removed a trill line'
    case 'updateTrillLine':
      return 'Updated a trill line'
    case 'insertTremoloBetween':
      return 'Added a tremolo between two notes'
    case 'removeTremoloBetween':
      return 'Removed a between-note tremolo'
    case 'updateTremoloBetween':
      return 'Updated a between-note tremolo'
    // ─── Structural multi-measure ops (M3.5-PR-3) ─────────────────────
    case 'appendMeasures':
      return `Added ${op.measures.length} ${op.measures.length === 1 ? 'bar' : 'bars'}`
    case 'insertMeasuresAfter':
      return `Inserted ${op.measures.length} ${op.measures.length === 1 ? 'bar' : 'bars'}`
    case 'regionReplace': {
      const replacedLen = op.endMeasureIdx - op.startMeasureIdx + 1
      return `Replaced ${replacedLen} ${replacedLen === 1 ? 'bar' : 'bars'} with ${op.measures.length}`
    }
    case 'dragMeasureRange': {
      const rangeLen = op.fromEnd - op.fromStart + 1
      const barsWord = rangeLen === 1 ? 'bar' : 'bars'
      // Display 1-indexed labels for the user-facing summary
      // (toolbar / undo history rows).
      const rangeLabel =
        rangeLen === 1
          ? `bar ${op.fromStart + 1}`
          : `bars ${op.fromStart + 1}-${op.fromEnd + 1}`
      if (op.mode === 'delete') {
        return `Deleted ${rangeLen} ${barsWord} (${rangeLabel})`
      }
      if (op.mode === 'duplicate') {
        // Duplicate insertion lands AFTER toAfter — first copy bar
        // sits at toAfter+1 (0-indexed) → +1 again for the user-facing
        // 1-indexed label.
        return `Duplicated ${rangeLen} ${barsWord} (${rangeLabel}) at bar ${op.toAfter + 2}`
      }
      // mode === 'move' — destination indexed as the new measure
      // position the first moved bar lands on, 1-indexed.
      const destStart = (op.toAfter > op.fromEnd ? op.toAfter - rangeLen : op.toAfter) + 1
      return `Moved ${rangeLen} ${barsWord} (${rangeLabel}) to bar ${destStart + 1}`
    }
  }
}

function summarizeNewScore(score: Score, kind: Classification['kind']): string {
  const title = score.title?.trim()
  const bars = score.measures.length
  const key = score.key
  const verb = kind === 'compose' ? 'Composed' : 'Generated'
  if (title) {
    return `${verb} “${title}” — ${bars} ${bars === 1 ? 'bar' : 'bars'} in ${key}`
  }
  return `${verb} ${bars} ${bars === 1 ? 'bar' : 'bars'} in ${key}`
}

function summarizeFallback(score: Score): string {
  const title = score.title?.trim()
  return title ? `Updated “${title}”` : 'Score updated'
}

function decapitalize(s: string): string {
  if (s.length === 0) return s
  return s.charAt(0).toLowerCase() + s.slice(1)
}
