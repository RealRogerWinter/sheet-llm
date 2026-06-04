import { describe, it, expect } from 'vitest'
import { contextMenuSections, type ContextMenuOpts } from '@/components/editor/contextMenuItems'
import type { ContextTarget } from '@/lib/chat/state'

const note: ContextTarget = { kind: 'note', selection: { measureIdx: 2, eventIdx: 0 } }
const measure: ContextTarget = { kind: 'measure', measureIdx: 2, insertAfterIdx: 0, staffIdx: 0 }
const range: ContextTarget = { kind: 'range', range: { fromStart: 1, fromEnd: 3 } }
const ids = (t: ContextTarget, opts: ContextMenuOpts) =>
  contextMenuSections(t, opts).flatMap((s) => s.items).map((i) => i.id)

describe('contextMenuSections AI rows (M29-PR-2)', () => {
  it('omits AI items when aiEnabled is false', () => {
    expect(ids(note, {})).not.toContain('ai:edit')
  })

  it('note gets Edit + Explain', () => {
    expect(ids(note, { aiEnabled: true })).toEqual(expect.arrayContaining(['ai:edit', 'ai:explain']))
  })

  it('measure gets Regenerate + Edit + Explain', () => {
    expect(ids(measure, { aiEnabled: true })).toEqual(
      expect.arrayContaining(['ai:regenerate', 'ai:edit', 'ai:explain']),
    )
  })

  it('range gets Regenerate-range + Explain', () => {
    expect(ids(range, { aiEnabled: true })).toEqual(expect.arrayContaining(['ai:regenerate-range', 'ai:explain']))
  })

  it('barline gets no AI items', () => {
    const barline: ContextTarget = { kind: 'barline', measureIdx: 0, staffIdx: 0 }
    expect(ids(barline, { aiEnabled: true })).not.toContain('ai:edit')
  })
})
