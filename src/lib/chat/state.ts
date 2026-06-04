'use client'

import { useEffect } from 'react'
import { create } from 'zustand'
import type { Accidental, Duration, Event, Measure, Score, Span } from '@/lib/music/types'
import type { TargetRegion } from '@/lib/shared/types'
import type { Operation } from '@/lib/music/editOperations'
import { transformScore, EditError } from '@/lib/music/editOperations'
import type { BalancedOp } from '@/lib/music/transformScoreBalanced'
import { transformScoreBalanced } from '@/lib/music/transformScoreBalanced'
import { BalanceError } from '@/lib/music/measureBalance'
import { validateScore } from '@/lib/music/validateScore'
import {
  getEventAt,
  getStaffCount,
  getStaffMeasureAt,
  getVoiceCount,
  getVoiceMeasureAt,
} from '@/lib/music/scoreAccessors'
import { scoreToAbcWithMap, type SourceMap } from '@/lib/music/scoreToAbcWithMap'
import { pitchAudioPing } from '@/lib/abc/pitchAudioPing'
import { resetSession } from './resetSession'
import type { ImportFormat, TranscriptTurn } from '@/lib/shared/types'

/**
 * Note-picker active state — UI-only. Drives the toolbar buttons that
 * choose which note will be placed by the next click-to-place gesture.
 *
 * `activeDuration` is always one of the SIX base values; the dotted
 * variants (dotted-half, dotted-quarter, dotted-eighth) are produced on
 * the fly when `activeDotted` is true via `effectiveActiveDuration`.
 * Keeping the base separate lets the dot toggle round-trip cleanly
 * (toggle off and you get the non-dotted base back).
 */
export type BaseDuration = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth' | '32nd'
export type ActiveAccidental = 'sharp' | 'natural' | 'flat' | 'none'

export function effectiveActiveDuration(base: BaseDuration, dotted: boolean): Duration {
  if (!dotted) return base
  if (base === 'half') return 'dotted-half'
  if (base === 'quarter') return 'dotted-quarter'
  if (base === 'eighth') return 'dotted-eighth'
  return base
}

export type Selection = {
  /** 0 = primary staff (treble by default); 1 = secondStaff when present. */
  staffIdx?: number
  /** 0 = primary voice on this staff; 1..N = extraVoices entries. */
  voiceIdx?: number
  measureIdx: number
  eventIdx: number
  pitchIdx?: number
  /** Optional click anchor (viewport coords) — used by NoteFloatingMenu to position itself. */
  anchorX?: number
  anchorY?: number
}

/**
 * Inclusive measure-index range for structural ops (M19-PR-6).
 * Distinct from the per-event `selection` — used by the bar-level
 * keyboard shortcuts (Shift+Backspace deletes the range; Cmd+D
 * duplicates it) and the drag-and-drop MOVE gesture (M19-PR-8).
 * Driven by Cmd/Ctrl+click on a measure (single bar) or Cmd/Ctrl+
 * Shift+click to extend.
 *
 * Invariant: 0 ≤ fromStart ≤ fromEnd ≤ measures.length-1. Setters
 * enforce normalization and prune against measures.length on score
 * mutation.
 */
export type MeasureRangeSelection = {
  fromStart: number
  fromEnd: number
}

/**
 * Intra-measure run selection (M28-PR-4 / D2): a contiguous span of events
 * `[startEventIdx, endEventIdx]` (inclusive) within ONE voice of ONE
 * measure. Set by Shift+click on a note (anchored on the prior single
 * selection). Drives run Copy/Cut and the RunSelectionHighlight overlay.
 */
export type RunSelection = {
  staffIdx: number
  voiceIdx: number
  measureIdx: number
  startEventIdx: number
  endEventIdx: number
}

/**
 * What a right-click (or ContextMenu-key / long-press) resolved to on
 * the rendered score (M27). Produced by `classifyContextTarget`
 * (components/editor/contextTarget.ts); consumed by the ContextMenu to
 * pick its per-target item set. `none` = off-score / pre-render /
 * non-interactive — the handler must NOT preventDefault, so the native
 * browser menu shows.
 */
export type ContextTarget =
  | { kind: 'note'; selection: Selection }
  | { kind: 'rest'; selection: Selection }
  | { kind: 'chordNote'; selection: Selection }
  | { kind: 'measure'; measureIdx: number; insertAfterIdx: number; staffIdx: number }
  | { kind: 'barline'; measureIdx: number; staffIdx: number }
  | { kind: 'range'; range: MeasureRangeSelection }
  | { kind: 'empty'; measureIdx?: number; staffIdx?: number }
  | { kind: 'none' }

/**
 * Open context-menu state: the resolved target plus the viewport anchor
 * (cursor) where the vertical menu should appear. Undefined when closed.
 */
export type ContextMenuState = {
  target: ContextTarget
  anchorX: number
  anchorY: number
}

/**
 * In-app clipboard payload (M28). A structural Score-fragment — `Event[]`
 * for a note / chord / intra-measure run, or a captured measure-range
 * bundle — deep-cloned so later score edits never mutate it. `sourceMeta`
 * carries the source meter + arity so paste can detect meter/arity
 * mismatch (see `lib/chat/clipboard.ts`).
 */
export type ClipboardEntry =
  | {
      kind: 'events'
      events: Event[]
      sourceMeta: { meter: string; staffIdx: number; voiceIdx: number; totalUnits: number }
    }
  | {
      kind: 'measures'
      captured: {
        primaryMeasures: Measure[]
        perVoiceContent: Array<{ voices: Measure[][] }>
        /** D4: spans fully inside the copied range, carried with original
         *  event ids; paste remaps their endpoints to the fresh copies. */
        spans?: Span[]
      }
      sourceMeta: { meter: string; measureHashes: string[]; staffCount: number; voiceCount: number }
    }

/**
 * In-flight pointer-drag state for the M19-PR-8 MOVE gesture.
 * Populated when the user pointerdowns on a highlighted measure
 * range and starts dragging; cleared on pointerup, Esc cancel, or
 * any score mutation. Drives the drop-indicator overlay rendering.
 *
 * `clientX` is the live pointer X (viewport coord) — fed by
 * pointermove. `toAfter` is the resolved drop position in score
 * coordinates (-1 means "before measure 0"); used by the dispatch
 * on pointerup AND by the indicator rendering.
 *
 * `toAfter === null` means the cursor is over the source range
 * itself (a no-op drop). The pointerup handler suppresses the
 * dispatch in that case.
 */
export type MeasureDragState = {
  sourceRange: MeasureRangeSelection
  clientX: number
  toAfter: number | null
}

/**
 * Command-palette dispatch bus (M23-PR-2). The ⌘K palette publishes
 * a request here; popover-owning components subscribe and open their
 * own popover when their `kind` matches.
 *
 * `nonce` auto-increments on every set so subscribers fire on EVERY
 * publish — including back-to-back identical-kind requests. Without
 * the nonce, "Open Score Info" → close → "Open Score Info" again
 * would no-op the second time since the request object's `kind`
 * didn't change.
 *
 * Add new kinds as additional palette commands are wired in M23-PR-3+.
 */
export type PaletteRequest =
  | { kind: 'open-score-info'; nonce: number }
  // M23-PR-3: NoteFloatingMenu opens MarkerPopover anchored on the
  // current selection's measure. Subscriber is gated on the live
  // selection; the catalog command's `available` predicate keeps the
  // entry out of the palette list when there's nothing to anchor to.
  | { kind: 'open-marker'; nonce: number }
  // M23-PR-4: more popover subscribers in NoteFloatingMenu. All
  // selection-gated — the catalog's `available` predicate hides the
  // command from the palette when no selection exists.
  | { kind: 'open-dynamics'; nonce: number }
  | { kind: 'open-chord-symbol'; nonce: number }
  | { kind: 'open-lyrics'; nonce: number }
  | { kind: 'open-annotation'; nonce: number }
  // M23-PR-5: remaining NoteFloatingMenu popovers. Selection-gated;
  // span popovers (hairpin/slur/tempo-span/octave-span/glissando/
  // trill-line/tremolo-between) additionally need event.id (their
  // render guards return null without it, which would soft-deadlock
  // the open state if we surfaced the command without checking).
  | { kind: 'open-hairpin'; nonce: number }
  | { kind: 'open-slur'; nonce: number }
  | { kind: 'open-tempo-span'; nonce: number }
  | { kind: 'open-octave-span'; nonce: number }
  | { kind: 'open-glissando'; nonce: number }
  | { kind: 'open-trill-line'; nonce: number }
  | { kind: 'open-tremolo-between'; nonce: number }
  | { kind: 'open-tie'; nonce: number }
  | { kind: 'open-fingering'; nonce: number }
  | { kind: 'open-ornament'; nonce: number }
  | { kind: 'open-technique'; nonce: number }
  | { kind: 'open-grace-note'; nonce: number }
  | { kind: 'open-barline'; nonce: number }
  | { kind: 'open-volta'; nonce: number }
  | { kind: 'open-jump-marker'; nonce: number }

