import type { JumpKind, JumpMarker, Score } from './types'

/**
 * One step in the linearized playback sequence produced by `expand`.
 * Holds the source measureIdx + the playback ordinal (0-based) so
 * downstream consumers (MIDI export, the renderer's playback cursor,
 * the future AI agent reasoning about post-jump order) can map back
 * to both the canonical measure and its position in the timeline.
 */
export interface ExpandStep {
  /** 0-indexed measure in the source score. */
  measureIdx: number
  /**
   * 0-indexed position in the linearized sequence. Same as the
   * containing array index — included for ergonomic access when
   * filtering or slicing without losing the playback ordinal.
   */
  playbackIdx: number
}

/**
 * Diagnostic reasons attached to an `ExpandResult`. Surface unusual
 * conditions back to callers (UI banners, future Onboarding lints,
 * MIDI export warnings) without throwing — `expand` is intentionally
 * tolerant of partially-valid scores so a piece-in-progress with one
 * unresolved jump still produces a useful linear sequence.
 */
export type ExpandWarning =
  | { code: 'cycle_aborted'; iterationCap: number; lastMeasureIdx: number }
  | { code: 'unresolved_segno'; jumpMarkerId: string; segnoRef: string }
  | { code: 'unresolved_coda'; jumpMarkerId: string; codaRef: string }
  | { code: 'al_coda_no_to_coda'; jumpMarkerId: string; codaRef: string }
  | { code: 'al_fine_no_fine'; jumpMarkerId: string }
  | { code: 'jump_out_of_range'; jumpMarkerId: string; measureIdx: number; measureCount: number }

export interface ExpandResult {
  /**
   * The linear playback sequence — one entry per measure visit.
   * `steps[k].measureIdx` is the source measure played at position
   * k. The same source measure can appear multiple times (e.g.
   * after a D.C. fires the opening measures replay).
   */
  steps: ExpandStep[]
  /**
   * Non-fatal anomalies encountered during expansion. An empty array
   * indicates a clean resolve. The renderer / playback path can
   * surface these as UI warnings; validateCrossRefs catches the
   * upstream schema-level violations separately at save time.
   */
  warnings: ExpandWarning[]
}

/**
 * Maximum number of expansion steps before the resolver aborts with
 * `cycle_aborted`. Calibrated for the longest expected real-world
 * score: a 500-measure piece + 1 D.C. al Coda + 1 D.S. al Fine =
 * ~1500 measure visits. Set high enough that legitimate long pieces
 * with multiple jumps complete, low enough that a pathological
 * cycle (A→B→A→B→...) terminates in milliseconds.
 */
const ITERATION_CAP = 100_000

/**
 * Linearize a Score's measure sequence honoring jump markers. Returns
 * the ordered list of source measureIdx values that playback should
 * visit, plus a list of non-fatal warnings for any unresolved jumps.
 *
 * Supported jumpMarker semantics (M18-PR-3):
 *   - `D.C.` — jump to measure 0; armed Fine markers stay armed.
 *   - `D.S.` — jump to the Segno marker referenced by `segnoRef`.
 *   - `D.C. al Coda` / `D.S. al Coda` — jump back, ARM the al-Coda
 *     target: on the next encounter of a `To Coda` jumpMarker, hop
 *     to the Coda marker referenced by `codaRef`.
 *   - `D.C. al Fine` / `D.S. al Fine` — jump back, ARM Fine: the
 *     next Fine jumpMarker terminates expansion.
 *   - `To Coda` — gating point for al-Coda. Without al-Coda armed,
 *     the marker is a no-op (the player walks past it normally).
 *   - `Fine` — terminates expansion ONLY when al-Fine is armed.
 *     Without al-Fine, Fine is decorative (the classical convention
 *     for a "Fine" without an explicit D.C./D.S. al Fine).
 *
 * Each jumpMarker fires AT MOST ONCE per expansion. Without this
 * guard a D.C. would loop forever (after the jump, the player
 * eventually reaches the D.C. again and would re-trigger).
 *
 * Multi-coda scores use the optional `JumpMarker.toCodaRef` field
 * on the *.al-Coda jump to disambiguate WHICH To Coda gates the
 * hop. When set, only the To Coda jumpMarker matching that id can
 * fire al-Coda; other To Codas in the score are treated as no-ops.
 * When `toCodaRef` is omitted, the FIRST To Coda encountered after
 * the al-Coda fires the hop — the single-coda common case.
 *
 * Repeats (startBarline:repeat-start / endBarline:repeat-end) and
 * voltas are NOT honored by this pass — the linear sequence reflects
 * one-pass-through-the-bars + jumps only. A future M18 PR (likely
 * PR-5 or a follow-up sweep) layers the repeat/volta semantics on
 * top by post-processing the bars between repeat boundaries before
 * passing to `expand`.
 *
 * Unsupported / partial-pairing cases produce a warning but the
 * resolver continues:
 *   - JumpMarker with out-of-range `measureIdx` → silently skipped
 *     during expansion; warning code `jump_out_of_range` emitted at
 *     start so downstream consumers can flag the data-integrity
 *     issue without waiting for the next save-time validateCrossRefs.
 *   - D.S.* with unresolvable segnoRef → linear continuation past
 *     the would-be jump; warning code `unresolved_segno`.
 *   - *.al-Coda with unresolvable codaRef → the al-Coda flag is
 *     never armed (no jump from To Coda will fire); warning
 *     `unresolved_coda`.
 *   - *.al-Coda armed but no To Coda marker ever encountered →
 *     warning `al_coda_no_to_coda` emitted when the expansion
 *     terminates with al-Coda still armed.
 *   - *.al-Fine armed but no Fine ever encountered → warning
 *     `al_fine_no_fine`.
 *
 * Cycle detection: hard cap of {@link ITERATION_CAP} steps. The
 * resolver returns whatever it accumulated up to the cap plus
 * `cycle_aborted` warning. The cap is high enough that all
 * legitimate scores complete; pathological inputs (e.g. a future
 * editor lets the user construct A→B→A toCodaRef cycles) terminate
 * in a bounded time instead of hanging the playback thread.
 */
