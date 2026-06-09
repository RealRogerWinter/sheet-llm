/**
 * SHE-15 model-matrix lib: aggregate per-case live-eval results across
 * candidate models, compute per-case parity vs a baseline, render a
 * cost×reliability report, and bound total spend.
 *
 * Pure + dependency-free so it's unit-testable. The driver
 * (`scripts/she15-eval-matrix.ts`) feeds it the JSONL each run writes
 * via `SL_EVAL_RESULTS_FILE` (see `evals/lib/buildLiveCase.ts`).
 */

/** One case's outcome, as emitted by buildLiveCase's results sink. */
export interface MatrixCaseResult {
  /** Effective model id the orchestrator reported (null if unknown). */
  model: string | null
  caseId: string
  /** PASS | FAIL | REGRESSION | SOFT_FAIL | NO_SCORE | INFRA */
  status: string
  /** True iff the case met its invariants (status === 'PASS'). */
  pass: boolean
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  estimatedCostUsd: number
  latencyMs?: number
  attempts?: number
}

export function parseResultsJsonl(text: string): MatrixCaseResult[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as MatrixCaseResult)
}

export interface ModelRunSummary {
  /** Human label, e.g. "groq:llama-3.1-8b-instant". */
  label: string
  /** Effective model id (from the first result that carries one). */
  model: string | null
  /** caseId → result. */
  cases: Map<string, MatrixCaseResult>
  passCount: number
  total: number
  infraCount: number
  totalCostUsd: number
  medianLatencyMs: number | null
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

export function summarizeRun(label: string, results: MatrixCaseResult[]): ModelRunSummary {
  const cases = new Map<string, MatrixCaseResult>()
  for (const r of results) cases.set(r.caseId, r)
  const latencies = results
    .map((r) => r.latencyMs)
    .filter((n): n is number => typeof n === 'number')
  return {
    label,
    model: results.find((r) => r.model)?.model ?? null,
    cases,
    passCount: results.filter((r) => r.pass).length,
    total: results.length,
    infraCount: results.filter((r) => r.status === 'INFRA').length,
    totalCostUsd: results.reduce((sum, r) => sum + (r.estimatedCostUsd || 0), 0),
    medianLatencyMs: median(latencies),
  }
}

export interface ParityRow {
  label: string
  model: string | null
  passCount: number
  total: number
  /** Cases that errored out (provider 5xx / rate-limit) — excluded from parity. */
  infraCount: number
  /** Of the baseline-passing cases, how many this model also passes. */
  parityPassCount: number
  /** Baseline-passing cases this model FAILS (the parity-breakers). */
  regressions: string[]
  /** Cases this model passes that the baseline failed. */
  gains: string[]
  /** True iff there are no regressions (holds every baseline-pass case). */
  meetsParity: boolean
  totalCostUsd: number
  costPerCaseUsd: number
  medianLatencyMs: number | null
}

export interface ParityReport {
  baselineLabel: string
  baselinePassCases: Set<string>
  rows: ParityRow[]
}

export function buildParityReport(
  baseline: ModelRunSummary,
  candidates: ModelRunSummary[],
): ParityReport {
  const baselinePassCases = new Set<string>()
  for (const [id, r] of baseline.cases) if (r.pass) baselinePassCases.add(id)

  const rows = candidates.map((c): ParityRow => {
    const regressions: string[] = []
    for (const id of baselinePassCases) {
      const cc = c.cases.get(id)
      // An INFRA result (provider 5xx / rate-limit exhausting retries) is no
      // signal about the model — don't count an infra flake as a regression.
      if (cc?.status === 'INFRA') continue
      if (!cc?.pass) regressions.push(id)
    }
    const gains: string[] = []
    for (const [id, r] of c.cases) {
      if (r.pass && !baselinePassCases.has(id)) gains.push(id)
    }
    regressions.sort()
    gains.sort()
    return {
      label: c.label,
      model: c.model,
      passCount: c.passCount,
      total: c.total,
      infraCount: c.infraCount,
      parityPassCount: baselinePassCases.size - regressions.length,
      regressions,
      gains,
      meetsParity: regressions.length === 0,
      totalCostUsd: c.totalCostUsd,
      costPerCaseUsd: c.total > 0 ? c.totalCostUsd / c.total : 0,
      medianLatencyMs: c.medianLatencyMs,
    }
  })

  return { baselineLabel: baseline.label, baselinePassCases, rows }
}

function usd(n: number): string {
  return '$' + n.toFixed(4)
}

export function renderMarkdown(report: ParityReport, baseline: ModelRunSummary): string {
  const lines: string[] = []
  lines.push(`# SHE-15 — cost × reliability (per-case parity vs ${baseline.label})`)
  lines.push('')
  lines.push(
    `Baseline **${baseline.label}** (${baseline.model ?? '—'}): ${baseline.passCount}/${baseline.total} cases pass, ${usd(baseline.totalCostUsd)} total, median ${baseline.medianLatencyMs ?? '—'}ms.`,
  )
  lines.push('')
  lines.push('| Model | Pass | Parity (of baseline-pass) | Regressions | Gains | $/case | Total $ | Median ms | Verdict |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  // Baseline row for reference.
  lines.push(
    `| ${baseline.label} (${baseline.model ?? '—'}) | ${baseline.passCount}/${baseline.total} | — | — | — | ${usd(baseline.totalCostUsd / Math.max(1, baseline.total))} | ${usd(baseline.totalCostUsd)} | ${baseline.medianLatencyMs ?? '—'} | baseline |`,
  )
  for (const r of report.rows) {
    const infra = r.infraCount > 0 ? ` (${r.infraCount} infra)` : ''
    const verdict = (r.meetsParity ? '✅ meets parity' : `❌ ${r.regressions.length} regression(s)`) + infra
    lines.push(
      `| ${r.label} (${r.model ?? '—'}) | ${r.passCount}/${r.total} | ${r.parityPassCount}/${report.baselinePassCases.size} | ${r.regressions.join(', ') || '—'} | ${r.gains.join(', ') || '—'} | ${usd(r.costPerCaseUsd)} | ${usd(r.totalCostUsd)} | ${r.medianLatencyMs ?? '—'} | ${verdict} |`,
    )
  }
  lines.push('')
  const cheapestParity = report.rows
    .filter((r) => r.meetsParity)
    .sort((a, b) => a.costPerCaseUsd - b.costPerCaseUsd)[0]
  lines.push(
    cheapestParity
      ? `**Recommendation:** cheapest model meeting per-case parity = **${cheapestParity.label}** (${cheapestParity.model ?? '—'}) at ${usd(cheapestParity.costPerCaseUsd)}/case.`
      : `**Recommendation:** no candidate met per-case parity with ${baseline.label}. See regressions per row.`,
  )
  lines.push('')
  lines.push(
    '_Cost is the per-case handler-call estimate (a floor — it excludes the classifier/dispatcher round-trips, which are metered separately); the relative comparison across models is preserved. INFRA cases (provider errors) are excluded from the parity verdict._',
  )
  return lines.join('\n')
}

/**
 * Hard spend ceiling for the experiment. Refuses to start a run whose
 * estimate would push cumulative spend past the cap. `record()` the
 * ACTUAL cost after each run so the next pre-flight uses real spend.
 */
export class SpendGuard {
  private spent = 0
  constructor(private readonly capUsd: number) {}
  get spentUsd(): number {
    return this.spent
  }
  remainingUsd(): number {
    return Math.max(0, this.capUsd - this.spent)
  }
  /** True if adding `estimateUsd` would exceed the cap (== cap is allowed). */
  wouldExceed(estimateUsd: number): boolean {
    return this.spent + estimateUsd > this.capUsd + 1e-9
  }
  record(actualUsd: number): void {
    this.spent += Math.max(0, actualUsd)
  }
}
