// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'
import { orchestratorTurns } from '@/lib/db/schema'
import { currentMeterTotals, recordProviderCall, runWithUsageMeter } from '@/lib/billing/usageMeter'
import { updateTurnUsageByRequestId } from '@/lib/orchestrator/observability'

// The load-bearing assumption behind PR-7a's route change: an async generator
// (the SSE stream) pumped INSIDE a runWithUsageMeter scope sees the meter store
// at each `.next()`, so recordProviderCall fired in its body is captured. If
// this didn't hold, streamed generations would meter to zero and the paywall
// would settle them for free.
describe('streamed metering — ALS propagates into a pumped generator', () => {
  it('meters recordProviderCall fired inside a generator pumped within the scope', async () => {
    async function* fakeStream(): AsyncGenerator<string> {
      yield 'a'
      recordProviderCall('claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 0 })
      yield 'b'
      recordProviderCall('claude-sonnet-4-6', { outputTokens: 1_000_000 })
    }
    const totals = await runWithUsageMeter('req-stream', async () => {
      for await (const ev of fakeStream()) {
        void ev // drain — this is what the route's pump does
      }
      return currentMeterTotals()
    })
    expect(totals?.callCount).toBe(2)
    expect(totals?.inputTokens).toBe(1_000_000)
    expect(totals?.outputTokens).toBe(1_000_000)
    expect(totals?.costUsd ?? 0).toBeGreaterThan(0)
  })
})

describe('updateTurnUsageByRequestId', () => {
  function insertTurn(db: ReturnType<typeof makeTestDb>, requestId: string): void {
    const client = db.$client
    client.pragma('foreign_keys = OFF') // isolate from the sessions FK
    client
      .prepare(
        'INSERT INTO orchestrator_turns (id, session_id, request_id, created_at, latency_ms, final_status, diff_algo_version, replacement_blocked) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(`t-${requestId}`, 's1', requestId, 0, 100, 'ok', 1, 0)
  }

  it('backfills the cost + token columns on the matching turn (null at dispatch)', () => {
    const db = makeTestDb()
    insertTurn(db, 'req-1')
    // The optimistic streamed-turn record had null cost.
    expect(db.select().from(orchestratorTurns).where(eq(orchestratorTurns.requestId, 'req-1')).get()?.costMicroUsd).toBeNull()

    updateTurnUsageByRequestId('req-1', { inputTokens: 500, outputTokens: 200, costMicroUsd: 90_000 }, db)

    const row = db.select().from(orchestratorTurns).where(eq(orchestratorTurns.requestId, 'req-1')).get()
    expect(row?.inputTokens).toBe(500)
    expect(row?.outputTokens).toBe(200)
    expect(row?.costMicroUsd).toBe(90_000)
  })

  it('is a no-op for an unknown requestId (never throws)', () => {
    const db = makeTestDb()
    expect(() => updateTurnUsageByRequestId('nope', { costMicroUsd: 1 }, db)).not.toThrow()
  })
})