/**
 * M24-PR-1 — AI ghost preview proposal slot.
 *
 * When the /api/chat orchestrator is in ghost-preview mode (PR-2 wires
 * the flag), score-mutating handlers return a proposal instead of
 * committing head. This slot holds it until the user accepts (Enter on
 * inline overlay / "Accept" in panel) or rejects (Esc / "Reject").
 *
 * `presentation` partitions the UI: <=4 affected event ids render as
 * warm-amber inline ghosts in the score (PR-3); >=5 render in a
 * right-docked diff panel that pushes the editor narrower (PR-4).
 * Derived from `affectedEventIds.length` by `computeProposalPresentation`
 * and stored explicitly so consumers don't re-compute on every render.
 *
 * Architecturally mirrors [[pendingConfirmation]] (M3.5-PR-4 wholesale-
 * replacement gate): server holds the candidate via `candidateVersionId`,
 * the client renders a preview, accept POSTs to promote, reject leaves
 * the candidate orphaned. The difference is that the ghost preview
 * fires for EVERY AI edit (gated by SL_GHOST_PREVIEW) — not just
 * wholesale rewrites.
 */
export type PendingProposalPresentation = 'inline' | 'diff-panel'

/**
 * Inline-vs-panel threshold. <= N affected event ids -> inline overlay;
 * > N -> docked diff panel. Tunable but stable: changing this requires
 * updating PR-3 / PR-4 layout assumptions, so it lives here as a single
 * source of truth.
 */
export const GHOST_PREVIEW_INLINE_THRESHOLD = 4

/**
 * Pick the proposal presentation from the set of affected event ids.
 *
 * One event id = one position in the score (a chord shares an id across
 * its pitches, so a chord change counts as 1). Inserts and deletes both
 * contribute one id per affected position. This matches the user mental
 * model of "how many places were touched", which is what the threshold
 * is meant to gate.
 */
export function computeProposalPresentation(
  affectedEventIds: readonly string[],
): PendingProposalPresentation {
  return affectedEventIds.length <= GHOST_PREVIEW_INLINE_THRESHOLD
    ? 'inline'
    : 'diff-panel'
}

export type PendingProposal = {
  /** Chat id of the session this proposal belongs to. */
  chatId: string
  /** Server-side score_versions row holding the candidate score. */
  candidateVersionId: string
  /** The proposed after-state. */
  candidateScore: Score
  /** Snapshot of editedScore at the moment the proposal was published.
   *  The ghost overlay renders BOTH this AND `candidateScore`; storing
   *  it on the slot avoids races if the user starts a manual edit
   *  while the proposal is pending (PR-5). */
  beforeScore: Score
  /** Pre-rendered abc of `candidateScore` — written into `abc` on
   *  accept so the crossfade gets a stable source string without
   *  re-running scoreToAbc on the click. */
  abc: string
  /** Event ids that differ between before and after. Drives both the
   *  inline-vs-panel decision (via length) and PR-3's per-note ghost
   *  rendering (the overlay highlights exactly these ids). */
  affectedEventIds: string[]
  /** Derived from affectedEventIds.length — see
   *  computeProposalPresentation. Stored on the slot so subscribers
   *  don't recompute on every render. */
  presentation: PendingProposalPresentation
  /** Intro text from the assistant that goes with the proposal — copied
   *  into `introText` on accept (matches resolveRequest semantics). */
  introText: string
  /** Tool-use id for the assistant `render_score` transcript turn that
   *  the caller appends after a successful accept. */
  toolUseId: string
  /** Server head version id at proposal time. Becomes the parent CAS
   *  link of the candidate row when accept POSTs to promote it.
   *  Optional in the type because PR-2 (orchestrator wiring) is what
   *  populates it; PR-1 ships the slot shape only. The accept-handler
   *  POST will require it once wired. */
  headVersionId?: string
}

/**
 * M25 sectional-stream progress. Present only while a streamed score
 * generation is in flight (first `section` frame → terminal `done`/`error`).
 * Drives the composing overlay's "section N of M" caption and gates the
 * streamed score to view-only so a half-built piece can't be edited (the
 * next section would clobber the edit). `sectionIndex` is 0-based.
 */
export type StreamProgress = {
  sectionIndex: number
  totalSections: number
  label: string
}

const HISTORY_CAP = 50
const COALESCE_WINDOW_MS = 500

interface ChatStore {
  chatId: string | undefined
  abc: string | undefined
  scoreJson: Score | undefined
  editedScore: Score | undefined
  editMap: SourceMap | undefined
  selection: Selection | undefined
  /** Optional inclusive measure-range selection (M19-PR-6) for
   *  structural ops. Independent of `selection` (per-event); the two
   *  may both be set. Kept normalized (fromStart ≤ fromEnd, both in
   *  bounds) by setters + post-edit pruning. */
  measureRangeSelection: MeasureRangeSelection | undefined
  /** Optional intra-measure run selection (M28-PR-4 / D2): a contiguous
   *  span of events within one voice of one measure, set by Shift+click.
   *  Drives run Copy/Cut and the RunSelectionHighlight overlay. A plain
   *  single `select()` clears it. */
  runSelection: RunSelection | undefined
  /** In-flight pointer-drag state for the M19-PR-8 MOVE gesture.
   *  Populated by useMeasureRangeDrag on pointerdown+threshold;
   *  cleared on pointerup, Esc cancel, or any score mutation. */
  measureDragState: MeasureDragState | undefined
  /** Pending "delete these measures?" confirmation. Set by the
   *  always-confirm measure-delete entry points (floating-menu button +
   *  ⌘K palette command) via `requestMeasureDelete`; the
   *  MeasureDeleteConfirmModal renders while it is set and the actual
   *  deletion (a span/marker-safe `dragMeasureRange` delete) only fires
   *  on `confirmMeasureDelete`. Inclusive 0-based range. */
  pendingMeasureDelete: MeasureRangeSelection | undefined
  lastPrompt: string | undefined
  introText: string | undefined
  pending: boolean
  /** M25 sectional-stream progress — see [[StreamProgress]]. Undefined when
   *  not mid-stream; while set, the streamed score renders view-only. */
  streamProgress: StreamProgress | undefined
  error: string | undefined
  history: Score[]
  historyPointer: number
  /** key used to coalesce held-key edits into one history entry */
  lastCoalesceKey: string | undefined
  lastCoalesceAt: number
  /** Monotonic counter, bumped only when a fresh LLM response replaces
   *  the score. Local edits (applyEdit/applyScore/undo/redo) leave it
   *  alone. UI consumers (ScoreStage) use this to gate the crossfade
   *  animation so edit-driven `abc` changes don't fade. */
  epoch: number

  /** Bumped each time a reveal completes or is cancelled. Lets consumers
   *  (e.g. PromptBar) react to "the post-network animation is over"
   *  without doing their own timing. */
  revealEpoch: number
  /** Timestamp (ms) when ScorePanel kicked off a reveal for the current
   *  score; null when no reveal is in flight. Cleared by the reveal
   *  hook on completion and by beginRequest/failRequest. */
  revealStartedAt: number | null
  /** Resolved once at mount from `matchMedia('(prefers-reduced-motion:
   *  reduce)')` and kept in sync via a change listener. Cached so
   *  components don't re-query on every render. */
  reduceMotion: boolean

  markRevealStarted: () => void
  markRevealComplete: () => void
  setReduceMotion: (b: boolean) => void

  setChatId: (id: string | undefined) => void
  beginRequest: (prompt: string) => void
  resolveRequest: (abc: string, scoreJson?: Score, introText?: string) => void
  /**
   * M25-PR-4 — render an in-progress streamed section. Swaps the editor
   * to the cumulative `scoreJson` (so the score grows on screen) WITHOUT
   * clearing `pending` or seeding undo history; the terminal `done` frame
   * calls resolveRequest to finalize. No epoch bump → in-place growth, no
   * per-section crossfade flicker.
   */
  streamScoreSection: (abc: string, scoreJson: Score, progress: StreamProgress) => void
  /**
   * Finalize a streaming-only response that produced no Score (converse
   * handler). Clears `pending` and `introText` without touching `abc`,
   * `scoreJson`, or `epoch` — so no crossfade animation fires.
   */
  endRequestNoScore: () => void
  /**
   * Abort an in-flight streamed generation when the user navigates to a
   * different session. Clears `pending` + `streamProgress` so the composing
   * overlay doesn't leak onto the newly-loaded session, WITHOUT touching
   * `abc` / `scoreJson` / `introText` (the destination session's load owns
   * those). The stream consumer in useSubmitPrompt also guards its writes by
   * the originating chatId so a stale stream can't clobber the new session.
   */
  cancelStreamingForSwitch: () => void

