import { describe, it, expect } from 'vitest'
import { contextMenuSections, type ContextMenuOpts } from '@/components/editor/contextMenuItems'
import type { ContextTarget } from '@/lib/chat/state'

const noteTarget: ContextTarget = { kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } }
const measureTarget: ContextTarget = { kind: 'measure', measureIdx: 0, insertAfterIdx: 0, staffIdx: 0 }
const rangeTarget: ContextTarget = { kind: 'range', range: { fromStart: 0, fromEnd: 1 } }
const items = (t: ContextTarget, opts: ContextMenuOpts) => contextMenuSections(t, opts).flatMap((s) => s.items)
const paste = (t: ContextTarget, opts: ContextMenuOpts) => items(t, opts).find((i) => i.id === 'paste')

describe('contextMenuSections clipboard rows (M28-PR-3)', () => {
  it('omits Cut/Copy/Paste when clipboard is disabled', () => {
    const ids = items(noteTarget, { clipboardEnabled: false }).map((i) => i.id)
    expect(ids).not.toContain('cut')
    expect(ids).not.toContain('copy')
    expect(ids).not.toContain('paste')
  })

  it('adds Cut/Copy/Paste on a note when enabled; Paste disabled with an empty clipboard', () => {
    const ids = items(noteTarget, { clipboardEnabled: true }).map((i) => i.id)
    expect(ids).toEqual(expect.arrayContaining(['cut', 'copy', 'paste']))
    expect(paste(noteTarget, { clipboardEnabled: true })?.disabled).toBe(true)
  })

  it('enables note Paste only for an events clipboard', () => {
    expect(paste(noteTarget, { clipboardEnabled: true, clipboardKind: 'events' })?.disabled).toBe(false)
    expect(paste(noteTarget, { clipboardEnabled: true, clipboardKind: 'measures' })?.disabled).toBe(true)
  })

  it('enables measure Paste for any non-empty clipboard', () => {
    expect(paste(measureTarget, { clipboardEnabled: true })?.disabled).toBe(true)
    expect(paste(measureTarget, { clipboardEnabled: true, clipboardKind: 'events' })?.disabled).toBe(false)
    expect(paste(measureTarget, { clipboardEnabled: true, clipboardKind: 'measures' })?.disabled).toBe(false)
  })

  it('enables range Paste only for a measures clipboard', () => {
    expect(paste(rangeTarget, { clipboardEnabled: true, clipboardKind: 'events' })?.disabled).toBe(true)
    expect(paste(rangeTarget, { clipboardEnabled: true, clipboardKind: 'measures' })?.disabled).toBe(false)
  })

  it('gives a barline no clipboard rows', () => {
    const barline: ContextTarget = { kind: 'barline', measureIdx: 0, staffIdx: 0 }
    expect(items(barline, { clipboardEnabled: true }).map((i) => i.id)).not.toContain('copy')
  })
})
