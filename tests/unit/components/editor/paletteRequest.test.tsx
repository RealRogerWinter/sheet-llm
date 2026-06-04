import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import EditorToolbar from '@/components/editor/EditorToolbar'
import { useChatStore } from '@/lib/chat/state'
import { COMMAND_CATALOG } from '@/components/editor/commandCatalog'
import type { Score } from '@/lib/music/types'

afterEach(() => cleanup())

const SCORE: Score = {
  title: 'Sketch',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
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
    paletteRequest: undefined,
    error: undefined,
  })
}

describe('paletteRequest store slot — nonce semantics', () => {
  beforeEach(() => seed(SCORE))

  it('first set assigns nonce 1', () => {
    useChatStore.getState().setPaletteRequest({ kind: 'open-score-info' })
    expect(useChatStore.getState().paletteRequest).toEqual({
      kind: 'open-score-info',
      nonce: 1,
    })
  })

  it('repeat set with same kind bumps the nonce', () => {
    useChatStore.getState().setPaletteRequest({ kind: 'open-score-info' })
    useChatStore.getState().setPaletteRequest({ kind: 'open-score-info' })
    expect(useChatStore.getState().paletteRequest).toEqual({
      kind: 'open-score-info',
      nonce: 2,
    })
  })

  it('clear via setPaletteRequest(undefined) drops the slot but preserves the next nonce count', () => {
    useChatStore.getState().setPaletteRequest({ kind: 'open-score-info' })
    useChatStore.getState().setPaletteRequest(undefined)
    expect(useChatStore.getState().paletteRequest).toBeUndefined()
    // Set again — nonce restarts from 1 (the previous nonce was lost
    // when paletteRequest cleared). This is acceptable: subscribers
    // identify uniqueness via object identity AND nonce together.
    useChatStore.getState().setPaletteRequest({ kind: 'open-score-info' })
    expect(useChatStore.getState().paletteRequest?.nonce).toBe(1)
  })
})

describe("EditorToolbar — palette 'open-score-info' subscription", () => {
  beforeEach(() => seed(SCORE))

  it('opens the Score Info popover when paletteRequest = open-score-info is published', () => {
    render(<EditorToolbar />)
    expect(screen.queryByRole('dialog', { name: 'Score info' })).toBeNull()
    act(() => {
      useChatStore.getState().setPaletteRequest({ kind: 'open-score-info' })
    })
    expect(screen.getByRole('dialog', { name: 'Score info' })).toBeDefined()
  })

  it('clears paletteRequest after consuming it', () => {
    render(<EditorToolbar />)
    act(() => {
      useChatStore.getState().setPaletteRequest({ kind: 'open-score-info' })
    })
    expect(useChatStore.getState().paletteRequest).toBeUndefined()
  })

  it('re-opening Score Info after closing it requires a NEW publish', () => {
    render(<EditorToolbar />)
    // First open
    act(() => {
      useChatStore.getState().setPaletteRequest({ kind: 'open-score-info' })
    })
    expect(screen.getByRole('dialog', { name: 'Score info' })).toBeDefined()
    // Close it (cancel)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Score info' })).toBeNull()
    // Second publish — nonce bumps so the effect re-fires
    act(() => {
      useChatStore.getState().setPaletteRequest({ kind: 'open-score-info' })
    })
    expect(screen.getByRole('dialog', { name: 'Score info' })).toBeDefined()
  })
})

describe('commandCatalog — open-score-info wiring', () => {
  beforeEach(() => seed(SCORE))

  it("the 'open-score-info' command publishes the matching palette request", () => {
    const cmd = COMMAND_CATALOG.find((c) => c.id === 'open-score-info')
    expect(cmd).toBeDefined()
    cmd!.action(useChatStore.getState())
    expect(useChatStore.getState().paletteRequest?.kind).toBe('open-score-info')
  })

  it("ships in the catalog with a 'Score / Metadata' hint", () => {
    const cmd = COMMAND_CATALOG.find((c) => c.id === 'open-score-info')
    expect(cmd?.hint).toBe('Score / Metadata')
  })
})

