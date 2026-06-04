import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import EditorToolbar from '@/components/editor/EditorToolbar'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

afterEach(() => cleanup())

const SCORE: Score = {
  title: 'Sketch',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

function seed(score: Score) {
  useChatStore.setState({
    editedScore: score,
    scoreJson: score,
    history: [score],
    historyPointer: 0,
    selection: undefined,
    error: undefined,
  })
}

describe('EditorToolbar — Score Info (M8-PR-5)', () => {
  beforeEach(() => seed(SCORE))

  it('Score Info toolbar button opens the popover', () => {
    render(<EditorToolbar />)
    expect(screen.queryByRole('dialog', { name: 'Score info' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Score info' }))
    expect(screen.getByRole('dialog', { name: 'Score info' })).toBeDefined()
  })

  it('Save with changes dispatches setScoreMetadata and updates the store', () => {
    render(<EditorToolbar />)
    fireEvent.click(screen.getByRole('button', { name: 'Score info' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Composer' }), {
      target: { value: 'J. S. Bach' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Copyright' }), {
      target: { value: 'Public Domain' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const score = useChatStore.getState().editedScore!
    expect(score.composer).toBe('J. S. Bach')
    expect(score.copyright).toBe('Public Domain')
    expect(score.title).toBe('Sketch') // untouched fields preserved
  })

  it('clearing the title sets it to undefined (null patch → strips the field)', () => {
    render(<EditorToolbar />)
    fireEvent.click(screen.getByRole('button', { name: 'Score info' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const score = useChatStore.getState().editedScore!
    expect(score).not.toHaveProperty('title')
  })

  it('Cancel after opening with no changes adds no history entry', () => {
    // Save is disabled when there are no changes; the user closes via
    // Cancel. Locks the no-spurious-undo-entry invariant for the
    // common "I opened by mistake" case. (The empty-patch guard in
    // EditorToolbar's onSubmit is defensive code for future popover
    // changes that might emit {} — not exercised here.)
    render(<EditorToolbar />)
    const beforeLen = useChatStore.getState().history.length
    fireEvent.click(screen.getByRole('button', { name: 'Score info' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useChatStore.getState().history.length).toBe(beforeLen)
  })

  it('seed re-fills the popover with the current score values', () => {
    seed({ ...SCORE, composer: 'Bach', copyright: '© 2026' })
    render(<EditorToolbar />)
    fireEvent.click(screen.getByRole('button', { name: 'Score info' }))
    expect((screen.getByRole('textbox', { name: 'Composer' }) as HTMLInputElement).value).toBe('Bach')
    expect((screen.getByRole('textbox', { name: 'Copyright' }) as HTMLInputElement).value).toBe('© 2026')
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Sketch')
  })

  it('multi-field edit lands as a single undo entry (atomic patch)', () => {
    render(<EditorToolbar />)
    const beforeHistoryLen = useChatStore.getState().history.length
    fireEvent.click(screen.getByRole('button', { name: 'Score info' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Composer' }), {
      target: { value: 'Bach' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Lyricist' }), {
      target: { value: 'Picander' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Copyright' }), {
      target: { value: 'Public Domain' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // Exactly ONE history entry was added for the three-field change.
    expect(useChatStore.getState().history.length).toBe(beforeHistoryLen + 1)
  })
})
