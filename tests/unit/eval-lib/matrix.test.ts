import { describe, it, expect } from 'vitest'
import {
  parseResultsJsonl,
  summarizeRun,
  buildParityReport,
  renderMarkdown,
  SpendGuard,
  type MatrixCaseResult,
} from '../../../evals/lib/matrix'

function rec(p: Partial<MatrixCaseResult> & { caseId: string; pass: boolean }): MatrixCaseResult {
  return {
    model: 'm',
    status: p.pass ? 'PASS' : 'FAIL',
    estimatedCostUsd: 0,
    ...p,
  }
}

describe('eval matrix lib (SHE-15)', () => {
  it('parseResultsJsonl parses lines and skips blanks', () => {
    const text = `${JSON.stringify(rec({ caseId: 'a', pass: true }))}\n\n${JSON.stringify(rec({ caseId: 'b', pass: false }))}\n`
    const out = parseResultsJsonl(text)
    expect(out).toHaveLength(2)
    expect(out[0].caseId).toBe('a')
    expect(out[1].pass).toBe(false)
  })

  it('summarizeRun counts pass/infra/cost and median latency', () => {
    const results: MatrixCaseResult[] = [
      rec({ caseId: 'a', pass: true, estimatedCostUsd: 0.01, latencyMs: 100 }),
      rec({ caseId: 'b', pass: false, estimatedCostUsd: 0.02, latencyMs: 300 }),
      { caseId: 'c', pass: false, status: 'INFRA', model: 'm', estimatedCostUsd: 0, latencyMs: 200 },
    ]
    const s = summarizeRun('groq:m', results)
    expect(s.passCount).toBe(1)
    expect(s.total).toBe(3)
    expect(s.infraCount).toBe(1)
    expect(s.totalCostUsd).toBeCloseTo(0.03, 6)
    expect(s.medianLatencyMs).toBe(200)
  })

  it('buildParityReport flags regressions vs baseline-passing cases', () => {
    const baseline = summarizeRun('anthropic:sonnet', [
      rec({ caseId: 'a', pass: true }),
      rec({ caseId: 'b', pass: true }),
      rec({ caseId: 'c', pass: false }),
    ])
    const cand = summarizeRun('groq:cheap', [
      rec({ caseId: 'a', pass: true }), // holds
      rec({ caseId: 'b', pass: false }), // regression (baseline passed)
      rec({ caseId: 'c', pass: true }), // gain (baseline failed)
    ])
    const report = buildParityReport(baseline, [cand])
    expect(report.baselinePassCases).toEqual(new Set(['a', 'b']))
    const row = report.rows[0]
    expect(row.regressions).toEqual(['b'])
    expect(row.gains).toEqual(['c'])
    expect(row.meetsParity).toBe(false)
    expect(row.parityPassCount).toBe(1) // of {a,b}, only a holds
  })

  it('buildParityReport: a model that holds every baseline-pass case meets parity', () => {
    const baseline = summarizeRun('anthropic:sonnet', [
      rec({ caseId: 'a', pass: true }),
      rec({ caseId: 'b', pass: false }),
    ])
    const cand = summarizeRun('groq:ok', [
      rec({ caseId: 'a', pass: true }),
      rec({ caseId: 'b', pass: false }),
    ])
    const report = buildParityReport(baseline, [cand])
    expect(report.rows[0].meetsParity).toBe(true)
    expect(report.rows[0].regressions).toEqual([])
  })

  it('does not count a candidate INFRA flake on a baseline-pass case as a regression', () => {
    const baseline = summarizeRun('anthropic:sonnet', [
      rec({ caseId: 'a', pass: true }),
      rec({ caseId: 'b', pass: true }),
    ])
    const cand = summarizeRun('groq:flaky', [
      rec({ caseId: 'a', pass: true }),
      { caseId: 'b', pass: false, status: 'INFRA', model: 'm', estimatedCostUsd: 0 },
    ])
    const report = buildParityReport(baseline, [cand])
    expect(report.rows[0].regressions).toEqual([]) // 'b' was infra, not a model regression
    expect(report.rows[0].meetsParity).toBe(true)
    expect(report.rows[0].infraCount).toBe(1)
  })

  it('renderMarkdown includes each model, a parity verdict, and cost', () => {
    const baseline = summarizeRun('anthropic:claude-sonnet-4-6', [rec({ caseId: 'a', pass: true, estimatedCostUsd: 0.03 })])
    const cand = summarizeRun('groq:llama-3.1-8b-instant', [rec({ caseId: 'a', pass: true, estimatedCostUsd: 0.001 })])
    const md = renderMarkdown(buildParityReport(baseline, [cand]), baseline)
    expect(md).toContain('claude-sonnet-4-6')
    expect(md).toContain('llama-3.1-8b-instant')
    expect(md).toMatch(/parity/i)
    expect(md).toContain('$')
  })

  describe('SpendGuard', () => {
    it('tracks spend and refuses a run that would exceed the cap', () => {
      const g = new SpendGuard(12)
      expect(g.wouldExceed(5)).toBe(false)
      g.record(5)
      expect(g.spentUsd).toBe(5)
      expect(g.remainingUsd()).toBe(7)
      expect(g.wouldExceed(7)).toBe(false) // exactly at cap is allowed
      expect(g.wouldExceed(7.01)).toBe(true)
      g.record(7)
      expect(g.remainingUsd()).toBe(0)
      expect(g.wouldExceed(0.01)).toBe(true)
    })
  })
})
