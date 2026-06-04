import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Score } from '@/lib/music/types'

const BASE_SCORE: Score = {
  title: 'Base',
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

const classifyMock = vi.fn()
vi.mock('@/lib/orchestrator/classifier', () => ({
  classify: classifyMock,
  ClassifierSchemaError: class extends Error {
    constructor(m: string) { super(m); this.name = 'ClassifierSchemaError' }
  },
}))

const completeMock = vi.fn()
vi.mock('@/lib/llm', () => ({
  getLLMClient: () => ({ complete: completeMock }),
}))

const runEditIntraMeasureMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/editIntraMeasure', () => ({
  runEditIntraMeasure: runEditIntraMeasureMock,
  EditIntraMeasureError: class extends Error {
    constructor(m: string) { super(m); this.name = 'EditIntraMeasureError' }
  },
}))

const runGenerateComplexMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/generateComplex', () => ({
  runGenerateComplex: runGenerateComplexMock,
  _resetGenerateComplexClient: () => undefined,
}))

const runComposeMock = vi.fn()
vi.mock('@/lib/orchestrator/handlers/compose', () => ({
  runCompose: runComposeMock,
  _resetComposeClient: () => undefined,
}))

const { run } = await import('@/lib/orchestrator')

describe('orchestrator.run dispatch (Phase 1)', () => {
  beforeEach(() => {
    classifyMock.mockReset()
    completeMock.mockReset()
    completeMock.mockResolvedValue({
      score: BASE_SCORE,
      introText: 'mocked',
      toolUseId: 'toolu_llm_1',
    })
    runEditIntraMeasureMock.mockReset()
    runGenerateComplexMock.mockReset()
    runComposeMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    // These tests cover the legacy classifier dispatch path explicitly.
    // PR-6 flipped `SL_NEW_TOOL_DISPATCH` to default-on, which routes
    // edited-score requests through the native dispatcher instead.
    // Opt-out here so the classifier mock stays in effect.
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0')
    // M25-PR-5 flipped sectional generation default-on; these tests pin
    // the single-shot generate_complex -> runGenerateComplex dispatch.
    vi.stubEnv('SL_SECTIONAL_GEN', '0')
    // M26 added a free-tier bounded choke point that pre-empts the classifier
    // for fresh generation. These tests exercise the legacy classifier dispatch
    // mechanics, so opt out of the bounded path (its rollback lever).
    vi.stubEnv('SL_BOUNDED_GEN', '0')
  })

  it('refuses on copyright hit BEFORE calling the classifier', async () => {
    const result = await run({
      requestId: 'r1',
      userText: 'Yesterday by The Beatles',
      editedScore: undefined,
      history: [],
    })
    expect(result).not.toBeNull()
    expect(result && 'refused' in result).toBe(true)
    if (result && 'refused' in result) {
      expect(result.refusalCode).toBe('copyright')
      expect(result.reason).toContain('copyrighted')
    }
    expect(classifyMock).not.toHaveBeenCalled()
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('dispatches generate_simple → LLM, returns Score', async () => {
    classifyMock.mockResolvedValue({
      kind: 'generate_simple',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
    })
    const result = await run({
      requestId: 'r2',
      userText: 'a c major scale',
      editedScore: undefined,
      history: [{ role: 'user', content: [{ type: 'text', text: 'a c major scale' }] }],
    })
    expect(result).not.toBeNull()
    if (
      result &&
      !('refused' in result) &&
      !('fellThrough' in result) &&
      !('outcomeKind' in result)
    ) {
      expect(result.score).toEqual(BASE_SCORE)
      expect(result.classification.kind).toBe('generate_simple')
      expect(result.toolUseId).toBe('toolu_llm_1')
      expect(result.model).toMatch(/sonnet/i)
    }
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it('dispatches edit_score_level → applies ops without LLM call', async () => {
    classifyMock.mockResolvedValue({
      kind: 'edit_score_level',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
      score_level_ops: [{ kind: 'changeKey', key: 'D' }],
    })
    const result = await run({
      requestId: 'r3',
      userText: 'change key to D',
      editedScore: BASE_SCORE,
      history: [],
    })
    expect(result).not.toBeNull()
    if (
      result &&
      !('refused' in result) &&
      !('fellThrough' in result) &&
      !('outcomeKind' in result)
    ) {
      expect(result.score.key).toBe('D')
      expect(result.model).toBeNull()
    }
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('dispatches refuse → refusal with classifier reason', async () => {
    classifyMock.mockResolvedValue({
      kind: 'refuse',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.99,
      reason: 'off-topic request',
    })
    const result = await run({
      requestId: 'r4',
      userText: 'what time is it',
      editedScore: undefined,
      history: [],
    })
    expect(result && 'refused' in result).toBe(true)
    if (result && 'refused' in result) {
      expect(result.reason).toBe('off-topic request')
      expect(result.refusalCode).toBe('out_of_scope')
    }
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('falls through with reason=low_confidence when confidence < 0.6', async () => {
    classifyMock.mockResolvedValue({
      kind: 'edit_intra_measure',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.4,
      target_description: 'unclear',
    })
    const result = await run({
      requestId: 'r5',
      userText: 'make it jazzier',
      editedScore: BASE_SCORE,
      history: [],
    })
    expect(result).not.toBeNull()
    if (result && 'fellThrough' in result) {
      expect(result.fellThrough).toBe(true)
      expect(result.reason).toBe('low_confidence')
      expect(result.classification?.confidence).toBe(0.4)
    }
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('falls through with reason=classifier_schema_error when classifier rejects', async () => {
    const { ClassifierSchemaError } = await import('@/lib/orchestrator/classifier')
    classifyMock.mockRejectedValue(new ClassifierSchemaError('bad schema'))
    const result = await run({
      requestId: 'r6',
      userText: 'something',
      editedScore: undefined,
      history: [],
    })
    expect(result).not.toBeNull()
    if (result && 'fellThrough' in result) {
      expect(result.reason).toBe('classifier_schema_error')
      expect(result.errorMessage).toContain('bad schema')
    }
  })

  it('dispatches edit_intra_measure → runEditIntraMeasure handler', async () => {
    classifyMock.mockResolvedValue({
      kind: 'edit_intra_measure',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.9,
      target_description: 'raise the third note',
    })
    const intraResult = {
      score: { ...BASE_SCORE, title: 'After intra edit' },
      classification: {
        kind: 'edit_intra_measure',
        scope: 'snippet',
        complexity: 'simple',
        confidence: 0.9,
      },
      model: 'claude-sonnet-4-6',
      latencyMs: 7,
      toolUseId: 'toolu_intra_1',
    }
    runEditIntraMeasureMock.mockResolvedValue(intraResult)
    const result = await run({
      requestId: 'r7',
      userText: 'raise the third note',
      editedScore: BASE_SCORE,
      history: [],
    })
    expect(result).not.toBeNull()
    if (
      result &&
      !('refused' in result) &&
      !('fellThrough' in result) &&
      !('outcomeKind' in result)
    ) {
      expect(result.score.title).toBe('After intra edit')
    }
    expect(runEditIntraMeasureMock).toHaveBeenCalledTimes(1)
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('dispatches generate_complex → runGenerateComplex handler (Opus)', async () => {
    classifyMock.mockResolvedValue({
      kind: 'generate_complex',
      scope: 'long',
      complexity: 'complex',
      confidence: 0.9,
    })
    runGenerateComplexMock.mockResolvedValue({
      score: BASE_SCORE,
      classification: {
        kind: 'generate_complex',
        scope: 'long',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-opus-4-7',
      latencyMs: 5,
      toolUseId: 'toolu_opus_1',
    })
    const result = await run({
      requestId: 'r8',
      chatId: 'chat-complex',
      userText: 'a long sonata',
      editedScore: undefined,
      history: [],
    })
    expect(result).not.toBeNull()
    if (
      result &&
      !('refused' in result) &&
      !('fellThrough' in result) &&
      !('outcomeKind' in result)
    ) {
      expect(result.model).toMatch(/opus/i)
    }
    expect(runGenerateComplexMock).toHaveBeenCalledTimes(1)
    expect(runGenerateComplexMock.mock.calls[0][0].chatId).toBe('chat-complex')
  })

  it('dispatches compose → runCompose handler (Opus)', async () => {
    classifyMock.mockResolvedValue({
      kind: 'compose',
      scope: 'short',
      complexity: 'complex',
      confidence: 0.9,
    })
    runComposeMock.mockResolvedValue({
      score: BASE_SCORE,
      classification: {
        kind: 'compose',
        scope: 'short',
        complexity: 'complex',
        confidence: 0.9,
      },
      model: 'claude-opus-4-7',
      latencyMs: 5,
      toolUseId: 'toolu_opus_compose_1',
    })
    const result = await run({
      requestId: 'r9',
      chatId: 'chat-compose',
      userText: 'counterpoint',
      editedScore: BASE_SCORE,
      history: [],
    })
    expect(result).not.toBeNull()
    expect(runComposeMock).toHaveBeenCalledTimes(1)
    expect(runComposeMock.mock.calls[0][0].chatId).toBe('chat-compose')
    expect(runComposeMock.mock.calls[0][0].editedScore).toEqual(BASE_SCORE)
  })

  // Note: route.ts owns the mode gate now — calling run() always runs.
  // The route-level "off mode → orchestrator not called" assertion
  // lives in tests/integration/api-chat-orchestrator-phase0.test.ts.

  it('falls through with reason=handler_error when an edit handler throws', async () => {
    classifyMock.mockResolvedValue({
      kind: 'edit_score_level',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
      score_level_ops: [{ kind: 'changeKey', key: 'G' }],
    })
    // No editedScore → handler throws EditHandlerError → orchestrator
    // should treat it as a fall-through rather than a hard 500.
    const result = await run({
      requestId: 'r11',
      userText: 'change key to G',
      editedScore: undefined,
      history: [],
    })
    expect(result).not.toBeNull()
    if (result && 'fellThrough' in result) {
      expect(result.reason).toBe('handler_error')
      expect(result.errorMessage).toBeTruthy()
    }
  })

  it('propagates RateLimitedError from a handler (does NOT double-spend)', async () => {
    classifyMock.mockResolvedValue({
      kind: 'generate_simple',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
    })
    const { RateLimitedError } = await import('@/lib/llm/errors')
    completeMock.mockRejectedValue(new RateLimitedError('429'))
    await expect(
      run({
        requestId: 'r12',
        userText: 'a c major scale',
        editedScore: undefined,
        history: [{ role: 'user', content: [{ type: 'text', text: 'a c major scale' }] }],
      }),
    ).rejects.toThrow(RateLimitedError)
    // The LLM was called exactly once — no silent retry.
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it('propagates UpstreamError from a handler', async () => {
    classifyMock.mockResolvedValue({
      kind: 'generate_simple',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
    })
    const { UpstreamError } = await import('@/lib/llm/errors')
    completeMock.mockRejectedValue(new UpstreamError('502 from anthropic', 502))
    await expect(
      run({
        requestId: 'r13',
        userText: 'x',
        editedScore: undefined,
        history: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      }),
    ).rejects.toThrow(UpstreamError)
  })

  it('confidence exactly 0.6 dispatches (boundary is < 0.6)', async () => {
    classifyMock.mockResolvedValue({
      kind: 'generate_simple',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.6,
    })
    const result = await run({
      requestId: 'r14',
      userText: 'x',
      editedScore: undefined,
      history: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })
    expect(result).not.toBeNull()
  })

  it('edit_score_level with empty score_level_ops falls through (handler_error)', async () => {
    classifyMock.mockResolvedValue({
      kind: 'edit_score_level',
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
      score_level_ops: [],
    })
    const result = await run({
      requestId: 'r15',
      userText: 'change something',
      editedScore: BASE_SCORE,
      history: [],
    })
    expect(result).not.toBeNull()
    if (result && 'fellThrough' in result) {
      expect(result.reason).toBe('handler_error')
    }
  })
})
