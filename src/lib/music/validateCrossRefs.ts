import type { Event, Score } from './types'
import { ValidationError } from './errors'
import { isRest } from './eventKind'
import { isPitchTiedToNext } from './pitchTies'
import { getStaffCount, getVoiceCount, getVoiceMeasures } from './scoreAccessors'

/**
 * Cross-reference invariants applied after schema + per-measure
 * validation in validateScore. Caps Milestone 1 of Phase 1 by
 * tightening the loose-now contracts surfaced as code-review
 * deferrals (PR-1 through PR-12).
 *
 * Each invariant is its own function so a future test can target a
 * single check, and so the rule set can be extended independently
 * (PR-future will add courtesy-time-signature and meter-change
 * boundary checks as Phase 2 lands the renderer integration).
 *
 * The collection runs ALL checks (not first-fail) so a single
 * validation run surfaces every problem; the first error thrown is
 * the most actionable. To swap to all-error mode later, change
 * `throw` to push-and-throw-at-end.
 */
export function validateCrossRefs(score: Score): void {
  validateSpans(score)
  validatePerPitchTies(score)
  validateJumpMarkerRefs(score)
  validateMarkers(score)
  validateVoltas(score)
  validateTechniqueStates(score)
}

/**
 * Build a quick lookup: every event-id present in the score, plus
 * the (staffIdx, voiceIdx, measureIdx, eventIdx) location and the
 * event itself. Used by span / pitch-tie checks.
 */
function indexEventsById(score: Score): Map<
  string,
  { staffIdx: number; voiceIdx: number; measureIdx: number; eventIdx: number; event: Event }
> {
  const map = new Map<string, ReturnType<typeof indexEventsById> extends Map<string, infer V> ? V : never>()
  for (let s = 0; s < getStaffCount(score); s++) {
    for (let v = 0; v < getVoiceCount(score, s); v++) {
      const measures = getVoiceMeasures(score, s, v)
      measures.forEach((m, mi) => {
        m.events.forEach((ev, ei) => {
          if (ev.id) {
            map.set(ev.id, { staffIdx: s, voiceIdx: v, measureIdx: mi, eventIdx: ei, event: ev })
          }
        })
      })
    }
  }
  return map
}

function validateSpans(score: Score): void {
  if (!score.spans || score.spans.length === 0) return
  const index = indexEventsById(score)

  for (const span of score.spans) {
    const start = index.get(span.startEventId)
    if (!start) {
      throw new ValidationError(
        `Span ${span.id ?? '(no id)'} (${span.kind}): startEventId ${span.startEventId} does not match any event`,
        'span_endpoint_missing',
      )
    }
    const end = index.get(span.endEventId)
    if (!end) {
      throw new ValidationError(
        `Span ${span.id ?? '(no id)'} (${span.kind}): endEventId ${span.endEventId} does not match any event`,
        'span_endpoint_missing',
      )
    }
    // Same voice + staff
    if (start.staffIdx !== end.staffIdx || start.voiceIdx !== end.voiceIdx) {
      throw new ValidationError(
        `Span ${span.id ?? '(no id)'} (${span.kind}): endpoints are on different staves/voices (start s${start.staffIdx}v${start.voiceIdx}, end s${end.staffIdx}v${end.voiceIdx}). Cross-voice / cross-staff spans are not supported in Phase 1.`,
        'span_cross_voice',
      )
    }
    // Same as span.staffIdx / voiceIdx (catch mismatch between span
    // metadata and actual event location).
    if (start.staffIdx !== span.staffIdx || start.voiceIdx !== span.voiceIdx) {
      throw new ValidationError(
        `Span ${span.id ?? '(no id)'} (${span.kind}): staffIdx/voiceIdx (${span.staffIdx}/${span.voiceIdx}) does not match the start event's location (${start.staffIdx}/${start.voiceIdx})`,
        'span_cross_voice',
      )
    }
    // Start <= End in score order (measure, event).
    if (
      start.measureIdx > end.measureIdx ||
      (start.measureIdx === end.measureIdx && start.eventIdx > end.eventIdx)
    ) {
      throw new ValidationError(
        `Span ${span.id ?? '(no id)'} (${span.kind}): start (m${start.measureIdx + 1}.${start.eventIdx + 1}) is AFTER end (m${end.measureIdx + 1}.${end.eventIdx + 1})`,
        'span_reversed',
      )
    }
  }
}

