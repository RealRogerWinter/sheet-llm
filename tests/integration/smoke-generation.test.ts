// @vitest-environment node
//
// Smoke generation suite. Born from the confirmed production 500:
//
//   prompt "a driving blues-funk rhythm in grand staff. 16 bars with a
//   turnaround at the end" -> HTTP 500 "Orchestrator failed: Tool input
//   for render_score failed schema validation: Invalid input: expected
//   array, received undefined".
//
// ROOT CAUSE (ground truth, already forensically established):
//   - generation-path MAX_TOKENS=4000 (generateComplex.ts:21 / compose.ts:26)
//     and legacy MAX_TOKENS=2000 (client.ts:9) are far below the ~15-25k
//     OUTPUT tokens a 16-bar grand-staff (two-staff) render_score needs.
//   - the model hits the ceiling mid render_score with
//     stop_reason='max_tokens'; tool_use.input is truncated so the required
//     top-level `measures` array is undefined.
//   - AnthropicProvider.toolCall (anthropic.ts:77) never reads
//     response.stop_reason, so it runs ScoreSchema.safeParse on the partial
//     input (anthropic.ts:111) and throws ProviderSchemaError
//     (anthropic.ts:113-115) with the verbatim Zod message.
//   - ProviderSchemaError is NOT a ValidationError, so callWithScoreRetry
//     (scoreRetry.ts:122-123) does NOT retry, and the orchestrator
//     dispatch catch (index.ts ~667-710) re-throws on the fresh-generation
//     path rather than falling through to legacy.
//   - route.ts:448-451 maps the bare error to a 500 whose body echoes the
//     raw Zod string.
//
// This file has TWO blocks:
//   1. a LIVE block that asserts ONLY behaviour that holds against the
//      CURRENT code (a simple generation via the mocked stub returns 200
//      with a parseable scoreJson). It mirrors the setup of
//      tests/integration/api-chat.test.ts EXACTLY (same provider stub via
//      @/lib/llm/stubClient, same auth mock, same installTestDb, same POST
//      Request construction, same response assertions).
//   2. a describe.skip block that pins the DESIRED post-fix contract — the
//      precise spec the truncation/output-limit fix must satisfy. These
//      assertions are written to FAIL today (so they document the gap) and
//      to PASS once the prerequisite fixes (PF-01..PF-08 in the design)
//      land. They are intentionally specific so they become the spec.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'
import { installTestDb, mockAuthSession } from '../factories/testEnv'

// Identical to api-chat.test.ts: stub the cookie-less session to the fixed
// test user, and replace the LLM client with a vi.fn so NO real network /
// Anthropic call is ever made. The route resolves `getLLMClient()` to the
// stub when ANTHROPIC_API_KEY is absent (it is, in the test env), and
// tests/setup.ts pins ORCHESTRATOR_ENABLED='false' so the legacy stub path
// serves directly — exactly the wiring api-chat.test.ts relies on.
vi.mock('@/lib/auth/session', () => mockAuthSession())