  /**
   * Seed the undo `history` from a server-returned parent chain
   * (oldest→head). Used by useTranscriptSync on session hydration so
   * Ctrl+Z survives reload. Sets the pointer to the last entry (head),
   * marks the LLM-source-most entry as `scoreJson` (the baseline that
   * `resetEditsToLLM` walks back to), and bumps epoch for the
   * crossfade.
   */
  seedHistoryFromServer: (
    history: Score[],
    headIndex: number,
    abc: string,
    introText?: string,
  ) => void
  failRequest: (error: string, options?: { resetChatId?: boolean }) => void
  clearError: () => void
  reset: () => Promise<void>

  /**
   * Marker describing the score the user *imported*. Drives the
   * PromptBar placeholder + the post-import SuggestionChips set.
   * Cleared on the first LLM response (resolveRequest) and on reset.
   */
  lastImport: { format: ImportFormat; filename?: string } | undefined
  /**
   * Seat an imported score into the store as if it were the result of
   * an LLM generation. Sets chatId, abc, scoreJson, editedScore,
   * editMap, history, and the lastImport marker. Mirrors the field
   * set written by resolveRequest so downstream components don't need
   * an import-specific branch.
   */
  resolveImport: (payload: {
    chatId: string
    abc: string
    scoreJson: Score
    introText?: string
    importFormat: ImportFormat
    filename?: string
  }) => void

  // Ephemeral status message (e.g. from smartInsertNote)
  statusMessage: string | undefined

  /** Picker state for click-to-place / +Note: which duration will be
   *  inserted on the next gesture, whether it's dotted, and the
   *  accidental (if any). Defaults: quarter, no dot, no accidental. */
  activeDuration: BaseDuration
  activeDotted: boolean
  activeAccidental: ActiveAccidental
  setActiveDuration: (d: BaseDuration) => void
  toggleActiveDotted: () => void
  setActiveAccidental: (a: ActiveAccidental) => void

  // Playback
  isPlaying: boolean
  playbackPosition: { measureIdx: number; eventIdx: number } | undefined
  /** Request from "Play from here": SynthHost watches this and seeks+plays. */
  playRequest: { selection: Selection; id: number } | undefined
  /** When true, the SynthHost cursor callback scrolls the currently-
   *  playing note into view as playback advances. User-toggleable next
   *  to the playback controls. Persists to localStorage so the user's
   *  preference survives reload. */
  followPlayback: boolean

  // Polish UI
  cheatSheetOpen: boolean
  chordPaletteOpen: boolean
  undoToast: { id: number; label: string } | undefined

  /**
   * M23-PR-2 command-palette dispatch bus. The palette publishes a
   * `PaletteRequest` here; popover-owning components (EditorToolbar,
   * NoteFloatingMenu) subscribe and open their popover when their
   * `kind` matches, then clear the slot via `setPaletteRequest(undefined)`.
   *
   * A `nonce` (auto-incrementing on every set) lets subscribers
   * distinguish repeat requests of the same kind — clicking
   * "Open Score Info" twice in a row should re-open the popover
   * even though the `kind` field is identical. Subscribers fire
   * their effect on every nonce change (not just kind change).
   *
   * Using a single slot rather than N kind-specific slots keeps the
   * store surface compact as the palette catalog grows.
   */
  paletteRequest: PaletteRequest | undefined
  setPaletteRequest: (request: Omit<PaletteRequest, 'nonce'> | undefined) => void
  /**
   * AI-entry input seed bus (M29). `seedAiInput(text)` pre-fills + focuses
   * the PromptBar input WITHOUT sending, so a context-menu "Edit with AI"
   * item can scope a request to the right-clicked target. `nonce`
   * auto-increments (like `paletteRequest`) so repeated identical seeds
   * still fire the subscriber.
   */
  aiSeed: { text: string; nonce: number; targetRegion?: TargetRegion } | undefined
  /** Seed the chat input (D5: optionally with a deterministic measure
   *  region the request is scoped to, threaded to the dispatcher). */
  seedAiInput: (text: string, targetRegion?: TargetRegion) => void

  /**
   * M3.5-PR-4 — pending replacement-confirmation proposal. Set when
   * the latest chat response carried `requiresConfirmation: true`.
   * The modal subscribes to this; on the user's decision it POSTs to
   * /api/chat/confirm-replacement and clears `pendingConfirmation`.
   *
   * While this is set:
   *   - the editor does NOT auto-switch to `candidateScore`
   *   - `scoreJson` / `editedScore` still point at the prior score
   *   - the modal renders a side-by-side diff (before vs. candidate)
   */
  pendingConfirmation:
    | {
        chatId: string
        candidateVersionId: string
        candidateScore: Score
        beforeScore: Score
        retainedIdentityRatio: number
        reasons: string[]
        toolUseId: string
        introText: string
        abc: string
        headVersionId?: string
      }
    | undefined
  setPendingConfirmation: (p: ChatStore['pendingConfirmation']) => void
  clearPendingConfirmation: () => void

  /**
   * M24-PR-1 — AI ghost preview proposal slot. See [[PendingProposal]]
   * for the shape and motivation. Set by the chat hook when the
   * orchestrator returns a proposal-mode response (PR-2). Read by the
   * inline overlay (PR-3) or docked panel (PR-4) depending on
   * `.presentation`.
   *
   * While this is set:
   *   - editedScore / scoreJson still point at `beforeScore`
   *   - history / historyPointer are NOT mutated (the proposal hasn't
   *     been accepted yet)
   *   - the UI renders an overlay/panel that lets the user accept or
   *     reject
   */
  pendingProposal: PendingProposal | undefined
  /**
   * Publish a proposal (or clear with `undefined`). The caller supplies
   * `affectedEventIds`; the store auto-computes `presentation` via
   * `computeProposalPresentation` and stores it on the slot, so callers
   * never know (and can never get out of sync with) the threshold.
   * Mirrors the auto-incrementing-nonce pattern on `setPaletteRequest`.
   */
  setPendingProposal: (
    proposal: Omit<PendingProposal, 'presentation'> | undefined,
  ) => void
  /** Discard the proposal slot without mutating any score state. */
  clearPendingProposal: () => void
  /**
   * Accept the pending proposal: swap editedScore / scoreJson to
   * candidateScore, write its pre-rendered abc, reset history to a
   * single entry on the new score (mirrors resolveRequest — every LLM
   * response is an undo checkpoint), bump epoch for the crossfade,
   * clear the slot. The caller is responsible for:
   *   - POSTing to /api/chat/confirm-proposal (PR-2) to promote the
   *     candidate row on the server
   *   - appending the assistant `render_score` transcript turn
   *   - updating currentHeadVersionId with the promoted row's id
   * No-op when no proposal is pending.
   */
  acceptPendingProposal: () => void
  /**
   * Reject the pending proposal: clear the slot. editedScore /
   * scoreJson / history are untouched (they already point at
   * beforeScore). The caller is responsible for POSTing to
   * /api/chat/confirm-proposal with decision=reject so the server
   * marks the candidate row dead. No-op when no proposal is pending.
   */
  rejectPendingProposal: () => void

  /**
   * M24-PR-5 — interrupted-proposal slot. When the user starts a
   * manual edit while a pendingProposal is set, the mutator helper
   * `_interruptProposalForManualEdit` moves the slot here and clears
   * pendingProposal. A small toast (ResumeProposalToast) lets the
   * user re-publish the proposal within a 30s window.
   *
   * Same shape as pendingProposal so resume is a direct copy. The
   * server-side candidate row is untouched (still orphan) — when
   * the user resumes + accepts, the same candidateVersionId promotes
   * cleanly.
   */
  interruptedProposal: PendingProposal | undefined
  /** Discard the interrupted-proposal slot (toast dismissed). */
  clearInterruptedProposal: () => void
  /**
   * Re-publish the interrupted proposal: move it back to
   * pendingProposal and clear the interrupted slot. No-op when no
   * proposal was interrupted.
   */
  resumeInterruptedProposal: () => void

  /**
   * Active drag snap target (free-position drag preview, Phase 4).
   * Set on pointermove when the snap point changes; cleared on
   * pointerup or pointercancel. Only consumed by DragPreviewOverlay
   * so unrelated subscribers don't re-render. Includes clientX so
   * the overlay can render a viewport-relative vertical indicator
   * without re-running snap math.
   */
  dragSnapTarget:
    | {
        staffIdx: number
        measureIdx: number
        position32nds: number
        clientX: number
        clientY: number
      }
    | undefined