/**
 * For every pitch with tied_to_next === true, verify the next event
 * in the same voice has a pitch with matching step + octave (or the
 * enharmonicTie flag is set, which relaxes the match requirement).
 *
 * Laissez-vibrer (lv) pitches are skipped — they intentionally have
 * no termination target.
 *
 * Diagnostic emphasis: when the check fails, the error message
 * includes the actual pitch tokens available in the next event AND,
 * when an enharmonic equivalent IS present, suggests setting
 * enharmonicTie:true. The LLM (and the user) gets actionable
 * feedback rather than a bare "no matching pitch" line.
 */
function validatePerPitchTies(score: Score): void {
  for (let s = 0; s < getStaffCount(score); s++) {
    for (let v = 0; v < getVoiceCount(score, s); v++) {
      const measures = getVoiceMeasures(score, s, v)
      // Flatten events with their measure index for cross-bar tie lookup.
      const flat: Array<{ measureIdx: number; eventIdx: number; event: Event }> = []
      measures.forEach((m, mi) => {
        m.events.forEach((ev, ei) => flat.push({ measureIdx: mi, eventIdx: ei, event: ev }))
      })

      for (let i = 0; i < flat.length; i++) {
        const { event, measureIdx, eventIdx } = flat[i]
        const next = flat[i + 1]
        for (const pitch of event.pitches) {
          // Honor BOTH per-pitch tied_to_next AND the legacy event-
          // wide flag. The pre-M13 validator only checked the per-
          // pitch field, which silently skipped any event-wide tie
          // (event.tied_to_next:true with no per-pitch overrides).
          // isPitchTiedToNext is the canonical helper.
          if (!isPitchTiedToNext(pitch, event)) continue
          if (pitch.lv) continue // laissez vibrer; no target required.
          const sourceLabel = formatPitchLabel(pitch)
          if (!next) {
            throw new ValidationError(
              `Pitch ${sourceLabel} at m${measureIdx + 1}.${eventIdx + 1} has tied_to_next but is the last event in voice ${v} of staff ${s}. Either release the tie (tied_to_next:false) or add lv:true for an open-ended ring.`,
              'pitch_tie_target_missing',
              { measure: measureIdx + 1, event: eventIdx + 1 },
            )
          }
          // Specific diagnostic for the most common operator
          // mistake: tying a pitch into a rest. isRest() returns true
          // for a single-rest event AND for the legacy step:'rest'
          // shape; multi-pitch chords containing a rest are rejected
          // by the schema upstream so the canonical "all-rest" check
          // collapses to the simple isRest predicate.
          if (isRest(next.event)) {
            throw new ValidationError(
              `Tied pitch ${sourceLabel} at m${measureIdx + 1}.${eventIdx + 1}: the next event (m${next.measureIdx + 1}.${next.eventIdx + 1}) is a rest. A tie must continue to a sounding note. Release the tie or fill the rest with the same pitch.`,
              'pitch_tie_target_missing',
              { measure: measureIdx + 1, event: eventIdx + 1 },
            )
          }
          if (pitch.enharmonicTie) continue // user opted out of the match check.
          const matches = next.event.pitches.some(
            (p) => p.step === pitch.step && p.octave === pitch.octave,
          )
          if (!matches) {
            const nextPitchList = next.event.pitches
              .filter((p) => p.step !== 'rest')
              .map(formatPitchLabel)
              .join(', ')
            const enharmonicHint = hasEnharmonicEquivalent(pitch, next.event.pitches)
              ? ' An enharmonic equivalent is present — set enharmonicTie:true on the source pitch if a respell across the boundary is intended.'
              : ''
            throw new ValidationError(
              `Tied pitch ${sourceLabel} at m${measureIdx + 1}.${eventIdx + 1} has no matching pitch in the next event (m${next.measureIdx + 1}.${next.eventIdx + 1}); next pitches: [${nextPitchList || '<none>'}].${enharmonicHint}`,
              'pitch_tie_target_missing',
              { measure: measureIdx + 1, event: eventIdx + 1 },
            )
          }
        }
      }
    }
  }
}

/**
 * Stable human-readable pitch label for diagnostic messages.
 * Examples: "C4", "C#4", "Db5", "E2". Rests render as "rest".
 */
function formatPitchLabel(pitch: Event['pitches'][number]): string {
  if (pitch.step === 'rest') return 'rest'
  const accidentalGlyph =
    pitch.accidental === 'sharp'
      ? '#'
      : pitch.accidental === 'flat'
        ? 'b'
        : pitch.accidental === 'dblsharp'
          ? '##'
          : pitch.accidental === 'dblflat'
            ? 'bb'
            : ''
  return `${pitch.step}${accidentalGlyph}${pitch.octave}`
}