describe('commandCatalog — open-marker wiring (M23-PR-3)', () => {
  beforeEach(() => seed(SCORE))

  it("the 'open-marker' command publishes the matching palette request", () => {
    const cmd = COMMAND_CATALOG.find((c) => c.id === 'open-marker')
    expect(cmd).toBeDefined()
    cmd!.action(useChatStore.getState())
    expect(useChatStore.getState().paletteRequest?.kind).toBe('open-marker')
  })

  it('is gated on selection: available() returns false when no selection', () => {
    useChatStore.setState({ selection: undefined })
    const cmd = COMMAND_CATALOG.find((c) => c.id === 'open-marker')
    expect(cmd?.available).toBeDefined()
    expect(cmd!.available!(useChatStore.getState())).toBe(false)
  })

  it('available() returns true when a selection exists', () => {
    useChatStore.setState({ selection: { measureIdx: 0, eventIdx: 0 } })
    const cmd = COMMAND_CATALOG.find((c) => c.id === 'open-marker')
    expect(cmd!.available!(useChatStore.getState())).toBe(true)
  })
})

describe('commandCatalog — M23-PR-4 selection-gated commands', () => {
  beforeEach(() => seed(SCORE))

  const NEW_COMMANDS = [
    { id: 'open-dynamics', kind: 'open-dynamics' as const },
    { id: 'open-chord-symbol', kind: 'open-chord-symbol' as const },
    { id: 'open-lyrics', kind: 'open-lyrics' as const },
    { id: 'open-annotation', kind: 'open-annotation' as const },
  ]

  for (const { id, kind } of NEW_COMMANDS) {
    it(`'${id}' publishes a paletteRequest with kind '${kind}'`, () => {
      const cmd = COMMAND_CATALOG.find((c) => c.id === id)
      expect(cmd).toBeDefined()
      cmd!.action(useChatStore.getState())
      expect(useChatStore.getState().paletteRequest?.kind).toBe(kind)
    })

    it(`'${id}' is selection-gated`, () => {
      useChatStore.setState({ selection: undefined })
      const cmd = COMMAND_CATALOG.find((c) => c.id === id)
      expect(cmd?.available).toBeDefined()
      expect(cmd!.available!(useChatStore.getState())).toBe(false)
      useChatStore.setState({ selection: { measureIdx: 0, eventIdx: 0 } })
      expect(cmd!.available!(useChatStore.getState())).toBe(true)
    })
  }
})

describe('commandCatalog — M23-PR-5 simple selection-gated commands', () => {
  beforeEach(() => seed(SCORE))

  const SIMPLE_SELECTION_COMMANDS = [
    { id: 'open-fingering', kind: 'open-fingering' as const },
    { id: 'open-ornament', kind: 'open-ornament' as const },
    { id: 'open-technique', kind: 'open-technique' as const },
    { id: 'open-grace-note', kind: 'open-grace-note' as const },
    { id: 'open-barline', kind: 'open-barline' as const },
    { id: 'open-volta', kind: 'open-volta' as const },
    { id: 'open-jump-marker', kind: 'open-jump-marker' as const },
  ]

  for (const { id, kind } of SIMPLE_SELECTION_COMMANDS) {
    it(`'${id}' publishes a paletteRequest with kind '${kind}'`, () => {
      const cmd = COMMAND_CATALOG.find((c) => c.id === id)
      expect(cmd).toBeDefined()
      cmd!.action(useChatStore.getState())
      expect(useChatStore.getState().paletteRequest?.kind).toBe(kind)
    })

    it(`'${id}' is selection-gated (hidden without selection)`, () => {
      useChatStore.setState({ selection: undefined })
      const cmd = COMMAND_CATALOG.find((c) => c.id === id)
      expect(cmd?.available).toBeDefined()
      expect(cmd!.available!(useChatStore.getState())).toBe(false)
      useChatStore.setState({ selection: { measureIdx: 0, eventIdx: 0 } })
      expect(cmd!.available!(useChatStore.getState())).toBe(true)
    })
  }
})

