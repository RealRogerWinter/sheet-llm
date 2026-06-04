import type { ContextTarget } from '@/lib/chat/state'

/**
 * One row in the right-click context menu. `id` encodes the action the
 * ContextMenu dispatches (see `ContextMenu.run`): `play`, `acc:<value>`,
 * `dur:<value>`, `bus:<paletteKind>`, `open-barline|volta|jump-marker`,
 * `measure:*`, `range:*`, `cut`/`copy`/`paste`, `remove-from-chord`,
 * `delete`.
 */
export interface ContextMenuItem {
  id: string
  label: string
  /** Renders in the danger color (destructive action). */
  danger?: boolean
  /** Rendered greyed + non-firing (e.g. Paste with an empty/incompatible clipboard). */
  disabled?: boolean
}

/** A divider-separated group of items, with an optional small header. */
export interface ContextMenuSection {
  label?: string
  items: ContextMenuItem[]
}

export interface ContextMenuOpts {
  /**
   * True when the selected event carries an `id`. Span popovers
   * (slur / hairpin / octave / glissando / trill / tremolo) soft-deadlock
   * on id-less events — their render guards return null — so we hide
   * those rows unless the event has an id. Mirrors the floating menu's
   * `selectedEvent?.id !== undefined` gate.
   */
  eventHasId?: boolean
  /** M28: show the Cut/Copy/Paste section (gated by NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD). */
  clipboardEnabled?: boolean
  /** M28: the current clipboard entry's kind (undefined = empty) — drives the Paste enable. */
  clipboardKind?: 'events' | 'measures'
  /** M29: show the AI-entry section (gated by NEXT_PUBLIC_SL_CONTEXT_AI). */
  aiEnabled?: boolean
}

const ACCIDENTAL_ITEMS: ContextMenuItem[] = [
  { id: 'acc:sharp', label: '♯  Sharp' },
  { id: 'acc:natural', label: '♮  Natural' },
  { id: 'acc:flat', label: '♭  Flat' },
]

const DURATION_ITEMS: ContextMenuItem[] = [
  { id: 'dur:whole', label: 'Whole note' },
  { id: 'dur:half', label: 'Half note' },
  { id: 'dur:quarter', label: 'Quarter note' },
  { id: 'dur:eighth', label: 'Eighth note' },
  { id: 'dur:sixteenth', label: 'Sixteenth note' },
]

const EXPRESSION_ITEMS: ContextMenuItem[] = [
  { id: 'bus:open-dynamics', label: 'Dynamics…' },
  { id: 'bus:open-ornament', label: 'Ornament…' },
]

const TEXT_ITEMS: ContextMenuItem[] = [
  { id: 'bus:open-fingering', label: 'Fingering…' },
  { id: 'bus:open-annotation', label: 'Annotation…' },
  { id: 'bus:open-lyrics', label: 'Lyrics…' },
]

/** Tie is always available on a pitched event; the spans need an event id. */
function lineItems(eventHasId: boolean | undefined): ContextMenuItem[] {
  const items: ContextMenuItem[] = [{ id: 'bus:open-tie', label: 'Tie…' }]
  if (eventHasId) {
    items.push(
      { id: 'bus:open-slur', label: 'Slur…' },
      { id: 'bus:open-hairpin', label: 'Hairpin…' },
    )
  }
  return items
}

/**
 * The Cut/Copy/Paste section for a target (M28), or null when clipboard is
 * disabled or the target has no clipboard verbs (barline/empty/none).
 * Paste's enable predicate:
 *  - event targets: an `events` clipboard pastes the run into the bar.
 *  - measure target: any non-empty clipboard (events → into the bar;
 *    measures → insert bars after).
 *  - range target: a `measures` clipboard replaces the range.
 */
function clipboardSection(target: ContextTarget, opts: ContextMenuOpts): ContextMenuSection | null {
  if (!opts.clipboardEnabled) return null
  const kind = opts.clipboardKind
  if (target.kind === 'note' || target.kind === 'rest' || target.kind === 'chordNote') {
    return {
      items: [
        { id: 'cut', label: 'Cut' },
        { id: 'copy', label: 'Copy' },
        { id: 'paste', label: 'Paste', disabled: kind !== 'events' },
      ],
    }
  }
  if (target.kind === 'measure') {
    return {
      items: [
        { id: 'cut', label: 'Cut measure' },
        { id: 'copy', label: 'Copy measure' },
        { id: 'paste', label: 'Paste', disabled: kind === undefined },
      ],
    }
  }
  if (target.kind === 'range') {
    return {
      items: [
        { id: 'cut', label: 'Cut measures' },
        { id: 'copy', label: 'Copy measures' },
        { id: 'paste', label: 'Paste over selection', disabled: kind !== 'measures' },
      ],
    }
  }
  return null
}

