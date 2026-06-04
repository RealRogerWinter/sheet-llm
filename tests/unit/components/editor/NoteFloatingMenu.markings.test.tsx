import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import NoteFloatingMenu from '@/components/editor/NoteFloatingMenu'
import { useChatStore } from '@/lib/chat/state'
import type { Score } from '@/lib/music/types'

afterEach(() => cleanup())

const FOUR_BARS_OF_QUARTERS: Score = {
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

function seedWithSelection(score: Score) {
  useChatStore.setState({
    editedScore: score,
    scoreJson: score,
    history: [score],
    historyPointer: 0,
    selection: { measureIdx: 0, eventIdx: 0 },
    error: undefined,
  })
}

function currentEvent() {
  return useChatStore.getState().editedScore!.measures[0].events[0]
}

// Post-condensation (category submenus): most actions now live inside a
// SubMenu popover keyed off a labeled trigger in the inline row. These
// helpers click the category trigger so the grouped action button is
// rendered, mirroring what a user does. Inline core actions (play /
// accidentals / durations / add / delete) need no opener.
function openArticulation() {
  fireEvent.click(screen.getByRole('button', { name: 'Articulation' }))
}
function openDynamics() {
  fireEvent.click(screen.getByRole('button', { name: 'Expression' }))
}
function openText() {
  fireEvent.click(screen.getByRole('button', { name: 'Text' }))
}

describe('NoteFloatingMenu — per-note marking toggles (M2-PR-5a)', () => {
  beforeEach(() => seedWithSelection(FOUR_BARS_OF_QUARTERS))

  describe('articulation stacking toggles', () => {
    it('clicking staccato adds it to the empty articulation set', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Staccato' }))
      expect(currentEvent().articulations).toEqual(['staccato'])
    })

    it('clicking an active articulation removes it (toggle off)', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Staccato' }))
      // Re-render now sees the updated store state.
      cleanup()
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: /Staccato/ }))
      expect(currentEvent()).not.toHaveProperty('articulations')
    })

    it('stacking staccato + accent leaves both in canonical order', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Staccato' }))
      cleanup()
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Accent' }))
      expect(currentEvent().articulations).toEqual(['staccato', 'accent'])
    })

    it('marcato+accent is silently no-op (engraving incoherence rejected by normalize)', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Marcato' }))
      cleanup()
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Accent' }))
      // Marcato stays; accent doesn't get added.
      expect(currentEvent().articulations).toEqual(['marcato'])
    })

    it('staccato+tenuto auto-coerces to portato (compound glyph)', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Staccato' }))
      cleanup()
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Tenuto' }))
      expect(currentEvent().articulations).toEqual(['portato'])
    })

    it('active state reflects the current articulation set', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  articulations: ['staccato', 'accent'],
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
      })
      render(<NoteFloatingMenu />)
      openArticulation()
      const staccatoBtn = screen.getByRole('button', { name: /Staccato/ })
      expect(staccatoBtn.getAttribute('aria-pressed')).toBe('true')
      const accentBtn = screen.getByRole('button', { name: /Accent/ })
      expect(accentBtn.getAttribute('aria-pressed')).toBe('true')
      const tenutoBtn = screen.getByRole('button', { name: /Tenuto/ })
      expect(tenutoBtn.getAttribute('aria-pressed')).toBe('false')
    })
  })

  describe('fermata toggle', () => {
    it('off → standard on first click', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Fermata' }))
      expect(currentEvent().fermata).toBe('standard')
    })

    it('on → off on second click (clears the field)', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Fermata' }))
      cleanup()
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: /Fermata/ }))
      expect(currentEvent()).not.toHaveProperty('fermata')
    })
  })

  describe('breath mark + caesura toggles', () => {
    it('breath mark toggles on and off', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Breath mark' }))
      expect(currentEvent().breathMark).toBe(true)
      cleanup()
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: /Breath mark/ }))
      expect(currentEvent()).not.toHaveProperty('breathMark')
    })

    it('caesura toggles on and off', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Caesura' }))
      expect(currentEvent().caesura).toBe(true)
      cleanup()
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: /Caesura/ }))
      expect(currentEvent()).not.toHaveProperty('caesura')
    })
  })

  describe('rapid-click safety (regression: closure-stale `current`)', () => {
    it('two rapid articulation clicks without a re-render between them both land', () => {
      // Simulates the production hazard: click Staccato, then Accent,
      // before React has flushed the re-render. The second handler's
      // closure still sees `current = []` from the original render —
      // but since the toggle reads fresh from the store via
      // useChatStore.getState(), it picks up the staccato written by
      // click 1 and stacks accent on top.
      render(<NoteFloatingMenu />)
      // Both toggles live in the Articulation submenu — toggle buttons
      // keep it open, so a single open before the rapid clicks suffices.
      openArticulation()
      // Don't cleanup() / re-render between clicks; mirror the rapid
      // double-click hazard the reviewer flagged.
      fireEvent.click(screen.getByRole('button', { name: 'Staccato' }))
      fireEvent.click(screen.getByRole('button', { name: 'Accent' }))
      expect(currentEvent().articulations).toEqual(['staccato', 'accent'])
    })

    it('two rapid toggle-OFF clicks without re-render remove both articulations', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  articulations: ['staccato', 'accent'],
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
      })
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: /Staccato/ }))
      fireEvent.click(screen.getByRole('button', { name: /Accent/ }))
      expect(currentEvent()).not.toHaveProperty('articulations')
    })
  })

  describe('dynamics popover wiring (M2-PR-5b)', () => {
    it('clicking the Dynamics button opens the popover', () => {
      render(<NoteFloatingMenu />)
      expect(screen.queryByRole('dialog', { name: 'Dynamics' })).toBeNull()
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Dynamics' }))
      expect(screen.getByRole('dialog', { name: 'Dynamics' })).toBeDefined()
    })

    it('Shift+D opens the popover when an event is selected', () => {
      render(<NoteFloatingMenu />)
      expect(screen.queryByRole('dialog', { name: 'Dynamics' })).toBeNull()
      fireEvent.keyDown(document, { key: 'D', shiftKey: true })
      expect(screen.getByRole('dialog', { name: 'Dynamics' })).toBeDefined()
    })

    it('Shift+D does NOT open the popover when an input is focused (typing-safety)', () => {
      render(
        <>
          <input data-testid="prompt" />
          <NoteFloatingMenu />
        </>,
      )
      const promptInput = screen.getByTestId('prompt')
      promptInput.focus()
      fireEvent.keyDown(promptInput, { key: 'D', shiftKey: true })
      expect(screen.queryByRole('dialog', { name: 'Dynamics' })).toBeNull()
    })

    it('submitting a simple dynamic dispatches setDynamic', () => {
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Dynamics' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Dynamic text' }), {
        target: { value: 'mf' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      expect(currentEvent().dynamic).toBe('mf')
      expect(currentEvent()).not.toHaveProperty('dynamic_structured')
    })

    it('submitting a compound dynamic dispatches setDynamicStructured', () => {
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Dynamics' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Dynamic text' }), {
        target: { value: 'sub. p espressivo' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      expect(currentEvent().dynamic_structured).toEqual({
        base: 'p',
        prefix: 'sub.',
        suffix: 'espressivo',
      })
    })

    it('seeds the popover input with the current compound dynamic when reopened', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  dynamic_structured: { base: 'f', prefix: 'sub.', suffix: 'marcato' },
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
      })
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Dynamics' }))
      const input = screen.getByRole('textbox', { name: 'Dynamic text' }) as HTMLInputElement
      expect(input.value).toBe('sub. f marcato')
    })
  })

  describe('ornament/tremolo/jazz inflection popover wiring (M2-PR-5c)', () => {
    it('clicking the Ornament menu button opens the popover', () => {
      render(<NoteFloatingMenu />)
      expect(
        screen.queryByRole('dialog', { name: 'Ornament, tremolo, jazz inflection' }),
      ).toBeNull()
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Ornament menu' }))
      expect(
        screen.getByRole('dialog', { name: 'Ornament, tremolo, jazz inflection' }),
      ).toBeDefined()
    })

    it('Shift+O opens the popover when an event is selected (M6-PR-2)', () => {
      render(<NoteFloatingMenu />)
      expect(
        screen.queryByRole('dialog', { name: 'Ornament, tremolo, jazz inflection' }),
      ).toBeNull()
      fireEvent.keyDown(document, { key: 'O', shiftKey: true })
      expect(
        screen.getByRole('dialog', { name: 'Ornament, tremolo, jazz inflection' }),
      ).toBeDefined()
    })

    it('Shift+O does NOT open the popover when an input is focused (typing-safety)', () => {
      render(
        <>
          <input data-testid="prompt" />
          <NoteFloatingMenu />
        </>,
      )
      const promptInput = screen.getByTestId('prompt')
      promptInput.focus()
      fireEvent.keyDown(promptInput, { key: 'O', shiftKey: true })
      expect(
        screen.queryByRole('dialog', { name: 'Ornament, tremolo, jazz inflection' }),
      ).toBeNull()
    })

    it("toolbar button title surfaces the Shift+O shortcut", () => {
      render(<NoteFloatingMenu />)
      openDynamics()
      const button = screen.getByRole('button', { name: 'Ornament menu' })
      expect(button.getAttribute('title')).toMatch(/Shift\+O/)
    })

    it('selecting an ornament dispatches setOrnament', () => {
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Ornament menu' }))
      fireEvent.click(screen.getByRole('button', { name: 'Trill' }))
      expect(currentEvent().ornament).toBe('trill')
    })

    it('selecting tremolo slashes dispatches setTremolo with measured=true', () => {
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Ornament menu' }))
      fireEvent.click(screen.getByRole('button', { name: '3 slashes' }))
      expect(currentEvent().tremolo).toEqual({ slashes: 3, measured: true })
    })

    it('selecting a jazz inflection dispatches setJazzInflection', () => {
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Ornament menu' }))
      fireEvent.click(screen.getByRole('button', { name: 'fall' }))
      expect(currentEvent().jazzInflection).toBe('fall')
    })

    it('Clear all wipes all three groups from the event', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  ornament: 'trill',
                  tremolo: { slashes: 2, measured: true },
                  jazzInflection: 'fall',
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
      })
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Ornament menu' }))
      fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
      const e = currentEvent()
      // ornament is stored as the literal 'none' sentinel (per setOrnament's contract).
      expect(e.ornament).toBe('none')
      expect(e).not.toHaveProperty('tremolo')
      expect(e).not.toHaveProperty('jazzInflection')
    })

    it('trigger button shows active state when any of the three fields is set', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  jazzInflection: 'ghost',
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
      })
      render(<NoteFloatingMenu />)
      openDynamics()
      const button = screen.getByRole('button', { name: 'Ornament menu' })
      expect(button.getAttribute('aria-pressed')).toBe('true')
    })
  })

  describe('M6-PR-1: trillUpperPitch auto-clear when leaving the trill family', () => {
    it('selecting a non-trill ornament on an event with a stale trillUpperPitch clears the accidental in the same gesture', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  ornament: 'trill',
                  trillUpperPitch: 'sharp',
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
      })
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Ornament menu' }))
      fireEvent.click(screen.getByRole('button', { name: 'Mordent' }))
      const e = currentEvent()
      expect(e.ornament).toBe('mordent')
      expect(e).not.toHaveProperty('trillUpperPitch')
    })

    it('toggling a trill-family ornament OFF also clears any orphan trillUpperPitch', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  ornament: 'pralltriller',
                  trillUpperPitch: 'natural',
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
      })
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Ornament menu' }))
      fireEvent.click(screen.getByRole('button', { name: 'Pralltriller' }))
      const e = currentEvent()
      expect(e.ornament).toBe('none')
      expect(e).not.toHaveProperty('trillUpperPitch')
    })

    it('switching between two trill-family ornaments PRESERVES the trillUpperPitch (accidental still meaningful)', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  ornament: 'trill',
                  trillUpperPitch: 'flat',
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
      })
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Ornament menu' }))
      fireEvent.click(screen.getByRole('button', { name: 'Pralltriller' }))
      const e = currentEvent()
      expect(e.ornament).toBe('pralltriller')
      expect(e.trillUpperPitch).toBe('flat')
    })

    it('selecting a non-trill ornament on an event with NO trillUpperPitch leaves the field absent (no spurious clear op)', () => {
      // The auto-clear branch must short-circuit when the live event
      // has no trillUpperPitch — otherwise we'd dispatch a useless
      // setTrillUpperPitch on every mordent/turn selection.
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  ornament: 'mordent',
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
      })
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Ornament menu' }))
      fireEvent.click(screen.getByRole('button', { name: 'Turn' }))
      const e = currentEvent()
      expect(e.ornament).toBe('turn')
      expect(e).not.toHaveProperty('trillUpperPitch')
    })

    it('selecting the trillUpperPitch accidental dispatches setTrillUpperPitch', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  ornament: 'trill',
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
      })
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Ornament menu' }))
      fireEvent.click(screen.getByRole('button', { name: 'Sharp upper auxiliary' }))
      expect(currentEvent().trillUpperPitch).toBe('sharp')
    })

    it('Clear all also clears trillUpperPitch', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  ornament: 'trill',
                  trillUpperPitch: 'sharp',
                  tremolo: { slashes: 2, measured: true },
                  jazzInflection: 'fall',
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
      })
      render(<NoteFloatingMenu />)
      openDynamics()
      fireEvent.click(screen.getByRole('button', { name: 'Ornament menu' }))
      fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
      const e = currentEvent()
      expect(e.ornament).toBe('none')
      expect(e).not.toHaveProperty('trillUpperPitch')
      expect(e).not.toHaveProperty('tremolo')
      expect(e).not.toHaveProperty('jazzInflection')
    })
  })

  describe('rest-event guards', () => {
    it('bowing buttons are disabled when the event is a rest', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter' },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
      })
      render(<NoteFloatingMenu />)
      openArticulation()
      const upBow = screen.getByRole('button', { name: 'Up-bow' }) as HTMLButtonElement
      const downBow = screen.getByRole('button', { name: 'Down-bow' }) as HTMLButtonElement
      expect(upBow.disabled).toBe(true)
      expect(downBow.disabled).toBe(true)
    })
  })

  describe('bowing toggles (mutually exclusive up vs. down)', () => {
    it('clicking Up-bow sets bowing=up', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Up-bow' }))
      expect(currentEvent().bowing).toBe('up')
    })

    it('clicking Down-bow sets bowing=down', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Down-bow' }))
      expect(currentEvent().bowing).toBe('down')
    })

    it('clicking the active bowing direction clears it', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Up-bow' }))
      cleanup()
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: /Up-bow/ }))
      expect(currentEvent()).not.toHaveProperty('bowing')
    })

    it('clicking the OTHER bowing direction switches (no need to clear first)', () => {
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Up-bow' }))
      cleanup()
      render(<NoteFloatingMenu />)
      openArticulation()
      fireEvent.click(screen.getByRole('button', { name: 'Down-bow' }))
      expect(currentEvent().bowing).toBe('down')
    })
  })

  describe('fingering button + Shift+F popover (M5-PR-3)', () => {
    it('toolbar ✋ button opens the FingeringPopover', () => {
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Fingering' })
      fireEvent.click(btn)
      expect(screen.getByRole('dialog', { name: 'Fingering' })).toBeDefined()
    })

    it('Shift+F (capture-phase document keydown) opens the popover', () => {
      render(<NoteFloatingMenu />)
      // Dispatch on document, no input focused — the hook's capture
      // listener should fire even though useEditorKeyboard isn't mounted
      // in this test, exercising the document-level path.
      fireEvent.keyDown(document, { key: 'F', shiftKey: true })
      expect(screen.getByRole('dialog', { name: 'Fingering' })).toBeDefined()
    })

    it('Apply on a parsed input dispatches setFingering on the selected pitch', () => {
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Fingering' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Fingering text' }), {
        target: { value: '3' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      expect(currentEvent().fingerings).toEqual([{ system: 'piano', value: '3' }])
    })

    it('active toolbar state when the focused pitch has a fingering', () => {
      // Seed with a fingering on the first event.
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  fingerings: [{ system: 'piano', value: '3' }],
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Fingering' })
      expect(btn.getAttribute('aria-pressed')).toBe('true')
    })

    it('the popover pre-fills with the focused pitch\'s current fingering', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  fingerings: [{ system: 'string', finger: 4, stringRoman: 'III' }],
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Fingering' }))
      const input = screen.getByRole('textbox', { name: 'Fingering text' }) as HTMLInputElement
      expect(input.value).toBe('4.III')
    })

    it('Clear button dispatches removeFingering when an existing fingering is present', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  fingerings: [{ system: 'piano', value: '5' }],
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Fingering' }))
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
      expect(currentEvent()).not.toHaveProperty('fingerings')
    })

    it('Clear button is absent when no existing fingering is on the focused pitch', () => {
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Fingering' }))
      expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    })

    it('fingering button is disabled when the focused event is a rest', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                { pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' },
              ],
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0, pitchIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Fingering' }) as HTMLButtonElement
      expect(btn.disabled).toBe(true)
    })

    it('targets the focused chord pitchIdx (sets fingering only on the selected pitch)', () => {
      const chord: Score = {
        key: 'C',
        meter: '4/4',
        measures: [
          {
            events: [
              {
                pitches: [
                  { step: 'C', octave: 4 },
                  { step: 'E', octave: 4 },
                  { step: 'G', octave: 4 },
                ],
                duration: 'whole',
              },
            ],
          },
        ],
      }
      useChatStore.setState({
        editedScore: chord,
        scoreJson: chord,
        history: [chord],
        historyPointer: 0,
        // Select the top pitch (G, index 2).
        selection: { measureIdx: 0, eventIdx: 0, pitchIdx: 2 },
        error: undefined,
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Fingering' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Fingering text' }), {
        target: { value: '5' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      // The op pads index 0 and 1 with null, slots index 2 with the
      // piano-5 fingering.
      expect(useChatStore.getState().editedScore!.measures[0].events[0].fingerings).toEqual([
        null,
        null,
        { system: 'piano', value: '5' },
      ])
    })
  })

  describe('grace-notes button + Shift+R popover (M7-PR-5)', () => {
    it('toolbar ✻ button opens the GraceNotePopover', () => {
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Grace notes' })
      fireEvent.click(btn)
      expect(screen.getByRole('dialog', { name: 'Grace notes' })).toBeDefined()
    })

    it('Shift+R opens the popover when an event is selected', () => {
      render(<NoteFloatingMenu />)
      expect(screen.queryByRole('dialog', { name: 'Grace notes' })).toBeNull()
      fireEvent.keyDown(document, { key: 'R', shiftKey: true })
      expect(screen.getByRole('dialog', { name: 'Grace notes' })).toBeDefined()
    })

    it('Shift+R does NOT open the popover when an input is focused (typing-safety)', () => {
      render(
        <>
          <input data-testid="prompt" />
          <NoteFloatingMenu />
        </>,
      )
      const promptInput = screen.getByTestId('prompt')
      promptInput.focus()
      fireEvent.keyDown(promptInput, { key: 'R', shiftKey: true })
      expect(screen.queryByRole('dialog', { name: 'Grace notes' })).toBeNull()
    })

    it("Apply on a parsed input dispatches setGraceNotes (single eighth grace, default octave 5)", () => {
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Grace notes' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Grace notes text' }), {
        target: { value: 'd' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      expect(currentEvent().graceNotes).toEqual([
        { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' },
      ])
    })

    it('Apply with a 3-note run dispatches a 3-element graceNotes array', () => {
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Grace notes' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Grace notes text' }), {
        target: { value: '/c d e' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      const graces = currentEvent().graceNotes
      expect(graces).toHaveLength(3)
      expect(graces![0].slashed).toBe(true)
      expect(graces![1].slashed).toBeUndefined()
    })

    it('active toolbar state when the event has structured graceNotes', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  graceNotes: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' }],
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Grace notes' })
      expect(btn.getAttribute('aria-pressed')).toBe('true')
    })

    it("the popover pre-fills with the event's current graceNotes shorthand", () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  graceNotes: [
                    {
                      pitches: [{ step: 'D', octave: 5 }],
                      duration: 'sixteenth',
                      slashed: true,
                    },
                  ],
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Grace notes' }))
      const input = screen.getByRole('textbox', { name: 'Grace notes text' }) as HTMLInputElement
      expect(input.value).toBe('/d/')
    })

    it('Clear button dispatches setGraceNotes([]) when graceNotes are present', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  graceNotes: [{ pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' }],
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Grace notes' }))
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
      expect(currentEvent()).not.toHaveProperty('graceNotes')
    })

    it('Clear button is absent when no graceNotes are present', () => {
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Grace notes' }))
      expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    })

    it('grace-notes button is disabled when the event is a rest (grace pitches cannot be rests)', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                { pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' },
              ],
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Grace notes' }) as HTMLButtonElement
      expect(btn.disabled).toBe(true)
    })
  })

  describe('annotation button + Shift+T popover (M8-PR-4)', () => {
    it('toolbar ✎ button opens the AnnotationPopover', () => {
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Annotation' })
      fireEvent.click(btn)
      expect(screen.getByRole('dialog', { name: 'Annotation' })).toBeDefined()
    })

    it('Shift+T opens the popover when an event is selected', () => {
      render(<NoteFloatingMenu />)
      expect(screen.queryByRole('dialog', { name: 'Annotation' })).toBeNull()
      fireEvent.keyDown(document, { key: 'T', shiftKey: true })
      expect(screen.getByRole('dialog', { name: 'Annotation' })).toBeDefined()
    })

    it('Shift+T does NOT open the popover when an input is focused (typing-safety)', () => {
      render(
        <>
          <input data-testid="prompt" />
          <NoteFloatingMenu />
        </>,
      )
      const promptInput = screen.getByTestId('prompt')
      promptInput.focus()
      fireEvent.keyDown(promptInput, { key: 'T', shiftKey: true })
      expect(screen.queryByRole('dialog', { name: 'Annotation' })).toBeNull()
    })

    it("Apply on a new annotation dispatches insertAnnotation against the selected event", () => {
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Annotation' }))
      const input = screen.getByRole('textbox', { name: 'Annotation text' }) as HTMLInputElement
      fireEvent.change(input, { target: { value: 'A' } })
      fireEvent.click(screen.getByRole('radio', { name: 'Rehearsal' }))
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      const score = useChatStore.getState().editedScore!
      expect(score.annotations).toBeDefined()
      expect(score.annotations).toHaveLength(1)
      expect(score.annotations![0].text).toBe('A')
      expect(score.annotations![0].style).toBe('rehearsal-mark')
      expect(score.annotations![0].target.measureIdx).toBe(0)
      expect(score.annotations![0].target.eventIdx).toBe(0)
    })

    it('active toolbar state when the selected event has at least one annotation', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          annotations: [
            {
              id: 'rehearseAA',
              target: { measureIdx: 0, eventIdx: 0, position: 'above' },
              text: 'A',
              style: 'rehearsal-mark',
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Annotation' })
      expect(btn.getAttribute('aria-pressed')).toBe('true')
    })

    it('existing annotations on the selected event appear in the popover with × buttons', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          annotations: [
            {
              id: 'rehearseAA',
              target: { measureIdx: 0, eventIdx: 0, position: 'above' },
              text: 'A',
              style: 'rehearsal-mark',
            },
            // Different event — must NOT appear in the popover list.
            {
              id: 'tempo00001',
              target: { measureIdx: 1, eventIdx: 0, position: 'above' },
              text: 'Allegro',
              style: 'tempo-text',
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Annotation' }))
      const list = screen.getByRole('list', { name: 'Existing annotations' })
      expect(list.textContent).toContain('A')
      expect(list.textContent).not.toContain('Allegro')
    })

    it('clicking × on an existing annotation dispatches removeAnnotation', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          annotations: [
            {
              id: 'rehearseAA',
              target: { measureIdx: 0, eventIdx: 0, position: 'above' },
              text: 'A',
              style: 'rehearsal-mark',
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Annotation' }))
      fireEvent.click(screen.getByRole('button', { name: 'Remove annotation "A"' }))
      const score = useChatStore.getState().editedScore!
      expect(score).not.toHaveProperty('annotations')
    })

    it('annotation button works on a rest event (annotations are score-level, not pitched)', () => {
      // Unlike grace notes, annotations attach to any event — including
      // rests. A rehearsal mark on a rest measure should work.
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                { pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' },
              ],
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Annotation' }) as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })
  })

  describe('marker button + Shift+M popover (M9-PR-4)', () => {
    it('toolbar ⏱ button opens the MarkerPopover', () => {
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Marker' })
      fireEvent.click(btn)
      expect(screen.getByRole('dialog', { name: 'Marker' })).toBeDefined()
    })

    it('Shift+M opens the popover when an event is selected', () => {
      render(<NoteFloatingMenu />)
      expect(screen.queryByRole('dialog', { name: 'Marker' })).toBeNull()
      fireEvent.keyDown(document, { key: 'M', shiftKey: true })
      expect(screen.getByRole('dialog', { name: 'Marker' })).toBeDefined()
    })

    it('Shift+M does NOT open the popover when an input is focused (typing-safety)', () => {
      render(
        <>
          <input data-testid="prompt" />
          <NoteFloatingMenu />
        </>,
      )
      const promptInput = screen.getByTestId('prompt')
      promptInput.focus()
      fireEvent.keyDown(promptInput, { key: 'M', shiftKey: true })
      expect(screen.queryByRole('dialog', { name: 'Marker' })).toBeNull()
    })

    it("Apply on a tempo marker dispatches insertMarker against the selected measure", () => {
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Marker' }))
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Tempo bpm' }), {
        target: { value: '140' },
      })
      fireEvent.change(screen.getByRole('textbox', { name: 'Tempo text' }), {
        target: { value: 'Allegro' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      const score = useChatStore.getState().editedScore!
      expect(score.markers).toBeDefined()
      expect(score.markers).toHaveLength(1)
      expect(score.markers![0].tempo_bpm).toBe(140)
      expect(score.markers![0].tempo_text).toBe('Allegro')
      expect(score.markers![0].measureIdx).toBe(0)
    })

    it('active toolbar state when the selected measure has at least one marker', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          markers: [{ id: 'marker0001', measureIdx: 0, tempo_bpm: 100 }],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Marker' })
      expect(btn.getAttribute('aria-pressed')).toBe('true')
    })

    it('existing markers on the selected measure appear in the popover list (filtered by measureIdx)', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
            { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
          ],
          markers: [
            { id: 'marker0001', measureIdx: 0, tempo_bpm: 120, tempo_text: 'Allegro' },
            // Different measure — must NOT appear in the popover.
            { id: 'marker0002', measureIdx: 1, meter: '3/4' },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Marker' }))
      const list = screen.getByRole('list', { name: 'Existing markers' })
      expect(list.textContent).toContain('Allegro')
      expect(list.textContent).not.toContain('3/4')
    })

    it('× on an existing marker dispatches removeMarker', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          markers: [{ id: 'marker0001', measureIdx: 0, tempo_bpm: 100 }],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Marker' }))
      fireEvent.click(screen.getByRole('button', { name: /Remove marker/ }))
      const score = useChatStore.getState().editedScore!
      expect(score).not.toHaveProperty('markers')
    })

    it('Apply on a clef marker dispatches insertMarker with clefs (single-staff)', () => {
      // M19-PR-1 wire-path test — single-staff scores see ONE clef
      // picker; Apply should dispatch insertMarker with clefs:[{ staffIdx:0, clef }].
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Marker' }))
      fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 1' }), {
        target: { value: 'bass' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      const score = useChatStore.getState().editedScore!
      expect(score.markers).toHaveLength(1)
      expect(score.markers![0].clefs).toEqual([{ staffIdx: 0, clef: 'bass' }])
      expect(score.markers![0].measureIdx).toBe(0)
    })

    it('Apply on a clef marker passes BOTH staves through dispatch (two-staff)', () => {
      // M19-PR-1 wire-path test — two-staff scores expose per-staff
      // pickers. Apply with both filled dispatches a 2-entry clefs[].
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          secondStaff: {
            clef: 'bass',
            measures: [
              {
                events: [
                  { pitches: [{ step: 'C', octave: 3 }], duration: 'whole' },
                ],
              },
            ],
          },
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        history: [FOUR_BARS_OF_QUARTERS],
        historyPointer: 0,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Marker' }))
      // Strengthen the wire-path test (review SUGGEST #8): assert
      // BOTH pickers are visible before Apply so a regression where
      // staffCount=2 doesn't propagate to the popover surfaces here.
      expect(screen.getByRole('combobox', { name: 'Clef change staff 1' })).toBeDefined()
      expect(screen.getByRole('combobox', { name: 'Clef change staff 2' })).toBeDefined()
      fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 1' }), {
        target: { value: 'bass' },
      })
      fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 2' }), {
        target: { value: 'treble' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      const score = useChatStore.getState().editedScore!
      expect(score.markers).toHaveLength(1)
      expect(score.markers![0].clefs).toEqual([
        { staffIdx: 0, clef: 'bass' },
        { staffIdx: 1, clef: 'treble' },
      ])
    })

    it('snapshot-target: mid-popover selection change does NOT redirect Apply', () => {
      // M19-PR-1 review fix — Marker is now snapshot-target-on-open
      // like Barline / Volta / JumpMarker. Open the popover on
      // measure 0, then change the selection to measure 1; Apply must
      // still land on measure 0 (the snapshot), and the existing-list
      // must keep showing measure-0 markers throughout.
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
            { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
          ],
          markers: [{ id: 'marker0001', measureIdx: 0, tempo_bpm: 88, tempo_text: 'Adagio' }],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        history: [FOUR_BARS_OF_QUARTERS],
        historyPointer: 0,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Marker' }))
      // Existing-list shows measure-0 marker.
      expect(
        screen.getByRole('list', { name: 'Existing markers' }).textContent,
      ).toContain('Adagio')
      // Now redirect the live selection to measure 1.
      useChatStore.setState({ selection: { measureIdx: 1, eventIdx: 0 } })
      // Apply a new clef while measure 1 is the live selection — the
      // snapshot at open was measure 0, so the new marker should land
      // on measure 0.
      fireEvent.change(screen.getByRole('combobox', { name: 'Clef change staff 1' }), {
        target: { value: 'bass' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      const score = useChatStore.getState().editedScore!
      const newMarker = (score.markers ?? []).find(
        (m) => m.clefs !== undefined && m.clefs.some((c) => c.clef === 'bass'),
      )
      expect(newMarker).toBeDefined()
      expect(newMarker!.measureIdx).toBe(0)
    })
  })

  describe('chord symbol button + Shift+H popover (M10-PR-5)', () => {
    it('toolbar ♭♯ button opens the ChordSymbolPopover', () => {
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Chord symbol' })
      fireEvent.click(btn)
      expect(screen.getByRole('dialog', { name: 'Chord symbol' })).toBeDefined()
    })

    it('Shift+H opens the popover when an event is selected', () => {
      render(<NoteFloatingMenu />)
      expect(screen.queryByRole('dialog', { name: 'Chord symbol' })).toBeNull()
      fireEvent.keyDown(document, { key: 'H', shiftKey: true })
      expect(screen.getByRole('dialog', { name: 'Chord symbol' })).toBeDefined()
    })

    it('Shift+H does NOT open the popover when an input is focused (typing-safety)', () => {
      render(
        <>
          <input data-testid="prompt" />
          <NoteFloatingMenu />
        </>,
      )
      const promptInput = screen.getByTestId('prompt')
      promptInput.focus()
      fireEvent.keyDown(promptInput, { key: 'H', shiftKey: true })
      expect(screen.queryByRole('dialog', { name: 'Chord symbol' })).toBeNull()
    })

    it('Apply on a parsed input dispatches setChordSymbol against the selected event', () => {
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Chord symbol' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Chord symbol text' }), {
        target: { value: 'Cmaj7' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      const ev = useChatStore.getState().editedScore!.measures[0].events[0]
      expect(ev.chordSymbol).toBeDefined()
      expect(ev.chordSymbol!.root).toBe('C')
      expect(ev.chordSymbol!.seventh).toBe('maj7')
    })

    it('active toolbar state when the event has a chord symbol', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  chordSymbol: { root: 'C', quality: 'major', seventh: 'maj7' },
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Chord symbol' })
      expect(btn.getAttribute('aria-pressed')).toBe('true')
    })

    it('popover pre-fills with the canonical formatted chord (not the raw display)', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  // display field intentionally weird so we can prove
                  // the popover seeds from the formatter, not display.
                  chordSymbol: {
                    root: 'F',
                    quality: 'minor',
                    seventh: 'halfdim7',
                    display: 'wrong_display_value',
                  },
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Chord symbol' }))
      const input = screen.getByRole('textbox', { name: 'Chord symbol text' }) as HTMLInputElement
      expect(input.value).toBe('Fm7b5')
      expect(input.value).not.toBe('wrong_display_value')
    })

    it('Clear button dispatches setChordSymbol without chordSymbol (drops the field)', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            {
              events: [
                {
                  pitches: [{ step: 'C', octave: 4 }],
                  duration: 'quarter',
                  chordSymbol: { root: 'C', quality: 'major', seventh: 'none' },
                },
                ...FOUR_BARS_OF_QUARTERS.measures[0].events.slice(1),
              ],
            },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      fireEvent.click(screen.getByRole('button', { name: 'Chord symbol' }))
      fireEvent.click(screen.getByRole('button', { name: /clear/i }))
      const ev = useChatStore.getState().editedScore!.measures[0].events[0]
      expect(ev).not.toHaveProperty('chordSymbol')
    })

    it('chord-symbol button is enabled even on rest events (chord symbols are harmony labels, not pitched content)', () => {
      useChatStore.setState({
        editedScore: {
          ...FOUR_BARS_OF_QUARTERS,
          measures: [
            { events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }] },
          ],
        },
        scoreJson: FOUR_BARS_OF_QUARTERS,
        selection: { measureIdx: 0, eventIdx: 0 },
      })
      render(<NoteFloatingMenu />)
      openText()
      const btn = screen.getByRole('button', { name: 'Chord symbol' }) as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })
  })

  describe('category submenu condensation', () => {
    it('a grouped action is hidden until its category trigger is clicked', () => {
      render(<NoteFloatingMenu />)
      // Staccato now lives inside the Articulation submenu — it is not
      // rendered while the submenu is closed.
      expect(screen.queryByRole('button', { name: 'Staccato' })).toBeNull()
      // The category trigger IS in the inline row.
      const trigger = screen.getByRole('button', { name: 'Articulation' })
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      fireEvent.click(trigger)
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      // Now the grouped action is visible inside the submenu dialog.
      expect(screen.getByRole('button', { name: 'Staccato' })).toBeDefined()
    })

    it('opening one submenu closes any other (single activeSubmenu)', () => {
      render(<NoteFloatingMenu />)
      fireEvent.click(screen.getByRole('button', { name: 'Articulation' }))
      expect(screen.getByRole('button', { name: 'Staccato' })).toBeDefined()
      // Open a different category — the first one's actions disappear.
      fireEvent.click(screen.getByRole('button', { name: 'Text' }))
      expect(screen.queryByRole('button', { name: 'Staccato' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Marker' })).toBeDefined()
    })

    it('a grouped toggle still dispatches its edit from inside the submenu', () => {
      render(<NoteFloatingMenu />)
      fireEvent.click(screen.getByRole('button', { name: 'Articulation' }))
      fireEvent.click(screen.getByRole('button', { name: 'Staccato' }))
      expect(currentEvent().articulations).toEqual(['staccato'])
    })

    it('clicking a dedicated-popover action closes the submenu before opening the popover', () => {
      render(<NoteFloatingMenu />)
      fireEvent.click(screen.getByRole('button', { name: 'Text' }))
      // Marker opens its own popover — the submenu must close first so
      // the popover anchors at the selection rather than hiding behind.
      fireEvent.click(screen.getByRole('button', { name: 'Marker' }))
      expect(screen.getByRole('dialog', { name: 'Marker' })).toBeDefined()
      // The submenu trigger is collapsed again.
      expect(
        screen.getByRole('button', { name: 'Text' }).getAttribute('aria-expanded'),
      ).toBe('false')
    })

    it('inline core actions remain directly available (no submenu needed)', () => {
      render(<NoteFloatingMenu />)
      const beforePointer = useChatStore.getState().historyPointer
      // Delete is an inline core action (glyph button, addressed by title).
      fireEvent.click(screen.getByTitle('Delete (Del)'))
      // The edit landed in history without any submenu being opened.
      expect(useChatStore.getState().historyPointer).toBe(beforePointer + 1)
    })

    it('an inline accidental action still works directly', () => {
      render(<NoteFloatingMenu />)
      fireEvent.click(screen.getByTitle('Sharp (=)'))
      expect(currentEvent().pitches[0].accidental).toBe('sharp')
    })
  })
})
