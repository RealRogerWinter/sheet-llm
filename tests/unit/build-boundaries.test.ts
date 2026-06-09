// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { ESLint } from 'eslint'

// SHE-8 — the OSS↔SaaS build-graph boundary is enforced two ways: the
// authoritative dependency-cruiser graph check (.dependency-cruiser.cjs) and the
// fast ESLint no-restricted-imports mirror. This test pins BOTH, and — critically
// — guards against a vacuous rule (a glob that matched nothing is green-and-useless).

const ROOT = resolve(__dirname, '../..')

function runDepcruise(): { summary: Record<string, unknown> & { totalCruised: number; error: number; ruleSetUsed?: { forbidden?: { name: string }[] }; violations?: { rule?: { name: string }; from: string; to: string }[] } } {
  try {
    const out = execFileSync(
      'node_modules/.bin/depcruise',
      ['src/lib', '--config', '.dependency-cruiser.cjs', '--output-type', 'json'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    return JSON.parse(out)
  } catch (e) {
    // depcruise exits non-zero when violations exist — the JSON report is still
    // on stdout, so parse it and let the assertions surface the violations.
    const stdout = (e as { stdout?: Buffer | string }).stdout
    if (stdout) return JSON.parse(stdout.toString())
    throw e
  }
}

describe('SHE-8 build-graph boundary', () => {
  it('dependency-cruiser: no core→billing/auth, rule active, graph non-empty', () => {
    const { summary } = runDepcruise()
    // The rule must be ACTIVE (guards against a typo'd/renamed config silently
    // disabling enforcement).
    const rule = (summary.ruleSetUsed?.forbidden ?? []).find((r) => r.name === 'no-billing-auth-from-core')
    expect(rule, 'no-billing-auth-from-core must be in the active ruleset').toBeTruthy()
    // The source globs must scan a NON-EMPTY graph (guards against a vacuous path
    // glob that matches nothing — green but useless).
    expect(summary.totalCruised).toBeGreaterThan(0)
    // Zero violations of the boundary.
    const boundary = (summary.violations ?? []).filter((v) => v.rule?.name === 'no-billing-auth-from-core')
    expect(boundary, JSON.stringify(boundary, null, 2)).toEqual([])
    expect(summary.error).toBe(0)
  }, 60_000)

  it('ESLint mirror: denies @/lib/billing|auth from core, allows @/lib/metering|http', async () => {
    const eslint = new ESLint({ cwd: ROOT })
    const fixture = resolve(ROOT, 'src/lib/orchestrator/__boundary_fixture__.ts')

    async function ruleHits(specifier: string): Promise<boolean> {
      const [res] = await eslint.lintText(`import '${specifier}'\nexport const _ = 1\n`, { filePath: fixture })
      return res.messages.some((m) => m.ruleId === 'no-restricted-imports')
    }

    expect(await ruleHits('@/lib/billing/usageMeter')).toBe(true)
    expect(await ruleHits('@/lib/auth/account')).toBe(true)
    expect(await ruleHits('@/lib/metering/usageMeter')).toBe(false)
    expect(await ruleHits('@/lib/http/clientIp')).toBe(false)
  }, 60_000)
})
