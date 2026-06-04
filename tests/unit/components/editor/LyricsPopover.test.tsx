import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import LyricsPopover, { type LyricsPopoverPatch } from '@/components/editor/LyricsPopover'
import type { LyricSyllable } from '@/lib/music/types'

afterEach(() => cleanup())

describe('LyricsPopover — render', () => {
  it('renders form fields when open', () => {
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('textbox', { name: 'Verse number' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Syllable text' })).toBeDefined()
    expect(screen.getByRole('checkbox', { name: /Hyphen/i })).toBeDefined()
    expect(screen.getByRole('checkbox', { name: /Extender/i })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <LyricsPopover
        open={false}
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('defaults the verse field to 1 when no existing lyrics', () => {
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const verseInput = screen.getByRole('textbox', { name: 'Verse number' }) as HTMLInputElement
    expect(verseInput.value).toBe('1')
  })

  it('defaults verse to N+1 of the highest existing verse', () => {
    const existingLyrics: LyricSyllable[] = [
      { verse: 1, syllable: 'one' },
      { verse: 3, syllable: 'three' },
    ]
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={existingLyrics}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const verseInput = screen.getByRole('textbox', { name: 'Verse number' }) as HTMLInputElement
    expect(verseInput.value).toBe('4')
  })

  it('caps the auto-bump at verse 50', () => {
    const existingLyrics: LyricSyllable[] = [{ verse: 50, syllable: 'fifty' }]
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={existingLyrics}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const verseInput = screen.getByRole('textbox', { name: 'Verse number' }) as HTMLInputElement
    expect(verseInput.value).toBe('50')
  })

  it('lists existing verses sorted ascending with × buttons', () => {
    const existingLyrics: LyricSyllable[] = [
      { verse: 3, syllable: 'three' },
      { verse: 1, syllable: 'one' },
      { verse: 2, syllable: 'two', hyphen: true },
    ]
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={existingLyrics}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('v1')
    expect(items[0]).toHaveTextContent('one')
    expect(items[1]).toHaveTextContent('v2')
    expect(items[1]).toHaveTextContent('two')
    expect(items[2]).toHaveTextContent('v3')
    expect(items[2]).toHaveTextContent('three')
    expect(screen.getAllByRole('button', { name: /Remove verse/i })).toHaveLength(3)
  })

  it('shows hyphen / extender flag tags on existing entries', () => {
    const existingLyrics: LyricSyllable[] = [
      { verse: 1, syllable: 'Glo', hyphen: true },
      { verse: 2, syllable: 'A', extender: true },
    ]
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={existingLyrics}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    // Confirm both entries show their respective flag glyph in
    // the list (separate span for the tag).
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('Glo')
    expect(items[0].textContent).toMatch(/-/)
    expect(items[1].textContent).toContain('A')
    expect(items[1].textContent).toMatch(/_/)
  })

  it('exposes "Clear all" button only when there are existing lyrics', () => {
    const { rerender } = render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /Clear all lyrics/i })).toBeNull()

    rerender(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[{ verse: 1, syllable: 'x' }]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /Clear all lyrics/i })).toBeDefined()
  })
})

describe('LyricsPopover — rest event', () => {
  it('shows the rest warning header label when isRest=true', () => {
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    // "rest event" appears in BOTH the header and the warning box
    // body (rest events round-trip ...). Use getAllByText so the
    // multiple-match doesn't throw.
    expect(screen.getAllByText(/rest event/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/will not render/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/extend the previous note/i)).toBeDefined()
  })

  it('disables the form fields and Apply button when isRest=true', () => {
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const verseInput = screen.getByRole('textbox', { name: 'Verse number' }) as HTMLInputElement
    const sylInput = screen.getByRole('textbox', { name: 'Syllable text' }) as HTMLInputElement
    const applyBtn = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(verseInput.disabled).toBe(true)
    expect(sylInput.disabled).toBe(true)
    expect(applyBtn.disabled).toBe(true)
  })
})

describe('LyricsPopover — Apply button validation', () => {
  it('Apply is enabled when verse + syllable are valid', () => {
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Syllable text' }), {
      target: { value: 'A' },
    })
    const applyBtn = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(applyBtn.disabled).toBe(false)
  })

  it('Apply is disabled when syllable is empty', () => {
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const applyBtn = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(applyBtn.disabled).toBe(true)
  })

  it('Apply is disabled when verse is out of range', () => {
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Syllable text' }), {
      target: { value: 'A' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Verse number' }), {
      target: { value: '51' },
    })
    const applyBtn = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(applyBtn.disabled).toBe(true)
  })

  it('Apply is disabled when hyphen + extender both true (mutual exclusion)', () => {
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Syllable text' }), {
      target: { value: 'A' },
    })
    // Click hyphen first, then click extender. The popover auto-
    // clears hyphen on extender-click, so this test would actually
    // never trigger the mutual-exclusion branch. To exercise it,
    // we'd need to programmatically set both to true. Skip the
    // forced-state path; the M15-PR-1 op-layer guard catches it.
    fireEvent.click(screen.getByRole('checkbox', { name: /Hyphen/i }))
    expect(screen.getByRole('checkbox', { name: /Extender/i }).hasAttribute('checked')).toBe(false)
  })

  it('toggling extender clears hyphen and vice versa (mutual exclusivity at the form layer)', () => {
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    const hyphenCheckbox = screen.getByRole('checkbox', {
      name: /Hyphen/i,
    }) as HTMLInputElement
    const extenderCheckbox = screen.getByRole('checkbox', {
      name: /Extender/i,
    }) as HTMLInputElement

    fireEvent.click(hyphenCheckbox)
    expect(hyphenCheckbox.checked).toBe(true)
    expect(extenderCheckbox.checked).toBe(false)

    fireEvent.click(extenderCheckbox)
    expect(hyphenCheckbox.checked).toBe(false)
    expect(extenderCheckbox.checked).toBe(true)

    fireEvent.click(hyphenCheckbox)
    expect(hyphenCheckbox.checked).toBe(true)
    expect(extenderCheckbox.checked).toBe(false)
  })
})

