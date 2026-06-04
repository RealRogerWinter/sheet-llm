import type { Score } from '@/lib/music/types'
import type { Operation } from '@/lib/music/editOperations'
import { hashMeasure } from '@/lib/music/scoreDiff'

/**
 * Invariant predicates we assert against the APPLIED Score after the
 * orchestrator+handlers (and any ops they emit) have run. We assert on
 * applied-state, not the JSON the LLM returned, because that's what the
 * user actually sees. Adding a new invariant here is cheap and should
 * be done as soon as a new contract bug surfaces in production.
 *
 * All fields are optional. Each present field becomes one assertion.
 * Missing fields are not checked.
 */
export interface ScoreInvariants {
  /** Final Score must have exactly this many measures. */
  measureCount?: number
  /** Final Score's top-level key must equal initial Score's key (and this value). */
  keyPreserved?: string
  /** Final Score's top-level meter must equal initial Score's meter (and this value). */
  meterPreserved?: string
  /** Final Score's title must equal initial Score's title (and this value). */
  titlePreserved?: string
  /**
   * Bars `[0, N)` of the after-score must be byte-identical to the
   * same range of the initial score under the per-measure canonical
   * hash. Catches "the LLM preserved the bars but with different
   * articulations / accidentals" silently.
   */
  firstNMeasuresIdentical?: number
  /**
   * The `appliedOps` array on the OrchestratorResult must include an
   * op of this kind. Typed as `string` (not `Operation['kind']`) so
   * cases can reference future-tense kinds like `extend_composition`
   * that don't exist yet — the assertion intentionally fails until
   * the op lands.
   */
  appliedOpsContain?: string
  /**
   * The handler-or-route response should carry `requiresConfirmation:
   * true` (M3.5-PR-4 replacement-as-confirmation gate). Until PR-4 lands
   * this is always undefined → assertion fails when present.
   */
  replacementBlocked?: boolean
}

/**
 * One failed invariant. We accumulate ALL failures rather than
 * throwing on the first so the dev sees the full picture in one test
 * run — particularly important while a case is `.fails` and we're
 * watching it slowly turn green PR by PR.
 */
export interface InvariantFailure {
  /** Field on ScoreInvariants that failed. */
  predicate: keyof ScoreInvariants
  /** One-line human-readable description of the mismatch. */
  message: string
}

/**
 * Carries enough of the actual orchestrator outcome to evaluate every
 * predicate above. Constructed by the mock + live runners.
 */
export interface ActualOutcome {
  /** The Score that was applied after the handler ran. */
  afterScore?: Score
  /** Ops returned by the handler (if any). */
  appliedOps?: ReadonlyArray<Operation>
  /**
   * Whether the response surface (route/handler) flagged this turn as
   * requiring user confirmation before applying. Until PR-4 lands, no
   * handler sets this — undefined is the expected pre-fix value.
   */
  requiresConfirmation?: boolean
}

/**
 * Evaluate every present predicate. Returns `[]` when all pass.
 * Callers wrap the array into `expect(...).toEqual([])` so vitest
 * pretty-prints the full mismatch list on failure.
 */
export function assertScoreInvariants(
  actual: ActualOutcome,
  expected: ScoreInvariants,
  initialScore: Score,
): InvariantFailure[] {
  const failures: InvariantFailure[] = []
  const after = actual.afterScore

  if (expected.measureCount !== undefined) {
    const got = after?.measures.length
    if (got !== expected.measureCount) {
      failures.push({
        predicate: 'measureCount',
        message: `expected measureCount=${expected.measureCount}, got ${got ?? '<no score>'}`,
      })
    }
  }

  if (expected.keyPreserved !== undefined) {
    const initialKey = initialScore.key
    if (initialKey !== expected.keyPreserved) {
      failures.push({
        predicate: 'keyPreserved',
        message: `case mis-configured: initialScore.key=${initialKey} but keyPreserved=${expected.keyPreserved}`,
      })
    } else if (after?.key !== expected.keyPreserved) {
      failures.push({
        predicate: 'keyPreserved',
        message: `expected key="${expected.keyPreserved}" preserved, got "${after?.key ?? '<no score>'}"`,
      })
    }
  }

  if (expected.meterPreserved !== undefined) {
    if (initialScore.meter !== expected.meterPreserved) {
      failures.push({
        predicate: 'meterPreserved',
        message: `case mis-configured: initialScore.meter=${initialScore.meter} but meterPreserved=${expected.meterPreserved}`,
      })
    } else if (after?.meter !== expected.meterPreserved) {
      failures.push({
        predicate: 'meterPreserved',
        message: `expected meter="${expected.meterPreserved}" preserved, got "${after?.meter ?? '<no score>'}"`,
      })
    }
  }

  if (expected.titlePreserved !== undefined) {
    if (initialScore.title !== expected.titlePreserved) {
      failures.push({
        predicate: 'titlePreserved',
        message: `case mis-configured: initialScore.title=${initialScore.title ?? '<unset>'} but titlePreserved=${expected.titlePreserved}`,
      })
    } else if (after?.title !== expected.titlePreserved) {
      failures.push({
        predicate: 'titlePreserved',
        message: `expected title="${expected.titlePreserved}" preserved, got "${after?.title ?? '<unset>'}"`,
      })
    }
  }

  if (expected.firstNMeasuresIdentical !== undefined) {
    const n = expected.firstNMeasuresIdentical
    if (!after) {
      failures.push({
        predicate: 'firstNMeasuresIdentical',
        message: `expected first ${n} measures identical, but afterScore is absent`,
      })
    } else if (initialScore.measures.length < n) {
      failures.push({
        predicate: 'firstNMeasuresIdentical',
        message: `case mis-configured: initialScore has only ${initialScore.measures.length} measures but expected first ${n} identical`,
      })
    } else if (after.measures.length < n) {
      failures.push({
        predicate: 'firstNMeasuresIdentical',
        message: `expected first ${n} measures identical, but afterScore has only ${after.measures.length}`,
      })
    } else {
      for (let i = 0; i < n; i++) {
        const initialHash = hashMeasure(initialScore.measures[i])
        const afterHash = hashMeasure(after.measures[i])
        if (initialHash !== afterHash) {
          failures.push({
            predicate: 'firstNMeasuresIdentical',
            message: `measure ${i} hash differs: initial=${initialHash} after=${afterHash}`,
          })
        }
      }
    }
  }

  if (expected.appliedOpsContain !== undefined) {
    const found = actual.appliedOps?.some((op) => op.kind === expected.appliedOpsContain)
    if (!found) {
      const got = actual.appliedOps?.map((o) => o.kind).join(',') ?? '<none>'
      failures.push({
        predicate: 'appliedOpsContain',
        message: `expected appliedOps to contain kind="${expected.appliedOpsContain}", got [${got}]`,
      })
    }
  }

  if (expected.replacementBlocked !== undefined) {
    if (actual.requiresConfirmation !== expected.replacementBlocked) {
      failures.push({
        predicate: 'replacementBlocked',
        message: `expected requiresConfirmation=${expected.replacementBlocked}, got ${actual.requiresConfirmation ?? 'undefined'}`,
      })
    }
  }

  return failures
}
