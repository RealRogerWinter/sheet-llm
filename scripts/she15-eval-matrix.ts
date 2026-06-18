/**
 * SHE-15 model-matrix driver.
 *
 * Runs the live eval suite once per candidate model (Sonnet 4.6 baseline +
 * cheapest-first Groq models + Anthropic Haiku), routing the WHOLE orchestrator to each via
 * PROVIDER_* env + a pinned `SL_EVAL_MODEL_OVERRIDE`, captures per-case
 * results through `SL_EVAL_RESULTS_FILE`, enforces a hard spend cap, and
 * writes a cost x reliability report (per-case parity vs the baseline).
 *
 * Usage:
 *   pnpm she15:matrix -- --dry-run            # print the plan + estimates, spend nothing
 *   pnpm she15:matrix                         # run baseline + cheapest-first trio
 *   pnpm she15:matrix -- --models=baseline,groq:llama-3.1-8b-instant
 *   pnpm she15:matrix -- --full --cap=12      # include expensive cases; $12 hard cap
 *
 * Requires ANTHROPIC_API_KEY (baseline + Haiku) and GROQ_API_KEY (Groq rows) in env.
 * NEVER spends without a real run; --dry-run is always safe.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  parseResultsJsonl,
  summarizeRun,
  buildParityReport,
  renderMarkdown,
  SpendGuard,
  type ModelRunSummary,
} from '../evals/lib/matrix'

interface Candidate {
  label: string
  /** Provider/model env applied on top of the base run env. */
  env: Record<string, string>
  /** Conservative per-case USD estimate for the pre-run spend guard. */
  estPerCaseUsd: number
  isBaseline?: boolean
  /** Included when --models is not passed (the standard sweep). */
  defaultSweep?: boolean
}

const GROQ_ENV = (model: string): Record<string, string> => ({
  PROVIDER_SMALL: 'groq',
  PROVIDER_MEDIUM: 'groq',
  PROVIDER_LARGE: 'groq',
  PROVIDER_FALLBACK: 'groq', // isolate Groq — no silent Anthropic rescue
  SL_EVAL_MODEL_OVERRIDE: model,
})

// Route the WHOLE stack to Anthropic and pin a specific Anthropic model id
// (e.g. Haiku) across tiers. Used to measure a cheaper Anthropic model on the
// exact same harness as the Sonnet baseline. The model instance is chosen by
// PROVIDER_<TIER>=anthropic; SL_EVAL_MODEL_OVERRIDE pins the id the handler uses.
const ANTHROPIC_ENV = (model: string): Record<string, string> => ({
  PROVIDER_SMALL: 'anthropic',
  PROVIDER_MEDIUM: 'anthropic',
  PROVIDER_LARGE: 'anthropic',
  PROVIDER_FALLBACK: 'anthropic',
  SL_EVAL_MODEL_OVERRIDE: model,
})

// Cheapest-first (SHE-15 locked decision) + Haiku (per Roger's eval request).
// gpt-oss-120b / llama-3.3-70b are rungs-up if the default sweep fails
// (add to --models explicitly).
const ALL_CANDIDATES: Candidate[] = [
  { label: 'baseline', env: {}, estPerCaseUsd: 0.05, isBaseline: true, defaultSweep: true },
  { label: 'groq:llama-3.1-8b-instant', env: GROQ_ENV('llama-3.1-8b-instant'), estPerCaseUsd: 0.015, defaultSweep: true },
  { label: 'groq:openai/gpt-oss-20b', env: GROQ_ENV('openai/gpt-oss-20b'), estPerCaseUsd: 0.015, defaultSweep: true },
  { label: 'groq:qwen/qwen3-32b', env: GROQ_ENV('qwen/qwen3-32b'), estPerCaseUsd: 0.015, defaultSweep: true },
  { label: 'anthropic:claude-haiku-4-5', env: ANTHROPIC_ENV('claude-haiku-4-5-20251001'), estPerCaseUsd: 0.02, defaultSweep: true },
  { label: 'groq:openai/gpt-oss-120b', env: GROQ_ENV('openai/gpt-oss-120b'), estPerCaseUsd: 0.02 },
  { label: 'groq:llama-3.3-70b-versatile', env: GROQ_ENV('llama-3.3-70b-versatile'), estPerCaseUsd: 0.03 },
]

function parseArgs(argv: string[]) {
  const args = { dryRun: false, full: false, cap: 12, models: '' }
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--full') args.full = true
    else if (a.startsWith('--cap=')) {
      const n = Number(a.slice('--cap='.length))
      if (Number.isFinite(n) && n >= 0) args.cap = n // ignore NaN/negative; keep the safe default
    }
    else if (a.startsWith('--models=')) args.models = a.slice('--models='.length)
  }
  return args
}

function sanitize(label: string): string {
  return label.replace(/[^a-z0-9._-]/gi, '_')
}

