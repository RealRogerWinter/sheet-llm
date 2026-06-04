import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import OrnamentMenuPopover from '@/components/editor/OrnamentMenuPopover'

afterEach(() => cleanup())

const EMPTY_CURRENT = {
  ornament: undefined,
  trillUpperPitch: undefined,
  tremolo: undefined,
  jazzInflection: undefined,
} as const

describe('OrnamentMenuPopover', () => {
  it('renders all sections when open', () => {
    render(
      <OrnamentMenuPopover
        open
        anchorX={400}
        anchorY={100}
        current={EMPTY_CURRENT}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.getByRole('group', { name: 'Ornament' })).toBeDefined()
    expect(screen.getByRole('group', { name: 'Tremolo' })).toBeDefined()
    expect(screen.getByRole('group', { name: 'Jazz inflection' })).toBeDefined()
  })

  it('does not render when open=false', () => {
    render(
      <OrnamentMenuPopover
        open={false}
        anchorX={400}
        anchorY={100}
        current={EMPTY_CURRENT}
        onClose={vi.fn()}
        onPatch={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  describe('ornament selection', () => {
    it('clicking an inactive ornament emits a set patch with that value', () => {
      const onPatch = vi.fn()
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={EMPTY_CURRENT}
          onClose={vi.fn()}
          onPatch={onPatch}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Pralltriller' }))
      expect(onPatch).toHaveBeenCalledWith({ kind: 'ornament', ornament: 'pralltriller' })
    })

    it('clicking the ACTIVE ornament emits a clear patch (none)', () => {
      const onPatch = vi.fn()
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, ornament: 'trill' }}
          onClose={vi.fn()}
          onPatch={onPatch}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Trill' }))
      expect(onPatch).toHaveBeenCalledWith({ kind: 'ornament', ornament: 'none' })
    })

    it('active ornament is highlighted via aria-pressed', () => {
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, ornament: 'upper-mordent' }}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
      const upper = screen.getByRole('button', { name: 'Upper mordent' })
      expect(upper.getAttribute('aria-pressed')).toBe('true')
      const lower = screen.getByRole('button', { name: 'Lower mordent' })
      expect(lower.getAttribute('aria-pressed')).toBe('false')
    })

    it('exposes all 14 ornament options (including non-arpeggio and the Baroque variants)', () => {
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={EMPTY_CURRENT}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
      const ornamentGroup = screen.getByRole('group', { name: 'Ornament' })
      const buttons = ornamentGroup.querySelectorAll('button')
      expect(buttons.length).toBe(14) // 15 enum values minus 'none' which is implicit via click-active-to-clear
    })

    it('renders the family subgroup labels visibly', () => {
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={EMPTY_CURRENT}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
      // Each family is labeled within the Ornament group. The subgroups
      // are visual dividers, not ARIA groups (one outer aria-label
      // 'Ornament' covers them all for tab order) — so we assert their
      // labels appear in the group's textContent.
      const ornamentGroup = screen.getByRole('group', { name: 'Ornament' })
      const text = ornamentGroup.textContent ?? ''
      for (const label of ['Trill', 'Mordent', 'Turn', 'Arpeggio', 'Other']) {
        expect(text).toContain(label)
      }
    })
  })

  describe('trillUpperPitch picker', () => {
    it('is hidden when no ornament is active', () => {
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={EMPTY_CURRENT}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
      expect(screen.queryByRole('group', { name: 'Trill upper pitch' })).toBeNull()
    })

    it('is hidden when a non-trill ornament is active', () => {
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, ornament: 'mordent' }}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
      expect(screen.queryByRole('group', { name: 'Trill upper pitch' })).toBeNull()
    })

    it('is shown when trill is active', () => {
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, ornament: 'trill' }}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
      expect(screen.getByRole('group', { name: 'Trill upper pitch' })).toBeDefined()
    })

    it('is shown when pralltriller is active', () => {
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, ornament: 'pralltriller' }}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
      expect(screen.getByRole('group', { name: 'Trill upper pitch' })).toBeDefined()
    })

    it('clicking an accidental emits a set patch with that value', () => {
      const onPatch = vi.fn()
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, ornament: 'trill' }}
          onClose={vi.fn()}
          onPatch={onPatch}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Sharp upper auxiliary' }))
      expect(onPatch).toHaveBeenCalledWith({ kind: 'trillUpperPitch', trillUpperPitch: 'sharp' })
    })

    it('clicking the ACTIVE accidental clears it', () => {
      const onPatch = vi.fn()
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, ornament: 'trill', trillUpperPitch: 'flat' }}
          onClose={vi.fn()}
          onPatch={onPatch}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Flat upper auxiliary' }))
      expect(onPatch).toHaveBeenCalledWith({ kind: 'trillUpperPitch' })
    })

    it('exposes all 5 accidentals (natural/sharp/flat/dblsharp/dblflat)', () => {
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, ornament: 'trill' }}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
      const group = screen.getByRole('group', { name: 'Trill upper pitch' })
      const buttons = group.querySelectorAll('button')
      expect(buttons.length).toBe(5)
      for (const label of [
        'Natural upper auxiliary',
        'Sharp upper auxiliary',
        'Flat upper auxiliary',
        'Double-sharp upper auxiliary',
        'Double-flat upper auxiliary',
      ]) {
        expect(screen.getByRole('button', { name: label })).toBeDefined()
      }
    })

    it('an ornament click ALWAYS emits a single ornament patch (auto-clear of trillUpperPitch happens at the caller)', () => {
      // Decoupling check: the popover never multi-patches on ornament
      // selection. The caller (NoteFloatingMenu) is responsible for
      // dispatching the auto-clear of an orphan trillUpperPitch by
      // re-reading live store state — covered in NoteFloatingMenu.
      // markings.test.tsx.
      const onPatch = vi.fn()
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, ornament: 'trill', trillUpperPitch: 'sharp' }}
          onClose={vi.fn()}
          onPatch={onPatch}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Mordent' }))
      expect(onPatch).toHaveBeenCalledTimes(1)
      expect(onPatch).toHaveBeenCalledWith({ kind: 'ornament', ornament: 'mordent' })
    })

    it('active accidental is highlighted via aria-pressed', () => {
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, ornament: 'trill', trillUpperPitch: 'dblsharp' }}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
      const dblsharp = screen.getByRole('button', { name: 'Double-sharp upper auxiliary' })
      expect(dblsharp.getAttribute('aria-pressed')).toBe('true')
      const sharp = screen.getByRole('button', { name: 'Sharp upper auxiliary' })
      expect(sharp.getAttribute('aria-pressed')).toBe('false')
    })
  })

  describe('tremolo selection', () => {
    it('clicking a slash count emits a tremolo set patch with measured=true by default', () => {
      const onPatch = vi.fn()
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={EMPTY_CURRENT}
          onClose={vi.fn()}
          onPatch={onPatch}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: '3 slashes' }))
      expect(onPatch).toHaveBeenCalledWith({
        kind: 'tremolo',
        tremolo: { slashes: 3, measured: true },
      })
    })

    it('clicking the ACTIVE slash count clears the tremolo', () => {
      const onPatch = vi.fn()
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, tremolo: { slashes: 2 } }}
          onClose={vi.fn()}
          onPatch={onPatch}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: '2 slashes' }))
      expect(onPatch).toHaveBeenCalledWith({ kind: 'tremolo' })
    })

    it('measured checkbox toggles the measured flag and preserves slashes', () => {
      const onPatch = vi.fn()
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, tremolo: { slashes: 4, measured: true } }}
          onClose={vi.fn()}
          onPatch={onPatch}
        />,
      )
      const measured = screen.getByRole('checkbox') as HTMLInputElement
      fireEvent.click(measured)
      expect(onPatch).toHaveBeenCalledWith({
        kind: 'tremolo',
        tremolo: { slashes: 4, measured: false },
      })
    })

    it('measured checkbox is disabled when no slashes are active', () => {
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={EMPTY_CURRENT}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
      const measured = screen.getByRole('checkbox') as HTMLInputElement
      expect(measured.disabled).toBe(true)
    })

    it('exposes all 5 slash counts', () => {
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={EMPTY_CURRENT}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
      for (const n of [1, 2, 3, 4, 5]) {
        expect(
          screen.getByRole('button', { name: `${n} slash${n === 1 ? '' : 'es'}` }),
        ).toBeDefined()
      }
    })
  })

  describe('jazz inflection selection', () => {
    it('clicking an inflection emits a set patch with that value', () => {
      const onPatch = vi.fn()
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={EMPTY_CURRENT}
          onClose={vi.fn()}
          onPatch={onPatch}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'fall' }))
      expect(onPatch).toHaveBeenCalledWith({ kind: 'jazzInflection', jazzInflection: 'fall' })
    })

    it('clicking the active inflection clears it', () => {
      const onPatch = vi.fn()
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{ ...EMPTY_CURRENT, jazzInflection: 'ghost' }}
          onClose={vi.fn()}
          onPatch={onPatch}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'ghost' }))
      expect(onPatch).toHaveBeenCalledWith({ kind: 'jazzInflection' })
    })

    it('exposes all 5 inflections', () => {
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={EMPTY_CURRENT}
          onClose={vi.fn()}
          onPatch={vi.fn()}
        />,
      )
      for (const v of ['fall', 'doit', 'scoop', 'plop', 'ghost']) {
        expect(screen.getByRole('button', { name: v })).toBeDefined()
      }
    })
  })

  describe('Clear all', () => {
    it('emits clear patches for all four groups', () => {
      const onPatch = vi.fn()
      render(
        <OrnamentMenuPopover
          open
          anchorX={400}
          anchorY={100}
          current={{
            ornament: 'trill',
            trillUpperPitch: 'sharp',
            tremolo: { slashes: 2 },
            jazzInflection: 'fall',
          }}
          onClose={vi.fn()}
          onPatch={onPatch}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
      expect(onPatch).toHaveBeenCalledTimes(4)
      expect(onPatch).toHaveBeenNthCalledWith(1, { kind: 'ornament', ornament: 'none' })
      expect(onPatch).toHaveBeenNthCalledWith(2, { kind: 'trillUpperPitch' })
      expect(onPatch).toHaveBeenNthCalledWith(3, { kind: 'tremolo' })
      expect(onPatch).toHaveBeenNthCalledWith(4, { kind: 'jazzInflection' })
    })
  })

  it('Done button closes', () => {
    const onClose = vi.fn()
    render(
      <OrnamentMenuPopover
        open
        anchorX={400}
        anchorY={100}
        current={EMPTY_CURRENT}
        onClose={onClose}
        onPatch={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalled()
  })
})
