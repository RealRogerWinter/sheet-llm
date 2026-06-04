import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import CommandPalette from '@/components/editor/CommandPalette'
import {
  applyAvailabilityFilter,
  COMMAND_CATALOG,
  filterCommands,
  fuzzyFilterCommands,
  groupCommandsByCategory,
  type PaletteCommand,
} from '@/components/editor/commandCatalog'
import { useChatStore } from '@/lib/chat/state'

afterEach(() => cleanup())

const STUB_COMMANDS: PaletteCommand[] = [
  { id: 'first', label: 'First Command', hint: 'Test / One', keybind: 'A', action: vi.fn() },
  { id: 'second', label: 'Second Command', hint: 'Test / Two', action: vi.fn() },
  { id: 'third', label: 'Third Command', hint: 'Help', keybind: 'B', action: vi.fn() },
]

describe('CommandPalette — render', () => {
  it('renders nothing when open=false', () => {
    render(<CommandPalette open={false} onClose={vi.fn()} commands={STUB_COMMANDS} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the search input + all commands when open with empty query', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />)
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Command search' })).toBeDefined()
    const options = screen.getAllByRole('option')
    expect(options.length).toBe(3)
    expect(options[0].textContent).toContain('First Command')
    expect(options[2].textContent).toContain('Third Command')
  })

  it('shows keybind hint when set, omits when undefined', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />)
    const options = screen.getAllByRole('option')
    expect(options[0].textContent).toContain('A')
    // Second has no keybind — its row text shouldn't contain 'A' or 'B'.
    expect(options[1].textContent?.match(/[AB]/)).toBeNull()
    expect(options[2].textContent).toContain('B')
  })
})

describe('CommandPalette — filtering', () => {
  it('filters by label substring (case-insensitive)', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />)
    const input = screen.getByRole('textbox', { name: 'Command search' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'third' } })
    const options = screen.getAllByRole('option')
    expect(options.length).toBe(1)
    expect(options[0].textContent).toContain('Third Command')
  })

  it('filters by hint text', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />)
    const input = screen.getByRole('textbox', { name: 'Command search' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'help' } })
    const options = screen.getAllByRole('option')
    expect(options.length).toBe(1)
    expect(options[0].textContent).toContain('Third Command')
  })

  it('multi-word query requires every term to match', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />)
    const input = screen.getByRole('textbox', { name: 'Command search' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'first one' } })
    const options = screen.getAllByRole('option')
    expect(options.length).toBe(1)
    expect(options[0].textContent).toContain('First Command')
  })

  it('shows empty state when no commands match', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />)
    const input = screen.getByRole('textbox', { name: 'Command search' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'xyznomatch' } })
    expect(screen.queryAllByRole('option').length).toBe(0)
    expect(screen.getByText(/no matching commands/i)).toBeDefined()
  })
})

