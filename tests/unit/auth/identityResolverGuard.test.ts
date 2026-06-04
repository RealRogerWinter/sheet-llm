// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Guard: route handlers must resolve identity ONLY through getRequestUser /
// getExistingRequestUser (which enforce the sl_sess-first + claimed-sl_uid
// refusal). A direct getOrCreateUserId/getExistingUserId import would bypass the
// claimed-account downgrade — the second half of the recovery-takeover fix.

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

describe('identity resolver guard', () => {
  it('no src/ file outside session.ts references the un-claim-gated getOrCreateUserId/getExistingUserId', () => {
    // Broad scan (not just routes): a src/lib or server-component caller of the
    // legacy resolvers would silently reopen the claimed-account downgrade that
    // getRequestUser/getExistingRequestUser enforce.
    const srcRoot = join(process.cwd(), 'src')
    const defFile = join(srcRoot, 'lib', 'auth', 'session.ts')
    const offenders = walk(srcRoot)
      .filter((f) => f !== defFile)
      .filter((file) =>
        /\bgetOrCreateUserId\b|\bgetExistingUserId\b/.test(readFileSync(file, 'utf8')),
      )
    expect(offenders).toEqual([])
  })
})