  // Chat history panel
  /** Panel-facing transcript. Mirrors the server transcript at GET time
   *  and is appended optimistically on each submit. */
  turns: TranscriptTurn[]
  /** True while a GET /api/chat?chatId=... is in flight. */
  transcriptLoading: boolean
  /** Last error from a transcript fetch — surfaced as a retry chip in
   *  the panel. Distinct from `error` (which is the chat-request error). */
  transcriptError: string | undefined
  /** Bumped to force useTranscriptSync to re-fire on retry. */
  transcriptRetryNonce: number
  /** Visibility of the chat history panel. */
  panelOpen: boolean

  /** Mobile drawer visibility (<1024px). Default false (closed). Desktop
   *  uses `sidebarCollapsed` instead so each viewport's natural default
   *  can stand without a media-query effect at mount. */
  sidebarOpen: boolean

  /** Collapsed state for the docked desktop sidebar (>=1024px). Default
   *  false (expanded). When true, the sidebar slides off-screen with
   *  the same transform the mobile drawer uses. */
  sidebarCollapsed: boolean

  /**
   * Server-side id of the score_versions row at the session's current
   * head. Used as `parentVersionId` when persisting edits via
   * /api/sessions/:id/versions, so the server's CAS chain is correct.
   * Populated from /api/chat responses and from /api/chat?chatId
   * hydration; mutated by useEditPersistence on each successful POST.
   */
  currentHeadVersionId: string | undefined

  // Editor actions
  select: (target: Selection | undefined) => void
  /** Set (or clear) the intra-measure run selection (D2). Endpoints are
   *  normalized (start ≤ end) by the caller. */
  selectRun: (run: RunSelection | undefined) => void
  /**
   * Set a single-bar measure range (clears any existing range).
   * Caller passes a measureIdx; the range becomes { fromStart: idx,
   * fromEnd: idx }. Pass undefined to clear.
   */
  selectMeasureRange: (range: MeasureRangeSelection | undefined) => void
  /**
   * Extend (or start) a measure range by including the supplied
   * measureIdx. Updates fromStart = min(existing, idx) and
   * fromEnd = max(existing, idx). When no range exists, behaves like
   * selectMeasureRange (single-bar). M19-PR-6 Cmd/Ctrl+Shift+click
   * routes here.
   */
  extendMeasureRangeTo: (measureIdx: number) => void
  /**
   * Begin or update an in-flight measure-range drag (M19-PR-8).
   * Pass `undefined` to cancel/clear (Esc + pointerup cleanup +
   * score mutation prune).
   */
  setMeasureDragState: (state: MeasureDragState | undefined) => void
  /**
   * Open the always-confirm measure-delete gate for an inclusive
   * 0-based range. Does NOT mutate the score — it only sets
   * `pendingMeasureDelete` so MeasureDeleteConfirmModal can render.
   * Refuses (sets `error`, leaves the slot clear) when the range would
   * delete every measure, mirroring the transform-layer guard so the
   * user gets a message instead of a dead confirm button. Used by the
   * floating-menu "Delete measure" button and the ⌘K palette command.
   */
  requestMeasureDelete: (range: MeasureRangeSelection) => void
  /**
   * Apply the pending measure deletion via a `dragMeasureRange` delete
   * (the span/marker/volta-safe op — never the legacy `deleteMeasure`,
   * which orphans those refs) and clear the gate. No-op if nothing is
   * pending. Routes through `applyEdit`, so history/undo-toast/selection
   * pruning all apply.
   */
  confirmMeasureDelete: () => void
  /** Dismiss the measure-delete confirmation without deleting. */
  cancelMeasureDelete: () => void
  /**
   * Right-click context menu (M27). Holds the resolved target + cursor
   * anchor while the menu is open; undefined when closed. Set by
   * `useScoreContextMenu` (M27-PR-2); read by the ContextMenu component
   * and used to suppress the left-click NoteFloatingMenu toolbar while a
   * context menu is open. Purely client UI state — never persisted.
   */
  contextMenu: ContextMenuState | undefined
  openContextMenu: (state: ContextMenuState) => void
  closeContextMenu: () => void
  /**
   * In-app clipboard (M28). Holds the last copied/cut fragment; undefined
   * when empty. Set by the copy serializers (`lib/chat/clipboard.ts`) via
   * the context-menu Cut/Copy items; read by Paste. Client UI state only —
   * never persisted.
   */
  clipboard: ClipboardEntry | undefined
  setClipboard: (entry: ClipboardEntry | undefined) => void
  clearClipboard: () => void
  applyEdit: (op: Operation, coalesceKey?: string) => void
  /**
   * Apply a guaranteed-valid edit (transformScoreBalanced). On
   * BalanceError, sets `statusMessage` to a human-readable explanation
   * and leaves the score unchanged. Used by direct-manipulation UI
   * paths (drag, etc.) so they cannot produce time-signature-invalid
   * measures.
   *
   * Kill switch: NEXT_PUBLIC_BALANCED_EDITS=off downgrades to no-op
   * (the calling site can fall back to applyEdit if it wants).
   */
  applyBalancedEdit: (op: BalancedOp, coalesceKey?: string) => void
  applyScore: (next: Score, options?: { selection?: Selection; statusMessage?: string }) => void
  /**
   * Apply a successful `POST /api/chat/revert` response. Appends the new
   * synthetic assistant turn to `turns` (does NOT replace), swaps the
   * editor to the reverted score, pushes that score onto the undo
   * history (preserving prior entries), bumps `epoch` for the crossfade,
   * and updates `currentHeadVersionId` for CAS on the next manual edit.
   *
   * Sets `editedScore` and `scoreJson` to the SAME reference so the
   * persistence gate in useEditPersistence skips a phantom POST.
   */
  applyRevertResponse: (payload: {
    newTurn: TranscriptTurn
    scoreJson: Score
    abc: string
    introText: string
    headVersionId: string
  }) => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  resetEditsToLLM: () => void
  showStatusMessage: (msg: string | undefined) => void

  // Playback actions
  setPlaying: (b: boolean) => void
  setPlaybackPosition: (pos: { measureIdx: number; eventIdx: number } | undefined) => void
  playFromSelection: (sel: Selection) => void
  setFollowPlayback: (follow: boolean) => void

  // Polish UI actions
  toggleCheatSheet: () => void
  toggleChordPalette: () => void
  setChordPaletteOpen: (open: boolean) => void
  showUndoToast: (label: string) => void
  clearUndoToast: () => void
  setDragSnapTarget: (
    t:
      | {
          staffIdx: number
          measureIdx: number
          position32nds: number
          clientX: number
          clientY: number
        }
      | undefined,
  ) => void

  setCurrentHeadVersionId: (id: string | undefined) => void

  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  toggleSidebarCollapsed: () => void
  setSidebarCollapsed: (collapsed: boolean) => void

  // Chat history panel actions
  setTurns: (turns: TranscriptTurn[]) => void
  appendTurns: (turns: TranscriptTurn[]) => void
  /**
   * Append a placeholder assistant `kind: 'text'` turn with empty body
   * and `streaming: true`. Returns its index so the caller can target
   * subsequent appendStreamingDelta / finalizeStreamingTurn calls.
   */
  appendStreamingAssistantTurn: (toolUseId: string) => number
  /** Concatenate `delta` to the streaming turn at `index`. */
  appendStreamingDelta: (index: number, delta: string) => void
  /**
   * Mark the streaming turn at `index` as complete. If `finalText` is
   * provided, replaces the accumulated text with it (reconciliation
   * against server's authoritative buffer).
   */
  finalizeStreamingTurn: (index: number, finalText?: string) => void
  /**
   * Mark the streaming turn at `index` as failed: stops the streaming
   * cursor, flags it `errored`, and attaches a human-readable
   * `errorText`. Keeps whatever partial text had already streamed in so
   * the chat shows "here's what I got, then it failed". No-op if the
   * index doesn't point at an assistant text turn. Unlike
   * `finalizeStreamingTurn`, this is the failure terminal — the caller
   * still clears `pending` (via endRequestNoScore / failRequest).
   */
  failStreamingTurn: (index: number, message: string) => void
  /**
   * Append a standalone errored assistant turn to the transcript. Used by
   * failure paths that have no in-flight streaming placeholder to mark
   * (HTTP / JSON / network errors, score-stream failures) so the error
   * becomes a PERMANENT part of the chat history instead of a transient
   * chip that vanishes on the next submit (`beginRequest` clears `error`
   * but never touches `turns`). Renders via the same errored-bubble path
   * as `failStreamingTurn`.
   */
  appendErrorTurn: (message: string) => void
  clearTurns: () => void
  setTranscriptLoading: (loading: boolean) => void
  setTranscriptError: (msg: string | undefined) => void
  retryTranscriptSync: () => void
  togglePanel: () => void
  setPanelOpen: (open: boolean) => void
}

const STORAGE_KEY = 'sheet-llm.chatId'
const FOLLOW_PLAYBACK_KEY = 'sheet-llm.followPlayback'

function renderWithMap(score: Score): { abc: string; map: SourceMap } {
  return scoreToAbcWithMap(score)
}