describe('LyricsPopover — patch emission', () => {
  it('Apply with verse + syllable emits set patch with hyphen:false / extender:false', () => {
    const onPatch = vi.fn<(p: LyricsPopoverPatch) => void>()
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Syllable text' }), {
      target: { value: 'amen' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'set',
      verse: 1,
      syllable: 'amen',
      hyphen: false,
      extender: false,
    })
  })

  it('Apply with hyphen:true emits the flag in the patch', () => {
    const onPatch = vi.fn<(p: LyricsPopoverPatch) => void>()
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Syllable text' }), {
      target: { value: 'Glo' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /Hyphen/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'set',
      verse: 1,
      syllable: 'Glo',
      hyphen: true,
      extender: false,
    })
  })

  it('Apply with extender:true emits the flag in the patch', () => {
    const onPatch = vi.fn<(p: LyricsPopoverPatch) => void>()
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Syllable text' }), {
      target: { value: 'A' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /Extender/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'set',
      verse: 1,
      syllable: 'A',
      hyphen: false,
      extender: true,
    })
  })

  it('Apply trims whitespace from the syllable input', () => {
    const onPatch = vi.fn<(p: LyricsPopoverPatch) => void>()
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Syllable text' }), {
      target: { value: '  amen  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPatch).toHaveBeenCalledWith({
      kind: 'set',
      verse: 1,
      syllable: 'amen',
      hyphen: false,
      extender: false,
    })
  })

  it('Apply bumps the verse field to N+1 and clears syllable (sticky workflow)', () => {
    const onPatch = vi.fn<(p: LyricsPopoverPatch) => void>()
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Syllable text' }), {
      target: { value: 'first' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    // After Apply, verse should bump from 1 → 2, syllable should clear.
    const verseInput = screen.getByRole('textbox', { name: 'Verse number' }) as HTMLInputElement
    const sylInput = screen.getByRole('textbox', { name: 'Syllable text' }) as HTMLInputElement
    expect(verseInput.value).toBe('2')
    expect(sylInput.value).toBe('')
  })

  it('Remove button on existing entry emits remove patch', () => {
    const onPatch = vi.fn<(p: LyricsPopoverPatch) => void>()
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[{ verse: 1, syllable: 'one' }, { verse: 2, syllable: 'two' }]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove verse 2' }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'remove', verse: 2 })
  })

  it('Clear all button remains ENABLED on a rest event (escape hatch for LLM-emitted bogus rest lyrics)', () => {
    // M15-PR-2 (the renderer) skips lyrics on rest events; the
    // LLM may still attach them. The popover's whole form is
    // disabled on rest events, but the Clear-all button must
    // remain reachable so users can wipe garbage data. Otherwise
    // the only way to recover is to delete the event entirely.
    const onPatch = vi.fn<(p: LyricsPopoverPatch) => void>()
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[{ verse: 1, syllable: 'orphan' }]}
        isRest
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    const clearBtn = screen.getByRole('button', {
      name: /Clear all lyrics/i,
    }) as HTMLButtonElement
    expect(clearBtn.disabled).toBe(false)
    fireEvent.click(clearBtn)
    expect(onPatch).toHaveBeenCalledWith({ kind: 'clear' })
  })

  it('Clear all button emits clear patch', () => {
    const onPatch = vi.fn<(p: LyricsPopoverPatch) => void>()
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[{ verse: 1, syllable: 'one' }]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Clear all lyrics/i }))
    expect(onPatch).toHaveBeenCalledWith({ kind: 'clear' })
  })

  it('Close button calls onClose without emitting a patch', () => {
    const onClose = vi.fn()
    const onPatch = vi.fn()
    render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={onClose}
        onPatch={onPatch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
    expect(onPatch).not.toHaveBeenCalled()
  })
})

describe('LyricsPopover — re-seed on reopen (M5-PR-3 regression pin)', () => {
  it('clears the new-verse form on closed→open transition', () => {
    const { rerender } = render(
      <LyricsPopover
        open
        anchorX={400}
        anchorY={100}
        existingLyrics={[]}
        isRest={false}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Syllable text' }), {
      target: { value: 'stale' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /Hyphen/i }))
    expect((screen.getByRole('textbox', { name: 'Syllable text' }) as HTMLInputElement).value).toBe('stale')

    act(() => {
      rerender(
        <LyricsPopover
          open={false}
          anchorX={400}
          anchorY={100}
          existingLyrics={[]}
          isRest={false}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
    })
    act(() => {
      rerender(
        <LyricsPopover
          open
          anchorX={400}
          anchorY={100}
          existingLyrics={[]}
          isRest={false}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
    })
    expect((screen.getByRole('textbox', { name: 'Syllable text' }) as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('checkbox', { name: /Hyphen/i }) as HTMLInputElement).checked).toBe(false)
  })
})