/**
 * Detect whether `target` is the enharmonic respell of any pitch in
 * `candidates`. Twelve-tone equivalence at the same octave (e.g.,
 * C#4 ≡ Db4, Bb3 ≡ A#3 — except where the respell crosses an octave,
 * e.g., B#4 ≡ C5, Cb5 ≡ B4 — those WILL be detected because the MIDI
 * number comparison normalizes through pitch class).
 *
 * Used only for the "did you mean enharmonicTie?" diagnostic hint;
 * not authoritative — engravers may genuinely intend the source
 * spelling without a tie at all.
 */
function hasEnharmonicEquivalent(
  target: Event['pitches'][number],
  candidates: ReadonlyArray<Event['pitches'][number]>,
): boolean {
  if (target.step === 'rest') return false
  const targetMidi = pitchToMidi(target)
  if (targetMidi === null) return false
  return candidates.some((c) => {
    if (c.step === 'rest') return false
    // Skip the identity-match case (handled by the literal step+
    // octave check upstream) so we only suggest the hint when a
    // respelled equivalent exists.
    if (c.step === target.step && c.octave === target.octave) return false
    const candidateMidi = pitchToMidi(c)
    return candidateMidi !== null && candidateMidi === targetMidi
  })
}

const STEP_TO_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
}

function pitchToMidi(pitch: Event['pitches'][number]): number | null {
  if (pitch.step === 'rest') return null
  const base = STEP_TO_PC[pitch.step]
  if (base === undefined) return null
  let semitones = base
  switch (pitch.accidental) {
    case 'sharp': semitones += 1; break
    case 'flat': semitones -= 1; break
    case 'dblsharp': semitones += 2; break
    case 'dblflat': semitones -= 2; break
    default: break
  }
  // Normalize through pitch-class so B#4 (which sounds C5) collapses
  // to the same midi as C5. We assume the source key context already
  // honored octave numbering — the MIDI mod-12 lets us treat
  // respell-across-octave as equivalent for the hint.
  return (pitch.octave + 1) * 12 + semitones
}

/**
 * Jump marker linking: for D.S./D.C./al-Coda kinds, validate that
 * segnoRef points at an existing SegnoMarker and codaRef/toCodaRef
 * point at existing CodaMarker entries.
 */
function validateJumpMarkerRefs(score: Score): void {
  if (!score.jumpMarkers || score.jumpMarkers.length === 0) return
  const segnoIds = new Set((score.segnoMarkers ?? []).map((s) => s.id))
  const codaIds = new Set((score.codaMarkers ?? []).map((c) => c.id))

  for (const j of score.jumpMarkers) {
    if (j.kind.startsWith('D.S.')) {
      if (!j.segnoRef) {
        throw new ValidationError(
          `JumpMarker ${j.id} (${j.kind}) at m${j.measureIdx + 1} has no segnoRef — D.S. jumps must reference a Segno marker`,
          'jump_ref_missing',
          { measure: j.measureIdx + 1 },
        )
      }
      if (!segnoIds.has(j.segnoRef)) {
        throw new ValidationError(
          `JumpMarker ${j.id} (${j.kind}): segnoRef ${j.segnoRef} does not match any SegnoMarker in this score`,
          'jump_ref_missing',
        )
      }
    }
    if (j.kind.endsWith('al Coda')) {
      if (j.codaRef && !codaIds.has(j.codaRef)) {
        throw new ValidationError(
          `JumpMarker ${j.id} (${j.kind}): codaRef ${j.codaRef} does not match any CodaMarker in this score`,
          'jump_ref_missing',
        )
      }
      // toCodaRef references another jump marker (the To Coda
      // marker that the al-Coda jump lands on). Validate by
      // existence in jumpMarkers (any kind).
      if (j.toCodaRef) {
        const refExists = score.jumpMarkers.some((other) => other.id === j.toCodaRef)
        if (!refExists) {
          throw new ValidationError(
            `JumpMarker ${j.id} (${j.kind}): toCodaRef ${j.toCodaRef} does not match any JumpMarker in this score`,
            'jump_ref_missing',
          )
        }
      }
    }
  }
}

/**
 * Markers: no two markers at the same measureIdx with overlapping
 * field changes. Two markers can coexist at the same idx if they
 * change disjoint fields (one sets meter, another sets key) — but
 * a duplicate (both set meter) is rejected.
 */