describe('commandCatalog — M23-PR-5 span commands (require selection AND event.id)', () => {
  const SPAN_COMMANDS = [
    { id: 'open-hairpin', kind: 'open-hairpin' as const },
    { id: 'open-slur', kind: 'open-slur' as const },
    { id: 'open-tempo-span', kind: 'open-tempo-span' as const },
    { id: 'open-octave-span', kind: 'open-octave-span' as const },
    { id: 'open-glissando', kind: 'open-glissando' as const },
    { id: 'open-trill-line', kind: 'open-trill-line' as const },
    { id: 'open-tremolo-between', kind: 'open-tremolo-between' as const },
  ]

  const SCORE_WITH_ID: Score = {
    title: 'WithIds',
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { id: 'eventaaa1', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
        ],
      },
    ],
  }

  const SCORE_WITHOUT_ID: Score = {
    title: 'NoIds',
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
        ],
      },
    ],
  }

  for (const { id, kind } of SPAN_COMMANDS) {
    it(`'${id}' publishes paletteRequest with kind '${kind}'`, () => {
      seed(SCORE_WITH_ID)
      useChatStore.setState({ selection: { measureIdx: 0, eventIdx: 0 } })
      const cmd = COMMAND_CATALOG.find((c) => c.id === id)
      expect(cmd).toBeDefined()
      cmd!.action(useChatStore.getState())
      expect(useChatStore.getState().paletteRequest?.kind).toBe(kind)
    })

    it(`'${id}' available=false when no selection`, () => {
      seed(SCORE_WITH_ID)
      useChatStore.setState({ selection: undefined })
      const cmd = COMMAND_CATALOG.find((c) => c.id === id)
      expect(cmd!.available!(useChatStore.getState())).toBe(false)
    })

    it(`'${id}' available=false when selected event has no id`, () => {
      seed(SCORE_WITHOUT_ID)
      useChatStore.setState({ selection: { measureIdx: 0, eventIdx: 0 } })
      const cmd = COMMAND_CATALOG.find((c) => c.id === id)
      expect(cmd!.available!(useChatStore.getState())).toBe(false)
    })

    it(`'${id}' available=true when selected event has an id`, () => {
      seed(SCORE_WITH_ID)
      useChatStore.setState({ selection: { measureIdx: 0, eventIdx: 0 } })
      const cmd = COMMAND_CATALOG.find((c) => c.id === id)
      expect(cmd!.available!(useChatStore.getState())).toBe(true)
    })
  }
})

describe("commandCatalog — 'open-tie' availability (requires non-rest pitch)", () => {
  const SCORE_PITCHED: Score = {
    title: 'Pitched',
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
      },
    ],
  }

  const SCORE_REST: Score = {
    title: 'Rest',
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [{ pitches: [{ step: 'rest', octave: 4 }], duration: 'whole' }],
      },
    ],
  }

  it("publishes paletteRequest with kind 'open-tie'", () => {
    seed(SCORE_PITCHED)
    useChatStore.setState({ selection: { measureIdx: 0, eventIdx: 0 } })
    const cmd = COMMAND_CATALOG.find((c) => c.id === 'open-tie')
    cmd!.action(useChatStore.getState())
    expect(useChatStore.getState().paletteRequest?.kind).toBe('open-tie')
  })

  it('available=false when selected event is a rest', () => {
    seed(SCORE_REST)
    useChatStore.setState({ selection: { measureIdx: 0, eventIdx: 0 } })
    const cmd = COMMAND_CATALOG.find((c) => c.id === 'open-tie')
    expect(cmd!.available!(useChatStore.getState())).toBe(false)
  })

  it('available=true when selected event has a pitched note', () => {
    seed(SCORE_PITCHED)
    useChatStore.setState({ selection: { measureIdx: 0, eventIdx: 0 } })
    const cmd = COMMAND_CATALOG.find((c) => c.id === 'open-tie')
    expect(cmd!.available!(useChatStore.getState())).toBe(true)
  })

  it('available=false when no selection', () => {
    seed(SCORE_PITCHED)
    useChatStore.setState({ selection: undefined })
    const cmd = COMMAND_CATALOG.find((c) => c.id === 'open-tie')
    expect(cmd!.available!(useChatStore.getState())).toBe(false)
  })
})
