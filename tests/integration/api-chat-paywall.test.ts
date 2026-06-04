// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Score } from '@/lib/music/types'
import { installTestDb, TEST_USER_ID } from '../factories/testEnv'
import { creditHolds, usageLedger } from '@/lib/db/schema'
import { creditWallet, getWallet } from '@/lib/billing/wallet'
import { worstCaseHoldCredits } from '@/lib/billing/valueTier'
import { policyFor } from '@/lib/orchestrator/generationTier'

/**
 * PR-7b-1 — the credit paywall on the NON-STREAMING /api/chat path. Proves the
 * money behavior end-to-end through the real route: dark by default; an
 * authenticated Pro turn holds worst-case then settles to the cost-plus charge;
 * insufficient credits fail closed BEFORE dispatch; anon + free tier never touch
 * the wallet; an unreadable cost fails closed to the flat fallback; and the
 * charge is always capped at the hold.
 *
 * Identity + the orchestrator are mocked so the test is deterministic: run() is
 * replaced by a canned non-streaming OrchestratorResult that ALSO writes the
 * orchestrator_turns cost row run() normally persists (keyed by requestId), so
 * the settle reads a real metered cost.
 */

const cfg = vi.hoisted(() => ({
  userId: '00000000-0000-0000-0000-000000000001', // === TEST_USER_ID
  authenticated: true,
  kind: 'generate_complex' as string,
  costMicroUsd: 90_000 as number | null, // ~$0.09 warm generation
  runCalls: 0,
}))

vi.mock('@/lib/auth/session', () => ({
  getRequestUser: async () => ({ userId: cfg.userId, authenticated: cfg.authenticated }),
  getExistingRequestUser: async () => ({ userId: cfg.userId, authenticated: cfg.authenticated }),
}))

const VALID_SCORE: Score = {
  title: 'M',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

vi.mock('@/lib/orchestrator', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/orchestrator')>()
  return {
    ...actual,
    run: async (input: { requestId: string; chatId?: string }) => {
      cfg.runCalls++
      // Persist the orchestrator_turns row run() normally writes, so the paywall
      // settle reads a real cost_micro_usd by request_id.
      if (input.chatId) {
        const { getDb } = await import('@/lib/db')
        const { orchestratorTurns } = await import('@/lib/db/schema')
        const { randomUUID } = await import('node:crypto')
        getDb()
          .insert(orchestratorTurns)
          .values({
            id: randomUUID(),
            sessionId: input.chatId,
            requestId: input.requestId,
            createdAt: Date.now(),
            latencyMs: 5,
            finalStatus: 'ok',
            classificationKind: cfg.kind,
            handler: cfg.kind,
            handlerModel: 'claude-sonnet-4-6',
            outputTokens: 1200,
            costMicroUsd: cfg.costMicroUsd,
          })
          .run()
      }
      return {
        score: VALID_SCORE,
        classification: { kind: cfg.kind, scope: 'short', complexity: 'simple', confidence: 0.95 },
        model: 'claude-sonnet-4-6',
        latencyMs: 5,
        toolUseId: 'toolu_test',
      }
    },
  }
})

const { POST } = await import('@/app/api/chat/route')

function postChat(message: string, orchestrator: 'on' | 'off' | 'shadow' = 'on') {
  return POST(
    new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      // debug.orchestrator:'on' forces primary mode so run()'s result is served
      // via respondWithOrchestratorResult (the non-streaming settle site). In
      // NODE_ENV=test the client override is honored (isTierOverrideAllowed).
      body: JSON.stringify({ message, debug: { orchestrator } }),
    }),
  )
}

async function countRows(table: typeof creditHolds | typeof usageLedger): Promise<number> {
  const { getDb } = await import('@/lib/db')
  return getDb().select().from(table).all().length
}

