import { useChatStore } from '@/lib/chat/state'
import { getStaffEventAt } from '@/lib/music/scoreAccessors'

/** The shape returned by `useChatStore.getState()`. Inferred so we
 *  don't need to re-export the private ChatStore interface. */
type StoreSnapshot = ReturnType<typeof useChatStore.getState>

/**
 * Helper: does the current selection point at an event with a stable
 * id? Span-class popovers (hairpin/slur/tempo-span/octave-span/
 * glissando/trill-line/tremolo-between) need an endpoint id to
 * reference, so their catalog `available` predicates use this.
 */
function selectionHasEventWithId(s: StoreSnapshot): boolean {
  const sel = s.selection
  const score = s.editedScore
  if (!sel || !score) return false
  const event = getStaffEventAt(score, sel.staffIdx ?? 0, sel.measureIdx, sel.eventIdx)
  return event?.id !== undefined
}

/**
 * Helper: does the current selection point at an event with at least
 * one non-rest pitch? Tie popover needs this — all three tie-family
 * ops reject on rests.
 */
function selectionHasPitchedEvent(s: StoreSnapshot): boolean {
  const sel = s.selection
  const score = s.editedScore
  if (!sel || !score) return false
  const event = getStaffEventAt(score, sel.staffIdx ?? 0, sel.measureIdx, sel.eventIdx)
  return event !== undefined && event.pitches.some((p) => p.step !== 'rest')
}

/**
 * Command palette catalog (M23-PR-1 scaffold). Each command is a
 * pure function from the chat-store API to an action — the palette
 * resolves them at submit time with `useChatStore.getState()` so
 * callers don't risk stale closure references.
 *
 * The scaffold ships only commands that operate on global chat-store
 * actions (toggles + setters) so no anchor-coordinate plumbing is
 * needed. Popover-opening commands ("Set tempo…", "Add chord
 * symbol…") arrive in M23-PR-2+ once a global popover dispatch bus
 * exists.
 *
 * Categories are advisory only — the palette renders commands in
 * catalog order without grouping today. Adding grouping later is a
 * UI-only change.
 */
export interface PaletteCommand {
  id: string
  label: string
  /** Right-side keybind hint (e.g., "Shift+/"). Display only. */
  keybind?: string
  /** Filterable secondary text (e.g., "View / Toggle"). */
  hint?: string
  /**
   * Action receives a *fresh* store snapshot at submit time. Don't
   * close over the store from the catalog declaration site —
   * `useChatStore.getState()` inside `action` keeps the dispatch
   * synced to the user's latest state.
   */
  action: (store: StoreSnapshot) => void
  /**
   * Optional gate (M23-PR-3): when present and returning false, the
   * command is filtered out of the palette's visible list. Used for
   * commands that require a selection (Open marker editor needs a
   * measure to anchor on) or other store-state preconditions.
   *
   * Evaluated once per palette open via `useChatStore.getState()`.
   * The catalog is filtered at render time, not on every keystroke —
   * store changes mid-search are intentionally NOT reactive (the
   * user's filter intent shouldn't be invalidated by a background
   * score edit).
   */
  available?: (store: StoreSnapshot) => boolean
}

