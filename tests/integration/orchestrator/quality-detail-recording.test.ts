// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Score } from '@/lib/music/types'
import { setDbForTesting } from '@/lib/db'
import { makeTestDb } from '../../factories/db'
import { users, sessions, orchestratorTurns } from '@/lib/db/schema'

/**
 * SHE-18 PR3 — end-to-end threading: a real run() edit turn must persist the
 * preservation-verify result (from the handler) AND the replacement-gate
 * detail (from detectReplacement, which runs for every edit turn) onto the
 * orchestrator_turns row. Only the dispatcher + handler LLM calls are stubbed;
 * the gate decision is computed for real.
 */

const BASE_SCORE: Score = {
  title: 'Triplet demo',
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

const EXTENDED_SCORE: Score = {
  ...BASE_SCORE,
  measures: [
    ...BASE_SCORE.measures,
    { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
    { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
  ],
}

const toolDispatchMock = vi.fn()
vi.mock('@/lib/orchestrator/toolDispatch', () => ({
  run: toolDispatchMock,
  ToolDispatchError: class extends Error {},
}))

const runExtendCompositionMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/extendComposition', () => ({
  runExtendComposition: runExtendCompositionMock,
  ExtendCompositionError: class extends Error {},
}))

const { run } = await import('@/lib/orchestrator')

let db: ReturnType<typeof makeTestDb>

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
  vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '') // enable the DB write
  vi.stubEnv('SL_REPLACEMENT_GATE', '1') // default-on, explicit for clarity
  toolDispatchMock.mockReset()
  runExtendCompositionMock.mockReset()
  db = makeTestDb()
  db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
  db.insert(sessions)
    .values({ id: 'chat-1', userId: 'u1', createdAt: 0, updatedAt: 0, lastMessageAt: 0 })
    .run()
  setDbForTesting(db)
})
afterEach(() => {
  setDbForTesting(undefined)
  vi.unstubAllEnvs()
})

describe('SHE-18 PR3 — quality detail recorded on the turn row', () => {
  it('persists preservation + replacement detail for an extend edit turn', async () => {
    toolDispatchMock.mockResolvedValue({
      tool: 'extend_composition',
      args: { targetBars: 2, hint: 'turnaround' },
      confidence: 0.9,
      model: 'claude-haiku-4-5',
    })
    runExtendCompositionMock.mockResolvedValue({
      score: EXTENDED_SCORE,
      classification: { kind: 'compose', scope: 'short', complexity: 'complex', confidence: 0.9 },
      model: 'claude-sonnet-4-6',
      latencyMs: 10,
      toolUseId: 'toolu_x',
      dispatchTool: 'extend_composition',
      // The handler computed a preservation-verify result.
      preservation: { ok: true, mismatchCount: 0 },
    })

    const result = await run({
      requestId: 'r-quality',
      chatId: 'chat-1',
      userText: 'add 2 more bars with a turnaround',
      editedScore: BASE_SCORE,
      history: [],
    })
    expect(result).toBeTruthy()

    const row = db
      .select()
      .from(orchestratorTurns)
      .where(eq(orchestratorTurns.sessionId, 'chat-1'))
      .get()!
    // Preservation, threaded up from the handler.
    expect(row.preservationOk).toBe(1)
    expect(row.preservationMismatchCount).toBe(0)
    // Replacement detail, from the real detectReplacement (gate ran because
    // editedScore is present). Extending keeps all originals → high ratio,
    // gate does not fire (replacementBlocked 0), reasons is a JSON array.
    expect(row.replacementRetainedIdentityRatio).not.toBeNull()
    expect(row.replacementRetainedIdentityRatio!).toBeGreaterThan(0.99)
    expect(row.replacementBlocked).toBe(0)
    expect(JSON.parse(row.replacementReasons!)).toBeInstanceOf(Array)
    expect(row.replacementUserExplicitRewrite).not.toBeNull()
  })

  it('records replacement_blocked=1 + low ratio + reasons when the gate FIRES', async () => {
    // The triplet-demo bug shape: the user asks for a small edit but the model
    // returns a wholesale-different score (new key/meter, no original measure
    // retained). detectReplacement runs for real → isReplacement=true.
    const WHOLESALE_REWRITE: Score = {
      title: 'Totally different',
      key: 'Am',
      meter: '5/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'A', octave: 4 }], duration: 'half' },
            { pitches: [{ step: 'B', octave: 4 }], duration: 'half' },
            { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
          ],
        },
      ],
    }
    toolDispatchMock.mockResolvedValue({
      tool: 'extend_composition', // NOT regenerate_all → no explicit-rewrite signal
      args: { targetBars: 1 },
      confidence: 0.9,
      model: 'claude-haiku-4-5',
    })
    runExtendCompositionMock.mockResolvedValue({
      score: WHOLESALE_REWRITE,
      classification: { kind: 'compose', scope: 'short', complexity: 'complex', confidence: 0.9 },
      model: 'claude-sonnet-4-6',
      latencyMs: 10,
      toolUseId: 'toolu_z',
      dispatchTool: 'extend_composition',
    })

    await run({
      requestId: 'r-fires',
      chatId: 'chat-1',
      userText: 'add one more bar', // a small-edit ask, not "start over"
      editedScore: BASE_SCORE,
      history: [],
    })

    const row = db
      .select()
      .from(orchestratorTurns)
      .where(eq(orchestratorTurns.sessionId, 'chat-1'))
      .get()!
    expect(row.replacementBlocked).toBe(1)
    expect(row.replacementRetainedIdentityRatio!).toBeLessThan(0.5)
    expect(JSON.parse(row.replacementReasons!).length).toBeGreaterThan(0)
    expect(row.replacementUserExplicitRewrite).toBe(0)
  })

  it('leaves quality detail NULL for a compose-from-scratch turn (no before-score)', async () => {
    toolDispatchMock.mockResolvedValue({
      tool: 'extend_composition',
      args: { targetBars: 2 },
      confidence: 0.9,
      model: 'claude-haiku-4-5',
    })
    runExtendCompositionMock.mockResolvedValue({
      score: EXTENDED_SCORE,
      classification: { kind: 'compose', scope: 'short', complexity: 'complex', confidence: 0.9 },
      model: 'claude-sonnet-4-6',
      latencyMs: 10,
      toolUseId: 'toolu_y',
      dispatchTool: 'extend_composition',
      // No preservation field this time.
    })

    // No editedScore → the replacement gate short-circuits (returns null), and
    // the handler reports no preservation → all quality columns stay NULL.
    await run({
      requestId: 'r-fresh',
      chatId: 'chat-1',
      userText: 'write something new',
      history: [],
    })

    const row = db
      .select()
      .from(orchestratorTurns)
      .where(eq(orchestratorTurns.sessionId, 'chat-1'))
      .get()!
    expect(row.preservationOk).toBeNull()
    expect(row.preservationMismatchCount).toBeNull()
    expect(row.replacementRetainedIdentityRatio).toBeNull()
    expect(row.replacementReasons).toBeNull()
    expect(row.replacementUserExplicitRewrite).toBeNull()
  })
})