export function expand(score: Score): ExpandResult {
  const measureCount = score.measures.length
  const steps: ExpandStep[] = []
  const warnings: ExpandWarning[] = []
  if (measureCount === 0) return { steps, warnings }

  const allJumpMarkers = score.jumpMarkers ?? []
  const segnoMarkers = score.segnoMarkers ?? []
  const codaMarkers = score.codaMarkers ?? []

  // Pre-pass: drop out-of-range jumpMarkers + emit a warning for each.
  // validateCrossRefs does NOT bound-check jump.measureIdx today, so a
  // user-or-LLM-supplied jump with measureIdx === 999 in a 4-bar
  // score would otherwise silently no-op. Surfacing the diagnostic
  // gives callers a chance to flag the data-integrity issue without
  // waiting for the next save-time validateScore pass.
  const jumpMarkers: JumpMarker[] = []
  for (const j of allJumpMarkers) {
    if (j.measureIdx < 0 || j.measureIdx >= measureCount) {
      warnings.push({
        code: 'jump_out_of_range',
        jumpMarkerId: j.id,
        measureIdx: j.measureIdx,
        measureCount,
      })
      continue
    }
    jumpMarkers.push(j)
  }

  // Pre-index for O(1) lookup at each visited measure.
  const segnoById = new Map(segnoMarkers.map((s) => [s.id, s]))
  const codaById = new Map(codaMarkers.map((c) => [c.id, c]))

  // Fast path: no in-range jumpMarkers → trivial linear sequence.
  if (jumpMarkers.length === 0) {
    for (let i = 0; i < measureCount; i++) {
      steps.push({ measureIdx: i, playbackIdx: i })
    }
    return { steps, warnings }
  }

  // Resolution state.
  let cursor = 0
  let alCodaTargetCodaId: string | null = null
  // Optional gating jumpMarker id for the armed al-Coda. When set,
  // ONLY a To Coda jumpMarker with this id can fire the hop; other
  // To Codas in the score are no-ops. Source: the *.al-Coda jump
  // that armed al-Coda carried a `toCodaRef`. When null, any To Coda
  // fires (the single-coda common case).
  let alCodaTargetToCodaId: string | null = null
  // Track which *.al-Coda jump armed the current al-Coda state. Used
  // for the trailing `al_coda_no_to_coda` warning so the reported id
  // reflects firing-order, not array-order. Same for al-Fine.
  let alCodaArmerJumpId: string | null = null
  let alFineActive = false
  let alFineArmerJumpId: string | null = null
  const jumpsFired = new Set<string>()

  // Bound the loop. Each iteration appends exactly one step (or
  // breaks); the cap is the absolute step limit, not a wall-clock
  // limit. See ITERATION_CAP docstring.
  let iter = 0
  while (cursor >= 0 && cursor < measureCount) {
    if (iter++ >= ITERATION_CAP) {
      warnings.push({
        code: 'cycle_aborted',
        iterationCap: ITERATION_CAP,
        lastMeasureIdx: cursor,
      })
      break
    }
    steps.push({ measureIdx: cursor, playbackIdx: steps.length })

    // Resolve the end-of-measure jump (if any) for this cursor.
    // jumpMarker.side === 'start' is treated as a same-measure
    // landmark (e.g. a Coda glyph at the start of a section) but
    // does NOT trigger expansion; expansion fires on side === 'end'.
    const endJumps = jumpMarkers.filter(
      (j) => j.measureIdx === cursor && j.side === 'end',
    )

    // Determine which jump (if any) fires here. Priority:
    //   1. al-Coda armed + To Coda at this measure → coda hop.
    //   2. al-Fine armed + Fine at this measure → terminate.
    //   3. First unfired non-To-Coda non-Fine jump → execute it.
    //   4. Unarmed To Coda / Fine → no-op, walk past.
    //
    // Multiple end-jumps on one measure are pathological (the user
    // should split into adjacent measures); the resolver picks the
    // first by array order after the priority gates.
    const fireableJumps = endJumps.filter((j) => !jumpsFired.has(j.id))

    // Gate 1: To Coda + al-Coda armed. If alCodaTargetToCodaId is
    // set (the *.al-Coda jump declared a `toCodaRef`), ONLY a To
    // Coda jumpMarker with that id can fire. Otherwise any unfired
    // To Coda fires (single-coda common case).
    if (alCodaTargetCodaId !== null) {
      const toCoda = fireableJumps.find(
        (j) =>
          j.kind === 'To Coda' &&
          (alCodaTargetToCodaId === null || j.id === alCodaTargetToCodaId),
      )
      if (toCoda) {
        const coda = codaById.get(alCodaTargetCodaId)
        if (!coda) {
          // Unreachable in practice — alCodaTargetCodaId was set
          // from a validated jump.codaRef at jump time, and the
          // codaById index is immutable. Defensive: drop the
          // al-Coda state and continue linearly.
          alCodaTargetCodaId = null
          alCodaTargetToCodaId = null
          alCodaArmerJumpId = null
        } else {
          jumpsFired.add(toCoda.id)
          cursor = coda.measureIdx
          alCodaTargetCodaId = null
          alCodaTargetToCodaId = null
          alCodaArmerJumpId = null
          continue
        }
      }
    }

    // Gate 2: Fine + al-Fine armed.
    if (alFineActive) {
      const fine = fireableJumps.find((j) => j.kind === 'Fine')
      if (fine) {
        jumpsFired.add(fine.id)
        alFineActive = false
        alFineArmerJumpId = null
        break
      }
    }

    // Gate 3: first unfired non-To-Coda non-Fine jump.
    const next = fireableJumps.find(
      (j) => j.kind !== 'To Coda' && j.kind !== 'Fine',
    )
    if (next) {
      jumpsFired.add(next.id)
      const fireResult = fireJump(next, segnoById, codaById, warnings)
      if (fireResult.alCodaArmCodaId !== undefined) {
        alCodaTargetCodaId = fireResult.alCodaArmCodaId
        alCodaTargetToCodaId = fireResult.alCodaArmToCodaId ?? null
        alCodaArmerJumpId = next.id
      }
      if (fireResult.alFineArm) {
        alFineActive = true
        alFineArmerJumpId = next.id
      }
      cursor = fireResult.cursor
      continue
    }

    cursor++
  }

  // Trailing-warning sweep: armed but never fired. The armer ids
  // are tracked at firing-time (not derived from array order) so
  // the warning's `jumpMarkerId` field reflects the *.al-Coda /
  // *.al-Fine that LEFT the state armed.
  if (alCodaTargetCodaId !== null) {
    warnings.push({
      code: 'al_coda_no_to_coda',
      jumpMarkerId: alCodaArmerJumpId ?? '<unknown>',
      codaRef: alCodaTargetCodaId,
    })
  }
  if (alFineActive) {
    warnings.push({
      code: 'al_fine_no_fine',
      jumpMarkerId: alFineArmerJumpId ?? '<unknown>',
    })
  }
  return { steps, warnings }
}

