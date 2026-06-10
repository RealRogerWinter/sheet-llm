import { describe, it, expect } from 'vitest'
import type { Score } from '@/lib/music/types'
import type { OrchestratorInput, OrchestratorResult } from '@/lib/orchestrator/types'
import { NO_OP_EDIT_NOTICE, noticeNoOpEdit } from '@/lib/orchestrator/noOpEditNotice'

/**
 * SHE-19 follow-up — when an edit-intent turn (a structural tool was chosen)
 * ends up changing nothing — e.g. the single-call no-op fell back to the 2-call
 * path and that ALSO echoed the score — the orchestrator must tell the user
 * instead of silently re-rendering "the same old score". This is the path-
 * agnostic backstop that complements the single-call fallback.
 */

const SCORE: Score = {
  title: 'T',
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

function changed(score: Score): Score {
  return {
    ...score,
    measures: [{ events: [...score.measures[0].events, { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' }] }],
  }
}

function input(editedScore: Score | undefined): OrchestratorInput {
  return { requestId: 'r', userText: 'make it dorian', editedScore } as unknown as OrchestratorInput
}

function result(over: Partial<OrchestratorResult>): OrchestratorResult {
  return {
    score: SCORE,
    classification: { kind: 'edit_intra_measure', scope: 'short', complexity: 'complex', confidence: 0.9 },
    model: 'claude-haiku-4-5',
    latencyMs: 1,
    ...over,
  }
}

describe('noticeNoOpEdit', () => {
  it('sets the notice when a structural edit produced no change', () => {
    const r = result({ score: SCORE, dispatchTool: 'region_replace' })
    noticeNoOpEdit(r, input(SCORE))
    expect(r.introText).toBe(NO_OP_EDIT_NOTICE)
  })

  it('leaves introText untouched when the edit actually changed the score', () => {
    const r = result({ score: changed(SCORE), dispatchTool: 'extend_composition', introText: 'Added a bar.' })
    noticeNoOpEdit(r, input(SCORE))
    expect(r.introText).toBe('Added a bar.')
  })

  it('does NOT fire for a converse/answer turn (no dispatchTool, score unchanged)', () => {
    const r = result({ score: SCORE, introText: 'This is in C major.' }) // no dispatchTool
    noticeNoOpEdit(r, input(SCORE))
    expect(r.introText).toBe('This is in C major.')
  })

  it('does NOT fire when a real change is pending confirmation', () => {
    const r = result({ score: SCORE, dispatchTool: 'region_replace', requiresConfirmation: true, introText: 'Proposed.' })
    noticeNoOpEdit(r, input(SCORE))
    expect(r.introText).toBe('Proposed.')
  })

  it('does NOT fire for a from-scratch generation (no editedScore)', () => {
    const r = result({ score: SCORE, dispatchTool: 'region_replace' })
    noticeNoOpEdit(r, input(undefined))
    expect(r.introText).toBeUndefined()
  })
})
