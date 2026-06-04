import { resolveClickPosition, type SourceMap } from './scoreToAbcWithMap'

/**
 * Subset of abcjs's NoteTimingEvent that we rely on.
 */
interface AbcTimingEvent {
  milliseconds?: number
  startCharArray?: number[]
}

interface VisualObjLike {
  setUpAudio?: (opts?: unknown) => { totalDuration?: number }
  setupEvents?: (start: number, end: number, bpm: number) => AbcTimingEvent[]
  getBpm?: () => number
  millisecondsPerMeasure?: () => number
}

export interface EventTimeIndex {
  /** Map keyed by `${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}` → milliseconds from start. */
  msByPosition: Map<string, number>
  /** Total milliseconds of the tune. */
  totalMs: number
}

/**
 * Build a position→time lookup so the editor can seek the synth to a
 * specific note. Walks abcjs's setupEvents output, resolving each
 * timing event back to a (measureIdx, eventIdx) via the SourceMap.
 */
export function buildEventTimeIndex(
  visualObj: unknown,
  sourceMap: SourceMap,
): EventTimeIndex {
  const vo = visualObj as VisualObjLike
  const bpm = typeof vo.getBpm === 'function' ? vo.getBpm() : 100
  const events: AbcTimingEvent[] =
    typeof vo.setupEvents === 'function' ? vo.setupEvents(0, 1, bpm) : []

  const msByPosition = new Map<string, number>()
  let totalMs = 0
  for (const e of events) {
    if (typeof e.milliseconds !== 'number') continue
    totalMs = Math.max(totalMs, e.milliseconds)
    const startChar = e.startCharArray?.[0]
    if (startChar === undefined) continue
    const pos = resolveClickPosition(sourceMap, startChar)
    if (!pos) continue
    const key = `${pos.staffIdx}:${pos.voiceIdx}:${pos.measureIdx}:${pos.eventIdx}`
    // Use the earliest ms for this position (events may include
    // duplicates for chord notes).
    if (!msByPosition.has(key)) msByPosition.set(key, e.milliseconds)
  }

  return { msByPosition, totalMs }
}