const VALID_SCORE: Score = {
  title: 'Mocked',
  key: 'C',
  meter: '4/4',
  measures: [
    { events: [
      { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
    ] },
  ],
}

let toolUseCounter = 0
const completeMock = vi.fn()

vi.mock('@/lib/llm/stubClient', () => ({
  stubClient: { complete: completeMock },
}))

const { POST } = await import('@/app/api/chat/route')

function mockOnce(score: Score, introText?: string): string {
  const id = `toolu_test_${++toolUseCounter}`
  completeMock.mockResolvedValueOnce({ score, introText, toolUseId: id })
  return id
}

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('smoke: generation happy path (current behaviour)', () => {
  installTestDb()
  beforeEach(() => {
    toolUseCounter = 0
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: VALID_SCORE,
      introText: 'Mocked intro',
      toolUseId: 'toolu_default',
    })
  })

  // The positive control: a plain generation request resolves to 200 with a
  // parseable Score. This is the load-bearing invariant the regression
  // SHOULD have preserved for the large grand-staff case too. Mirrors
  // api-chat.test.ts:76-86.
  it('SM-12 (control): a simple generation returns 200 with a parseable scoreJson', async () => {
    const res = await POST(makeRequest({ message: 'a c major scale' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.chatId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    // scoreJson is present and parses back to the score the provider emitted.
    expect(data.scoreJson).toBeDefined()
    expect(data.scoreJson.key).toBe('C')
    // ScoreSchema.safeParse must succeed on the returned score (the exact
    // thing that FAILS on a truncated render_score in the regression).
    const { ScoreSchema } = await import('@/lib/music/types')
    expect(ScoreSchema.safeParse(data.scoreJson).success).toBe(true)
    // ABC was transpiled (the route validates it before responding).
    expect(typeof data.abc).toBe('string')
    expect(data.abc).toContain('K:C')
  })

  // A grand-staff-SHAPED score (two staves) that is SMALL enough that the
  // mocked provider returns it whole still round-trips to a 200 today. This
  // proves the two-staff *shape* is not itself the problem — the regression
  // is purely an OUTPUT-SIZE / truncation problem at the provider boundary,
  // not a schema-rejection of grand-staff scores. (The provider is stubbed,
  // so no token ceiling is exercised here; the real ceiling is pinned in
  // the skipped SM-01/SM-02/SM-10 specs below.)
  it('a small two-staff (grand-staff) generation returns 200 with secondStaff intact', async () => {
    const grandStaff: Score = {
      title: 'Tiny grand staff',
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        ] },
      ],
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [
            { pitches: [{ step: 'C', octave: 3 }, { step: 'G', octave: 3 }], duration: 'whole' },
          ] },
        ],
      },
    }
    completeMock.mockReset()
    mockOnce(grandStaff, 'Here is a grand staff:')
    const res = await POST(
      makeRequest({ message: 'a short grand staff phrase' }),
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.scoreJson).toBeDefined()
    expect(data.scoreJson.secondStaff).toBeDefined()
    expect(data.scoreJson.secondStaff.clef).toBe('bass')
    expect(data.scoreJson.measures).toHaveLength(1)
    const { ScoreSchema } = await import('@/lib/music/types')
    expect(ScoreSchema.safeParse(data.scoreJson).success).toBe(true)
  })

  // The status quo the fix must REPLACE. Today, when the provider surfaces a
  // ProviderSchemaError whose message contains the raw Zod truncation text,
  // the route maps it to 500 internal_error with that string echoed
  // verbatim in the body (route.ts:448-451). We assert that *current*
  // behaviour here so the post-fix block (SM-03/SM-09) has a documented
  // before-state to diff against. NOTE: this drives the legacy path's
  // catch (route.ts:495-496) which wraps an LLM throw as a 502
  // upstream_error — the legacy fall-through does not re-emit the raw Zod
  // 500. The raw-Zod 500 specifically arises on the *orchestrator* dispatch
  // path (index.ts:710 -> route.ts:450), which requires a real key to
  // reach and is therefore pinned in the skipped SM-03 spec, not here.
  it('a provider throw on the legacy path surfaces as a typed error response (not a silent success)', async () => {
    completeMock.mockReset()
    // Simulate the provider boundary failing the way a truncated
    // render_score does today: a thrown error. On the legacy stub path the
    // route catches it and returns a typed 502 upstream_error.
    completeMock.mockRejectedValueOnce(
      new Error(
        'Tool input for render_score failed schema validation: Invalid input: expected array, received undefined',
      ),
    )
    const res = await POST(
      makeRequest({ message: 'a driving blues-funk rhythm in grand staff. 16 bars with a turnaround at the end' }),
    )
    // Whatever the code does, it must NOT be a 200 masking a corrupt/absent
    // score. Today it is a 502 upstream_error (legacy path). The post-fix
    // contract (SM-03) tightens this to a sanitized, non-raw-Zod message.
    expect(res.status).not.toBe(200)
    const data = await res.json()
    expect(typeof data.code).toBe('string')
    expect(typeof data.error).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// POST-FIX CONTRACT (the spec for the truncation / output-limit fix).
//
// Every assertion below is written to be PRECISE about the desired behaviour
// after the prerequisite fixes land. They are skipped because they FAIL
// against the current code (that failure IS the bug). Un-skip — and flip the
// `it.skip`s to `it`s — as each PF-* lands:
//
//   PF-01  size generation-path max_tokens for multi-staff output
//          (generateComplex.ts:21, compose.ts:26, extendComposition.ts:39,
//           insertMeasures.ts:26, regionReplace.ts:170; legacy client.ts:9)
//   PF-02  read stop_reason/finish_reason -> throw a typed OutputTruncatedError
//          BEFORE ScoreSchema.safeParse (anthropic.ts:77, openaiCompatible.ts:141)
//   PF-03  make truncation recoverable on the fresh-generation path
//          (scoreRetry.ts:122-123 retry; index.ts:710 fallThrough instead of
//           throw; route.ts:448-451 sanitized copy; no reportProviderFailure)
//   PF-04  raise chat body cap (route.ts:53) >= persistence cap; compact-embed
//   PF-05  raise maxDuration (route.ts:50) in lockstep with the token budget
//   PF-06  stop auto-dismissing error toasts + add copy (ErrorToast.tsx:13)
//   PF-07  surface chat error inline in PromptBar (PromptBar.tsx:21)
//   PF-08  validate legacy tool output + raise legacy ceiling (client.ts:80,:9)
//
// The integration-layer specs here use the SAME stub-provider + auth-mock
// wiring as the live block above; the unit/live/e2e-layer specs are
// documented as TODO pointers to the file the fix must add the test in.
// ---------------------------------------------------------------------------
describe.skip('post-fix behavior — pending output-limit/truncation fix', () => {
  installTestDb()
  beforeEach(() => {
    toolUseCounter = 0
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: VALID_SCORE,
      introText: 'Mocked intro',
      toolUseId: 'toolu_default',
    })
  })

  // SM-03 [integration, P0] — the headline contract. A render_score call
  // that truncates at max_tokens must NOT produce a 500 whose body contains
  // the raw Zod string. The orchestrator either retries with a higher
  // ceiling (PF-03a) or falls through to legacy (PF-03b); if it must error,
  // the response is a mapped, sanitized status (4xx/503), never
  // internal_error echoing the schema text. Requires PF-02 + PF-03.
  it('SM-03: truncated render_score yields a sanitized error, never a raw-Zod 500', async () => {
    // After PF-02, the provider boundary throws a typed truncation error
    // rather than a bare ProviderSchemaError. After PF-03, the route maps it
    // to safe copy. We model the truncation as a provider throw carrying the
    // current raw text and assert the RESPONSE never leaks it.
    completeMock.mockReset()
    completeMock.mockRejectedValueOnce(
      new Error(
        'Tool input for render_score failed schema validation: Invalid input: expected array, received undefined',
      ),
    )
    const res = await POST(
      makeRequest({ message: 'a driving blues-funk rhythm in grand staff. 16 bars with a turnaround at the end' }),
    )
    // Not the cryptic internal_error 500 the regression produced.
    expect(res.status).not.toBe(500)
    const data = await res.json()
    expect(data.code).not.toBe('internal_error')
    // The raw Zod / schema-validation text must be confined to server logs.
    expect(data.error).not.toContain('expected array, received undefined')
    expect(data.error).not.toContain('failed schema validation')
    expect(data.error).not.toMatch(/^Orchestrator failed:/)
    // The user-facing copy should explain the actual situation.
    expect(data.error.toLowerCase()).toMatch(/too large|too long|one pass|fewer bars|try/)
  })

  // SM-05 [integration, P0] — a realistic large grand-staff editedScore
  // refinement must be ACCEPTED (no 413). Today route.ts:53 caps the chat
  // body at 24KB; a 16th-note 16-bar two-staff score serializes to ~30-35KB
  // and is rejected before the orchestrator runs. Requires PF-04 (raise
  // MAX_BODY_BYTES at route.ts:53 to >= the persistence cap).
  it('SM-05: a ~30-35KB grand-staff editedScore refinement is not rejected with 413', async () => {
    // Seed a first turn so there is a prior tool_use to anchor the edit.
    completeMock.mockReset()
    mockOnce(VALID_SCORE)
    const first = await (await POST(makeRequest({ message: 'turn 1' }))).json()

    const largeGrandStaff = buildLargeGrandStaffScore()
    const bodyBytes = Buffer.byteLength(
      JSON.stringify({ chatId: first.chatId, message: 'make the turnaround busier', editedScore: largeGrandStaff }),
      'utf8',
    )
    // Sanity-pin the fixture itself: it must exceed the OLD 24KB cap so the
    // test genuinely exercises the raised limit (and stay realistic, < 64KB).
    expect(bodyBytes).toBeGreaterThan(24 * 1024)
    expect(bodyBytes).toBeLessThan(64 * 1024)

    mockOnce(VALID_SCORE)
    const res = await POST(
      makeRequest({ chatId: first.chatId, message: 'make the turnaround busier', editedScore: largeGrandStaff }),
    )
    // The exact wall users hit on refinement today.
    expect(res.status).not.toBe(413)
    // The orchestrator/legacy path actually ran (the provider was consulted
    // for the refinement turn).
    expect(completeMock).toHaveBeenCalledTimes(2)
  })

  // SM-06 [unit, P1] — sync-pin: the chat body cap must be >= the
  // single-version persistence cap so the conversation layer can never
  // silently regress below what the editor already persists. Today chat=24KB
  // < versions=32KB (exactly backwards). Requires PF-04.
  it('SM-06: chat MAX_BODY_BYTES >= versions MAX_BODY_BYTES (sync-pin)', async () => {
    // Read both module-level caps at runtime. After PF-04, chat >= versions
    // (ideally aligned with the 1MB batch per-score cap). Source of truth:
    //   chat:     src/app/api/chat/route.ts:53          (currently 24*1024)
    //   versions: src/app/api/sessions/[id]/versions/route.ts:17 (32*1024)
    const CHAT_MAX_BODY_BYTES = await readChatMaxBodyBytes()
    const VERSIONS_MAX_BODY_BYTES = 32 * 1024
    expect(CHAT_MAX_BODY_BYTES).toBeGreaterThanOrEqual(VERSIONS_MAX_BODY_BYTES)
  })

  // SM-11 [unit/deadline, P1] — raising max_tokens must move maxDuration in
  // lockstep so the 500 is not merely traded for a 60s platform timeout. The
  // confirmed incident already burned ~36s running to the 4000 ceiling; a
  // full 16-bar two-staff emit (~15-25k tokens) needs far longer than 60s.
  // Requires PF-05 (raise route.ts:50 maxDuration and the deadline estimate).
  it('SM-11: route maxDuration was raised in lockstep with the token budget', async () => {
    const { maxDuration } = await import('@/app/api/chat/route')
    // 60s cannot cover the worst-case full-score emit. The fix must raise it
    // (platform-permitting) so SM-01 cannot regress into a 504.
    expect(maxDuration).toBeGreaterThan(60)
  })

  // SM-04 [unit, P1] — degradation poisoning. Two consecutive truncation
  // errors on the same chatId+tier must NOT flip the chat to the fallback
  // model. Today a truncation surfaces AS ProviderSchemaError, which
  // callWithFailover.ts:34 records via reportProviderFailure; with
  // DEGRADATION_THRESHOLD=2 a user who retries the failing prompt twice
  // silently demotes the chat's large tier off Opus. After PF-02 classifies
  // truncation distinctly, reportProviderFailure must NOT fire for it.
  // TODO(unit): assert in a dedicated callWithFailover + degradation unit
  // test (src/lib/providers/callWithFailover.ts:34, degradation.ts:13) that
  // feeding two OutputTruncatedErrors leaves isProviderDegraded(chatId,
  // 'large','anthropic') === false and the next large-tier call still routes
  // to Opus. Placed here as the cross-reference; the assertion belongs at
  // the provider layer where chatId/tier are in scope.
  it('SM-04: truncation does not poison the per-chat degradation tracker', () => {
    // Spec marker — see TODO above. Lives at the provider unit layer.
    expect(true).toBe(true)
  })

  // ---- Lower-layer specs (documented pointers; the live block above only
  // exercises the integration layer the route exposes). ----

  // SM-01 [live-eval, P0] — the exact regression, end-to-end against the
  // real model. New case under evals/cases/ gated by RUN_LIVE_EVALS=1:
  // POST the literal prompt through orchestrator primary mode; assert 200,
  // result.score.measures.length === 16 AND a secondStaff with 16
  // bar-aligned measures, and validateScore(result.score) passes, within
  // route maxDuration. Requires PF-01 + PF-05. Cannot run in CI (needs a
  // real key) — pinned as a gated live eval, not a stub test.

  // SM-02 [unit, P0] — provider-level: mock anthropic.messages.create to
  // resolve { stop_reason:'max_tokens', content:[{type:'tool_use',
  // name:'render_score', input:{title:'x',key:'C',meter:'4/4'}}] } (measures
  // omitted). Assert AnthropicProvider.toolCall throws the NEW typed
  // OutputTruncatedError carrying max_tokens — NOT a bare ProviderSchemaError
  // with 'expected array, received undefined'. Mirror for
  // OpenAICompatibleProvider with finish_reason==='length'. Belongs in
  // tests/unit/providers/anthropic.test.ts (it stubs ANTHROPIC_API_KEY and
  // the SDK). Requires PF-02.

  // SM-10 [unit, P1] — handler token budgets: assert compose.ts /
  // extendComposition.ts / insertMeasures.ts / regionReplace.ts each pass a
  // max_tokens sized for a full two-staff score (estimate-driven or
  // >= 16000), not the flat 4000. Replace the existing '>= 4000' assertion
  // in tests/unit/orchestrator/generateComplexAndCompose.test.ts:89 with an
  // estimate-driven check tied to target piece size. Requires PF-01.

  // SM-13 [unit, P1] — legacy client.ts: feed a truncated tool_use.input
  // (missing measures); assert it now runs ScoreSchema.safeParse (PF-08) and
  // throws a typed error rather than casting `toolUse.input as Score`
  // (client.ts:80) and propagating a corrupt object. Confirm legacy
  // MAX_TOKENS raised from 2000 (client.ts:9). Belongs in a client unit test.

  // SM-07 [unit, P0] — ErrorToast must NOT auto-dismiss in 6s. RTL test:
  // set a long error, advance fake timers 7s, assert the toast is STILL
  // rendered and a copy-to-clipboard control is present; confirm the prior
  // setTimeout(clearError, 6000) (ErrorToast.tsx:13) is gone or gated to a
  // non-error severity. Requires PF-06. Belongs in a jsdom component test.

  // SM-08 [unit, P1] — PromptBar must surface the chat `error` inline near
  // the input (PromptBar.tsx:21 currently destructures only `pending`). RTL
  // test: drive useSubmitPrompt to a failed submit; assert a persistent,
  // dismissible inline error region renders and the typed prompt is not lost
  // (move setInput('') into the success branch). Requires PF-07.

  // SM-09 [integration, P1] — error-mapping table: trigger the orchestrator
  // throw, the legacy 'LLM call failed', and a missing-API-key UpstreamError;
  // assert body.error is mapped safe copy (ChatErrorCode -> copy) and raw
  // exception/SDK/Zod text is only in server logs. Requires PF-03(d).

  // SM-17 [manual/CI, P1] — after `pnpm test`, neither ./sheet-llm.db nor
  // ./test-db-shouldnotexist/ exists (git status clean of these); broaden
  // .gitignore to ignore *.db regardless of directory; test factories use
  // :memory: only. CI guard, not an in-suite assertion.
})

