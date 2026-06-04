'use client'

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useChatStore } from '@/lib/chat/state'
import Popover from './Popover'
import {
  applyAvailabilityFilter,
  COMMAND_CATALOG,
  fuzzyFilterCommands,
  groupCommandsByCategory,
  type PaletteCommand,
} from './commandCatalog'
import styles from './CommandPalette.module.css'

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  /** Override the catalog (tests only). Defaults to COMMAND_CATALOG. */
  commands?: readonly PaletteCommand[]
}

/**
 * ⌘K command palette (M23-PR-1 scaffold). Modeless centered popover
 * with a search input, an arrow-key-navigable filtered command list,
 * and Enter to dispatch. Esc closes (handled by the underlying
 * [[Popover]] shell). Mouse-hover updates the active index so click +
 * keyboard stay in sync.
 *
 * Commands resolve through [[useChatStore.getState]] at dispatch time
 * so they pick up the user's latest state (closure-staleness defense,
 * matching the per-popover convention across M3.5..M20).
 *
 * Centering: the underlying Popover anchors to a viewport-derived
 * point (innerWidth/2, innerHeight/3) and its clamp logic keeps the
 * frame inside the viewport. No special "centered" mode needed.
 */
export default function CommandPalette({
  open,
  onClose,
  commands = COMMAND_CATALOG,
}: CommandPaletteProps): React.ReactElement | null {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  // Availability-filtered subset snapshotted on every open via
  // `applyAvailabilityFilter`. Stored in state so the catalog stays
  // stable across keystrokes — the user's filter intent shouldn't be
  // invalidated by a background score edit while the palette is open.
  const [availableCommands, setAvailableCommands] = useState<readonly PaletteCommand[]>(commands)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset query + selection + focus the input on each closed→open
  // transition (wasOpen pattern, matches BarlinePopover/VoltaPopover/
  // LyricsPopover). A mid-popover re-render with `open` still true
  // does NOT clear the user's in-flight query. Also re-snapshots the
  // availability-filtered catalog so freshly satisfied predicates
  // (e.g. user just selected an event) include their commands.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setQuery('')
      setActiveIdx(0)
      setAvailableCommands(applyAvailabilityFilter(commands, useChatStore.getState()))
      // Defer focus to a microtask so the Popover has mounted the
      // input into the DOM. Matches the queueMicrotask pattern in
      // BarlinePopover.
      queueMicrotask(() => inputRef.current?.focus())
    }
    wasOpen.current = open
  }, [open, commands])

  const filtered = useMemo(
    () => fuzzyFilterCommands(availableCommands, query),
    [availableCommands, query],
  )

  // Per-keystroke onChange already resets activeIdx to 0 on every
  // query mutation, so a stale activeIdx only matters when the
  // `commands` prop itself shrinks. The catalog is stable in
  // production; tests that swap the commands prop should also
  // reopen the palette to reset. No additional clamp effect needed.

  function dispatch(cmd: PaletteCommand) {
    // Close FIRST so any UI-changing action lands on a fresh frame
    // without the palette overlapping; matches the popover-close-
    // before-dispatch pattern in NoteFloatingMenu.
    onClose()
    cmd.action(useChatStore.getState())
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filtered[activeIdx]
      if (cmd) dispatch(cmd)
    }
    // Esc bubbles to Popover's keydown handler — don't intercept it
    // here.
  }

  // Anchor at upper-center of the viewport. The underlying Popover
  // clamps to viewport bounds, so we don't need precision here —
  // anchorY=innerHeight/3 places the top of the palette around the
  // upper third of the screen, the conventional spot for ⌘K palettes.
  const anchorX = typeof window !== 'undefined' ? window.innerWidth / 2 : 400
  const anchorY = typeof window !== 'undefined' ? Math.floor(window.innerHeight / 3) : 120

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedWidth={480}
      // 80px is the chrome (input + padding + gaps); 30px per row;
      // capped so the list scrolls instead of growing off-screen.
      estimatedHeight={Math.min(400, 80 + filtered.length * 30)}
      ariaLabel="Command palette"
      className={styles.palette}
    >
      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActiveIdx(0)
        }}
        onKeyDown={onKeyDown}
        placeholder="Type a command…"
        aria-label="Command search"
        // Keyboard-only navigation; suppress the default browser
        // autocomplete chrome which adds noise to a transient input.
        autoComplete="off"
        spellCheck={false}
      />
      <div className={styles.list} role="listbox" aria-label="Commands">
        {filtered.length === 0 ? (
          <div className={styles.empty}>No matching commands</div>
        ) : (
          // M23-PR-6: render commands in category groups with section
          // headers. activeIdx still tracks the FLAT filtered-list
          // index so keyboard navigation skips headers naturally
          // (headers don't render with the active class, and arrow
          // keys advance through commands).
          groupCommandsByCategory(filtered).map((group) => (
            <div key={group.category} className={styles.group}>
              <div className={styles.groupHeader} role="presentation">
                {group.category}
              </div>
              {group.commands.map((cmd) => {
                // Map the command back to its position in the flat
                // filtered list so the active highlight stays in sync
                // with keyboard navigation (O(n) per cmd, fine at our
                // catalog size).
                const flatIdx = filtered.indexOf(cmd)
                const isActive = flatIdx === activeIdx
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    className={
                      isActive ? `${styles.row} ${styles.rowActive}` : styles.row
                    }
                    onMouseEnter={() => setActiveIdx(flatIdx)}
                    onClick={() => dispatch(cmd)}
                    role="option"
                    aria-selected={isActive}
                  >
                    <span className={styles.label}>{cmd.label}</span>
                    {cmd.keybind && (
                      <span className={styles.keybind}>{cmd.keybind}</span>
                    )}
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>
    </Popover>
  )
}
