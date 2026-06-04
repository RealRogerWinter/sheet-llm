// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Score } from '@/lib/music/types'
import type {
  OrchestratorConverseStream,
  OrchestratorScoreStream,
} from '@/lib/orchestrator/types'
import { installTestDb, TEST_USER_ID } from '../factories/testEnv'
import { creditHolds, usageLedger } from '@/lib/db/schema'
import { creditWallet, getWallet } from '@/lib/billing/wallet'
import { recordProviderCall } from '@/lib/billing/usageMeter'

/**
 * PR-7b-2 — the credit paywall on the STREAMING /api/chat paths (converse +
 * sectional score). A streamed Pro turn settles at `done`/message-stop off the
 * request-scoped METER (the streamed cost captured by the pump), and RELEASES
 * the hold on a pre-done error (our failure → free). The pump runs to completion
 * even on client disconnect (no AbortSignal propagation), so settle-at-done is
 * the single charge site.
 *
 * run() is mocked to return a stream outcome whose async-generator `events` are
 * canned and call recordProviderCall (inside the route's pump meter scope, like
 * a real provider call) so the settle reads a real cost. The mock writes NO
 * orchestrator_turns row, proving the settle reads the in-memory METER (not the
 * row) — robust even if the turn row or its best-effort cost-backfill is absent
 * or silently fails in prod.
 */

const cfg = vi.hoisted(() => ({
  scenario: 'converse_done' as
    | 'converse_done'
    | 'converse_error'
    | 'score_done'
    | 'score_error',
  // The streamed provider usage the generator records into the pump meter; null
  // → record nothing (meter empty → settle hits the fail-closed flat fallback).
  meterUsage: { inputTokens: 10_000, outputTokens: 2_000 } as
    | { inputTokens: number; outputTokens: number }
    | null,
}))

vi.mock('@/lib/auth/session', () => ({
  getRequestUser: async () => ({ userId: TEST_USER_ID, authenticated: true }),
  getExistingRequestUser: async () => ({ userId: TEST_USER_ID, authenticated: true }),
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

function recordStreamedCost(): void {
  if (!cfg.meterUsage) return
  recordProviderCall('claude-sonnet-4-6', {
    inputTokens: cfg.meterUsage.inputTokens,
    outputTokens: cfg.meterUsage.outputTokens,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
  })
}

vi.mock('@/lib/orchestrator', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/orchestrator')>()
  return {
    ...actual,
    run: async (input: { requestId: string; chatId?: string }) => {
      const classification = {
        kind: cfg.scenario.startsWith('converse') ? ('converse' as const) : ('compose' as const),
        scope: 'short' as const,
        complexity: 'simple' as const,
        confidence: 0.95,
      }
      if (cfg.scenario.startsWith('converse')) {
        const events = (async function* () {
          yield { type: 'text-delta', delta: 'Hello' }
          if (cfg.scenario === 'converse_error') {
            yield { type: 'error', error: new Error('upstream boom') }
            return
          }
          recordStreamedCost() // fires inside the route's pump meter scope
          yield { type: 'message-stop', usage: { inputTokens: 1000, outputTokens: 200 }, stopReason: 'end_turn' }
        })()
        return {
          outcomeKind: 'converse_stream',
          classification,
          model: 'claude-sonnet-4-6',
          chatId: input.chatId,
          latencyMs: 5,
          events,
        } as unknown as OrchestratorConverseStream
      }
      const events = (async function* () {
        yield { type: 'section', score: VALID_SCORE, sectionIndex: 0, totalSections: 1, label: 'A' }
        if (cfg.scenario === 'score_error') {
          yield { type: 'error', error: new Error('seed truncated') }
          return
        }
        recordStreamedCost()
        yield { type: 'done', score: VALID_SCORE, introText: 'Done.', model: 'claude-sonnet-4-6', toolUseId: 'toolu_test' }
      })()
      return {
        outcomeKind: 'score_stream',
        classification,
        model: 'claude-sonnet-4-6',
        chatId: input.chatId,
        latencyMs: 5,
        events,
      } as unknown as OrchestratorScoreStream
    },
  }
})

const { POST } = await import('@/app/api/chat/route')

// Drive the SSE pump to completion by reading the whole response body.
async function postStream(message: string): Promise<{ status: number; body: string }> {
  const res = await POST(
    new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.11' },
      body: JSON.stringify({ message, debug: { orchestrator: 'on' } }),
    }),
  )
  const body = await res.text() // consuming the stream runs start() → pump → settle/release
  return { status: res.status, body }
}