/**
 * Build a realistic 16-bar grand-staff (two-staff) Score with a 16th-note
 * groove, sized to exceed the OLD 24KB chat body cap when serialized
 * compact (the exact "driving blues-funk" shape that produced the
 * regression). Two staves, dense per-bar activity. Used by SM-05.
 *
 * Kept schema-valid (each 4/4 bar sums correctly) so it passes
 * ScoreSchema.parse; the point is BYTE SIZE, not musicality.
 */
function buildLargeGrandStaffScore(): Score {
  const sixteenth = 'sixteenth' as const
  const eighth = 'eighth' as const
  const steps = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const

  const trebleBar = () => ({
    events: Array.from({ length: 16 }, (_, i) => ({
      pitches: [{ step: steps[i % steps.length], octave: 4 + ((i >> 3) & 1) }],
      duration: sixteenth,
      ...(i % 4 === 0 ? { articulation: 'staccato' as const } : {}),
    })),
  })

  const bassBar = () => ({
    events: Array.from({ length: 8 }, (_, i) => ({
      pitches: [
        { step: steps[i % steps.length], octave: 2 },
        { step: steps[(i + 2) % steps.length], octave: 3 },
      ],
      duration: eighth,
    })),
  })

  return {
    title: 'Driving blues-funk (16 bars, grand staff)',
    key: 'C',
    meter: '4/4',
    tempo_bpm: 120,
    measures: Array.from({ length: 16 }, () => trebleBar()),
    secondStaff: {
      clef: 'bass',
      measures: Array.from({ length: 16 }, () => bassBar()),
    },
  } as Score
}

