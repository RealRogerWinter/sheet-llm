import { describe, it, expect } from 'vitest'
import { copyMeasureRange, pasteMeasuresInsertOp, pasteMeasuresReplaceOp } from '@/lib/chat/clipboard'
import type { Score } from '@/lib/music/types'

const note = (step: string) => ({ pitches: [{ step, octave: 4 }], duration: 'whole', id: `src-${step}` })

const buildScore = (): Score =>
  ({
    key: 'C',
    meter: '4/4',
    measures: [{ events: [note('C')] }, { events: [note('D')] }],
  } as unknown as Score)

describe('clipboard measures paste ops (M28-PR-2)', () => {
  it('pasteMeasuresInsertOp builds an insertMeasuresAfter op with fresh ids', () => {
    const entry = copyMeasureRange(buildScore(), { fromStart: 0, fromEnd: 1 })
    if (entry.kind !== 'measures') throw new Error('expected measures')
    const op = pasteMeasuresInsertOp(entry.captured, 3)
    expect(op.kind).toBe('insertMeasuresAfter')
    if (op.kind !== 'insertMeasuresAfter') throw new Error('expected insertMeasuresAfter')
    expect(op.afterMeasureIdx).toBe(3)
    expect(op.measures).toHaveLength(2)
    expect(op.measures[0].events[0].id).not.toBe('src-C') // refreshed
    expect(op.perVoiceContent).toBeDefined()
  })

  it('pasteMeasuresReplaceOp builds a regionReplace op over the range', () => {
    const entry = copyMeasureRange(buildScore(), { fromStart: 0, fromEnd: 0 })
    if (entry.kind !== 'measures') throw new Error('expected measures')
    const op = pasteMeasuresReplaceOp(entry.captured, 2, 4)
    expect(op.kind).toBe('regionReplace')
    if (op.kind !== 'regionReplace') throw new Error('expected regionReplace')
    expect(op.startMeasureIdx).toBe(2)
    expect(op.endMeasureIdx).toBe(4)
    expect(op.measures).toHaveLength(1)
  })
})
