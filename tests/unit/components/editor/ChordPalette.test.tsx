import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ChordPalette from '@/components/editor/ChordPalette'

afterEach(() => cleanup())

describe('ChordPalette', () => {
  it('renders the preview for the default Cmaj selection', () => {
    render(
      <ChordPalette
        open
        anchorX={400}
        anchorY={100}
        scoreKey="C"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByText('C Major')).toBeDefined()
    // C E G pitches in the preview line
    expect(screen.getByText(/C4 · E4 · G4/)).toBeDefined()
  })

  it('updates the preview when root + quality change', () => {
    render(
      <ChordPalette
        open
        anchorX={400}
        anchorY={100}
        scoreKey="C"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'D' }))
    fireEvent.click(screen.getByRole('button', { name: 'Min 7' }))
    expect(screen.getByText('D Min 7')).toBeDefined()
    // Dm7 = D F A C
    expect(screen.getByText(/D4 · F4 · A4 · C5/)).toBeDefined()
  })

  it('submits the built pitches and closes', () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    render(
      <ChordPalette
        open
        anchorX={400}
        anchorY={100}
        scoreKey="C"
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Maj 7' }))
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const pitches = onSubmit.mock.calls[0][0] as Array<{ step: string; octave: number }>
    expect(pitches.map((p) => p.step)).toEqual(['C', 'E', 'G', 'B'])
    expect(onClose).toHaveBeenCalled()
  })

  it('respects the initialRoot seed', () => {
    render(
      <ChordPalette
        open
        anchorX={400}
        anchorY={100}
        scoreKey="C"
        initialRoot={{ step: 'F', octave: 5, accidental: 'sharp' }}
        initialQuality="m7"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByText('F♯ Min 7')).toBeDefined()
    // F#m7 = F# A C# E, all rooted at octave 5
    expect(screen.getByText(/F♯5 · A5 · C♯6 · E6/)).toBeDefined()
  })

  it('uses the supplied submitLabel', () => {
    render(
      <ChordPalette
        open
        anchorX={400}
        anchorY={100}
        scoreKey="C"
        submitLabel="Replace"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDefined()
  })

  it('renders nothing when open is false', () => {
    const { container } = render(
      <ChordPalette
        open={false}
        anchorX={400}
        anchorY={100}
        scoreKey="C"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <ChordPalette
        open
        anchorX={400}
        anchorY={100}
        scoreKey="C"
        onClose={onClose}
        onSubmit={vi.fn()}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
