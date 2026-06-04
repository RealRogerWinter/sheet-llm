import { describe, it, expect } from 'vitest'
import { contextMenuSections, type ContextMenuOpts } from '@/components/editor/contextMenuItems'
import type { ContextTarget } from '@/lib/chat/state'

const sel = { measureIdx: 0, eventIdx: 0 }
const items = (t: ContextTarget, opts?: ContextMenuOpts) => contextMenuSections(t, opts).flatMap((s) => s.items)
const ids = (t: ContextTarget, opts?: ContextMenuOpts) => items(t, opts).map((i) => i.id)

describe('contextMenuSections (M27)', () => {
  it('note offers play, accidentals, durations, expression/text verbs, tie, and delete', () => {
    const got = ids({ kind: 'note', selection: sel })
    expect(got).toEqual(
      expect.arrayContaining([
        'play',
        'acc:sharp',
        'dur:quarter',
        'bus:open-dynamics',
        'bus:open-ornament',
        'bus:open-fingering',
        'bus:open-tie',
        'delete',
      ]),
    )
  })

  it('hides span rows (slur / hairpin) unless the event has an id', () => {
    expect(ids({ kind: 'note', selection: sel }, { eventHasId: false })).not.toContain('bus:open-slur')
    const withId = ids({ kind: 'note', selection: sel }, { eventHasId: true })
    expect(withId).toContain('bus:open-slur')
    expect(withId).toContain('bus:open-hairpin')
  })

  it('groups the note menu under section labels', () => {
    const labels = contextMenuSections({ kind: 'note', selection: sel })
      .map((s) => s.label)
      .filter(Boolean)
    expect(labels).toEqual(expect.arrayContaining(['Accidental', 'Duration', 'Expression', 'Text', 'Lines']))
  })

  it('rest omits accidentals + tie/dynamics (rest-illegal verbs)', () => {
    const got = ids({ kind: 'rest', selection: sel })
    expect(got).toEqual(expect.arrayContaining(['play', 'dur:quarter', 'delete']))
    expect(got).not.toContain('acc:sharp')
    expect(got).not.toContain('bus:open-dynamics')
    expect(got).not.toContain('bus:open-tie')
  })

  it('chordNote offers remove-from-chord and delete', () => {
    const got = ids({ kind: 'chordNote', selection: { ...sel, pitchIdx: 1 } })
    expect(got).toContain('remove-from-chord')
    expect(got).toContain('delete')
  })

  it('measure offers insert, structure, select, and a numbered delete', () => {
    const got = ids({ kind: 'measure', measureIdx: 2, insertAfterIdx: 0, staffIdx: 0 })
    expect(got).toEqual([
      'measure:insert',
      'open-barline',
      'open-volta',
      'open-jump-marker',
      'measure:select',
      'measure:delete',
    ])
    const del = items({ kind: 'measure', measureIdx: 2, insertAfterIdx: 0, staffIdx: 0 }).find(
      (i) => i.id === 'measure:delete',
    )
    expect(del?.label).toContain('measure 3') // 1-based
  })

  it('barline offers set-barline / volta and a measure delete', () => {
    expect(ids({ kind: 'barline', measureIdx: 0, staffIdx: 0 })).toEqual(['open-barline', 'open-volta', 'measure:delete'])
  })

  it('range offers a single delete-measures with the inclusive 1-based label', () => {
    const item = items({ kind: 'range', range: { fromStart: 1, fromEnd: 3 } })[0]
    expect(item.id).toBe('range:delete')
    expect(item.label).toContain('2–4')
    expect(item.danger).toBe(true)
  })

  it('returns no sections for empty / none (no actionable target)', () => {
    expect(contextMenuSections({ kind: 'empty' })).toEqual([])
    expect(contextMenuSections({ kind: 'none' })).toEqual([])
  })

  it('marks the delete row as danger', () => {
    const del = items({ kind: 'note', selection: sel }).find((i) => i.id === 'delete')
    expect(del?.danger).toBe(true)
  })
})
