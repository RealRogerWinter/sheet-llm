// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Every MUTATING handler under src/app/api/auth/** must run guardAuthMutation
// (the SL_ACCOUNTS_ENABLED 404 + strict same-origin + JSON-only + CSRF front
// gate). This bans a new auth route from shipping without it. The legacy
// /api/auth/restore endpoint is exempt — it predates accounts (anonymous
// recovery, always-on) and has its own checkSameOrigin + nonce-CAS + claimed
// refusal.

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

describe('auth route guard', () => {
  it('every mutating src/app/api/auth route calls guardAuthMutation (except restore)', () => {
    const authRoot = join(process.cwd(), 'src', 'app', 'api', 'auth')
    const offenders = walk(authRoot).filter((file) => {
      if (!/route\.tsx?$/.test(file)) return false
      if (/[\\/]restore[\\/]/.test(file)) return false
      const src = readFileSync(file, 'utf8')
      const mutates = /export async function (POST|PUT|PATCH|DELETE)\b/.test(src)
      return mutates && !/guardAuthMutation\(/.test(src)
    })
    expect(offenders).toEqual([])
  })
})