describe('CommandPalette — keyboard navigation', () => {
  it('ArrowDown advances active index', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />)
    const input = screen.getByRole('textbox', { name: 'Command search' })
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[2].getAttribute('aria-selected')).toBe('true')
  })

  it('ArrowDown does not advance past the last command', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />)
    const input = screen.getByRole('textbox', { name: 'Command search' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // already at 2
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // should stay at 2
    expect(screen.getAllByRole('option')[2].getAttribute('aria-selected')).toBe('true')
  })

  it('ArrowUp moves active index back, capped at 0', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />)
    const input = screen.getByRole('textbox', { name: 'Command search' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[2].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'ArrowUp' }) // should cap at 0
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true')
  })

  it('Enter dispatches the active command and closes the palette', () => {
    const onClose = vi.fn()
    const action = vi.fn()
    const commands = [
      { id: 'go', label: 'Go', action },
      { id: 'no', label: 'No', action: vi.fn() },
    ]
    render(<CommandPalette open onClose={onClose} commands={commands} />)
    const input = screen.getByRole('textbox', { name: 'Command search' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(action).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Enter on filtered list dispatches the visible command (not the catalog index)', () => {
    const action = vi.fn()
    const commands: PaletteCommand[] = [
      { id: 'a', label: 'Alpha', action: vi.fn() },
      { id: 'b', label: 'Beta', action },
    ]
    render(<CommandPalette open onClose={vi.fn()} commands={commands} />)
    const input = screen.getByRole('textbox', { name: 'Command search' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'beta' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(action).toHaveBeenCalledTimes(1)
    expect(commands[0].action).not.toHaveBeenCalled()
  })
})

describe('CommandPalette — mouse interaction', () => {
  it('clicking a command dispatches it and closes', () => {
    const onClose = vi.fn()
    const action = vi.fn()
    render(
      <CommandPalette
        open
        onClose={onClose}
        commands={[{ id: 'x', label: 'X', action }]}
      />,
    )
    fireEvent.click(screen.getByRole('option'))
    expect(action).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('mouseEnter updates the active index (keyboard + mouse stay in sync)', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />)
    fireEvent.mouseEnter(screen.getAllByRole('option')[2])
    expect(screen.getAllByRole('option')[2].getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('false')
  })
})

describe('CommandPalette — reset on open', () => {
  it('resets query + active index when reopened', () => {
    const { rerender } = render(
      <CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />,
    )
    const input = screen.getByRole('textbox', { name: 'Command search' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'second' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    // Close + reopen
    rerender(<CommandPalette open={false} onClose={vi.fn()} commands={STUB_COMMANDS} />)
    rerender(<CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />)
    const input2 = screen.getByRole('textbox', { name: 'Command search' }) as HTMLInputElement
    expect(input2.value).toBe('')
    // Active should be back at 0
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true')
  })
})

describe('filterCommands — pure helper', () => {
  it('empty query returns a shallow copy of all commands', () => {
    const out = filterCommands(STUB_COMMANDS, '')
    expect(out).toHaveLength(STUB_COMMANDS.length)
    expect(out).not.toBe(STUB_COMMANDS) // shallow copy, distinct ref
  })

  it('whitespace-only query passes everything through', () => {
    const out = filterCommands(STUB_COMMANDS, '   ')
    expect(out).toHaveLength(STUB_COMMANDS.length)
  })

  it('case-insensitive match', () => {
    const out = filterCommands(STUB_COMMANDS, 'FIRST')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('first')
  })

  it('returns empty array when nothing matches', () => {
    const out = filterCommands(STUB_COMMANDS, 'nomatch')
    expect(out).toHaveLength(0)
  })
})

describe('applyAvailabilityFilter — selection gating (M23-PR-3)', () => {
  const COMMANDS_WITH_PREDICATE: PaletteCommand[] = [
    { id: 'always', label: 'Always', action: vi.fn() },
    {
      id: 'when-selection',
      label: 'When Selection',
      action: vi.fn(),
      available: (s) => s.selection !== undefined,
    },
    {
      id: 'when-score',
      label: 'When Score',
      action: vi.fn(),
      available: (s) => s.editedScore !== undefined,
    },
  ]

  it('commands without an available predicate always pass through', () => {
    useChatStore.setState({
      selection: undefined,
      editedScore: undefined,
    })
    const out = applyAvailabilityFilter(COMMANDS_WITH_PREDICATE, useChatStore.getState())
    expect(out.map((c) => c.id)).toContain('always')
  })

  it('selection-required commands are filtered out when no selection', () => {
    useChatStore.setState({ selection: undefined })
    const out = applyAvailabilityFilter(COMMANDS_WITH_PREDICATE, useChatStore.getState())
    expect(out.map((c) => c.id)).not.toContain('when-selection')
  })

  it('selection-required commands appear when a selection exists', () => {
    useChatStore.setState({
      selection: { measureIdx: 0, eventIdx: 0 },
    })
    const out = applyAvailabilityFilter(COMMANDS_WITH_PREDICATE, useChatStore.getState())
    expect(out.map((c) => c.id)).toContain('when-selection')
  })
})

describe('CommandPalette — availability filtering (M23-PR-3)', () => {
  it("hides commands whose `available` predicate returns false at open time", () => {
    useChatStore.setState({ selection: undefined })
    const commands: PaletteCommand[] = [
      { id: 'always', label: 'Always Visible', action: vi.fn() },
      {
        id: 'guarded',
        label: 'Selection Only',
        action: vi.fn(),
        available: (s) => s.selection !== undefined,
      },
    ]
    render(<CommandPalette open onClose={vi.fn()} commands={commands} />)
    const options = screen.getAllByRole('option')
    expect(options.length).toBe(1)
    expect(options[0].textContent).toContain('Always Visible')
  })

  it("includes guarded commands when the predicate passes at open time", () => {
    useChatStore.setState({
      selection: { measureIdx: 2, eventIdx: 0 },
    })
    const commands: PaletteCommand[] = [
      { id: 'always', label: 'Always Visible', action: vi.fn() },
      {
        id: 'guarded',
        label: 'Selection Only',
        action: vi.fn(),
        available: (s) => s.selection !== undefined,
      },
    ]
    render(<CommandPalette open onClose={vi.fn()} commands={commands} />)
    const options = screen.getAllByRole('option')
    expect(options.length).toBe(2)
  })

  it("availability is snapshotted on OPEN, not reactive to mid-session store changes", () => {
    useChatStore.setState({ selection: undefined })
    const commands: PaletteCommand[] = [
      {
        id: 'guarded',
        label: 'Selection Only',
        action: vi.fn(),
        available: (s) => s.selection !== undefined,
      },
    ]
    const { rerender } = render(
      <CommandPalette open onClose={vi.fn()} commands={commands} />,
    )
    expect(screen.queryAllByRole('option').length).toBe(0)
    // Mid-session selection change should NOT add the command to the
    // visible list — the snapshot was taken at open time.
    useChatStore.setState({ selection: { measureIdx: 0, eventIdx: 0 } })
    rerender(<CommandPalette open onClose={vi.fn()} commands={commands} />)
    expect(screen.queryAllByRole('option').length).toBe(0)
  })

  it("re-snapshots availability on the NEXT open (close → store change → reopen makes guarded command visible)", () => {
    useChatStore.setState({ selection: undefined })
    const commands: PaletteCommand[] = [
      {
        id: 'guarded',
        label: 'Selection Only',
        action: vi.fn(),
        available: (s) => s.selection !== undefined,
      },
    ]
    const { rerender } = render(
      <CommandPalette open onClose={vi.fn()} commands={commands} />,
    )
    expect(screen.queryAllByRole('option').length).toBe(0)
    rerender(<CommandPalette open={false} onClose={vi.fn()} commands={commands} />)
    useChatStore.setState({ selection: { measureIdx: 0, eventIdx: 0 } })
    rerender(<CommandPalette open onClose={vi.fn()} commands={commands} />)
    expect(screen.queryAllByRole('option').length).toBe(1)
  })
})

describe('groupCommandsByCategory — pure helper (M23-PR-6)', () => {
  it('extracts category from the hint prefix before "/"', () => {
    const cmds: PaletteCommand[] = [
      { id: 'a', label: 'A', hint: 'Foo / Bar', action: vi.fn() },
      { id: 'b', label: 'B', hint: 'Foo / Baz', action: vi.fn() },
    ]
    const groups = groupCommandsByCategory(cmds)
    expect(groups).toHaveLength(1)
    expect(groups[0].category).toBe('Foo')
    expect(groups[0].commands.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('groups commands without a hint under "Other"', () => {
    const cmds: PaletteCommand[] = [
      { id: 'a', label: 'A', action: vi.fn() },
      { id: 'b', label: 'B', hint: 'Foo / x', action: vi.fn() },
    ]
    const groups = groupCommandsByCategory(cmds)
    expect(groups.map((g) => g.category)).toEqual(['Other', 'Foo'])
  })

  it('treats whitespace-only hint as "Other"', () => {
    const cmds: PaletteCommand[] = [
      { id: 'a', label: 'A', hint: '   ', action: vi.fn() },
    ]
    const groups = groupCommandsByCategory(cmds)
    expect(groups[0].category).toBe('Other')
  })

  it('treats hint without "/" as a standalone category', () => {
    const cmds: PaletteCommand[] = [
      { id: 'a', label: 'A', hint: 'Help', action: vi.fn() },
    ]
    const groups = groupCommandsByCategory(cmds)
    expect(groups[0].category).toBe('Help')
  })

  it('preserves declaration order (first-occurrence wins)', () => {
    const cmds: PaletteCommand[] = [
      { id: 'a', label: 'A', hint: 'Alpha / x', action: vi.fn() },
      { id: 'b', label: 'B', hint: 'Beta / x', action: vi.fn() },
      { id: 'c', label: 'C', hint: 'Alpha / y', action: vi.fn() },
    ]
    const groups = groupCommandsByCategory(cmds)
    expect(groups.map((g) => g.category)).toEqual(['Alpha', 'Beta'])
    expect(groups[0].commands.map((c) => c.id)).toEqual(['a', 'c'])
    expect(groups[1].commands.map((c) => c.id)).toEqual(['b'])
  })

  it('returns empty array for empty input', () => {
    expect(groupCommandsByCategory([])).toEqual([])
  })
})

describe('CommandPalette — section headers (M23-PR-6)', () => {
  it('renders a section header per category', () => {
    const commands: PaletteCommand[] = [
      { id: 'a', label: 'A', hint: 'Alpha / x', action: vi.fn() },
      { id: 'b', label: 'B', hint: 'Beta / y', action: vi.fn() },
    ]
    render(<CommandPalette open onClose={vi.fn()} commands={commands} />)
    // Section headers render the category text. Use text-presence
    // checks rather than role assertions since headers are markup-only.
    expect(screen.getByText('Alpha')).toBeDefined()
    expect(screen.getByText('Beta')).toBeDefined()
  })

  it('does not render section headers in the empty state', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={STUB_COMMANDS} />)
    const input = screen.getByRole('textbox', { name: 'Command search' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'xyznomatch' } })
    expect(screen.getByText(/no matching commands/i)).toBeDefined()
    expect(screen.queryByText('Test')).toBeNull()
  })

  it('filtered list rebuilds groups (categories with no matches drop their header)', () => {
    const commands: PaletteCommand[] = [
      { id: 'a', label: 'Apple', hint: 'Fruit / x', action: vi.fn() },
      { id: 'c', label: 'Carrot', hint: 'Vegetable / y', action: vi.fn() },
    ]
    render(<CommandPalette open onClose={vi.fn()} commands={commands} />)
    // Initial — both headers present
    expect(screen.getByText('Fruit')).toBeDefined()
    expect(screen.getByText('Vegetable')).toBeDefined()
    // Filter to fruit only — Vegetable header should disappear
    const input = screen.getByRole('textbox', { name: 'Command search' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'apple' } })
    expect(screen.getByText('Fruit')).toBeDefined()
    expect(screen.queryByText('Vegetable')).toBeNull()
  })

  it('arrow-key navigation still advances through commands across groups (headers are not selectable)', () => {
    const commands: PaletteCommand[] = [
      { id: 'a', label: 'A', hint: 'Alpha / x', action: vi.fn() },
      { id: 'b', label: 'B', hint: 'Beta / y', action: vi.fn() },
    ]
    render(<CommandPalette open onClose={vi.fn()} commands={commands} />)
    const input = screen.getByRole('textbox', { name: 'Command search' })
    // Initial activeIdx=0 → command 'A' selected
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true')
    // ArrowDown should advance to 'B' (the second command), NOT to a
    // header. Headers don't get role=option so they're not in the list.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
  })
})

describe('delete-measure command — catalog wiring', () => {
  type Snap = Parameters<PaletteCommand['action']>[0]

  const cmd = COMMAND_CATALOG.find((c) => c.id === 'delete-measure')!

  function snap(over: Partial<Snap>): Snap {
    return {
      selection: undefined,
      measureRangeSelection: undefined,
      requestMeasureDelete: vi.fn(),
      ...over,
    } as unknown as Snap
  }

  it('is present in the catalog under Measure / Structure', () => {
    expect(cmd).toBeDefined()
    expect(cmd.hint).toBe('Measure / Structure')
  })

  it('is unavailable with no selection and no range', () => {
    expect(cmd.available?.(snap({}))).toBe(false)
  })

  it('is available when a single event is selected', () => {
    expect(cmd.available?.(snap({ selection: { measureIdx: 2, eventIdx: 0 } }))).toBe(true)
  })

  it('is available when a measure range is selected', () => {
    expect(cmd.available?.(snap({ measureRangeSelection: { fromStart: 1, fromEnd: 3 } }))).toBe(true)
  })

  it('routes a single selection to a single-bar delete request', () => {
    const requestMeasureDelete = vi.fn()
    cmd.action(snap({ selection: { measureIdx: 2, eventIdx: 0 }, requestMeasureDelete }))
    expect(requestMeasureDelete).toHaveBeenCalledWith({ fromStart: 2, fromEnd: 2 })
  })

  it('prefers an explicit measure range over the event selection', () => {
    const requestMeasureDelete = vi.fn()
    cmd.action(
      snap({
        selection: { measureIdx: 2, eventIdx: 0 },
        measureRangeSelection: { fromStart: 0, fromEnd: 1 },
        requestMeasureDelete,
      }),
    )
    expect(requestMeasureDelete).toHaveBeenCalledWith({ fromStart: 0, fromEnd: 1 })
  })

  it('does nothing when neither selection nor range is set', () => {
    const requestMeasureDelete = vi.fn()
    cmd.action(snap({ requestMeasureDelete }))
    expect(requestMeasureDelete).not.toHaveBeenCalled()
  })
})

describe('fuzzyFilterCommands — pure helper (M23-PR-7)', () => {
  const COMMANDS: PaletteCommand[] = [
    { id: 'set-tempo', label: 'Set tempo span', hint: 'Span / Tempo', action: vi.fn() },
    { id: 'add-chord', label: 'Add chord symbol', hint: 'Event / Harmony', action: vi.fn() },
    { id: 'set-marker', label: 'Set marker', hint: 'Markers / Mid-piece tempo', action: vi.fn() },
    { id: 'show-cheat', label: 'Show keyboard shortcuts', hint: 'View / Toggle', action: vi.fn() },
    { id: 'add-lyrics', label: 'Add lyrics', hint: 'Event / Verse', action: vi.fn() },
  ]

  it('empty query returns commands in catalog order (no ranking)', () => {
    const out = fuzzyFilterCommands(COMMANDS, '')
    expect(out.map((c) => c.id)).toEqual(COMMANDS.map((c) => c.id))
  })

  it('exact label match ranks above prefix/substring matches', () => {
    const cmds: PaletteCommand[] = [
      { id: 'longer', label: 'Set marker for tempo', action: vi.fn() },
      { id: 'exact', label: 'Set marker', action: vi.fn() },
    ]
    const out = fuzzyFilterCommands(cmds, 'set marker')
    expect(out[0].id).toBe('exact')
  })

  it('prefix match ranks above middle-of-label substring', () => {
    const cmds: PaletteCommand[] = [
      { id: 'mid', label: 'Add tempo span', action: vi.fn() },
      { id: 'prefix', label: 'Tempo direction', action: vi.fn() },
    ]
    const out = fuzzyFilterCommands(cmds, 'tempo')
    expect(out[0].id).toBe('prefix')
  })

  it('label substring ranks above hint-only substring', () => {
    const out = fuzzyFilterCommands(COMMANDS, 'tempo')
    // 'Set tempo span' (label) beats 'Set marker' (whose hint mentions tempo)
    expect(out[0].id).toBe('set-tempo')
    expect(out.map((c) => c.id)).toContain('set-marker')
  })

  it('subsequence match: "stmp" finds "Set tempo span"', () => {
    const out = fuzzyFilterCommands(COMMANDS, 'stmp')
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].id).toBe('set-tempo')
  })

  it('subsequence match: "addchd" finds "Add chord symbol"', () => {
    const out = fuzzyFilterCommands(COMMANDS, 'addchd')
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].id).toBe('add-chord')
  })

  it('subsequence match: "lyr" finds "Add lyrics"', () => {
    const out = fuzzyFilterCommands(COMMANDS, 'lyr')
    expect(out.length).toBeGreaterThan(0)
    expect(out.map((c) => c.id)).toContain('add-lyrics')
  })

  it('returns empty when no command matches even fuzzily', () => {
    const out = fuzzyFilterCommands(COMMANDS, 'qqqqq')
    expect(out).toEqual([])
  })

  it('multi-word: every term must match (AND semantics)', () => {
    const out = fuzzyFilterCommands(COMMANDS, 'add chord')
    expect(out.map((c) => c.id)).toContain('add-chord')
    expect(out.map((c) => c.id)).not.toContain('add-lyrics') // 'lyrics' has no 'chord'
  })

  it('multi-word: dropping any single word matches more commands', () => {
    const oneTerm = fuzzyFilterCommands(COMMANDS, 'add')
    const twoTerms = fuzzyFilterCommands(COMMANDS, 'add tempo')
    expect(oneTerm.length).toBeGreaterThanOrEqual(twoTerms.length)
  })

  it('case-insensitive', () => {
    const out = fuzzyFilterCommands(COMMANDS, 'TEMPO')
    expect(out[0].id).toBe('set-tempo')
  })

  it('whitespace-only query returns all commands', () => {
    const out = fuzzyFilterCommands(COMMANDS, '   ')
    expect(out.map((c) => c.id)).toEqual(COMMANDS.map((c) => c.id))
  })

  it('ties broken by catalog order (stable across runs)', () => {
    // Two commands with identical labels score identically. The one
    // declared first should appear first.
    const cmds: PaletteCommand[] = [
      { id: 'first', label: 'Open editor', action: vi.fn() },
      { id: 'second', label: 'Open editor', action: vi.fn() },
    ]
    const out = fuzzyFilterCommands(cmds, 'open')
    expect(out.map((c) => c.id)).toEqual(['first', 'second'])
  })
})

