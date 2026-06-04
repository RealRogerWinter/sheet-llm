import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '@/lib/chat/state'
import { validateScore } from '@/lib/music/validateScore'
import type { Score } from '@/lib/music/types'

/**
 * Regression: before #84, the note-floating-menu duration buttons and
 * the 1-6 keyboard shortcuts dispatched `applyEdit({ kind:'changeDuration' })`,
 * which routes through the meter-blind `transformScore`. Shrinking a
 * quarter to an eighth therefore left the bar short by one eighth.
 * Any subsequent edit that revalidated the score (click-to-place,
 * drag-reorder) surfaced the latent corruption as
 * "Measure N: duration sum is 7 eighths, expected 8 for meter 4/4".
 *
 * Fix routes those entry-points through `applyBalancedEdit({ kind:
 * 'changeDurationBalanced' })` / `removeBalanced`, which auto-fill the
 * freed (or removed) space with rests so the bar stays meter-valid.
 */

const TWO_BARS_OF_QUARTERS: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
    ] },
    { events: [
      { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
    ] },
  ],
}

function seed(score: Score) {
  useChatStore.setState({
    editedScore: score,
    scoreJson: score,
    history: [score],
    historyPointer: 0,
    lastCoalesceKey: undefined,
    lastCoalesceAt: 0,
    statusMessage: undefined,
    error: undefined,
  })
}

describe('duration-edit entry points keep the bar meter-valid', () => {
  beforeEach(() => seed(TWO_BARS_OF_QUARTERS))

  it('shrinking a quarter to an eighth in m.2 leaves m.2 summing to 8 eighths', () => {
    useChatStore.getState().applyBalancedEdit({
      kind: 'changeDurationBalanced',
      selection: { measureIdx: 1, eventIdx: 0 },
      duration: 'eighth',
    })
    const next = useChatStore.getState().editedScore!
    expect(() => validateScore(next)).not.toThrow()
    // The shrunk event keeps pitch G, gains a freed eighth-rest after it.
    expect(next.measures[1].events[0].duration).toBe('eighth')
    expect(next.measures[1].events[0].pitches[0].step).toBe('G')
    expect(next.measures[1].events[1].pitches[0].step).toBe('rest')
    expect(next.measures[1].events[1].duration).toBe('eighth')
  })

  it('deleting an event in m.2 leaves m.2 summing to 8 eighths', () => {
    useChatStore.getState().applyBalancedEdit({
      kind: 'removeBalanced',
      selection: { measureIdx: 1, eventIdx: 1 },
    })
    const next = useChatStore.getState().editedScore!
    expect(() => validateScore(next)).not.toThrow()
    // Removed event replaced by a quarter rest; bar still 4 events.
    expect(next.measures[1].events).toHaveLength(4)
    expect(next.measures[1].events[1].pitches[0].step).toBe('rest')
    expect(next.measures[1].events[1].duration).toBe('quarter')
  })

  it('grow-then-shrink round-trips meter-valid', () => {
    // Grow first quarter to half (consumes following quarter)
    useChatStore.getState().applyBalancedEdit({
      kind: 'changeDurationBalanced',
      selection: { measureIdx: 1, eventIdx: 0 },
      duration: 'half',
    })
    expect(() => validateScore(useChatStore.getState().editedScore!)).not.toThrow()
    // Then shrink back to quarter
    useChatStore.getState().applyBalancedEdit({
      kind: 'changeDurationBalanced',
      selection: { measureIdx: 1, eventIdx: 0 },
      duration: 'quarter',
    })
    expect(() => validateScore(useChatStore.getState().editedScore!)).not.toThrow()
  })
})