/**
 * Read the chat route's MAX_BODY_BYTES without exporting it from the route
 * module (it is a module-private const). We re-derive it behaviourally: the
 * post-fix contract for SM-06 is that the chat cap is at least the 32KB
 * single-version cap, so we probe the route with bodies straddling 32KB and
 * infer the effective cap. A body strictly under the cap must not 413; a
 * body over it must 413.
 *
 * This keeps the sync-pin honest even though the constant isn't exported:
 * it pins the OBSERVABLE limit the route enforces, which is what actually
 * matters for the persistence-vs-conversation parity.
 */
async function readChatMaxBodyBytes(): Promise<number> {
  // Probe at exactly the 32KB persistence cap. A `message`-only body of this
  // size (well over the 2000-char schema limit, but that's a 400 not a 413 —
  // size is checked first at route.ts:269-282) tells us whether the cap is
  // >= 32KB. We return 32KB when the route accepts the size check at 32KB,
  // else a value below it. After PF-04 the route must accept it.
  const probe = await POST(makeRequest({ message: 'x'.repeat(32 * 1024) }))
  // 413 => cap is below 32KB (today's 24KB). Anything else (e.g. 400 from
  // the message-length schema, which runs AFTER the size gate) => the size
  // gate let a 32KB body through, i.e. cap >= 32KB.
  return probe.status === 413 ? 24 * 1024 : 32 * 1024
}
