import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Per-model-SHA baseline tracking. Each Anthropic model release
 * gets its own row; a case that PREVIOUSLY-PASSED on a given model
 * and now FAILS is treated as a regression (exit 79) rather than a
 * new failure (exit 1).
 *
 * On-disk shape:
 *   {
 *     "<model-sha>": {
 *       "<case-id>": {
 *         "firstSeen": <iso-string>,
 *         "lastPassed": <iso-string-or-null>,
 *         "lastResult": "pass" | "fail",
 *         "failures": string[]
 *       },
 *       ...
 *     },
 *     ...
 *   }
 *
 * The file lives at `evals/baselines/eval-scores.json` and is checked
 * in. Nightly CI rewrites it on successful main-branch runs (PR-5
 * scope), so the file in main is the source of truth.
 *
 * Loaded lazily, mutated in memory, written on demand. We don't worry
 * about concurrent writes — tests run sequentially within a single
 * vitest process.
 */

export type EvalCaseResult = 'pass' | 'fail'

export type EvalCaseStatus =
  | 'new' // first time we've seen this case on this model
  | 'still-passing' // previously passed, still passes
  | 'still-failing' // previously failed, still fails (not a regression)
  | 'regression' // previously passed, now fails
  | 'recovery' // previously failed, now passes

export interface BaselineCaseEntry {
  firstSeen: string
  lastPassed: string | null
  lastResult: EvalCaseResult
  failures: string[]
}

export type BaselinesFile = Record<string, Record<string, BaselineCaseEntry>>

/** Default location of the baselines file. */
export const DEFAULT_BASELINES_PATH = 'evals/baselines/eval-scores.json'

export function loadBaselines(path: string = DEFAULT_BASELINES_PATH): BaselinesFile {
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as BaselinesFile
  } catch (e) {
    if (process.env.EVAL_SILENT !== '1') {
      console.warn(`[eval baselines] failed to read ${path}: ${(e as Error).message}`)
    }
    return {}
  }
}

export function saveBaselines(
  data: BaselinesFile,
  path: string = DEFAULT_BASELINES_PATH,
): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/**
 * Detect regression status BEFORE updating the entry. Returns:
 * - `regression` when prior `lastResult === 'pass'` and `currentPass === false`
 * - `recovery` when prior `lastResult === 'fail'` and `currentPass === true`
 * - `new`, `still-passing`, `still-failing` otherwise.
 *
 * Does NOT mutate `data` — callers must follow up with
 * `recordLiveResult` to persist.
 */
export function detectRegression(
  data: BaselinesFile,
  model: string,
  caseId: string,
  currentPass: boolean,
): EvalCaseStatus {
  const prev = data[model]?.[caseId]
  if (!prev) return 'new'
  if (prev.lastResult === 'pass' && !currentPass) return 'regression'
  if (prev.lastResult === 'fail' && currentPass) return 'recovery'
  return currentPass ? 'still-passing' : 'still-failing'
}

/**
 * Update one case entry in memory. Caller is responsible for calling
 * `saveBaselines(data)` when ready to persist (typically once at end
 * of a nightly main-branch run).
 */
export function recordLiveResult(
  data: BaselinesFile,
  model: string,
  caseId: string,
  update: { lastResult: EvalCaseResult; failures: string[] },
): BaselineCaseEntry {
  if (!data[model]) data[model] = {}
  const now = new Date().toISOString()
  const prev = data[model][caseId]
  const entry: BaselineCaseEntry = {
    firstSeen: prev?.firstSeen ?? now,
    lastPassed:
      update.lastResult === 'pass'
        ? now
        : (prev?.lastPassed ?? null),
    lastResult: update.lastResult,
    failures: update.failures,
  }
  data[model][caseId] = entry
  return entry
}