export const COMMAND_CATALOG: PaletteCommand[] = [
  // ── Score / Metadata ─────────────────────────────────────────────
  {
    id: 'open-score-info',
    label: 'Open score info…',
    hint: 'Score / Metadata',
    action: (s) => s.setPaletteRequest({ kind: 'open-score-info' }),
  },
  // ── Mid-piece markers (require a selection to anchor on) ─────────
  {
    id: 'open-marker',
    label: 'Edit marker (tempo / key / meter / clef)…',
    keybind: 'Shift+M',
    hint: 'Markers / Mid-piece',
    available: (s) => s.selection !== undefined,
    action: (s) => s.setPaletteRequest({ kind: 'open-marker' }),
  },
  // ── Per-event editors (require a selection) ──────────────────────
  {
    id: 'open-dynamics',
    label: 'Edit dynamic on selected event…',
    keybind: 'Shift+D',
    hint: 'Event / Markings',
    available: (s) => s.selection !== undefined,
    action: (s) => s.setPaletteRequest({ kind: 'open-dynamics' }),
  },
  {
    id: 'open-chord-symbol',
    label: 'Edit chord symbol on selected event…',
    keybind: 'Shift+H',
    hint: 'Event / Harmony',
    available: (s) => s.selection !== undefined,
    action: (s) => s.setPaletteRequest({ kind: 'open-chord-symbol' }),
  },
  {
    id: 'open-lyrics',
    label: 'Edit lyrics on selected event…',
    keybind: 'Shift+V',
    hint: 'Event / Verse',
    available: (s) => s.selection !== undefined,
    action: (s) => s.setPaletteRequest({ kind: 'open-lyrics' }),
  },
  {
    id: 'open-annotation',
    label: 'Add annotation (text / rehearsal mark)…',
    keybind: 'Shift+T',
    hint: 'Event / Text',
    available: (s) => s.selection !== undefined,
    action: (s) => s.setPaletteRequest({ kind: 'open-annotation' }),
  },
  // ── Spans (require selection AND event.id; span endpoints reference ids) ──
  {
    id: 'open-hairpin',
    label: 'Add hairpin (crescendo / diminuendo)…',
    keybind: 'Shift+W',
    hint: 'Span / Dynamics',
    available: selectionHasEventWithId,
    action: (s) => s.setPaletteRequest({ kind: 'open-hairpin' }),
  },
  {
    id: 'open-slur',
    label: 'Add slur / phrase slur…',
    keybind: 'Shift+S',
    hint: 'Span / Phrasing',
    available: selectionHasEventWithId,
    action: (s) => s.setPaletteRequest({ kind: 'open-slur' }),
  },
  {
    id: 'open-tempo-span',
    label: 'Add tempo span (accel. / rit.)…',
    keybind: 'Shift+L',
    hint: 'Span / Tempo',
    available: selectionHasEventWithId,
    action: (s) => s.setPaletteRequest({ kind: 'open-tempo-span' }),
  },
  {
    id: 'open-octave-span',
    label: 'Add octave span (8va / 8vb / 15ma / 15mb)…',
    keybind: 'Shift+U',
    hint: 'Span / Octave',
    available: selectionHasEventWithId,
    action: (s) => s.setPaletteRequest({ kind: 'open-octave-span' }),
  },
  {
    id: 'open-glissando',
    label: 'Add glissando…',
    keybind: 'Shift+G',
    hint: 'Span / Ornament',
    available: selectionHasEventWithId,
    action: (s) => s.setPaletteRequest({ kind: 'open-glissando' }),
  },
  {
    id: 'open-trill-line',
    label: 'Add trill line…',
    keybind: 'Shift+Z',
    hint: 'Span / Ornament',
    available: selectionHasEventWithId,
    action: (s) => s.setPaletteRequest({ kind: 'open-trill-line' }),
  },
  {
    id: 'open-tremolo-between',
    label: 'Add tremolo between two notes…',
    keybind: 'Shift+X',
    hint: 'Span / Ornament',
    available: selectionHasEventWithId,
    action: (s) => s.setPaletteRequest({ kind: 'open-tremolo-between' }),
  },
  // ── Event-anchored (selection required; tie additionally needs a pitched event) ──
  {
    id: 'open-tie',
    label: 'Edit ties on selected event…',
    keybind: 'Shift+I',
    hint: 'Event / Ties',
    available: selectionHasPitchedEvent,
    action: (s) => s.setPaletteRequest({ kind: 'open-tie' }),
  },
  {
    id: 'open-fingering',
    label: 'Edit fingerings on selected event…',
    keybind: 'Shift+F',
    hint: 'Event / Fingering',
    available: (s) => s.selection !== undefined,
    action: (s) => s.setPaletteRequest({ kind: 'open-fingering' }),
  },
  {
    id: 'open-ornament',
    label: 'Edit ornament on selected event…',
    keybind: 'Shift+O',
    hint: 'Event / Ornament',
    available: (s) => s.selection !== undefined,
    action: (s) => s.setPaletteRequest({ kind: 'open-ornament' }),
  },
  {
    id: 'open-technique',
    label: 'Edit performance technique on selected event…',
    keybind: 'Shift+P',
    hint: 'Event / Technique',
    available: (s) => s.selection !== undefined,
    action: (s) => s.setPaletteRequest({ kind: 'open-technique' }),
  },
  {
    id: 'open-grace-note',
    label: 'Edit grace notes on selected event…',
    keybind: 'Shift+R',
    hint: 'Event / Grace notes',
    available: (s) => s.selection !== undefined,
    action: (s) => s.setPaletteRequest({ kind: 'open-grace-note' }),
  },
  // ── Measure-scoped (require selection for the target measure) ────
  {
    id: 'open-barline',
    label: 'Edit barline at current measure…',
    keybind: 'Shift+J',
    hint: 'Measure / Barline',
    available: (s) => s.selection !== undefined,
    action: (s) => s.setPaletteRequest({ kind: 'open-barline' }),
  },
  {
    id: 'open-volta',
    label: 'Edit volta (1st / 2nd ending) at current measure…',
    keybind: 'Shift+K',
    hint: 'Measure / Repeats',
    available: (s) => s.selection !== undefined,
    action: (s) => s.setPaletteRequest({ kind: 'open-volta' }),
  },
  {
    id: 'open-jump-marker',
    label: 'Edit jump marker (D.C. / D.S. / Coda) at current measure…',
    keybind: 'Shift+Y',
    hint: 'Measure / Jumps',
    available: (s) => s.selection !== undefined,
    action: (s) => s.setPaletteRequest({ kind: 'open-jump-marker' }),
  },
  {
    id: 'delete-measure',
    label: 'Delete selected measure(s)…',
    keybind: 'Shift+Backspace',
    hint: 'Measure / Structure',
    // A measure range (Cmd/Ctrl+click a bar) takes precedence; otherwise
    // the selected event's measure is the single-bar target.
    available: (s) => s.measureRangeSelection !== undefined || s.selection !== undefined,
    action: (s) => {
      const range =
        s.measureRangeSelection ??
        (s.selection ? { fromStart: s.selection.measureIdx, fromEnd: s.selection.measureIdx } : undefined)
      // Opens the always-confirm gate (MeasureDeleteConfirmModal); the
      // actual span/marker-safe dragMeasureRange delete fires on confirm.
      if (range) s.requestMeasureDelete(range)
    },
  },
  // ── View / Toggle ────────────────────────────────────────────────
  {
    id: 'toggle-cheatsheet',
    label: 'Show keyboard shortcuts',
    keybind: 'Shift+/',
    hint: 'View / Toggle',
    action: (s) => s.toggleCheatSheet(),
  },
  {
    id: 'toggle-chord-palette',
    label: 'Toggle chord palette',
    hint: 'View / Toggle',
    action: (s) => s.toggleChordPalette(),
  },
  {
    id: 'toggle-chat-panel',
    label: 'Toggle chat history panel',
    hint: 'View / Toggle',
    action: (s) => s.togglePanel(),
  },
  {
    id: 'toggle-follow-playback',
    label: 'Toggle follow playback',
    hint: 'View / Playback',
    action: (s) => s.setFollowPlayback(!s.followPlayback),
  },
  // ── Duration picker ──────────────────────────────────────────────
  {
    id: 'duration-whole',
    label: 'Set whole-note duration',
    keybind: '6',
    hint: 'Insert / Duration',
    action: (s) => s.setActiveDuration('whole'),
  },
  {
    id: 'duration-half',
    label: 'Set half-note duration',
    keybind: '5',
    hint: 'Insert / Duration',
    action: (s) => s.setActiveDuration('half'),
  },
  {
    id: 'duration-quarter',
    label: 'Set quarter-note duration',
    keybind: '4',
    hint: 'Insert / Duration',
    action: (s) => s.setActiveDuration('quarter'),
  },
  {
    id: 'duration-eighth',
    label: 'Set eighth-note duration',
    keybind: '3',
    hint: 'Insert / Duration',
    action: (s) => s.setActiveDuration('eighth'),
  },
  {
    id: 'duration-sixteenth',
    label: 'Set sixteenth-note duration',
    keybind: '2',
    hint: 'Insert / Duration',
    action: (s) => s.setActiveDuration('sixteenth'),
  },
  {
    id: 'toggle-dotted',
    label: 'Toggle dotted duration',
    keybind: '.',
    hint: 'Insert / Duration',
    action: (s) => s.toggleActiveDotted(),
  },
  // ── Accidental picker ────────────────────────────────────────────
  {
    id: 'accidental-sharp',
    label: 'Sharp accidental',
    keybind: '=',
    hint: 'Insert / Accidental',
    action: (s) => s.setActiveAccidental('sharp'),
  },
  {
    id: 'accidental-flat',
    label: 'Flat accidental',
    keybind: '-',
    hint: 'Insert / Accidental',
    action: (s) => s.setActiveAccidental('flat'),
  },
  {
    id: 'accidental-natural',
    label: 'Natural accidental',
    keybind: '0',
    hint: 'Insert / Accidental',
    action: (s) => s.setActiveAccidental('natural'),
  },
  {
    id: 'accidental-clear',
    label: 'Clear accidental',
    hint: 'Insert / Accidental',
    action: (s) => s.setActiveAccidental('none'),
  },
]