/**
 * Mirror "chat request in flight" to a globalThis flag so
 * `src/lib/auth/clientBackup.ts` can avoid a recovery-driven
 * window.location.reload() while the user has destructible state
 * (optimistic prompt, partial assistant response) in memory. Set on
 * beginRequest, cleared on every terminal action.
 */
function markChatActive(active: boolean): void {
  if (typeof globalThis === 'undefined') return
  ;(globalThis as { __sheetLlmChatActive?: boolean }).__sheetLlmChatActive = active
}

/**
 * Drop a stale selection whose target no longer exists in `score`. A
 * selection pointing at staff 1 / voice 1 / measure 7 / event 3 /
 * pitch 2 can be invalidated by any mutator: undo across an addStaff,
 * Grand→Single toggle, deleteMeasure, removePitchFromChord, etc.
 * Downstream consumers (NoteFloatingMenu, useNoteDrag, getStaffEventAt
 * callers) dereference selection.staffIdx without a fallback and will
 * crash on stale indices. Call this from every mutator that swaps in a
 * new score.
 */
function pruneSelection(score: Score, sel: Selection | undefined): Selection | undefined {
  if (!sel) return undefined
  const staffIdx = sel.staffIdx ?? 0
  if (staffIdx < 0 || staffIdx >= getStaffCount(score)) return undefined
  const voiceIdx = sel.voiceIdx ?? 0
  if (voiceIdx < 0 || voiceIdx >= getVoiceCount(score, staffIdx)) return undefined
  // Voice-aware measure check (covers both primary and extraVoices).
  const measure = voiceIdx === 0
    ? getStaffMeasureAt(score, staffIdx, sel.measureIdx)
    : getVoiceMeasureAt(score, staffIdx, voiceIdx, sel.measureIdx)
  if (!measure) return undefined
  if (sel.eventIdx < 0 || sel.eventIdx >= measure.events.length) return undefined
  if (sel.pitchIdx !== undefined) {
    const event = measure.events[sel.eventIdx]
    if (sel.pitchIdx < 0 || sel.pitchIdx >= event.pitches.length) {
      // Event still valid; only the pitch index is stale → keep the
      // event selection, drop the pitch focus.
      return { ...sel, pitchIdx: undefined }
    }
  }
  return sel
}

/**
 * Prune a measure-range selection against the post-mutation measure
 * count (M19-PR-6). Two outcomes:
 *   - Both endpoints in-bounds → keep the range as-is.
 *   - One endpoint out-of-bounds → clamp to measures.length-1; if
 *     that leaves fromStart > fromEnd, drop the range entirely.
 *   - Both endpoints out-of-bounds OR score empty → drop the range.
 * Called from every mutator that swaps in a new score.
 */
function pruneMeasureRangeSelection(
  score: Score,
  range: MeasureRangeSelection | undefined,
): MeasureRangeSelection | undefined {
  if (!range) return undefined
  const count = score.measures.length
  if (count === 0) return undefined
  if (range.fromStart >= count) return undefined
  const fromStart = Math.max(0, range.fromStart)
  const fromEnd = Math.min(count - 1, range.fromEnd)
  if (fromStart > fromEnd) return undefined
  if (fromStart === range.fromStart && fromEnd === range.fromEnd) return range
  return { fromStart, fromEnd }
}

function humanLabelFor(op: Operation): string | undefined {
  switch (op.kind) {
    case 'changePitch': return 'Changed pitch'
    case 'changeDuration': return `Changed duration to ${op.duration}`
    case 'setAccidental': return `Set accidental: ${op.accidental}`
    case 'setArticulation': return `Set articulation`
    case 'toggleTie': return 'Toggled tie'
    case 'deleteEvent': return 'Deleted note'
    case 'insertEventAfter': return 'Inserted note'
    case 'addPitchToChord': return 'Added pitch to chord'
    case 'removePitchFromChord': return 'Removed pitch from chord'
    case 'setEventPitches': return op.pitches.length > 1 ? 'Built chord' : 'Replaced pitch'
    case 'changeKey': return `Changed key to ${op.key}`
    case 'changeMeter': return `Changed meter to ${op.meter}`
    case 'changeTempo': return `Changed tempo to ${op.tempo_bpm}`
    case 'changeTitle': return 'Changed title'
    case 'insertMeasureAfter': return 'Inserted measure'
    case 'deleteMeasure': return 'Deleted measure'
    case 'duplicateMeasure': return 'Duplicated measure'
    case 'dragMeasureRange': {
      const span = op.fromEnd - op.fromStart + 1
      const noun = span > 1 ? `${span} measures` : 'measure'
      if (op.mode === 'delete') return `Deleted ${noun}`
      if (op.mode === 'duplicate') return `Duplicated ${noun}`
      return `Moved ${noun}`
    }
    default: return undefined
  }
}

function humanLabelForBalanced(op: BalancedOp): string | undefined {
  switch (op.kind) {
    case 'reorderBalanced': return 'Moved note'
    case 'changeDurationBalanced': return `Changed duration to ${op.duration}`
    case 'removeBalanced': return 'Deleted note'
  }
}

function balanceErrorToMessage(e: BalanceError): string {
  switch (e.code) {
    case 'tuplet_blocked':
      return "Can't move into or out of a tuplet."
    case 'tuplet_unsplittable':
      return "Can't split a tuplet across a barline."
    case 'cascade_overflow':
      return 'Note is too long for the remaining space.'
    case 'would_empty_measure':
      return "Can't move the only note out of a measure."
    case 'unrepresentable':
      return "That edit can't be notated — try a different position or duration."
  }
}

