import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContextMenu } from '@/components/editor/ContextMenu'
import { useChatStore, type ContextTarget } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

const real = {
  applyBalancedEdit: useChatStore.getState().applyBalancedEdit,
  applyEdit: useChatStore.getState().applyEdit,
  playFromSelection: useChatStore.getState().playFromSelection,
  setPaletteRequest: useChatStore.getState().setPaletteRequest,
  selectMeasureRange: useChatStore.getState().selectMeasureRange,
  requestMeasureDelete: useChatStore.getState().requestMeasureDelete,
  select: useChatStore.getState().select,
}

function open(target: ContextTarget) {
  useChatStore.getState().openContextMenu({ target, anchorX: 100, anchorY: 100 })
}

describe('ContextMenu (M27-PR-2)', () => {
  // These tests exercise the core menu structure + nav, so pin the M28
  // clipboard + M29 AI rows OFF for a deterministic item order.
  const origClip = process.env.NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD
  const origAi = process.env.NEXT_PUBLIC_SL_CONTEXT_AI
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD = 'off'
    process.env.NEXT_PUBLIC_SL_CONTEXT_AI = 'off'
    useChatStore.getState().closeContextMenu()
  })
  afterEach(() => {
    if (origClip === undefined) delete process.env.NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD
    else process.env.NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD = origClip
    if (origAi === undefined) delete process.env.NEXT_PUBLIC_SL_CONTEXT_AI
    else process.env.NEXT_PUBLIC_SL_CONTEXT_AI = origAi
    useChatStore.setState({ ...real, editedScore: undefined })
    useChatStore.getState().closeContextMenu()
  })

  it('renders nothing when closed', () => {
    const { container } = render(<ContextMenu />)
    expect(container.firstChild).toBeNull()
  })

  it('renders role=menu with menuitems for a note target', () => {
    open({ kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } })
    render(<ContextMenu />)
    expect(screen.getByRole('menu', { name: /context menu/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Play from here/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Delete note/i })).toBeInTheDocument()
  })

  it('clicking Delete dispatches removeBalanced and closes the menu', () => {
    const applyBalancedEdit = vi.fn()
    useChatStore.setState({ applyBalancedEdit })
    open({ kind: 'note', selection: { measureIdx: 1, eventIdx: 2 } })
    render(<ContextMenu />)
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete note/i }))
    expect(applyBalancedEdit).toHaveBeenCalledWith({
      kind: 'removeBalanced',
      selection: { measureIdx: 1, eventIdx: 2 },
    })
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('Dynamics… publishes the paletteRequest bus and closes', () => {
    const setPaletteRequest = vi.fn()
    useChatStore.setState({ setPaletteRequest })
    open({ kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } })
    render(<ContextMenu />)
    fireEvent.click(screen.getByRole('menuitem', { name: /Dynamics/i }))
    expect(setPaletteRequest).toHaveBeenCalledWith({ kind: 'open-dynamics' })
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('chordNote routes Remove-this-note-from-chord to removePitchFromChord with the pitchIdx', () => {
    const applyEdit = vi.fn()
    useChatStore.setState({ applyEdit })
    open({ kind: 'chordNote', selection: { measureIdx: 0, eventIdx: 0, pitchIdx: 2 } })
    render(<ContextMenu />)
    fireEvent.click(screen.getByRole('menuitem', { name: /Remove this note from chord/i }))
    expect(applyEdit).toHaveBeenCalledWith({
      kind: 'removePitchFromChord',
      target: { measureIdx: 0, eventIdx: 0, pitchIdx: 2 },
      pitchIdx: 2,
    })
  })

  it('Escape closes the menu', () => {
    open({ kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } })
    render(<ContextMenu />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('an outside mousedown closes the menu', () => {
    open({ kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } })
    render(<ContextMenu />)
    fireEvent.mouseDown(document.body)
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('a mousedown INSIDE the menu does not close it', () => {
    open({ kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } })
    render(<ContextMenu />)
    fireEvent.mouseDown(screen.getByRole('menu'))
    expect(useChatStore.getState().contextMenu).not.toBeUndefined()
  })

  it('measure: Select measure dispatches selectMeasureRange and closes', () => {
    const selectMeasureRange = vi.fn()
    useChatStore.setState({ selectMeasureRange })
    open({ kind: 'measure', measureIdx: 3, insertAfterIdx: 0, staffIdx: 0 })
    render(<ContextMenu />)
    fireEvent.click(screen.getByRole('menuitem', { name: /Select measure/i }))
    expect(selectMeasureRange).toHaveBeenCalledWith({ fromStart: 3, fromEnd: 3 })
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('measure: Delete routes through the confirm gate (requestMeasureDelete)', () => {
    const requestMeasureDelete = vi.fn()
    useChatStore.setState({ requestMeasureDelete })
    open({ kind: 'measure', measureIdx: 3, insertAfterIdx: 0, staffIdx: 0 })
    render(<ContextMenu />)
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete measure 4/i }))
    expect(requestMeasureDelete).toHaveBeenCalledWith({ fromStart: 3, fromEnd: 3 })
  })

  it('measure: Barline… selects the bar then publishes open-barline', () => {
    const select = vi.fn()
    const setPaletteRequest = vi.fn()
    useChatStore.setState({ select, setPaletteRequest })
    open({ kind: 'measure', measureIdx: 2, insertAfterIdx: 0, staffIdx: 0 })
    render(<ContextMenu />)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Barline/i }))
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ measureIdx: 2, eventIdx: 0, staffIdx: 0 }))
    expect(setPaletteRequest).toHaveBeenCalledWith({ kind: 'open-barline' })
  })

  it('range: Delete measures dispatches requestMeasureDelete with the whole range', () => {
    const requestMeasureDelete = vi.fn()
    useChatStore.setState({ requestMeasureDelete })
    open({ kind: 'range', range: { fromStart: 1, fromEnd: 3 } })
    render(<ContextMenu />)
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete measures/i }))
    expect(requestMeasureDelete).toHaveBeenCalledWith({ fromStart: 1, fromEnd: 3 })
  })

  it('shows Slur only when the selected event has an id (span gating)', () => {
    // No editedScore → event undefined → span rows hidden.
    open({ kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } })
    const { unmount } = render(<ContextMenu />)
    expect(screen.queryByRole('menuitem', { name: /^Slur/i })).toBeNull()
    unmount()
    useChatStore.getState().closeContextMenu()

    // Event with an id → Slur + Hairpin appear.
    const score = {
      key: 'C',
      meter: '4/4',
      measures: [{ events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'quarter', id: 'evt12345' }] }],
    } as unknown as Score
    useChatStore.setState({ editedScore: score })
    open({ kind: 'note', selection: { staffIdx: 0, voiceIdx: 0, measureIdx: 0, eventIdx: 0 } })
    render(<ContextMenu />)
    expect(screen.getByRole('menuitem', { name: /^Slur/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Hairpin/i })).toBeInTheDocument()
  })

  it('closes on wheel (cursor anchor goes stale under zoom/scroll)', () => {
    open({ kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } })
    render(<ContextMenu />)
    window.dispatchEvent(new Event('wheel'))
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('Enter fires the focused (first) item', () => {
    const playFromSelection = vi.fn()
    useChatStore.setState({ playFromSelection })
    open({ kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } })
    render(<ContextMenu />)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' })
    expect(playFromSelection).toHaveBeenCalled()
    expect(useChatStore.getState().contextMenu).toBeUndefined()
  })

  it('ArrowDown moves the active item; Enter then fires it', () => {
    const applyEdit = vi.fn()
    useChatStore.setState({ applyEdit })
    open({ kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } })
    render(<ContextMenu />)
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' }) // 0 (Play) → 1 (♯ Sharp)
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(applyEdit).toHaveBeenCalledWith({
      kind: 'setAccidental',
      target: { measureIdx: 0, eventIdx: 0 },
      accidental: 'sharp',
    })
  })

  it('ArrowUp from the first item wraps to the last', () => {
    const applyBalancedEdit = vi.fn()
    useChatStore.setState({ applyBalancedEdit })
    open({ kind: 'note', selection: { measureIdx: 4, eventIdx: 1 } })
    render(<ContextMenu />)
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowUp' }) // wrap to last item = Delete note
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(applyBalancedEdit).toHaveBeenCalledWith({ kind: 'removeBalanced', selection: { measureIdx: 4, eventIdx: 1 } })
  })

  it('restores focus to the previously-focused element on close', () => {
    const btn = document.createElement('button')
    document.body.appendChild(btn)
    btn.focus()
    open({ kind: 'note', selection: { measureIdx: 0, eventIdx: 0 } })
    const { rerender } = render(<ContextMenu />)
    useChatStore.getState().closeContextMenu()
    rerender(<ContextMenu />)
    expect(document.activeElement).toBe(btn)
    btn.remove()
  })
})