/**
 * Filter commands by their `available` predicate against a store
 * snapshot (M23-PR-3). Commands without a predicate pass through.
 * Used by the palette to hide selection-required commands when
 * there's nothing to anchor on.
 *
 * The palette evaluates this once per OPEN (not on every keystroke),
 * so a background score edit during an open session won't invalidate
 * the user's filter intent.
 */
export function applyAvailabilityFilter(
  commands: readonly PaletteCommand[],
  store: StoreSnapshot,
): PaletteCommand[] {
  return commands.filter((cmd) => cmd.available === undefined || cmd.available(store))
}

/**
 * Substring-includes filter on label + hint. Case-insensitive. Empty
 * query passes everything through. Multi-word queries match when EVERY
 * term appears somewhere in label or hint — favors "natural sharp" →
 * matching commands containing both words.
 *
 * Retained as the simpler reference filter; the palette itself uses
 * [[fuzzyFilterCommands]] for ranked output. Pure helpers, both
 * exported so tests can pin behavior independently.
 */
export function filterCommands(
  commands: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...commands]
  const terms = q.split(/\s+/).filter(Boolean)
  return commands.filter((cmd) => {
    const haystack = `${cmd.label} ${cmd.hint ?? ''}`.toLowerCase()
    return terms.every((t) => haystack.includes(t))
  })
}