/**
 * The per-context menu, as labeled SECTIONS (rendered divider-separated).
 * Pure + exhaustively testable: the item set per target kind is the
 * contract (a rest never offers accidentals or a tie; a chord-note offers
 * "remove this note from chord"; span rows appear only when the event has
 * an id; Cut/Copy/Paste appear only when the clipboard flag is on).
 */
/**
 * The AI-entry section (M29) — gated on `aiEnabled`. Every item seeds a
 * 1-based target-scoped prompt into the chat input (see `contextMenuAi`);
 * none send headlessly.
 */
function aiSection(target: ContextTarget, opts: ContextMenuOpts): ContextMenuSection | null {
  if (!opts.aiEnabled) return null
  if (target.kind === 'note' || target.kind === 'rest' || target.kind === 'chordNote') {
    return {
      label: 'AI',
      items: [
        { id: 'ai:edit', label: 'Edit this with AI…' },
        { id: 'ai:explain', label: 'Explain with AI' },
      ],
    }
  }
  if (target.kind === 'measure') {
    return {
      label: 'AI',
      items: [
        { id: 'ai:regenerate', label: 'Regenerate this measure' },
        { id: 'ai:edit', label: 'Edit with AI…' },
        { id: 'ai:explain', label: 'Explain with AI' },
      ],
    }
  }
  if (target.kind === 'range') {
    return {
      label: 'AI',
      items: [
        { id: 'ai:regenerate-range', label: 'Regenerate these measures' },
        { id: 'ai:explain', label: 'Explain with AI' },
      ],
    }
  }
  return null
}

export function contextMenuSections(
  target: ContextTarget,
  opts: ContextMenuOpts = {},
): ContextMenuSection[] {
  const clipSection = clipboardSection(target, opts)
  const aiSec = aiSection(target, opts)
  const pre = [...(clipSection ? [clipSection] : []), ...(aiSec ? [aiSec] : [])]
  switch (target.kind) {
    case 'note':
      return [
        { items: [{ id: 'play', label: '▶  Play from here' }] },
        ...pre,
        { label: 'Accidental', items: ACCIDENTAL_ITEMS },
        { label: 'Duration', items: DURATION_ITEMS },
        { label: 'Expression', items: EXPRESSION_ITEMS },
        { label: 'Text', items: TEXT_ITEMS },
        { label: 'Lines', items: lineItems(opts.eventHasId) },
        { items: [{ id: 'delete', label: 'Delete note', danger: true }] },
      ]
    case 'rest':
      // Rest-illegal verbs (accidentals, tie, dynamics) are omitted —
      // they throw EditError downstream.
      return [
        { items: [{ id: 'play', label: '▶  Play from here' }] },
        ...pre,
        { label: 'Duration', items: DURATION_ITEMS },
        { items: [{ id: 'delete', label: 'Delete rest', danger: true }] },
      ]
    case 'chordNote':
      return [
        { items: [{ id: 'remove-from-chord', label: 'Remove this note from chord' }] },
        ...pre,
        { label: 'Accidental', items: ACCIDENTAL_ITEMS },
        { label: 'Duration', items: DURATION_ITEMS },
        { label: 'Expression', items: EXPRESSION_ITEMS },
        { label: 'Lines', items: lineItems(opts.eventHasId) },
        { items: [{ id: 'delete', label: 'Delete chord', danger: true }] },
      ]
    case 'measure':
      return [
        { items: [{ id: 'measure:insert', label: 'Insert note' }] },
        ...pre,
        {
          label: 'Structure',
          items: [
            { id: 'open-barline', label: 'Barline…' },
            { id: 'open-volta', label: 'Volta…' },
            { id: 'open-jump-marker', label: 'Repeat / jump…' },
          ],
        },
        { items: [{ id: 'measure:select', label: 'Select measure' }] },
        { items: [{ id: 'measure:delete', label: `Delete measure ${target.measureIdx + 1}`, danger: true }] },
      ]
    case 'barline':
      // measureIdx is the bar the barline op keys off (inferred from the
      // nearest measure X-band by the classifier).
      return [
        {
          label: 'Structure',
          items: [
            { id: 'open-barline', label: 'Set barline…' },
            { id: 'open-volta', label: 'Volta…' },
          ],
        },
        { items: [{ id: 'measure:delete', label: `Delete measure ${target.measureIdx + 1}`, danger: true }] },
      ]
    case 'range':
      return [
        ...pre,
        {
          items: [
            {
              id: 'range:delete',
              label: `Delete measures ${target.range.fromStart + 1}–${target.range.fromEnd + 1}`,
              danger: true,
            },
          ],
        },
      ]
    default:
      // empty / none — no actionable target → native browser menu.
      return []
  }
}