interface JumpFireResult {
  /** New cursor measureIdx (where to resume playback). */
  cursor: number
  /** When set, arm al-Coda with this codaMarker id. */
  alCodaArmCodaId?: string
  /**
   * Optional gating To-Coda jumpMarker id for the al-Coda arming.
   * When set, ONLY the To Coda with this id can fire the hop;
   * other To Codas in the score are ignored. Source: the firing
   * *.al-Coda's `toCodaRef` field. When omitted, any To Coda
   * encountered fires (single-coda common case).
   */
  alCodaArmToCodaId?: string
  /** When true, arm al-Fine. */
  alFineArm?: boolean
}

/**
 * Resolve a single jumpMarker firing and compute the next state.
 * Emits warnings (push to the caller's array) for unresolvable refs;
 * returns a sensible cursor fallback (typically continue linearly
 * past the jump) so a partially-broken score still produces SOME
 * output.
 */
function fireJump(
  jump: JumpMarker,
  segnoById: Map<string, { measureIdx: number }>,
  codaById: Map<string, { measureIdx: number }>,
  warnings: ExpandWarning[],
): JumpFireResult {
  const kind = jump.kind
  if (kind === 'D.C.') {
    return { cursor: 0 }
  }
  if (kind === 'D.S.') {
    const segno = jump.segnoRef ? segnoById.get(jump.segnoRef) : undefined
    if (!segno) {
      warnings.push({
        code: 'unresolved_segno',
        jumpMarkerId: jump.id,
        segnoRef: jump.segnoRef ?? '<missing>',
      })
      return { cursor: jump.measureIdx + 1 }
    }
    return { cursor: segno.measureIdx }
  }
  if (kind === 'D.C. al Coda') {
    const codaId = resolveCodaRef(jump, codaById, warnings)
    return {
      cursor: 0,
      ...(codaId !== null ? { alCodaArmCodaId: codaId } : {}),
      ...(codaId !== null && jump.toCodaRef !== undefined
        ? { alCodaArmToCodaId: jump.toCodaRef }
        : {}),
    }
  }
  if (kind === 'D.S. al Coda') {
    const segno = jump.segnoRef ? segnoById.get(jump.segnoRef) : undefined
    if (!segno) {
      warnings.push({
        code: 'unresolved_segno',
        jumpMarkerId: jump.id,
        segnoRef: jump.segnoRef ?? '<missing>',
      })
      return { cursor: jump.measureIdx + 1 }
    }
    const codaId = resolveCodaRef(jump, codaById, warnings)
    return {
      cursor: segno.measureIdx,
      ...(codaId !== null ? { alCodaArmCodaId: codaId } : {}),
      ...(codaId !== null && jump.toCodaRef !== undefined
        ? { alCodaArmToCodaId: jump.toCodaRef }
        : {}),
    }
  }
  if (kind === 'D.C. al Fine') {
    return { cursor: 0, alFineArm: true }
  }
  if (kind === 'D.S. al Fine') {
    const segno = jump.segnoRef ? segnoById.get(jump.segnoRef) : undefined
    if (!segno) {
      warnings.push({
        code: 'unresolved_segno',
        jumpMarkerId: jump.id,
        segnoRef: jump.segnoRef ?? '<missing>',
      })
      return { cursor: jump.measureIdx + 1 }
    }
    return { cursor: segno.measureIdx, alFineArm: true }
  }
  // To Coda / Fine end up here only as a fallthrough (gates above
  // already filtered them). Treat as linear continuation.
  return { cursor: jump.measureIdx + 1 }
}