async function holdRows() {
  const { getDb } = await import('@/lib/db')
  return getDb().select().from(creditHolds).all()
}
async function ledgerRows() {
  const { getDb } = await import('@/lib/db')
  return getDb().select().from(usageLedger).all()
}

describe('/api/chat streaming credit paywall (PR-7b-2)', () => {
  installTestDb()
  beforeEach(() => {
    cfg.scenario = 'converse_done'
    cfg.meterUsage = { inputTokens: 10_000, outputTokens: 2_000 }
    vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-bytes!')
    vi.stubEnv('SL_PAID_GENERATION', '1')
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('converse stream: settles at message-stop off the metered (pump) cost', async () => {
    cfg.scenario = 'converse_done'
    // (10000×3 + 2000×15)/1e6 = $0.06 = 60_000 µUSD; ×2.5 / 10_000 = 15 credits
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
    const { status } = await postStream('what is a tritone?')
    expect(status).toBe(200)
    expect(getWallet(TEST_USER_ID)).toEqual({ balance: 985, held: 0, available: 985 })
    const ledger = await ledgerRows()
    expect(ledger.length).toBe(1)
    expect(ledger[0].creditsCharged).toBe(15)
    expect((await holdRows())[0].status).toBe('settled')
  })

  it('score (sectional) stream: settles at done off the metered (pump) cost — even with NO turn row', async () => {
    cfg.scenario = 'score_done'
    cfg.meterUsage = { inputTokens: 40_000, outputTokens: 8_000 } // $0.24 → 60 credits
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
    const { status } = await postStream('compose a 16-bar piece')
    expect(status).toBe(200)
    expect(getWallet(TEST_USER_ID).balance).toBe(940)
    expect((await ledgerRows())[0].creditsCharged).toBe(60)
    expect((await holdRows())[0].status).toBe('settled')
  })

  it('converse stream ERROR before done: hold released, NOT charged (our failure)', async () => {
    cfg.scenario = 'converse_error'
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
    const { status } = await postStream('what is a tritone?')
    expect(status).toBe(200) // SSE opened; the error is an in-stream frame
    expect(getWallet(TEST_USER_ID)).toEqual({ balance: 1000, held: 0, available: 1000 })
    expect((await ledgerRows()).length).toBe(0)
    expect((await holdRows())[0].status).toBe('released')
  })

  it('score stream ERROR before done: hold released, NOT charged (our failure)', async () => {
    cfg.scenario = 'score_error'
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
    const { status } = await postStream('compose a 16-bar piece')
    expect(status).toBe(200)
    expect(getWallet(TEST_USER_ID).balance).toBe(1000)
    expect((await ledgerRows()).length).toBe(0)
    expect((await holdRows())[0].status).toBe('released')
  })

  it('FAIL-CLOSED: a streamed turn with NO metered cost at done charges the flat fallback', async () => {
    cfg.scenario = 'score_done'
    cfg.meterUsage = null // pump records nothing → meter empty → fallback (standard 25)
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
    const { status } = await postStream('compose a 16-bar piece')
    expect(status).toBe(200)
    expect(getWallet(TEST_USER_ID).balance).toBe(975) // 1000 - 25 standard fallback
  })

  it('flag OFF: streaming never touches the wallet', async () => {
    vi.stubEnv('SL_PAID_GENERATION', '')
    cfg.scenario = 'score_done'
    cfg.meterUsage = { inputTokens: 40_000, outputTokens: 8_000 }
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
    const { status } = await postStream('compose a 16-bar piece')
    expect(status).toBe(200)
    expect(getWallet(TEST_USER_ID).balance).toBe(1000)
    expect((await holdRows()).length).toBe(0)
  })
})
