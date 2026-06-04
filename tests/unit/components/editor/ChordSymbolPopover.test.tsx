import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ChordSymbolPopover from '@/components/editor/ChordSymbolPopover'

afterEach(() => cleanup())

describe('ChordSymbolPopover — render', () => {
  it('renders text input + Apply button when open', () => {
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByRole('textbox', { name: 'Chord symbol text' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <ChordSymbolPopover
        open={false}
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('seeds input with the provided initialText (canonical formatted form)', () => {
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        initialText="Cmaj7"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect((screen.getByRole('textbox', { name: 'Chord symbol text' }) as HTMLInputElement).value).toBe(
      'Cmaj7',
    )
  })

  it('shows Clear button when onClear is provided', () => {
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        initialText="Cmaj7"
        onClear={vi.fn()}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /clear/i })).toBeDefined()
  })

  it('omits Clear button when onClear is not provided', () => {
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull()
  })
})

describe('ChordSymbolPopover — Apply (parse)', () => {
  it('Apply disabled when input is empty', () => {
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('Apply enabled once text is valid', () => {
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Chord symbol text' }), {
      target: { value: 'Cmaj7' },
    })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(false)
  })

  it('emits the parsed structured chord on Apply', () => {
    const onSubmit = vi.fn()
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Chord symbol text' }), {
      target: { value: 'Cmaj7' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const chord = onSubmit.mock.calls[0][0]
    expect(chord.root).toBe('C')
    expect(chord.quality).toBe('major')
    expect(chord.seventh).toBe('maj7')
  })

  it('parses slash chord C/E with bass note', () => {
    const onSubmit = vi.fn()
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Chord symbol text' }), {
      target: { value: 'C/E' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const chord = onSubmit.mock.calls[0][0]
    expect(chord.bass).toEqual({ type: 'note', value: 'E' })
  })

  it('parses polychord C|G with nested chord bass', () => {
    const onSubmit = vi.fn()
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Chord symbol text' }), {
      target: { value: 'C|G' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const chord = onSubmit.mock.calls[0][0]
    expect(chord.bass?.type).toBe('chord')
    if (chord.bass?.type === 'chord') expect(chord.bass.value.root).toBe('G')
  })

  it('parses modal symbol C Mixolydian', () => {
    const onSubmit = vi.fn()
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Chord symbol text' }), {
      target: { value: 'C Mixolydian' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSubmit.mock.calls[0][0].modal).toBe('Mixolydian')
  })

  it('Apply disabled when input is unparseable (no root letter)', () => {
    // parseChordSymbol returns null for inputs like 'xyz' (no root
    // matches); the popover's strict wrapper treats null as parse-
    // failure.
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Chord symbol text' }), {
      target: { value: 'xyz' },
    })
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('STRICT mode: Apply disabled for lenient-parse garbage (Cxyz / Cmaj7junk / C@@)', () => {
    // M10-PR-5 review fix: the bare parser accepts any input with a
    // valid root letter and silently drops the unconsumed remainder
    // into the `display` field. That's right for LLM emissions
    // (preserve unfamiliar input) but wrong for UI typing where the
    // user almost certainly means "I made a typo". The strict
    // wrapper requires formatChordSymbol(parse(s)) to round-trip
    // exactly (modulo whitespace) — otherwise reject.
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Chord symbol text' }) as HTMLInputElement
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    for (const garbage of ['Cxyz', 'Cmaj7junk', 'C@@', 'D7sus@']) {
      fireEvent.change(input, { target: { value: garbage } })
      expect(apply.disabled).toBe(true)
    }
  })

  it('STRICT mode: Apply enabled for canonical forms even with extra whitespace', () => {
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Chord symbol text' }) as HTMLInputElement
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    for (const ok of ['Cmaj7', '  Cmaj7  ', 'F#m7b5', 'C Mixolydian']) {
      fireEvent.change(input, { target: { value: ok } })
      expect(apply.disabled).toBe(false)
    }
  })

  it('Enter submits when input is valid', () => {
    const onSubmit = vi.fn()
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Chord symbol text' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'F#m7b5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalled()
    expect(onSubmit.mock.calls[0][0].root).toBe('F#')
  })
})

describe('ChordSymbolPopover — Clear', () => {
  it('Clear button calls onClear', () => {
    const onClear = vi.fn()
    render(
      <ChordSymbolPopover
        open
        anchorX={400}
        anchorY={100}
        initialText="Cmaj7"
        onClear={onClear}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /clear/i }))
    expect(onClear).toHaveBeenCalled()
  })
})