describe('CommandPalette — fuzzy ranking surfaces best match first (M23-PR-7)', () => {
  it('the top result reflects fuzzy ranking, not catalog order', () => {
    const commands: PaletteCommand[] = [
      { id: 'first-in-catalog', label: 'Add lyrics', hint: 'Event', action: vi.fn() },
      { id: 'exact-match', label: 'Tempo', hint: 'Span', action: vi.fn() },
      { id: 'partial', label: 'Set tempo span', hint: 'Span', action: vi.fn() },
    ]
    render(<CommandPalette open onClose={vi.fn()} commands={commands} />)
    const input = screen.getByRole('textbox', { name: 'Command search' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'tempo' } })
    // The exact-label match should be the first visible row (and the
    // active one since activeIdx resets to 0 on query change).
    const options = screen.getAllByRole('option')
    expect(options[0].textContent).toContain('Tempo')
    expect(options[0].getAttribute('aria-selected')).toBe('true')
  })

  it('subsequence query "stmp" filters and ranks "Set tempo" first', () => {
    const commands: PaletteCommand[] = [
      { id: 'noise1', label: 'Add lyrics', action: vi.fn() },
      { id: 'target', label: 'Set tempo', action: vi.fn() },
      { id: 'noise2', label: 'Show shortcuts', action: vi.fn() },
    ]
    render(<CommandPalette open onClose={vi.fn()} commands={commands} />)
    const input = screen.getByRole('textbox', { name: 'Command search' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'stmp' } })
    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThanOrEqual(1)
    expect(options[0].textContent).toContain('Set tempo')
  })
})