export const useChatStore = create<ChatStore>((set, get) => ({
  chatId: undefined,
  abc: undefined,
  scoreJson: undefined,
  editedScore: undefined,
  editMap: undefined,
  selection: undefined,
  measureRangeSelection: undefined,
  runSelection: undefined,
  measureDragState: undefined,
  pendingMeasureDelete: undefined,
  lastPrompt: undefined,
  introText: undefined,
  pending: false,
  streamProgress: undefined,
  error: undefined,
  history: [],
  historyPointer: -1,
  lastCoalesceKey: undefined,
  lastCoalesceAt: 0,
  statusMessage: undefined,
  activeDuration: 'quarter',
  activeDotted: false,
  activeAccidental: 'none',
  setActiveDuration: (d) => set({ activeDuration: d }),
  toggleActiveDotted: () => set((s) => ({ activeDotted: !s.activeDotted })),
  setActiveAccidental: (a) => set({ activeAccidental: a }),
  isPlaying: false,
  playbackPosition: undefined,
  playRequest: undefined,
  cheatSheetOpen: false,
  chordPaletteOpen: false,
  undoToast: undefined,
  paletteRequest: undefined,
  setPaletteRequest: (request) =>
    set((s) => {
      if (request === undefined) return { paletteRequest: undefined }
      // Auto-bump the nonce on every publish so subscribers fire on
      // repeated-kind requests too. The caller doesn't pass a nonce
      // — the store owns the counter.
      const prevNonce =
        s.paletteRequest !== undefined ? s.paletteRequest.nonce : 0
      return { paletteRequest: { ...request, nonce: prevNonce + 1 } }
    }),
  aiSeed: undefined,
  seedAiInput: (text, targetRegion) =>
    set((s) => ({
      aiSeed: {
        text,
        nonce: (s.aiSeed?.nonce ?? 0) + 1,
        ...(targetRegion ? { targetRegion } : {}),
      },
    })),
  pendingConfirmation: undefined,
  setPendingConfirmation: (p) => set({ pendingConfirmation: p }),
  clearPendingConfirmation: () => set({ pendingConfirmation: undefined }),
  pendingProposal: undefined,
  setPendingProposal: (proposal) => {
    if (proposal === undefined) {
      set({ pendingProposal: undefined })
      return
    }
    set({
      pendingProposal: {
        ...proposal,
        presentation: computeProposalPresentation(proposal.affectedEventIds),
      },
    })
  },
  clearPendingProposal: () => set({ pendingProposal: undefined }),
  acceptPendingProposal: () => {
    const state = get()
    const proposal = state.pendingProposal
    if (!proposal) return
    const { map } = renderWithMap(proposal.candidateScore)
    set({
      pendingProposal: undefined,
      abc: proposal.abc,
      scoreJson: proposal.candidateScore,
      editedScore: proposal.candidateScore,
      editMap: map,
      introText: proposal.introText,
      selection: undefined,
      history: [proposal.candidateScore],
      historyPointer: 0,
      lastCoalesceKey: undefined,
      lastCoalesceAt: 0,
      epoch: state.epoch + 1,
      lastImport: undefined,
    })
  },
  rejectPendingProposal: () => set({ pendingProposal: undefined }),
  interruptedProposal: undefined,
  clearInterruptedProposal: () => set({ interruptedProposal: undefined }),
  resumeInterruptedProposal: () => {
    const interrupted = get().interruptedProposal
    if (!interrupted) return
    set({
      pendingProposal: interrupted,
      interruptedProposal: undefined,
    })
  },
  dragSnapTarget: undefined,
  epoch: 0,
  revealEpoch: 0,
  revealStartedAt: null,
  reduceMotion: false,
  lastImport: undefined,
  turns: [],
  transcriptLoading: false,
  transcriptError: undefined,
  transcriptRetryNonce: 0,
  panelOpen: false,
  sidebarOpen: false,
  sidebarCollapsed: false,
  followPlayback: false,
  currentHeadVersionId: undefined,

  setChatId: (id) => set({ chatId: id }),
  setCurrentHeadVersionId: (id) => set({ currentHeadVersionId: id }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  beginRequest: (prompt) => {
    markChatActive(true)
    set({
      pending: true,
      streamProgress: undefined,
      lastPrompt: prompt,
      error: undefined,
      introText: undefined,
      revealStartedAt: null,
    })
  },

  resolveRequest: (abc, scoreJson, introText) => {
    markChatActive(false)
    const nextEpoch = get().epoch + 1
    if (scoreJson) {
      const { map } = renderWithMap(scoreJson)
      set({
        pending: false,
        streamProgress: undefined,
        abc,
        scoreJson,
        editedScore: scoreJson,
        editMap: map,
        introText,
        selection: undefined,
        history: [scoreJson],
        historyPointer: 0,
        lastCoalesceKey: undefined,
        lastCoalesceAt: 0,
        epoch: nextEpoch,
        // First LLM response after an import "claims" the score — the
        // imported-state affordances (placeholder copy, post-import
        // chips) drop away once Claude has spoken once.
        lastImport: undefined,
      })
    } else {
      // No structured score returned — keep editor state cleared.
      set({
        pending: false,
        streamProgress: undefined,
        abc,
        scoreJson: undefined,
        editedScore: undefined,
        editMap: undefined,
        introText,
        selection: undefined,
        history: [],
        historyPointer: -1,
        epoch: nextEpoch,
      })
    }
  },

  streamScoreSection: (abc, scoreJson, progress) => {
    const { map } = renderWithMap(scoreJson)
    // Keep `pending` true and history untouched — this is mid-stream. The
    // streamProgress slot drives the "section N of M" caption and the
    // view-only gate on the streamed (not-yet-final) score.
    set({ abc, scoreJson, editedScore: scoreJson, editMap: map, selection: undefined, streamProgress: progress })
  },

  endRequestNoScore: () => {
    markChatActive(false)
    set({ pending: false, streamProgress: undefined, introText: undefined })
  },

  cancelStreamingForSwitch: () => {
    markChatActive(false)
    // Only release the request flags; the destination session's load owns
    // abc / scoreJson / introText, so leave those untouched.
    set({ pending: false, streamProgress: undefined })
  },

  seedHistoryFromServer: (history, headIndex, abc, introText) => {
    if (history.length === 0) return
    const safeIndex = Math.max(0, Math.min(headIndex, history.length - 1))
    const head = history[safeIndex]
    const { map } = renderWithMap(head)
    set({
      pending: false,
      streamProgress: undefined,
      abc,
      // scoreJson is the LLM baseline for `resetEditsToLLM`. The seed
      // chain may be entirely edits if the head has drifted far from
      // the last LLM checkpoint; fall back to history[0] in that case
      // (resetEditsToLLM walks to the root of the persisted chain,
      // which is the closest thing to "baseline" we have).
      scoreJson: head,
      editedScore: head,
      editMap: map,
      // introText is the persisted confirmation text from the most-
      // recent assistant `render_score` turn (see route.ts GET handler
      // / `mapTranscriptToTurns`). Keeping it in sync on the history-
      // rich seed path is what lets `LastConfirmationLabel` survive a
      // page reload mid-session.
      introText,
      selection: undefined,
      history: history.slice(),
      historyPointer: safeIndex,
      lastCoalesceKey: undefined,
      lastCoalesceAt: 0,
      epoch: get().epoch + 1,
      lastImport: undefined,
    })
  },

  failRequest: (error, options) => {
    markChatActive(false)
    set({
      pending: false,
      streamProgress: undefined,
      error,
      revealStartedAt: null,
      ...(options?.resetChatId
        ? { chatId: undefined, abc: undefined, scoreJson: undefined, editedScore: undefined, editMap: undefined, selection: undefined, history: [], historyPointer: -1 }
        : {}),
    })
  },

  clearError: () => set({ error: undefined }),

  markRevealStarted: () => set({ revealStartedAt: Date.now() }),
  markRevealComplete: () =>
    set((s) => ({ revealStartedAt: null, revealEpoch: s.revealEpoch + 1 })),
  setReduceMotion: (b) => set({ reduceMotion: b }),

  reset: async () => {
    const id = get().chatId
    if (typeof window !== 'undefined') window.sessionStorage.removeItem(STORAGE_KEY)
    set({
      chatId: undefined,
      abc: undefined,
      scoreJson: undefined,
      editedScore: undefined,
      editMap: undefined,
      selection: undefined,
      lastPrompt: undefined,
      introText: undefined,
      pending: false,
      streamProgress: undefined,
      error: undefined,
      history: [],
      historyPointer: -1,
      lastCoalesceKey: undefined,
      lastCoalesceAt: 0,
      turns: [],
      transcriptError: undefined,
      transcriptLoading: false,
      lastImport: undefined,
    })
    if (id) await resetSession(id)
  },

  resolveImport: ({ chatId, abc, scoreJson, introText, importFormat, filename }) => {
    // M24-PR-5 — user-initiated import is a manual action; interrupt
    // any pending AI proposal so the user can resume it from the
    // toast if the import was a mistake.
    if (get().pendingProposal) {
      set({
        interruptedProposal: get().pendingProposal,
        pendingProposal: undefined,
      })
    }
    const { map } = renderWithMap(scoreJson)
    set((s) => ({
      chatId,
      abc,
      scoreJson,
      editedScore: scoreJson,
      editMap: map,
      introText,
      lastPrompt: undefined,
      pending: false,
      streamProgress: undefined,
      error: undefined,
      selection: undefined,
      history: [scoreJson],
      historyPointer: 0,
      lastCoalesceKey: undefined,
      lastCoalesceAt: 0,
      // Bump the epoch so ScoreStage crossfades from the previous
      // score, matching the visual behavior of a fresh LLM response.
      epoch: s.epoch + 1,
      lastImport: { format: importFormat, filename },
      // Drop any prior chat panel transcript — this is a fresh session.
      turns: [],
      transcriptError: undefined,
      transcriptLoading: false,
    }))
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(STORAGE_KEY, chatId)
    }
  },

  select: (target) => set({ selection: target, runSelection: undefined }),
  selectRun: (run) => set({ runSelection: run }),

  selectMeasureRange: (range) => {
    if (range === undefined) {
      set({ measureRangeSelection: undefined })
      return
    }
    const state = get()
    const measureCount = state.editedScore?.measures.length ?? 0
    if (measureCount === 0) {
      set({ measureRangeSelection: undefined })
      return
    }
    const fromStart = Math.max(0, Math.min(range.fromStart, range.fromEnd))
    const fromEnd = Math.min(
      measureCount - 1,
      Math.max(range.fromStart, range.fromEnd),
    )
    if (fromStart > fromEnd) {
      set({ measureRangeSelection: undefined })
      return
    }
    set({ measureRangeSelection: { fromStart, fromEnd } })
  },

  extendMeasureRangeTo: (measureIdx) => {
    const state = get()
    const measureCount = state.editedScore?.measures.length ?? 0
    if (measureCount === 0) return
    if (measureIdx < 0 || measureIdx >= measureCount) return
    const existing = state.measureRangeSelection
    if (existing === undefined) {
      set({ measureRangeSelection: { fromStart: measureIdx, fromEnd: measureIdx } })
      return
    }
    const fromStart = Math.min(existing.fromStart, measureIdx)
    const fromEnd = Math.max(existing.fromEnd, measureIdx)
    set({ measureRangeSelection: { fromStart, fromEnd } })
  },

  setMeasureDragState: (state) => set({ measureDragState: state }),

  requestMeasureDelete: (range) => {
    const state = get()
    const score = state.editedScore
    if (!score) return
    const count = score.measures.length
    const fromStart = Math.max(0, Math.min(range.fromStart, range.fromEnd))
    const fromEnd = Math.min(count - 1, Math.max(range.fromStart, range.fromEnd))
    if (fromStart > fromEnd) return
    // Mirror the transformScore guard (dragMeasureRange delete throws
    // "would empty the score") up front, so the modal never offers a
    // delete that can only fail. The user gets an inline message instead.
    if (fromEnd - fromStart + 1 >= count) {
      set({ error: 'Cannot delete every measure — a score must keep at least one.' })
      return
    }
    set({ pendingMeasureDelete: { fromStart, fromEnd }, error: undefined })
  },

  confirmMeasureDelete: () => {
    const pending = get().pendingMeasureDelete
    if (!pending) return
    // Clear the gate first so the modal unmounts before the (immediate)
    // applyEdit commit, then perform the deletion through the canonical
    // span/marker-safe op. applyEdit handles history + undo toast +
    // selection/range pruning.
    set({ pendingMeasureDelete: undefined })
    get().applyEdit({
      kind: 'dragMeasureRange',
      mode: 'delete',
      fromStart: pending.fromStart,
      fromEnd: pending.fromEnd,
    })
  },

  cancelMeasureDelete: () => set({ pendingMeasureDelete: undefined }),

  contextMenu: undefined,
  openContextMenu: (state) => set({ contextMenu: state }),
  closeContextMenu: () => set({ contextMenu: undefined }),

  clipboard: undefined,
  setClipboard: (entry) => set({ clipboard: entry }),
  clearClipboard: () => set({ clipboard: undefined }),

  applyEdit: (op, coalesceKey) => {
    const state = get()
    const current = state.editedScore
    if (!current) return

    // M24-PR-5 — manual edit interrupts a pending AI proposal.
    // Stash it on `interruptedProposal` so ResumeProposalToast can
    // offer the user a 30s window to undo the interruption.
    if (state.pendingProposal) {
      set({
        interruptedProposal: state.pendingProposal,
        pendingProposal: undefined,
      })
    }

    // Pure transform only — no semantic validation. Temporarily
    // invalid scores (e.g., a measure that doesn't sum correctly
    // mid-edit) are allowed; Claude repairs them on the next prompt.
    // transformScore still throws for hard impossibilities (delete
    // only event, octave out of range, addPitch when at 6, etc.).
    let next: Score
    try {
      next = transformScore(current, op)
    } catch (e) {
      if (e instanceof EditError) {
        set({ error: e.message })
        return
      }
      throw e
    }

    // Audio ping on pitch changes (coalesced internally).
    if (op.kind === 'changePitch') {
      const pitch = getEventAt(next, op.target.measureIdx, op.target.eventIdx)
        ?.pitches[op.target.pitchIdx ?? 0]
      if (pitch) pitchAudioPing(pitch.step, pitch.octave, pitch.accidental)
    }

    // Surface an undo toast for the edit.
    const label = humanLabelFor(op)
    if (label) {
      const id = (state.undoToast?.id ?? 0) + 1
      // Defer via state.set in the main update below.
      set({ undoToast: { id, label } })
    }

    const { abc, map } = renderWithMap(next)

    // Coalesce: if this op's key matches the previous within the
    // window, replace the top of the history stack instead of pushing.
    const now = Date.now()
    const shouldCoalesce =
      coalesceKey !== undefined &&
      coalesceKey === state.lastCoalesceKey &&
      now - state.lastCoalesceAt < COALESCE_WINDOW_MS &&
      state.historyPointer === state.history.length - 1

    let newHistory: Score[]
    let newPointer: number

    if (shouldCoalesce) {
      newHistory = [...state.history.slice(0, state.historyPointer), next]
      newPointer = state.historyPointer
    } else {
      // Truncate redo branch.
      const trimmed = state.history.slice(0, state.historyPointer + 1)
      trimmed.push(next)
      // Cap depth.
      if (trimmed.length > HISTORY_CAP) {
        trimmed.shift()
      }
      newHistory = trimmed
      newPointer = newHistory.length - 1
    }

    set({
      editedScore: next,
      abc,
      editMap: map,
      history: newHistory,
      historyPointer: newPointer,
      lastCoalesceKey: coalesceKey,
      lastCoalesceAt: now,
      error: undefined,
      selection: pruneSelection(next, state.selection),
      measureRangeSelection: pruneMeasureRangeSelection(next, state.measureRangeSelection),
      measureDragState: undefined,
    })
  },

  applyBalancedEdit: (op, coalesceKey) => {
    const state = get()
    const current = state.editedScore
    if (!current) return

    // Kill switch: NEXT_PUBLIC_BALANCED_EDITS=off → silently no-op.
    // The caller can decide whether to fall back to applyEdit; for
    // now (drag, etc.) the v1 behavior on kill is "nothing happens",
    // which is safer than re-introducing the bug.
    if (process.env.NEXT_PUBLIC_BALANCED_EDITS === 'off') {
      return
    }

    // M24-PR-5 — manual drag/edit interrupts a pending AI proposal.
    if (state.pendingProposal) {
      set({
        interruptedProposal: state.pendingProposal,
        pendingProposal: undefined,
      })
    }

    let next: Score
    try {
      next = transformScoreBalanced(current, op)
    } catch (e) {
      if (e instanceof BalanceError) {
        set({ statusMessage: balanceErrorToMessage(e) })
        return
      }
      throw e
    }

    const labelText = humanLabelForBalanced(op)
    if (labelText) {
      const id = (state.undoToast?.id ?? 0) + 1
      set({ undoToast: { id, label: labelText } })
    }

    const { abc, map } = renderWithMap(next)
    const now = Date.now()
    const shouldCoalesce =
      coalesceKey !== undefined &&
      coalesceKey === state.lastCoalesceKey &&
      now - state.lastCoalesceAt < COALESCE_WINDOW_MS &&
      state.historyPointer === state.history.length - 1

    let newHistory: Score[]
    let newPointer: number
    if (shouldCoalesce) {
      newHistory = [...state.history.slice(0, state.historyPointer), next]
      newPointer = state.historyPointer
    } else {
      const trimmed = state.history.slice(0, state.historyPointer + 1)
      trimmed.push(next)
      if (trimmed.length > HISTORY_CAP) {
        trimmed.shift()
      }
      newHistory = trimmed
      newPointer = newHistory.length - 1
    }

    // Dev-only assertion: balanced ops must produce valid scores.
    if (process.env.NODE_ENV !== 'production') {
      try {
        validateScore(next)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // eslint-disable-next-line no-console
        console.error(`[applyBalancedEdit] post-balance validateScore failed: ${msg}`)
        throw err
      }
    }

    set({
      editedScore: next,
      abc,
      editMap: map,
      history: newHistory,
      historyPointer: newPointer,
      lastCoalesceKey: coalesceKey,
      lastCoalesceAt: now,
      error: undefined,
      selection: pruneSelection(next, state.selection),
      measureRangeSelection: pruneMeasureRangeSelection(next, state.measureRangeSelection),
      measureDragState: undefined,
    })
  },

  applyRevertResponse: ({ newTurn, scoreJson, abc, introText, headVersionId }) => {
    const state = get()
    const { map } = renderWithMap(scoreJson)
    const trimmed = state.history.slice(0, state.historyPointer + 1)
    trimmed.push(scoreJson)
    while (trimmed.length > HISTORY_CAP) trimmed.shift()
    set({
      turns: [...state.turns, newTurn],
      // Same reference for scoreJson and editedScore — useEditPersistence
      // gates on (editedScore === scoreJson) and skips, so this swap does
      // NOT fire a phantom POST of the reverted score back to the server.
      scoreJson,
      editedScore: scoreJson,
      abc,
      editMap: map,
      introText,
      history: trimmed,
      historyPointer: trimmed.length - 1,
      lastCoalesceKey: undefined,
      lastCoalesceAt: 0,
      selection: undefined,
      currentHeadVersionId: headVersionId,
      epoch: state.epoch + 1,
      error: undefined,
    })
  },

  applyScore: (next, options) => {
    const state = get()
    if (!state.editedScore) return
    // Dev-only assertion: direct-replacement edits (e.g. smartInsertNote
    // via NoteFloatingMenu, LLM full-score swaps) must produce valid
    // scores. Without this, bugs that corrupt the score here are only
    // surfaced lazily by applyBalancedEdit's post-balance validator on
    // the next drag — pointing the stack trace at the wrong call site.
    if (process.env.NODE_ENV !== 'production') {
      try {
        validateScore(next)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[applyScore] validateScore failed: ${msg}`)
        throw err
      }
    }
    // M24-PR-5 — direct-replacement (toolbar popovers, click-to-place,
    // NoteFloatingMenu actions) interrupts a pending AI proposal.
    if (state.pendingProposal) {
      set({
        interruptedProposal: state.pendingProposal,
        pendingProposal: undefined,
      })
    }
    const { abc, map } = renderWithMap(next)
    const trimmed = state.history.slice(0, state.historyPointer + 1)
    trimmed.push(next)
    if (trimmed.length > HISTORY_CAP) trimmed.shift()
    const desiredSelection = options?.selection ?? state.selection
    set({
      editedScore: next,
      abc,
      editMap: map,
      history: trimmed,
      historyPointer: trimmed.length - 1,
      lastCoalesceKey: undefined,
      lastCoalesceAt: 0,
      selection: pruneSelection(next, desiredSelection),
      measureRangeSelection: pruneMeasureRangeSelection(next, state.measureRangeSelection),
      measureDragState: undefined,
      statusMessage: options?.statusMessage,
      error: undefined,
    })
  },

  showStatusMessage: (msg) => set({ statusMessage: msg }),

  setPlaying: (b) => set({ isPlaying: b }),
  setPlaybackPosition: (pos) => set({ playbackPosition: pos }),
  setFollowPlayback: (follow) => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(FOLLOW_PLAYBACK_KEY, follow ? '1' : '0')
      } catch {
        /* private-mode / quota — ignore, in-memory state still wins */
      }
    }
    set({ followPlayback: follow })
  },
  playFromSelection: (sel) =>
    set((s) => ({
      playRequest: { selection: sel, id: (s.playRequest?.id ?? 0) + 1 },
      isPlaying: true,
    })),

  toggleCheatSheet: () =>
    set((s) => {
      const next = !s.cheatSheetOpen
      // Mutual exclusion with the chat history panel: opening one
      // closes the other so they never stack.
      return next ? { cheatSheetOpen: true, panelOpen: false } : { cheatSheetOpen: false }
    }),
  toggleChordPalette: () =>
    set((s) => ({ chordPaletteOpen: !s.chordPaletteOpen })),
  setChordPaletteOpen: (open) => set({ chordPaletteOpen: open }),
  showUndoToast: (label) =>
    set((s) => ({ undoToast: { id: (s.undoToast?.id ?? 0) + 1, label } })),
  clearUndoToast: () => set({ undoToast: undefined }),
  setDragSnapTarget: (t) => set({ dragSnapTarget: t }),

  setTurns: (turns) => set({ turns }),
  appendTurns: (newTurns) => set((s) => ({ turns: [...s.turns, ...newTurns] })),
  appendStreamingAssistantTurn: (toolUseId) => {
    const idx = get().turns.length
    set((s) => ({
      turns: [
        ...s.turns,
        {
          role: 'assistant',
          kind: 'text',
          text: '',
          toolUseId,
          streaming: true,
          ts: Date.now(),
        },
      ],
    }))
    return idx
  },
  appendStreamingDelta: (index, delta) =>
    set((s) => {
      const turn = s.turns[index]
      if (!turn || turn.role !== 'assistant' || turn.kind !== 'text') return {}
      const next = s.turns.slice()
      next[index] = { ...turn, text: turn.text + delta }
      return { turns: next }
    }),
  finalizeStreamingTurn: (index, finalText) =>
    set((s) => {
      const turn = s.turns[index]
      if (!turn || turn.role !== 'assistant' || turn.kind !== 'text') return {}
      const next = s.turns.slice()
      next[index] = {
        ...turn,
        text: finalText ?? turn.text,
        streaming: false,
      }
      return { turns: next }
    }),
  failStreamingTurn: (index, message) =>
    set((s) => {
      const turn = s.turns[index]
      if (!turn || turn.role !== 'assistant' || turn.kind !== 'text') return {}
      const next = s.turns.slice()
      next[index] = {
        ...turn,
        streaming: false,
        errored: true,
        errorText: message,
      }
      return { turns: next }
    }),
  appendErrorTurn: (message) =>
    set((s) => ({
      turns: [
        ...s.turns,
        {
          role: 'assistant',
          kind: 'text',
          text: '',
          // Synthetic, session-only id — error turns are client artifacts,
          // not server-persisted, so they only need to be unique within
          // this transcript for React keys / optimistic mapping.
          toolUseId: `toolu_error_${s.turns.length}_${Date.now()}`,
          errored: true,
          errorText: message,
          ts: Date.now(),
        },
      ],
    })),
  clearTurns: () => set({ turns: [], transcriptError: undefined }),
  setTranscriptLoading: (loading) => set({ transcriptLoading: loading }),
  setTranscriptError: (msg) => set({ transcriptError: msg }),
  retryTranscriptSync: () =>
    set((s) => ({ transcriptRetryNonce: s.transcriptRetryNonce + 1, transcriptError: undefined })),
  togglePanel: () =>
    set((s) => {
      const next = !s.panelOpen
      return next ? { panelOpen: true, cheatSheetOpen: false } : { panelOpen: false }
    }),
  setPanelOpen: (open) =>
    set((s) =>
      open ? { panelOpen: true, cheatSheetOpen: false } : { panelOpen: false, cheatSheetOpen: s.cheatSheetOpen },
    ),

  undo: () => {
    const state = get()
    if (state.historyPointer <= 0) return
    // M24-PR-5 — undo counts as a manual edit; interrupt the proposal.
    if (state.pendingProposal) {
      set({
        interruptedProposal: state.pendingProposal,
        pendingProposal: undefined,
      })
    }
    const newPointer = state.historyPointer - 1
    const score = state.history[newPointer]
    const { abc, map } = renderWithMap(score)
    set({
      editedScore: score,
      abc,
      editMap: map,
      historyPointer: newPointer,
      lastCoalesceKey: undefined,
      selection: pruneSelection(score, state.selection),
      measureRangeSelection: pruneMeasureRangeSelection(score, state.measureRangeSelection),
      measureDragState: undefined,
    })
  },

  redo: () => {
    const state = get()
    if (state.historyPointer >= state.history.length - 1) return
    // M24-PR-5 — redo counts as a manual edit; interrupt the proposal.
    if (state.pendingProposal) {
      set({
        interruptedProposal: state.pendingProposal,
        pendingProposal: undefined,
      })
    }
    const newPointer = state.historyPointer + 1
    const score = state.history[newPointer]
    const { abc, map } = renderWithMap(score)
    set({
      editedScore: score,
      abc,
      editMap: map,
      historyPointer: newPointer,
      lastCoalesceKey: undefined,
      selection: pruneSelection(score, state.selection),
      measureRangeSelection: pruneMeasureRangeSelection(score, state.measureRangeSelection),
      measureDragState: undefined,
    })
  },

  canUndo: () => get().historyPointer > 0,
  canRedo: () => get().historyPointer < get().history.length - 1,

  resetEditsToLLM: () => {
    const state = get()
    if (!state.scoreJson) return
    // M24-PR-5 — "Reset to LLM" is a manual action bailing on the
    // current path. Interrupt (rather than discard) the pending
    // proposal because the user might change their mind within the
    // 30s window: "I want to start fresh, no wait, actually try
    // that suggestion again" is a normal undo-curiosity pattern.
    // The toast's Dismiss button + 30s timer cover the "really
    // throw it away" path.
    if (state.pendingProposal) {
      set({
        interruptedProposal: state.pendingProposal,
        pendingProposal: undefined,
      })
    }
    const { abc, map } = renderWithMap(state.scoreJson)
    set({
      editedScore: state.scoreJson,
      abc,
      editMap: map,
      selection: undefined,
      history: [state.scoreJson],
      historyPointer: 0,
      lastCoalesceKey: undefined,
      lastCoalesceAt: 0,
    })
  },
}))

/**
 * Hydrate followPlayback from localStorage on mount. Writes happen
 * inside setFollowPlayback (the toggle is rare so a write per toggle
 * is fine), so this hook only needs to read on mount.
 */
export function useFollowPlaybackSync() {
  const setFollowPlayback = useChatStore((s) => s.setFollowPlayback)

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const stored = window.localStorage.getItem(FOLLOW_PLAYBACK_KEY)
      if (stored === '1') setFollowPlayback(true)
    } catch {
      /* private-mode / quota — ignore */
    }
  }, [setFollowPlayback])
}

/**
 * Sync the store's chatId with sessionStorage:
 * - On mount, restore chatId if present.
 * - On change, persist (or clear) it.
 * sessionStorage (not localStorage) means: refresh continues the chat,
 * a new tab gets a fresh one.
 */
export function useChatIdSession() {
  const chatId = useChatStore((s) => s.chatId)
  const setChatId = useChatStore((s) => s.setChatId)

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? window.sessionStorage.getItem(STORAGE_KEY) : null
    if (stored) setChatId(stored)
  }, [setChatId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (chatId) window.sessionStorage.setItem(STORAGE_KEY, chatId)
    else window.sessionStorage.removeItem(STORAGE_KEY)
  }, [chatId])
}

/**
 * Sync the store's `reduceMotion` flag with the user's OS-level
 * `prefers-reduced-motion` setting. Resolved once at mount and updated
 * via a `change` listener so toggling the system preference live takes
 * effect without a refresh. The cached value lets animation consumers
 * branch without calling matchMedia on every render.
 */
export function useReduceMotionSync() {
  const setReduceMotion = useChatStore((s) => s.setReduceMotion)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduceMotion(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setReduceMotion(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [setReduceMotion])
}