describe('/api/chat credit paywall (PR-7b-1)', () => {
  installTestDb()
  beforeEach(() => {
    cfg.authenticated = true
    cfg.kind = 'generate_complex'
    cfg.costMicroUsd = 90_000
    cfg.runCalls = 0
    vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-bytes!')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('is DARK by default: flag off → never touches the wallet, generation succeeds', async () => {
    vi.stubEnv('SL_GENERATION_TIER', 'pro') // pro scope, but paywall flag is OFF
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
    const res = await postChat('compose a melody')
    expect(res.status).toBe(200)
    expect(cfg.runCalls).toBe(1)
    expect(await countRows(creditHolds)).toBe(0)
    expect(await countRows(usageLedger)).toBe(0)
    expect(getWallet(TEST_USER_ID).balance).toBe(1000) // untouched
  })

  describe('flag ON + authenticated Pro', () => {
    beforeEach(() => {
      vi.stubEnv('SL_PAID_GENERATION', '1')
      vi.stubEnv('SL_GENERATION_TIER', 'pro')
    })

    it('charges cost-plus (2.5×) for a generation and settles the hold', async () => {
      creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
      const res = await postChat('compose a melody')
      expect(res.status).toBe(200)
      // 90_000 µUSD × 2.5 / 10_000 = 22.5 → ceil → 23 credits
      expect(getWallet(TEST_USER_ID)).toEqual({ balance: 977, held: 0, available: 977 })
      const { getDb } = await import('@/lib/db')
      const ledger = getDb().select().from(usageLedger).all()
      expect(ledger.length).toBe(1)
      expect(ledger[0].creditsCharged).toBe(23)
      const holds = getDb().select().from(creditHolds).all()
      expect(holds.length).toBe(1)
      expect(holds[0].status).toBe('settled')
    })

    it('charges the gentler 1.2× markup for a deterministic edit', async () => {
      cfg.kind = 'edit_score_level'
      creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
      const res = await postChat('change the key to G major')
      expect(res.status).toBe(200)
      // 90_000 × 1.2 / 10_000 = 10.8 → ceil → 11 credits
      expect(getWallet(TEST_USER_ID).balance).toBe(1000 - 11)
    })

    it('FAIL-CLOSED: an unreadable metered cost charges the flat standard fallback (25)', async () => {
      cfg.costMicroUsd = null // NULL ≠ free
      creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
      const res = await postChat('compose a melody')
      expect(res.status).toBe(200)
      expect(getWallet(TEST_USER_ID).balance).toBe(1000 - 25)
    })

    it('SECURITY: a paid request that would hit the uncharged legacy path is REFUSED, not served free', async () => {
      // mode=off routes around the orchestrator to the legacy single-shot path,
      // which PR-7b-1 does not charge. A paid Pro user must NOT get a free
      // generation there (the debug.orchestrator='off' bypass the security review
      // flagged). Expect a refusal + the hold released + no charge + no dispatch.
      creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
      const res = await postChat('compose a melody', 'off')
      expect(res.status).toBe(422)
      const data = await res.json()
      expect(data.code).toBe('refused')
      expect(cfg.runCalls).toBe(0)
      expect(getWallet(TEST_USER_ID).balance).toBe(1000) // not charged
      expect(getWallet(TEST_USER_ID).held).toBe(0) // hold released, not stranded
      expect(await countRows(usageLedger)).toBe(0)
      const { getDb } = await import('@/lib/db')
      const holds = getDb().select().from(creditHolds).all()
      expect(holds.length).toBe(1)
      expect(holds[0].status).toBe('released')
    })

    it('insufficient credits → 402 insufficient_credits and NEVER dispatches', async () => {
      // wallet has 0 (no funding) → the worst-case hold fails closed
      const res = await postChat('compose a melody')
      expect(res.status).toBe(402)
      const data = await res.json()
      expect(data.code).toBe('insufficient_credits')
      expect(cfg.runCalls).toBe(0) // dispatch never happened — fail-closed before run
      expect(await countRows(usageLedger)).toBe(0)
    })

    it('charge is CAPPED at the hold (creditsCharged ≤ hold) even on an absurd cost', async () => {
      cfg.costMicroUsd = 999_999_999 // would settle far above the reservation
      creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
      const res = await postChat('compose a melody')
      expect(res.status).toBe(200)
      const hold = worstCaseHoldCredits(policyFor('pro').maxOutputTokens)
      const { getDb } = await import('@/lib/db')
      const ledger = getDb().select().from(usageLedger).all()
      expect(ledger[0].creditsCharged).toBe(hold) // capped at the hold, never overdrafts
      expect(getWallet(TEST_USER_ID).balance).toBe(1000 - hold)
      expect(getWallet(TEST_USER_ID).balance).toBeGreaterThanOrEqual(0)
    })
  })

  describe('free tier + anon stay OFF the money path', () => {
    it('anonymous (authenticated:false) is never charged even with the flag on', async () => {
      cfg.authenticated = false
      vi.stubEnv('SL_PAID_GENERATION', '1')
      vi.stubEnv('SL_GENERATION_TIER', 'pro')
      const res = await postChat('compose a melody')
      expect(res.status).toBe(200)
      expect(await countRows(creditHolds)).toBe(0)
      expect(await countRows(usageLedger)).toBe(0)
    })

    it('free generationTier is never charged even when authenticated with the flag on', async () => {
      vi.stubEnv('SL_PAID_GENERATION', '1')
      vi.stubEnv('SL_GENERATION_TIER', 'free')
      creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
      const res = await postChat('compose a melody')
      expect(res.status).toBe(200)
      expect(await countRows(creditHolds)).toBe(0)
      expect(getWallet(TEST_USER_ID).balance).toBe(1000) // untouched
    })
  })
})
