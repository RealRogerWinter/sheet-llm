import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { run as runOrchestrator } from '@/lib/orchestrator'
import type { Score } from '@/lib/music/types'

/**
 * Smoke D — the new tool-dispatch path (default-on since PR-6) actually
 * fires. The other three smokes (`classifier-*.smoke.eval.ts`) only
 * exercise the legacy Haiku `classify()` call directly; production
 * traffic now goes through `toolDispatch.run` (Sonnet) instead.
 *
 * Without this case, CI could stay green even if the new dispatcher is
 * completely broken on real prompts — the legacy classifier path it
 * REPLACED is the only thing the smokes were testing.
 *
 * What this case asserts:
 *  - Full `orchestrator.run(...)` pipeline runs end-to-end (NOT a
 *    direct `classify()` call).
 *  - `result.dispatchTool` is defined — i.e. the new dispatch path
 *    was taken, not the legacy classifier fallback (which leaves
 *    dispatchTool undefined).
 *  - The dispatcher picked SOME structural tool. We allow any of the
 *    structural choices (extend / insert / region_replace) — what
 *    matters is "a structural tool fired", not "the model picked the
 *    one I'd pick". `regenerate_all` is permitted but soft-warned: if
 *    the dispatcher consistently nukes the score on an extend prompt
 *    that's an M3.5 incident class, but a single smoke run shouldn't
 *    fail CI on a model judgment call.
 *
 * Gating: same pattern as the other smokes —
 *   RUN_SMOKE_EVALS=1 + ANTHROPIC_API_KEY=sk-...
 * Without these, the suite all-skips. Cost: ~$0.005-0.01 per run
 * (one Sonnet dispatcher call).
 */

const RUN =
  process.env.RUN_SMOKE_EVALS === '1' && !!process.env.ANTHROPIC_API_KEY

// 4-bar Triplet demo — cloned from
// evals/cases/additive/triplet-demo-extend-turnaround.live.eval.ts.
// Small enough to keep the dispatcher cost low; non-trivial enough that
// the dispatcher can't shortcut to a constant answer.
const TRIPLET_DEMO_4_BARS: Score = {
  title: 'Triplet demo',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'D', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'E', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'F', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'eighth', tuplet: 3 },
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 5 }], duration: 'quarter' },
      ],
    },
  ],
}

describe.skipIf(!RUN)('smoke D: orchestrator.run dispatches a structural tool on "add 4 more bars"', () => {
  // Defense in depth — PR-6 made SL_NEW_TOOL_DISPATCH default-on, but
  // if a future PR flips the default back off we want the smoke to
  // KEEP exercising the dispatch path (that's the whole point of this
  // case). Force it on locally and restore afterwards.
  let prevDispatchFlag: string | undefined

  beforeAll(() => {
    prevDispatchFlag = process.env.SL_NEW_TOOL_DISPATCH
    process.env.SL_NEW_TOOL_DISPATCH = '1'
  })

  afterAll(() => {
    if (prevDispatchFlag === undefined) {
      delete process.env.SL_NEW_TOOL_DISPATCH
    } else {
      process.env.SL_NEW_TOOL_DISPATCH = prevDispatchFlag
    }
  })

  it('orchestrator dispatch picks a structural tool (not the legacy classifier path)', async () => {
    const outcome = await runOrchestrator({
      requestId: `smoke_dispatch_${Date.now()}`,
      userText: 'add 4 more bars',
      editedScore: TRIPLET_DEMO_4_BARS,
      history: [],
    })

    // Sanity: orchestrator returned something with a score (not a
    // refusal / fall-through). A fall-through here would mean the
    // dispatcher threw — also a regression we want to catch.
    expect(outcome).not.toBeNull()
    expect(outcome).toBeTruthy()
    if (!outcome || typeof outcome !== 'object') {
      throw new Error(`smoke D: orchestrator returned non-object: ${String(outcome)}`)
    }
    if ('fellThrough' in outcome) {
      throw new Error(
        `smoke D: orchestrator fell through (reason=${outcome.reason}, err=${outcome.errorMessage ?? '<none>'}) — dispatcher path did not complete`,
      )
    }
    if ('refused' in outcome) {
      throw new Error(`smoke D: orchestrator refused the prompt — unexpected for an extend request`)
    }
    if (!('score' in outcome)) {
      throw new Error(`smoke D: orchestrator returned a converse stream — unexpected for an extend prompt with a score`)
    }

    // The load-bearing assertions:
    //  - dispatchTool defined ⇒ the new dispatch path ran (the legacy
    //    classifier path never sets this field).
    //  - the picked tool is one of the structural choices, not raw
    //    regenerate_all (which would indicate the dispatcher mistook
    //    an additive extend prompt for a full rewrite — that's the
    //    M3.5 incident class).
    expect(outcome.dispatchTool).toBeDefined()
    expect([
      'extend_composition',
      'insert_measures',
      'region_replace',
    ]).toContain(outcome.dispatchTool)
  }, 60_000)
})

describe.skipIf(RUN)('smoke D: skipped (set RUN_SMOKE_EVALS=1 + ANTHROPIC_API_KEY)', () => {
  it('skip placeholder', () => {
    expect(true).toBe(true)
  })
})