function main(): number {
  const args = parseArgs(process.argv.slice(2))
  const root = path.resolve(__dirname, '..')
  const resultsDir = path.join(root, 'evals', 'results')
  mkdirSync(resultsDir, { recursive: true })

  // Pre-flight ESTIMATE only (the real guard uses post-run actual cost). ~22
  // *.live.eval.ts exist (generation + editing), 2 marked expensive; --full
  // runs all, else the non-expensive ~20.
  const numCases = args.full ? 22 : 20

  const want = new Set(args.models.split(',').map((s) => s.trim()).filter(Boolean))
  // Default sweep: baseline + cheapest-first Groq trio + Haiku (not the rungs-up).
  const selected = args.models
    ? ALL_CANDIDATES.filter((c) => want.has(c.label))
    : ALL_CANDIDATES.filter((c) => c.defaultSweep)

  const guard = new SpendGuard(args.cap)
  console.log(`\nSHE-15 model matrix — cap $${args.cap}, ${numCases} cases/run, ${selected.length} configs`)
  console.log('Plan:')
  for (const c of selected) {
    console.log(
      `  - ${c.label.padEnd(32)} est ~$${(c.estPerCaseUsd * numCases).toFixed(3)} ` +
        `(${c.env.SL_EVAL_MODEL_OVERRIDE ?? 'anthropic default'})`,
    )
  }
  const totalEst = selected.reduce((s, c) => s + c.estPerCaseUsd * numCases, 0)
  console.log(`  total conservative estimate ~$${totalEst.toFixed(3)} (cap $${args.cap})\n`)

  if (args.dryRun) {
    console.log('[dry-run] no eval spawned, no spend. Re-run without --dry-run to execute.')
    return 0
  }

  if (selected.length === 0) {
    console.error('ERROR: --models matched no known configs. Known: ' + ALL_CANDIDATES.map((c) => c.label).join(', '))
    return 2
  }
  if (!selected.some((c) => c.isBaseline)) {
    console.error('ERROR: selection has no baseline; per-case parity requires it. Add "baseline" to --models.')
    return 2
  }

  // Pre-flight key checks, keyed off each candidate's actual provider routing
  // (not just baseline-vs-not) so an Anthropic-routed Haiku row requires the
  // Anthropic key, and a baseline+Haiku-only selection needs no Groq key.
  const needsAnthropic = selected.some(
    (c) => c.isBaseline || c.env.PROVIDER_MEDIUM === 'anthropic',
  )
  const needsGroq = selected.some((c) => c.env.PROVIDER_MEDIUM === 'groq')
  if (needsAnthropic && !process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: baseline selected but ANTHROPIC_API_KEY is not set.')
    return 2
  }
  if (needsGroq && !process.env.GROQ_API_KEY) {
    console.error('ERROR: Groq candidates selected but GROQ_API_KEY is not set.')
    return 2
  }

  const baselineResults: ModelRunSummary[] = []
  const candidateResults: ModelRunSummary[] = []

  for (const c of selected) {
    const preEst = c.estPerCaseUsd * numCases
    if (guard.wouldExceed(preEst)) {
      console.error(
        `\n*** SPEND GUARD: stopping before "${c.label}". ` +
          `Spent ~$${guard.spentUsd.toFixed(4)}, this run est ~$${preEst.toFixed(3)}, ` +
          `cap $${args.cap}. Remaining ~$${guard.remainingUsd().toFixed(4)}. ***`,
      )
      break
    }

    const resultsFile = path.join(resultsDir, `${sanitize(c.label)}.jsonl`)
    rmSync(resultsFile, { force: true }) // fresh per run

    const runEnv: NodeJS.ProcessEnv = {
      ...process.env,
      RUN_LIVE_EVALS: '1',
      ...(args.full ? { RUN_LIVE_FULL: '1' } : {}),
      SL_EVAL_RESULTS_FILE: resultsFile,
      ...c.env,
    }

    console.log(`\n=== running ${c.label} (pre-run spent ~$${guard.spentUsd.toFixed(4)}) ===`)
    const r = spawnSync('pnpm', ['exec', 'vitest', 'run', '-c', 'vitest.evals.live.config.ts'], {
      cwd: root,
      env: runEnv,
      stdio: 'inherit',
    })

    const results = existsSync(resultsFile) ? parseResultsJsonl(readFileSync(resultsFile, 'utf8')) : []
    const summary = summarizeRun(c.label, results)
    guard.record(summary.totalCostUsd)
    console.log(
      `  ${c.label}: ${summary.passCount}/${summary.total} pass, $${summary.totalCostUsd.toFixed(4)}, ` +
        `vitest exit=${r.status}. Cumulative spend ~$${guard.spentUsd.toFixed(4)}.`,
    )
    if (c.isBaseline) baselineResults.push(summary)
    else candidateResults.push(summary)
  }

  if (baselineResults.length === 0) {
    console.error('\nNo baseline run captured — cannot compute per-case parity. Report skipped.')
    return 1
  }

  const report = buildParityReport(baselineResults[0], candidateResults)
  const md = renderMarkdown(report, baselineResults[0])
  const mdPath = path.join(resultsDir, 'she15-report.md')
  const jsonPath = path.join(resultsDir, 'she15-report.json')
  writeFileSync(mdPath, md + '\n')
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        baseline: baselineResults[0].label,
        spentUsd: guard.spentUsd,
        rows: report.rows,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`\nReport written:\n  ${mdPath}\n  ${jsonPath}\n`)
  console.log(md)
  return 0
}

process.exit(main())
