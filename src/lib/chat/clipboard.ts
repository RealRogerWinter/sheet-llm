import type { Event, Score, Span } from '@/lib/music/types'
import type { Operation } from '@/lib/music/editOperations'
import {
  captureRangeContent,
  cloneCapturedRangeWithFreshIdsMapped,
  remapSpansToFreshIds,
  spansFullyInsideRange,
} from '@/lib/music/editOperations'
import { hashMeasure } from '@/lib/music/scoreDiff'
import { DURATION_32NDS, fillWithRests, mergeAdjacentRests } from '@/lib/music/measureBalance'
import {
  getStaffCount,
  getVoiceCount,
  getVoiceEventAt,
  getVoiceMeasureAt,
  withVoiceMeasures,
} from '@/lib/music/scoreAccessors'
import type { ClipboardEntry, MeasureRangeSelection, RunSelection, Selection } from './state'

/**
 * Deep clone via JSON round-trip. Events/Measures are plain JSON-safe
 * data (no functions/Dates), so this faithfully copies them AND isolates
 * the clipboard entry from later in-place score edits — copy must not be
 * a live view of the score.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Serialize the selected event into a clipboard entry. A chord-note
 * selection (`pitchIdx` set on a >1-pitch event) copies just that pitch
 * as a one-note event, so "copy this note → paste" yields one note, not
 * the whole chord. Returns null when the selection doesn't resolve.
 */
export function copyEventSelection(score: Score, selection: Selection): ClipboardEntry | null {
  const staffIdx = selection.staffIdx ?? 0
  const voiceIdx = selection.voiceIdx ?? 0
  const event = getVoiceEventAt(score, staffIdx, voiceIdx, selection.measureIdx, selection.eventIdx)
  if (!event) return null
  let src: Event = event
  if (selection.pitchIdx !== undefined && event.pitches.length > 1) {
    const pitch = event.pitches[selection.pitchIdx]
    if (pitch) src = { ...event, pitches: [pitch] }
  }
  const events = [clone(src)]
  const totalUnits = events.reduce((sum, e) => sum + (DURATION_32NDS[e.duration] ?? 0), 0)
  return {
    kind: 'events',
    events,
    sourceMeta: { meter: score.meter, staffIdx, voiceIdx, totalUnits },
  }
}

/**
 * Serialize an intra-measure RUN selection (D2) — the contiguous events
 * `[startEventIdx, endEventIdx]` of one voice/measure — into an `events`
 * clipboard entry, preserving internal ties/articulations with fresh-id
 * isolation. The run's TRAILING boundary ties are stripped: the last
 * event (and its pitches) may be `tied_to_next` an event left behind, so
 * the pasted run would otherwise tie into whatever follows at the
 * destination. Returns null when the run doesn't resolve.
 */
export function copyEventRun(score: Score, run: RunSelection): ClipboardEntry | null {
  const staffIdx = run.staffIdx ?? 0
  const voiceIdx = run.voiceIdx ?? 0
  const measure = getVoiceMeasureAt(score, staffIdx, voiceIdx, run.measureIdx)
  if (!measure) return null
  const start = Math.max(0, Math.min(run.startEventIdx, run.endEventIdx))
  const end = Math.min(measure.events.length - 1, Math.max(run.startEventIdx, run.endEventIdx))
  if (start > end) return null
  const events = measure.events.slice(start, end + 1).map((e) => clone(e))
  if (events.length === 0) return null
  const last = events[events.length - 1]
  delete last.tied_to_next
  for (const p of last.pitches) delete p.tied_to_next
  const totalUnits = events.reduce((sum, e) => sum + (DURATION_32NDS[e.duration] ?? 0), 0)
  return {
    kind: 'events',
    events,
    sourceMeta: { meter: score.meter, staffIdx, voiceIdx, totalUnits },
  }
}

/**
 * Replace an intra-measure RUN with rests of equal total duration (cut's
 * delete half), keeping the bar meter-valid. Adjacent rests are merged so
 * the gap collapses into the fewest rest tokens. If the event BEFORE the
 * run was tied INTO it, that tie now dangles and is stripped. Pure score
 * transform — committed by the caller via `applyScore` (one undo entry).
 */
export function removeEventRun(score: Score, run: RunSelection): Score {
  const staffIdx = run.staffIdx ?? 0
  const voiceIdx = run.voiceIdx ?? 0
  const measure = getVoiceMeasureAt(score, staffIdx, voiceIdx, run.measureIdx)
  if (!measure) return score
  const start = Math.max(0, Math.min(run.startEventIdx, run.endEventIdx))
  const end = Math.min(measure.events.length - 1, Math.max(run.startEventIdx, run.endEventIdx))
  if (start > end) return score
  const removedUnits = measure.events
    .slice(start, end + 1)
    .reduce((sum, e) => sum + (DURATION_32NDS[e.duration] ?? 0), 0)
  const head = measure.events.slice(0, start)
  if (head.length > 0 && head[head.length - 1].tied_to_next) {
    const prev = { ...head[head.length - 1] }
    delete prev.tied_to_next
    prev.pitches = prev.pitches.map((p) => {
      if (!p.tied_to_next) return p
      const copy = { ...p }
      delete copy.tied_to_next
      return copy
    })
    head[head.length - 1] = prev
  }
  const nextEvents = mergeAdjacentRests([
    ...head,
    ...fillWithRests(removedUnits),
    ...measure.events.slice(end + 1),
  ])
  return withVoiceMeasures(score, staffIdx, voiceIdx, (ms) =>
    ms.map((m, i) => (i === run.measureIdx ? { ...m, events: nextEvents } : m)),
  )
}

