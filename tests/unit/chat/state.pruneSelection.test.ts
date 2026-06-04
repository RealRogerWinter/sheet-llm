import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

const GRAND_SCORE: Score = {
  key: 'C',
  meter: '4/4',
  measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
  secondStaff: {
    clef: 'bass',
    measures: [{ events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] }],
  },
}

function seedGrand() {
  useChatStore.setState({
    chatId: 'test',
    abc: 'X:1\n',
    scoreJson: GRAND_SCORE,
    editedScore: GRAND_SCORE,
    editMap: undefined,
    selection: undefined,
    history: [GRAND_SCORE],
    historyPointer: 0,
    lastCoalesceKey: undefined,
    lastCoalesceAt: 0,
    pending: false,
    error: undefined,
  })
}

describe('pruneSelection — wired into mutators', () => {
  beforeEach(seedGrand)

  it('drops a staffIdx=1 selection after applyEdit removeStaff', () => {
    useChatStore.getState().select({ staffIdx: 1, measureIdx: 0, eventIdx: 0, pitchIdx: 0 })
    expect(useChatStore.getState().selection?.staffIdx).toBe(1)
    useChatStore.getState().applyEdit({ kind: 'removeStaff', staffIdx: 1 })
    expect(useChatStore.getState().selection).toBeUndefined()
  })

  it('keeps a staffIdx=0 selection across removeStaff', () => {
    useChatStore.getState().select({ staffIdx: 0, measureIdx: 0, eventIdx: 0, pitchIdx: 0 })
    useChatStore.getState().applyEdit({ kind: 'removeStaff', staffIdx: 1 })
    expect(useChatStore.getState().selection).toEqual({
      staffIdx: 0,
      measureIdx: 0,
      eventIdx: 0,
      pitchIdx: 0,
    })
  })

  it('drops a staffIdx=1 selection after undo back across addStaff', () => {
    // Start single-staff, addStaff (now grand), select staff 1, undo
    // (back to single) — selection on staff 1 must be pruned.
    const singleScore: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] }],
    }
    useChatStore.setState({
      chatId: 'test',
      abc: 'X:1\n',
      scoreJson: singleScore,
      editedScore: singleScore,
      editMap: undefined,
      selection: undefined,
      history: [singleScore],
      historyPointer: 0,
      lastCoalesceKey: undefined,
      lastCoalesceAt: 0,
      pending: false,
    })
    useChatStore.getState().applyEdit({ kind: 'addStaff', clef: 'bass' })
    useChatStore.getState().select({ staffIdx: 1, measureIdx: 0, eventIdx: 0, pitchIdx: 0 })
    expect(useChatStore.getState().selection?.staffIdx).toBe(1)
    useChatStore.getState().undo()
    expect(useChatStore.getState().selection).toBeUndefined()
  })

  it('demotes only the pitchIdx when the event survives but pitch index does not', () => {
    // Build a 2-pitch chord, select pitchIdx=1, then remove a pitch ->
    // event still exists, but pitchIdx 1 is gone.
    const chordScore: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [{
        pitches: [{ step: 'C', octave: 4 }, { step: 'E', octave: 4 }],
        duration: 'whole',
      }] }],
    }
    useChatStore.setState({
      chatId: 'test',
      abc: 'X:1\n',
      scoreJson: chordScore,
      editedScore: chordScore,
      editMap: undefined,
      selection: { measureIdx: 0, eventIdx: 0, pitchIdx: 1 },
      history: [chordScore],
      historyPointer: 0,
      lastCoalesceKey: undefined,
      lastCoalesceAt: 0,
      pending: false,
    })
    useChatStore.getState().applyEdit({
      kind: 'removePitchFromChord',
      target: { measureIdx: 0, eventIdx: 0 },
      pitchIdx: 1,
    })
    const sel = useChatStore.getState().selection
    expect(sel).toBeDefined()
    expect(sel!.measureIdx).toBe(0)
    expect(sel!.eventIdx).toBe(0)
    expect(sel!.pitchIdx).toBeUndefined()
  })

  it('drops selection when the event index is past the end after deleteEvent', () => {
    const twoEv: Score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'half' },
      ] }],
    }
    useChatStore.setState({
      chatId: 'test',
      abc: 'X:1\n',
      scoreJson: twoEv,
      editedScore: twoEv,
      editMap: undefined,
      selection: { measureIdx: 0, eventIdx: 1, pitchIdx: 0 },
      history: [twoEv],
      historyPointer: 0,
      lastCoalesceKey: undefined,
      lastCoalesceAt: 0,
      pending: false,
    })
    useChatStore.getState().applyEdit({
      kind: 'deleteEvent',
      target: { measureIdx: 0, eventIdx: 1 },
    })
    // Event 1 deleted; only event 0 remains. selection.eventIdx=1 is stale.
    expect(useChatStore.getState().selection).toBeUndefined()
  })
})
