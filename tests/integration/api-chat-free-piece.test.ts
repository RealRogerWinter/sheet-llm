// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Score } from '@/lib/music/types'
import type { OrchestratorScoreStream } from '@/lib/orchestrator/types'
import { installTestDb, TEST_USER_ID } from '../factories/testEnv'
import { creditHolds, usageLedger, users } from '@/lib/db/schema'
import { creditWallet, getWallet } from '@/lib/billing/wallet'
import { recordProviderCall } from '@/lib/billing/usageMeter'

/**
 * PR-7b-3 — the one-time free full piece. A VERIFIED account's FIRST from-scratch
 * (no existing score) generation runs at pro scope, free + OFF the money path (no
 * hold/settle/wallet), and consumes the grant on delivery. Edits/refinements (an
 * existing score) and unverified accounts never get it.
 *
 * run() is mocked to return a from-scratch sectional score stream (the dominant
 * free-piece path); the test drives the SSE pump to completion by reading the
 * body.
 */

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

const cfg = vi.hoisted(() => ({ outcome: 'stream' as 'stream' | 'fallthrough' }))

vi.mock('@/lib/orchestrator', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/orchestrator')>()
  return {
    ...actual,
    run: async (input: { requestId: string; chatId?: string }) => {
      if (cfg.outcome === 'fallthrough') {
        // Orchestrator bails (low confidence) → handleChat drops to the legacy
        // path, where a free piece MUST be refused (not served free-unbounded).
        return { fellThrough: true, reason: 'low_confidence', latencyMs: 5 } as unknown as Awaited<
          ReturnType<typeof actual.run>
        >
      }
      const events = (async function* () {
        yield { type: 'section', score: VALID_SCORE, sectionIndex: 0, totalSections: 1, label: 'A' }
        // Real provider cost — proves the free piece does NOT charge it (and a
        // paid generation WOULD).
        recordProviderCall('claude-sonnet-4-6', {
          inputTokens: 40_000,
          outputTokens: 8_000,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
        })
        yield { type: 'done', score: VALID_SCORE, introText: 'Done.', model: 'claude-sonnet-4-6', toolUseId: 'toolu_test' }
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

function setVerified(verified: boolean, usedAt: number | null = null): Promise<void> {
  return getDb().then((db) => {
    db.update(users)
      .set({ emailVerified: verified ? 1 : 0, freeFullPieceUsedAt: usedAt })
      .where(eq(users.id, TEST_USER_ID))
      .run()
  })
}

// POST a from-scratch (no chatId) message and drain the SSE; returns the chatId
// parsed from the header frame so a follow-up can reuse the now-scored chat.
async function postFresh(message: string): Promise<{ status: number; chatId: string }> {
  const res = await POST(
    new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.13' },
      body: JSON.stringify({ message, debug: { orchestrator: 'on' } }),
    }),
  )
  const body = await res.text()
  const header = body.match(/event: header\ndata: (.*)/)
  const chatId = header ? (JSON.parse(header[1]).chatId as string) : ''
  return { status: res.status, chatId }
}

async function postOnChat(chatId: string, message: string): Promise<void> {
  const res = await POST(
    new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.13' },
      body: JSON.stringify({ chatId, message, debug: { orchestrator: 'on' } }),
    }),
  )
  await res.text()
}

async function freePieceUsed(): Promise<boolean> {
  const db = await getDb()
  const row = db.select({ u: users.freeFullPieceUsedAt }).from(users).where(eq(users.id, TEST_USER_ID)).get()
  return row?.u != null
}
async function holdCount(): Promise<number> {
  return (await getDb()).select().from(creditHolds).all().length
}
async function ledgerCount(): Promise<number> {
  return (await getDb()).select().from(usageLedger).all().length
}

describe('/api/chat free full piece (PR-7b-3)', () => {
  installTestDb()
  beforeEach(() => {
    cfg.outcome = 'stream'
    vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-bytes!')
    vi.stubEnv('SL_PAID_GENERATION', '1')
    vi.stubEnv('SL_GENERATION_TIER', 'pro')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('a VERIFIED account: first from-scratch piece is FREE + consumes the grant (no wallet touch)', async () => {
    await setVerified(true)
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' }) // funded, but not charged
    await postFresh('compose a 16-bar piece')
    expect(await freePieceUsed()).toBe(true) // grant consumed
    expect(await holdCount()).toBe(0) // off the money path — no hold
    expect(await ledgerCount()).toBe(0) // not charged
    expect(getWallet(TEST_USER_ID).balance).toBe(1000) // untouched
  })

  it('once consumed, the next from-scratch piece is PAID (hold + settle)', async () => {
    await setVerified(true, 123) // already used the grant
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
    await postFresh('compose another piece')
    expect(await holdCount()).toBe(1) // paid path placed a hold
    expect((await getDb()).select().from(creditHolds).all()[0].status).toBe('settled')
    expect(await ledgerCount()).toBe(1) // charged
    expect(getWallet(TEST_USER_ID).balance).toBeLessThan(1000)
  })

  it('a free piece that FALLS THROUGH to legacy is REFUSED, grant NOT consumed (no free unbounded legacy)', async () => {
    await setVerified(true)
    cfg.outcome = 'fallthrough'
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
    const { status } = await postFresh('compose something vague')
    expect(status).toBe(422) // refused, not served free via the uncharged legacy path
    expect(await freePieceUsed()).toBe(false) // grant survives → a retry gets the real (consumed) free piece
    expect(await holdCount()).toBe(0)
    expect(await ledgerCount()).toBe(0)
  })

  it('an UNVERIFIED account never gets the free piece (paid path)', async () => {
    await setVerified(false)
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
    await postFresh('compose a piece')
    expect(await freePieceUsed()).toBe(false) // not consumed
    expect(await holdCount()).toBe(1) // went paid, not free
  })

  it('an EXISTING-score request is NOT a free piece, even when eligible (no free-edits hole)', async () => {
    await setVerified(true)
    const { chatId } = await postFresh('compose a piece') // first: free, persists a score
    expect(await freePieceUsed()).toBe(true)
    // Re-grant eligibility, then refine the SAME (now-scored) chat: it has an
    // existing score, so it must NOT be treated as a from-scratch free piece.
    await setVerified(true, null) // re-grant eligibility
    creditWallet({ userId: TEST_USER_ID, creditsDelta: 1000, source: 'test' })
    await postOnChat(chatId, 'make it longer')
    // The refine has an existing score → it is NOT a from-scratch free piece, so
    // it does NOT consume the re-granted free piece (stays unused) and instead
    // goes through the PAID path. This is the no-free-edits gate.
    expect(await freePieceUsed()).toBe(false)
    expect(await holdCount()).toBe(1)
  })

  it('flag OFF: no free-piece logic (grant untouched, normal behavior)', async () => {
    vi.stubEnv('SL_PAID_GENERATION', '')
    await setVerified(true)
    await postFresh('compose a piece')
    expect(await freePieceUsed()).toBe(false) // dark — free-piece logic inert
    expect(await holdCount()).toBe(0)
  })
})