/**
 * Look up the codaRef on an *.al-Coda jump. Emits an
 * `unresolved_coda` warning when the ref is missing or doesn't
 * match a CodaMarker. Returns null in those cases so the caller
 * does NOT arm al-Coda (a phantom-arm would emit a misleading
 * `al_coda_no_to_coda` trailing warning).
 */
function resolveCodaRef(
  jump: JumpMarker,
  codaById: Map<string, { measureIdx: number }>,
  warnings: ExpandWarning[],
): string | null {
  if (!jump.codaRef) {
    warnings.push({
      code: 'unresolved_coda',
      jumpMarkerId: jump.id,
      codaRef: '<missing>',
    })
    return null
  }
  if (!codaById.has(jump.codaRef)) {
    warnings.push({
      code: 'unresolved_coda',
      jumpMarkerId: jump.id,
      codaRef: jump.codaRef,
    })
    return null
  }
  return jump.codaRef
}

/**
 * Convenience accessor that returns just the linear measure index
 * sequence. Equivalent to `expand(score).steps.map(s => s.measureIdx)`.
 * Provided for callers that only need the order and don't care about
 * playback ordinals or warnings (e.g. a future debug renderer that
 * paints the post-jump path on the score).
 */
export function expandedMeasureSequence(score: Score): number[] {
  return expand(score).steps.map((s) => s.measureIdx)
}

/**
 * For tests + external callers: explicit type narrowing on a
 * JumpKind to the subset that can be the target of a *.al-Coda /
 * *.al-Fine arm. Not used internally — kept around because the
 * forthcoming popover UI needs the same predicate.
 */
export function isJumpThatArmsAlCoda(kind: JumpKind): boolean {
  return kind === 'D.C. al Coda' || kind === 'D.S. al Coda'
}

export function isJumpThatArmsAlFine(kind: JumpKind): boolean {
  return kind === 'D.C. al Fine' || kind === 'D.S. al Fine'
}
