import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import NoteFloatingMenu from '@/components/editor/NoteFloatingMenu'
import TechniquePopover, {
  type TechniquePopoverPatch,
} from '@/components/editor/TechniquePopover'
import { useChatStore } from '@/lib/chat/state'
import type { Score, TechniqueChange } from '@/lib/music/types'

afterEach(() => cleanup())

const TWO_BAR_BASS: Score = {
  key: 'C',
  meter: '4/4',
  clef: 'bass',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 3 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 3 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 3 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 3 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'G', octave: 3 }], duration: 'whole' },
      ],
    },
  ],
}

function seedWithSelection(score: Score, sel: { measureIdx: number; eventIdx: number }) {
  useChatStore.setState({
    editedScore: score,
    scoreJson: score,
    history: [score],
    historyPointer: 0,
    selection: sel,
    error: undefined,
  })
}

describe('TechniquePopover — direct component contract', () => {
  it('renders every TechniqueKind as a button when open', () => {
    render(
      <TechniquePopover
        open={true}
        anchorX={100}
        anchorY={100}
        markersAtPosition={[]}
        activeTechnique={undefined}
        onClose={() => {}}
        onPatch={() => {}}
      />,
    )
    for (const title of [
      'Pizzicato',
      'Arco (cancels pizz.)',
      'Col legno battuto',
      'Col legno tratto',
      'Sul ponticello',
      'Sul tasto',
      'Flautando',
      'Ordinario (return to normal)',
      'Snap pizzicato (Bartók)',
      'Left-hand pizzicato',
      'Tremolo (state)',
      'Mute on (con sordino)',
      'Mute off (senza sordino)',
    ]) {
      expect(screen.getByRole('button', { name: title })).toBeDefined()
    }
  })

  it('renders nothing when open=false', () => {
    const { container } = render(
      <TechniquePopover
        open={false}
        anchorX={100}
        anchorY={100}
        markersAtPosition={[]}
        activeTechnique={undefined}
        onClose={() => {}}
        onPatch={() => {}}
      />,
    )
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows "Active: none" header when no technique is in effect', () => {
    render(
      <TechniquePopover
        open={true}
        anchorX={100}
        anchorY={100}
        markersAtPosition={[]}
        activeTechnique={undefined}
        onClose={() => {}}
        onPatch={() => {}}
      />,
    )
    expect(screen.getByText(/Active: none/i)).toBeDefined()
  })

  it('shows "Active: <label>" header when a technique propagates here', () => {
    render(
      <TechniquePopover
        open={true}
        anchorX={100}
        anchorY={100}
        markersAtPosition={[]}
        activeTechnique={'pizz'}
        onClose={() => {}}
        onPatch={() => {}}
      />,
    )
    // The header "Active:" plus the italicized "pizz." label sits in
    // the dialog header. Locate via the wrapping <span> with the
    // "Active:" text content rather than the bare label (which collides
    // with the button label).
    const dialog = screen.getByRole('dialog', { name: 'Performance technique' })
    expect(dialog.textContent ?? '').toMatch(/Active:\s*pizz\./)
  })

  it('clicking a technique always emits a toggle patch (the caller resolves insert-vs-remove)', () => {
    const onPatch = vi.fn<(p: TechniquePopoverPatch) => void>()
    render(
      <TechniquePopover
        open={true}
        anchorX={100}
        anchorY={100}
        markersAtPosition={[]}
        activeTechnique={undefined}
        onClose={() => {}}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pizzicato' }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'toggle', technique: 'pizz' })
  })

  it('clicking a button while a marker exists still emits a toggle (NOT insert/remove pre-resolved)', () => {
    // The popover does NOT pre-resolve insert-vs-remove because its
    // markersAtPosition prop captures a stale snapshot for fast double-
    // clicks. Resolution happens in the caller against live state.
    const marker: TechniqueChange = {
      id: 'tech-xyz-1234',
      measureIdx: 0,
      staffIdx: 0,
      voiceIdx: 0,
      kind: 'pizz',
    }
    const onPatch = vi.fn<(p: TechniquePopoverPatch) => void>()
    render(
      <TechniquePopover
        open={true}
        anchorX={100}
        anchorY={100}
        markersAtPosition={[marker]}
        activeTechnique={'pizz'}
        onClose={() => {}}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pizzicato' }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'toggle', technique: 'pizz' })
  })

  it('aria-pressed reflects "marker at this position", not "currently active"', () => {
    // Active technique propagates from earlier marker; no marker AT
    // this exact position. The button must NOT show as pressed —
    // pressing it would insert a NEW marker, not remove the old one.
    const marker: TechniqueChange = {
      id: 'tech-pos-1234',
      measureIdx: 0,
      staffIdx: 0,
      voiceIdx: 0,
      kind: 'arco',
    }
    render(
      <TechniquePopover
        open={true}
        anchorX={100}
        anchorY={100}
        markersAtPosition={[marker]}
        activeTechnique={'pizz'} // propagating, not from this position
        onClose={() => {}}
        onPatch={() => {}}
      />,
    )
    const pizzBtn = screen.getByRole('button', { name: 'Pizzicato' })
    const arcoBtn = screen.getByRole('button', { name: 'Arco (cancels pizz.)' })
    expect(pizzBtn.getAttribute('aria-pressed')).toBe('false')
    expect(arcoBtn.getAttribute('aria-pressed')).toBe('true')
  })

  it('Escape closes the popover', () => {
    const onClose = vi.fn()
    render(
      <TechniquePopover
        open={true}
        anchorX={100}
        anchorY={100}
        markersAtPosition={[]}
        activeTechnique={undefined}
        onClose={onClose}
        onPatch={() => {}}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('NoteFloatingMenu — technique popover integration (M3-PR-4)', () => {
  beforeEach(() => seedWithSelection(TWO_BAR_BASS, { measureIdx: 0, eventIdx: 0 }))

  // Post-condensation: the "Performance technique" button now lives inside
  // the "Expression" category submenu. Click the trigger first so the
  // button is rendered, mirroring a real user. (Shift+P still opens the
  // dedicated popover directly without going through the submenu.)
  function openExpression() {
    fireEvent.click(screen.getByRole('button', { name: 'Expression' }))
  }

  it('clicking the toolbar technique button opens the popover', () => {
    render(<NoteFloatingMenu />)
    openExpression()
    fireEvent.click(screen.getByRole('button', { name: 'Performance technique' }))
    expect(screen.getByRole('dialog', { name: 'Performance technique' })).toBeDefined()
  })

  it('inserting via the popover writes a techniqueStates entry to the store', () => {
    render(<NoteFloatingMenu />)
    openExpression()
    fireEvent.click(screen.getByRole('button', { name: 'Performance technique' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pizzicato' }))
    const states = useChatStore.getState().editedScore?.techniqueStates
    expect(states).toHaveLength(1)
    expect(states![0].kind).toBe('pizz')
    expect(states![0].measureIdx).toBe(0)
    expect(states![0].eventIdx).toBe(0)
  })

  it('removing via the popover deletes the techniqueStates entry from the store', () => {
    const seeded: Score = {
      ...TWO_BAR_BASS,
      techniqueStates: [
        { id: 'tech-seed-12', measureIdx: 0, eventIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
      ],
    }
    seedWithSelection(seeded, { measureIdx: 0, eventIdx: 0 })
    render(<NoteFloatingMenu />)
    openExpression()
    fireEvent.click(screen.getByRole('button', { name: 'Performance technique' }))
    // The pizz button shows as active (marker at this position); click removes.
    fireEvent.click(screen.getByRole('button', { name: 'Pizzicato' }))
    expect(useChatStore.getState().editedScore?.techniqueStates).toBeUndefined()
  })

  it('toolbar button shows active state when a technique propagates from an earlier marker', () => {
    // pizz at m0 e0, selection at m1 e0 — pizz still active here.
    const seeded: Score = {
      ...TWO_BAR_BASS,
      techniqueStates: [
        { id: 'tech-prop-1', measureIdx: 0, eventIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
      ],
    }
    seedWithSelection(seeded, { measureIdx: 1, eventIdx: 0 })
    render(<NoteFloatingMenu />)
    openExpression()
    const btn = screen.getByRole('button', { name: 'Performance technique' })
    expect(btn.getAttribute('aria-pressed')).toBe('true')
  })

  it('Shift+P opens the popover', () => {
    render(<NoteFloatingMenu />)
    fireEvent.keyDown(document, { key: 'P', shiftKey: true })
    expect(screen.getByRole('dialog', { name: 'Performance technique' })).toBeDefined()
  })

  it('fast double-click on the same technique button toggles cleanly (insert then remove — no duplicates, no missing-id error)', () => {
    // Regression for the closure-staleness bug. Two clicks fire BEFORE
    // React re-renders the popover. With the old "popover pre-resolves
    // insert-vs-remove" model, both clicks see markersAtPosition=[]
    // and emit two inserts → two duplicate markers. With the toggle
    // model (caller resolves against live store state), the second
    // click sees the just-inserted marker and removes it.
    render(<NoteFloatingMenu />)
    openExpression()
    fireEvent.click(screen.getByRole('button', { name: 'Performance technique' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pizzicato' }))
    // Without re-rendering, click again.
    fireEvent.click(screen.getByRole('button', { name: 'Pizzicato' }))
    expect(useChatStore.getState().editedScore?.techniqueStates).toBeUndefined()
  })

  it('fast triple-click — insert, remove, insert — produces a single marker', () => {
    render(<NoteFloatingMenu />)
    openExpression()
    fireEvent.click(screen.getByRole('button', { name: 'Performance technique' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pizzicato' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pizzicato' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pizzicato' }))
    const states = useChatStore.getState().editedScore?.techniqueStates
    expect(states).toHaveLength(1)
    expect(states![0].kind).toBe('pizz')
  })

  it('Shift+P does not fire while typing in an input', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    render(<NoteFloatingMenu />)
    fireEvent.keyDown(input, { key: 'P', shiftKey: true })
    expect(screen.queryByRole('dialog', { name: 'Performance technique' })).toBeNull()
    document.body.removeChild(input)
  })
})
