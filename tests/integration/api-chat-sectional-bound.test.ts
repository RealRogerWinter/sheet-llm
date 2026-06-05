// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Score } from '@/lib/music/types'
import type { OrchestratorScoreStream } from '@/lib/orchestrator/types'
import { installTestDb, TEST_USER_ID } from '../factories/testEnv'
import { creditHolds, usageLedger } from '@/lib/db/schema'
import { creditWallet, getWallet } from '@/lib/billing/wallet'
import { recordProviderCall } from '@/lib/billing/usageMeter'
import { worstCaseHoldCredits } from '@/lib/billing/valueTier'
import { policyFor } from '@/lib/orchestrator/generationTier'

/**
 * PR-7b-2c — the sectional COST-BOUND launch gate on the streamed /api/chat score
 * path. A large sectional re-sends a growing score with no call cap; without the
 * abort it could settle ABOVE the hold (overHold under-earn) or run past
 * maxDuration → reaped → free. This proves the pump STOPS pulling sections once the
 * metered cost nears the hold budget, settles the metered PARTIAL (≤ hold, never
 * overdraft), persists the partial-but-valid score, and emits an "ask to continue"
 * warning — and that a small sectional under the budget settles its full cost
 * normally.
 *
 * run() is mocked to return a score stream that records a per-section provider cost
 * BEFORE each `section` yield (mirroring real sectionalEvents, so the in-scope meter
 * reflects each section as it is delivered).
 */

vi.mock('@/lib/auth/session', () => ({
  getRequestUser: async () => ({ userId: TEST_USER_ID, authenticated: true }),
  getExistingRequestUser: async () => ({ userId: TEST_USER_ID, authenticated: true }),
}))

const VALID_MEASURE = {
  events: [
    { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
    { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
  ],
}
function makeScore(nBars: number): Score {
  return { title: 'M', key: 'C', meter: '4/4', measures: Array.from({ length: nBars }, () => VALID_MEASURE) } as Score
}

// Per-section raw cost (µUSD). 200k input tokens × $3/M = $0.60 → 150 cr at 2.5×.
// Cumulative cost-plus credits after each section: 150, 300, 450, 600, …
const cfg = vi.hoisted(() => ({
  sectionCount: 6,
  sectionInputTokens: 200_000,
  sectionOutputTokens: 0,
}))

vi.mock('@/lib/orchestrator', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/orchestrator')>()
  return {
    ...actual,
    run: async (input: { requestId: string; chatId?: string }) => {
      const events = (async function* () {
        for (let i = 0; i < cfg.sectionCount; i++) {
          // Record the section's cost BEFORE yielding it (real sectionalEvents does
          // the provider call, then yields), so the route's in-scope meter includes
          // section i by the time the abort check runs for it.
          recordProviderCall('claude-sonnet-4-6', {
            inputTokens: cfg.sectionInputTokens,
            outputTokens: cfg.sectionOutputTokens,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
          })
          yield { type: 'section', score: makeScore(i + 1), sectionIndex: i, totalSections: cfg.sectionCount, label: `S${i}` }
        }
        yield { type: 'done', score: makeScore(cfg.sectionCount), introText: 'Done.', model: 'claude-sonnet-4-6' }
      })()
      return {
        outcomeKind: 'score_stream',
        classification: { kind: 'compose', scope: 'long', complexity: 'complex', confidence: 0.95 },
        model: 'claude-sonnet-4-6',
        chatId: input.chatId,
        latencyMs: 5,
        events,
      } as unknown as OrchestratorScoreStream
    },
  }
})

const { POST } = await import('@/app/api/chat/route')

async function getDb() {
  return (await import('@/lib/db')).getDb()
}

interface Drained {
  status: number
  sectionFrames: number
  done?: Record<string, unknown>
  errorFrame?: Record<string, unknown>
}
async function postAndDrain(message: string): Promise<Drained> {
  const res = await POST(
    new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.21' },
      body: JSON.stringify({ message, debug: { orchestrator: 'on' } }),
    }),
  )
  const body = await res.text()
  const sectionFrames = (body.match(/event: section\n/g) ?? []).length
  const doneMatch = body.match(/event: done\ndata: (.*)/)
  const errMatch = body.match(/event: error\ndata: (.*)/)
  return {
    status: res.status,
    sectionFrames,
    ...(doneMatch ? { done: JSON.parse(doneMatch[1]) as Record<string, unknown> } : {}),
    ...(errMatch ? { errorFrame: JSON.parse(errMatch[1]) as Record<string, unknown> } : {}),
  }
}

