import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

/**
 * Tests for the always-confirm measure-delete gate
 * (requestMeasureDelete / confirmMeasureDelete / cancelMeasureDelete).
 *
 * The gate is shared by the NoteFloatingMenu "Delete measure" button
 * and the ⌘K "Delete selected measure(s)" command. It must:
 *   - stage a pending range without mutating the score,
 *   - refuse to delete every measure,
 *   - on confirm, route through the span/marker-SAFE dragMeasureRange
 *     delete (NOT the legacy deleteMeasure, which orphans spans).
 */

function bar(step: 'C' | 'D' | 'E' | 'F' | 'G'): Score['measures'][number] {
  return { events: [{ pitches: [{ step, octave: 4 }], duration: 'whole' }] }
}

const SCORE: Score = {
  key: 'C',
  meter: '4/4',
  measures: [bar('C'), bar('D'), bar('E'), bar('F'), bar('G')],
}

function seed(score: Score = SCORE) {
  useChatStore.setState({
    chatId: 'test',
    abc: 'X:1\n',
    scoreJson: score,
    editedScore: score,
    editMap: undefined,
    selection: undefined,
    measureRangeSelection: undefined,
    pendingMeasureDelete: undefined,
    history: [score],
    historyPointer: 0,
    lastCoalesceKey: undefined,
    lastCoalesceAt: 0,
    pending: false,
    error: undefined,
  })
}

describe('requestMeasureDelete', () => {
  beforeEach(() => seed())

  it('stages a single-bar range without mutating the score', () => {
    useChatStore.getState().requestMeasureDelete({ fromStart: 2, fromEnd: 2 })
    expect(useChatStore.getState().pendingMeasureDelete).toEqual({ fromStart: 2, fromEnd: 2 })
    // Score untouched until confirm.
    expect(useChatStore.getState().editedScore?.measures).toHaveLength(5)
  })

  it('stages a multi-bar range', () => {
    useChatStore.getState().requestMeasureDelete({ fromStart: 1, fromEnd: 3 })
    expect(useChatStore.getState().pendingMeasureDelete).toEqual({ fromStart: 1, fromEnd: 3 })
  })

  it('normalizes reversed endpoints and clamps out-of-bounds', () => {
    useChatStore.getState().requestMeasureDelete({ fromStart: 99, fromEnd: 3 })
    expect(useChatStore.getState().pendingMeasureDelete).toEqual({ fromStart: 3, fromEnd: 4 })
  })

  it('refuses to delete every measure (sets error, leaves gate closed)', () => {
    useChatStore.getState().requestMeasureDelete({ fromStart: 0, fromEnd: 4 })
    expect(useChatStore.getState().pendingMeasureDelete).toBeUndefined()
    expect(useChatStore.getState().error).toMatch(/at least one/i)
  })

  it('is a no-op with no score', () => {
    useChatStore.setState({ editedScore: undefined })
    useChatStore.getState().requestMeasureDelete({ fromStart: 0, fromEnd: 0 })
    expect(useChatStore.getState().pendingMeasureDelete).toBeUndefined()
  })
})

describe('cancelMeasureDelete', () => {
  beforeEach(() => seed())

  it('clears the gate without mutating the score', () => {
    useChatStore.getState().requestMeasureDelete({ fromStart: 1, fromEnd: 2 })
    useChatStore.getState().cancelMeasureDelete()
    expect(useChatStore.getState().pendingMeasureDelete).toBeUndefined()
    expect(useChatStore.getState().editedScore?.measures).toHaveLength(5)
  })
})

describe('confirmMeasureDelete', () => {
  beforeEach(() => seed())

  it('deletes the staged range and clears the gate', () => {
    useChatStore.getState().requestMeasureDelete({ fromStart: 1, fromEnd: 2 })
    useChatStore.getState().confirmMeasureDelete()
    const score = useChatStore.getState().editedScore
    expect(score?.measures).toHaveLength(3)
    // Bars D, E removed → remaining are C, F, G.
    expect(score?.measures.map((m) => m.events[0].pitches[0].step)).toEqual(['C', 'F', 'G'])
    expect(useChatStore.getState().pendingMeasureDelete).toBeUndefined()
  })

  it('pushes onto history so the delete is undoable', () => {
    useChatStore.getState().requestMeasureDelete({ fromStart: 0, fromEnd: 0 })
    useChatStore.getState().confirmMeasureDelete()
    expect(useChatStore.getState().editedScore?.measures).toHaveLength(4)
    useChatStore.getState().undo()
    expect(useChatStore.getState().editedScore?.measures).toHaveLength(5)
  })

  it('is a no-op when nothing is pending', () => {
    useChatStore.getState().confirmMeasureDelete()
    expect(useChatStore.getState().editedScore?.measures).toHaveLength(5)
  })

  it('uses the span-safe op: a span interior to the deleted bar is dropped', () => {
    // Bar 1 (idx 1) holds two id-tagged events joined by a slur span.
    // The span lives entirely inside the deleted bar, so the safe
    // dragMeasureRange delete drops it. The legacy deleteMeasure op
    // would leave it orphaned — this asserts we route to the safe one.
    const scored: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        bar('C'),
        {
          events: [
            { id: 'e1', pitches: [{ step: 'D', octave: 4 }], duration: 'half' },
            { id: 'e2', pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
          ],
        },
        bar('G'),
      ],
      spans: [
        {
          id: 'sp1',
          kind: 'slur',
          startEventId: 'e1',
          endEventId: 'e2',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
    }
    seed(scored)
    useChatStore.getState().requestMeasureDelete({ fromStart: 1, fromEnd: 1 })
    useChatStore.getState().confirmMeasureDelete()
    const after = useChatStore.getState().editedScore
    expect(after?.measures).toHaveLength(2)
    // Span referencing the deleted events must be gone (not orphaned).
    expect(after?.spans ?? []).toHaveLength(0)
  })
})