/**
 * Fuzzy filter + ranking (M23-PR-7). Returns commands sorted by match
 * quality. Multi-word queries require EVERY term to match somewhere
 * (in label or label+hint, with label matches preferred).
 *
 * Per-term scoring tiers (highest first):
 *   - Exact label match: 10000
 *   - Label prefix match: 5000 − label.length (shorter label wins)
 *   - Label substring match: 1000 − labelSubstrIdx − label.length
 *   - Label+hint substring match: 500 − haystackSubstrIdx
 *   - Label subsequence match (each query char appears in label in
 *     order; needn't be contiguous): 100 + contiguity bonus
 *   - Label+hint subsequence match: 50 + contiguity bonus
 *   - No match: 0 (term is rejected; command drops)
 *
 * "stmp" → "Set tempo span…" via the label-subsequence tier.
 * "addchd" → "Add chord symbol…" via the same.
 * "tempo" → "Set tempo span…" (label substring) ranks above "Set
 * marker (tempo / key / meter / clef)…" (hint mentions tempo too,
 * but label-substring beats hint-substring).
 *
 * Empty / whitespace query passes everything through unranked
 * (preserves catalog order so the visual grouping from M23-PR-6
 * matches the authored order).
 */
export function fuzzyFilterCommands(
  commands: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...commands]
  const terms = q.split(/\s+/).filter(Boolean)
  const results: Array<{ command: PaletteCommand; score: number; idx: number }> = []
  commands.forEach((cmd, idx) => {
    const label = cmd.label.toLowerCase()
    const haystack = `${cmd.label} ${cmd.hint ?? ''}`.toLowerCase()
    let total = 0
    let ok = true
    for (const term of terms) {
      const s = fuzzyTermScore(term, label, haystack)
      if (s <= 0) {
        ok = false
        break
      }
      total += s
    }
    if (ok) results.push({ command: cmd, score: total, idx })
  })
  // Higher score first; ties broken by original catalog order so the
  // sort is stable across repeated runs (matches the visual grouping
  // expectation from M23-PR-6 and gives deterministic test output).
  results.sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
  return results.map((r) => r.command)
}