describe('/api/chat sectional cost-bound (PR-7b-2c)', () => {
  installTestDb()
  beforeEach(() => {
    cfg.sectionCount = 6
    cfg.sectionInputTokens = 200_000
    cfg.sectionOutputTokens = 0
    vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-bytes!')
    vi.stubEnv('SL_PAID_GENERATION', '1')
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('ABORTS before overspending: settles the metered partial (≤ hold), persists it, warns', async () => {
    const hold = worstCaseHoldCredits(policyFor('pro').maxOutputTokens) // 491 → budget; margin 102 → threshold 389
    creditWallet({ userId: TEST_USER_ID, creditsDelta: hold, source: 'test' }) // hold = full balance = 491
    const out = await postAndDrain('compose an enormous symphony')
    expect(out.status).toBe(200)

    // 150, 300, 450 → aborts AFTER section index 2 (3 sections), before the 6 the
    // generator would have produced.
    expect(out.sectionFrames).toBe(3)

    // The `done` frame carries the partial score + the "ask to continue" warning.
    expect(out.done).toBeDefined()
    const warnings = out.done!.warnings as string[] | undefined
    expect(warnings?.some((w) => /credit budget/i.test(w))).toBe(true)
    expect((out.done!.scoreJson as Score).measures.length).toBe(3) // the partial (section 2 = 3 bars)

    // Settled the metered partial: 3 × $0.60 = $1.80 → 450 cr (≤ 491 hold, no overdraft).
    const db = await getDb()
    const ledger = db.select().from(usageLedger).all()
    expect(ledger.length).toBe(1)
    expect(ledger[0].creditsCharged).toBe(450)
    expect(ledger[0].creditsCharged).toBeLessThanOrEqual(hold) // never above the hold
    const holds = db.select().from(creditHolds).all()
    expect(holds[0].status).toBe('settled')
    expect(getWallet(TEST_USER_ID)).toEqual({ balance: hold - 450, held: 0, available: hold - 450 })
  })

  it('a SMALL sectional under the budget settles its FULL cost (no abort, all sections)', async () => {
    cfg.sectionCount = 2
    cfg.sectionInputTokens = 40_000 // $0.12 → 30 cr each; 60 cr total, far below 389
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1_000, source: 'test' })
    const out = await postAndDrain('compose a short piece')
    expect(out.status).toBe(200)
    expect(out.sectionFrames).toBe(2) // both sections + the generator's own done
    expect(out.done).toBeDefined()
    expect(out.done!.warnings).toBeUndefined() // no abort warning
    const db = await getDb()
    const ledger = db.select().from(usageLedger).all()
    // 2 × 40_000 × $3/M = $0.24 → 60 cr at 2.5×.
    expect(ledger[0].creditsCharged).toBe(60)
    expect(getWallet(TEST_USER_ID).balance).toBe(1_000 - 60)
  })

  it('DARK (flag off): no hold, no abort, no charge — the full sectional streams', async () => {
    vi.stubEnv('SL_PAID_GENERATION', '')
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1_000, source: 'test' })
    const out = await postAndDrain('compose an enormous symphony')
    expect(out.status).toBe(200)
    expect(out.sectionFrames).toBe(6) // no budget → no abort → all sections
    const db = await getDb()
    expect(db.select().from(creditHolds).all().length).toBe(0)
    expect(db.select().from(usageLedger).all().length).toBe(0)
    expect(getWallet(TEST_USER_ID).balance).toBe(1_000)
  })
})