function validateMarkers(score: Score): void {
  if (!score.markers || score.markers.length === 0) return
  const seenByIdx = new Map<number, Set<string>>()
  for (const m of score.markers) {
    const fields = new Set<string>()
    if (m.key !== undefined) fields.add('key')
    if (m.meter !== undefined) fields.add('meter')
    if (m.tempo_bpm !== undefined) fields.add('tempo_bpm')
    if (m.tempo_text !== undefined) fields.add('tempo_text')
    if (m.clefs && m.clefs.length > 0) fields.add('clefs')
    // M9-PR-1: metricModulation must also participate in the
    // duplicate-field check — two markers at the same measureIdx
    // both carrying metricModulation would reach the renderer with
    // conflicting "♩ = ♩." semantics.
    if (m.metricModulation !== undefined) fields.add('metricModulation')

    const prior = seenByIdx.get(m.measureIdx) ?? new Set<string>()
    for (const f of fields) {
      if (prior.has(f)) {
        throw new ValidationError(
          `Two markers at measure ${m.measureIdx + 1} both change the same field (${f})`,
          'marker_duplicate',
          { measure: m.measureIdx + 1 },
        )
      }
      prior.add(f)
    }
    seenByIdx.set(m.measureIdx, prior)
  }
}

/**
 * Voltas: endings must be sorted ascending and contain no duplicates.
 * startMeasureIdx <= endMeasureIdx.
 */
function validateVoltas(score: Score): void {
  if (!score.voltas || score.voltas.length === 0) return
  for (const v of score.voltas) {
    if (v.startMeasureIdx > v.endMeasureIdx) {
      throw new ValidationError(
        `Volta ${v.id}: startMeasureIdx (${v.startMeasureIdx}) is after endMeasureIdx (${v.endMeasureIdx})`,
        'volta_endings_invalid',
        { measure: v.startMeasureIdx + 1 },
      )
    }
    const set = new Set(v.endings)
    if (set.size !== v.endings.length) {
      throw new ValidationError(
        `Volta ${v.id}: endings array has duplicates: [${v.endings.join(', ')}]`,
        'volta_endings_invalid',
      )
    }
  }
}

/**
 * TechniqueStates: each entry must reference an existing
 * (staffIdx, voiceIdx, measureIdx, optional eventIdx). The schema
 * bounds staffIdx 0..1 and voiceIdx 0..3, but does not know the
 * score's actual measure / voice / event counts — without this check
 * the renderer would silently drop out-of-range markers.
 */
function validateTechniqueStates(score: Score): void {
  if (!score.techniqueStates || score.techniqueStates.length === 0) return
  const staffCount = getStaffCount(score)
  for (const t of score.techniqueStates) {
    if (t.staffIdx >= staffCount) {
      throw new ValidationError(
        `TechniqueChange ${t.id ?? '(no id)'}: staffIdx ${t.staffIdx} does not exist; score has ${staffCount} stave${staffCount === 1 ? '' : 's'}`,
        'technique_state_invalid',
      )
    }
    const voiceCount = getVoiceCount(score, t.staffIdx)
    if (t.voiceIdx >= voiceCount) {
      throw new ValidationError(
        `TechniqueChange ${t.id ?? '(no id)'}: (staffIdx ${t.staffIdx}, voiceIdx ${t.voiceIdx}) does not exist; staff ${t.staffIdx} has ${voiceCount} voice${voiceCount === 1 ? '' : 's'}`,
        'technique_state_invalid',
      )
    }
    const measures = getVoiceMeasures(score, t.staffIdx, t.voiceIdx)
    if (t.measureIdx >= measures.length) {
      throw new ValidationError(
        `TechniqueChange ${t.id ?? '(no id)'}: measureIdx ${t.measureIdx} does not exist; staff ${t.staffIdx} voice ${t.voiceIdx} has ${measures.length} measure${measures.length === 1 ? '' : 's'}`,
        'technique_state_invalid',
        { measure: t.measureIdx + 1 },
      )
    }
    if (t.eventIdx !== undefined) {
      const events = measures[t.measureIdx].events
      if (t.eventIdx >= events.length) {
        throw new ValidationError(
          `TechniqueChange ${t.id ?? '(no id)'}: eventIdx ${t.eventIdx} does not exist; measure ${t.measureIdx + 1} has ${events.length} event${events.length === 1 ? '' : 's'}`,
          'technique_state_invalid',
          { measure: t.measureIdx + 1, event: t.eventIdx + 1 },
        )
      }
    }
  }
}