function fuzzyTermScore(term: string, label: string, haystack: string): number {
  if (label === term) return 10000
  if (label.startsWith(term)) return 5000 - label.length
  const labelSub = label.indexOf(term)
  if (labelSub !== -1) return 1000 - labelSub - label.length
  const haystackSub = haystack.indexOf(term)
  if (haystackSub !== -1) return 500 - haystackSub
  const labelSeq = subsequenceScore(term, label)
  if (labelSeq > 0) return 100 + labelSeq
  const haystackSeq = subsequenceScore(term, haystack)
  if (haystackSeq > 0) return 50 + haystackSeq
  return 0
}

/**
 * Score a subsequence match: every character of `needle` must appear
 * in `haystack` in order (not necessarily contiguous). Returns 0 when
 * no match exists, otherwise a positive score where contiguous runs
 * are rewarded and shorter haystacks rank slightly higher.
 */
function subsequenceScore(needle: string, haystack: string): number {
  let hi = 0
  let lastMatch = -1
  let contiguous = 0
  for (let ni = 0; ni < needle.length; ni++) {
    const nc = needle[ni]
    let found = -1
    for (let i = hi; i < haystack.length; i++) {
      if (haystack[i] === nc) {
        found = i
        break
      }
    }
    if (found === -1) return 0
    if (found === lastMatch + 1) contiguous++
    lastMatch = found
    hi = found + 1
  }
  // Reward contiguous chars heavily; small bonus for short haystacks.
  return 10 * contiguous + Math.max(0, 50 - haystack.length)
}

/**
 * Group commands by their hint category (M23-PR-6). The "category" is
 * the part of the hint before the first "/" (e.g., "Span / Dynamics"
 * → "Span"). Commands without a hint group under "Other".
 *
 * Preserves declaration order (first-occurrence wins) so the palette's
 * visual section order matches the catalog's authored order — easier
 * to reason about than a sort.
 *
 * Returns an empty array for an empty input (so the palette can fall
 * back to its empty-state message).
 */
export interface CommandGroup {
  category: string
  commands: PaletteCommand[]
}

export function groupCommandsByCategory(
  commands: readonly PaletteCommand[],
): CommandGroup[] {
  const groups: CommandGroup[] = []
  const byCategory = new Map<string, CommandGroup>()
  for (const cmd of commands) {
    const cat = extractCategory(cmd.hint)
    let group = byCategory.get(cat)
    if (!group) {
      group = { category: cat, commands: [] }
      byCategory.set(cat, group)
      groups.push(group)
    }
    group.commands.push(cmd)
  }
  return groups
}

function extractCategory(hint: string | undefined): string {
  if (!hint) return 'Other'
  const slashIdx = hint.indexOf('/')
  const prefix = slashIdx === -1 ? hint : hint.slice(0, slashIdx)
  const trimmed = prefix.trim()
  return trimmed.length > 0 ? trimmed : 'Other'
}