/**
 * Serialize an inclusive measure range into a clipboard entry — all
 * staves/voices via `captureRangeContent`, deep-cloned + per-bar
 * hash-tagged. The clone preserves the capture's invariant that
 * `primaryMeasures` IS `perVoiceContent[0].voices[0]` (same reference),
 * which a naive JSON clone would split.
 *
 * D4: also carries the spans FULLY inside the range (both endpoints on
 * copied events). They ride along with original event ids; paste remaps
 * those endpoints onto the inserted copies' fresh ids.
 */
export function copyMeasureRange(score: Score, range: MeasureRangeSelection): ClipboardEntry {
  const perVoiceContent = clone(captureRangeContent(score, range.fromStart, range.fromEnd).perVoiceContent)
  const primaryMeasures = perVoiceContent[0].voices[0]
  const spans = spansFullyInsideRange(score, range.fromStart, range.fromEnd)
  return {
    kind: 'measures',
    captured: {
      primaryMeasures,
      perVoiceContent,
      ...(spans.length > 0 ? { spans: clone(spans) } : {}),
    },
    sourceMeta: {
      meter: score.meter,
      measureHashes: primaryMeasures.map(hashMeasure),
      staffCount: getStaffCount(score),
      voiceCount: getVoiceCount(score, 0),
    },
  }
}

/**
 * JSON text for the system-clipboard mirror
 * (`navigator.clipboard.writeText`) — the cross-tab/app affordance
 * (wired in M28-PR-5). The in-memory store slot stays canonical on
 * intra-app paste; this is a best-effort export tagged with a marker so
 * a foreign paste can recognize it.
 */
export function clipboardEntryToJSON(entry: ClipboardEntry): string {
  return JSON.stringify({ _sheetLlmClipboard: 1, entry })
}

/**
 * Inverse of `clipboardEntryToJSON` — parse a system-clipboard text payload
 * back into a `ClipboardEntry` (D3 foreign paste). Returns null when the
 * text isn't JSON, isn't tagged with our `_sheetLlmClipboard` marker, or
 * isn't a recognized `kind`. Structural-only: the paste ops re-validate
 * arity/balance, so a deeper schema check here would be redundant. Never
 * throws.
 */
export function clipboardEntryFromJSON(text: string): ClipboardEntry | null {
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if ((parsed as { _sheetLlmClipboard?: unknown })._sheetLlmClipboard !== 1) return null
  const entry = (parsed as { entry?: unknown }).entry
  if (!entry || typeof entry !== 'object') return null
  const kind = (entry as { kind?: unknown }).kind
  if (kind !== 'events' && kind !== 'measures') return null
  return entry as ClipboardEntry
}

type Captured = ReturnType<typeof captureRangeContent> & { spans?: Span[] }

/**
 * Build an `insertMeasuresAfter` op that pastes a captured measure bundle
 * AFTER `afterMeasureIdx`, with fresh event ids (so the copy's spans stay
 * pointed at the copy, not the originals). All staves/voices are carried
 * via `perVoiceContent`; D4 carried spans are remapped onto the fresh ids
 * and attached as `spansToAdd`.
 */
export function pasteMeasuresInsertOp(captured: Captured, afterMeasureIdx: number): Operation {
  const refreshed = cloneCapturedRangeWithFreshIdsMapped(captured)
  const spansToAdd = captured.spans ? remapSpansToFreshIds(captured.spans, refreshed.idMap) : []
  return {
    kind: 'insertMeasuresAfter',
    afterMeasureIdx,
    measures: refreshed.primaryMeasures,
    perVoiceContent: refreshed.perVoiceContent,
    ...(spansToAdd.length > 0 ? { spansToAdd } : {}),
  }
}

/**
 * Build a `regionReplace` op that pastes a captured measure bundle over the
 * inclusive `[startMeasureIdx, endMeasureIdx]` range (fresh ids). The op
 * handles an M→N count change and drops severed spans; D4 carried spans
 * are remapped onto the replacement's fresh ids and appended after that
 * drop.
 */
export function pasteMeasuresReplaceOp(
  captured: Captured,
  startMeasureIdx: number,
  endMeasureIdx: number,
): Operation {
  const refreshed = cloneCapturedRangeWithFreshIdsMapped(captured)
  const spansToAdd = captured.spans ? remapSpansToFreshIds(captured.spans, refreshed.idMap) : []
  return {
    kind: 'regionReplace',
    startMeasureIdx,
    endMeasureIdx,
    measures: refreshed.primaryMeasures,
    perVoiceContent: refreshed.perVoiceContent,
    ...(spansToAdd.length > 0 ? { spansToAdd } : {}),
  }
}
