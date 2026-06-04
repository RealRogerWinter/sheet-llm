import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import ScorePanel from '@/components/ScorePanel'
import { GhostPreviewAmber } from '@/components/orchestrator/GhostPreviewAmber'
import { useChatStore } from '@/lib/chat/state'
import { scoreToAbc } from '@/lib/music/scoreToAbc'
import type { Score } from '@/lib/music/types'

// Six-event single measure so we can drive BOTH presentations:
//   - 1 affected id  → 'inline'    (<= GHOST_PREVIEW_INLINE_THRESHOLD)
//   - 5 affected ids → 'diff-panel' (>= 5)
const STEPS = ['C', 'D', 'E', 'F', 'G', 'A'] as const
function makeScore(): Score {
  return {
    title: 'baseline',
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: STEPS.map((step, i) => ({
          id: `a${i}`,
          pitches: [{ step, octave: 4 }],
          duration: 'eighth' as const,
        })),
      },
    ],
  }
}

const BEFORE = makeScore()
// Candidate raises a couple of pitches; the ids/structure stay so every
// affected id still resolves to a position in the candidate score.
const CANDIDATE: Score = (() => {
  const s = makeScore()
  s.measures[0].events[1].pitches = [{ step: 'E', octave: 4 }]
  s.measures[0].events[2].pitches = [{ step: 'G', octave: 4 }]
  return s
})()

const CHAT_ID = '00000000-0000-0000-0000-0000000000aa'
const CANDIDATE_ID = '00000000-0000-0000-0000-0000000000cc'

function seedProposal(affectedEventIds: string[]) {
  useChatStore.setState({
    chatId: CHAT_ID,
    scoreJson: BEFORE,
    editedScore: BEFORE,
    pendingProposal: undefined,
  })
  // Use the store action so `presentation` is derived from the affected
  // count exactly the way the production flow derives it.
  useChatStore.getState().setPendingProposal({
    chatId: CHAT_ID,
    candidateVersionId: CANDIDATE_ID,
    candidateScore: CANDIDATE,
    beforeScore: BEFORE,
    // Real candidate abc so a ScorePanel render tags `data-startchar`
    // offsets that line up with the SourceMap the recolor computes.
    abc: scoreToAbc(CANDIDATE),
    affectedEventIds,
    introText: 'Edited the line.',
    toolUseId: 'toolu_gp_1',
    headVersionId: 'head-1',
  })
}

beforeEach(() => {
  cleanup()
  useChatStore.setState({ pendingProposal: undefined })
})

afterEach(() => {
  useChatStore.setState({ pendingProposal: undefined })
})

describe('<GhostPreviewAmber />', () => {
  it('renders nothing when no proposal is pending', () => {
    const { container } = render(<GhostPreviewAmber />)
    expect(container.firstChild).toBeNull()
    expect(container.querySelector('style')).toBeNull()
  })

  it('injects the amber <style> for an INLINE proposal (<=4 affected events)', () => {
    seedProposal(['a1'])
    expect(useChatStore.getState().pendingProposal?.presentation).toBe('inline')

    const { container } = render(<GhostPreviewAmber />)
    const style = container.querySelector('style')
    expect(style).toBeTruthy()
    const css = style!.textContent ?? ''
    expect(css).toMatch(/\.abcjs-note\[data-startchar="\d+"\]/)
    expect(css).toMatch(/\.abcjs-rest\[data-startchar="\d+"\]/)
    expect(css).toMatch(/fill: var\(--ghost-amber/)
    expect(css).toMatch(/filter: drop-shadow/)
  })

  it('injects the amber <style> for a DIFF-PANEL proposal (>=5 affected events)', () => {
    // This is the case the fix restores: large edits previously got the
    // docked list with NO on-score highlight at all.
    seedProposal(['a0', 'a1', 'a2', 'a3', 'a4'])
    expect(useChatStore.getState().pendingProposal?.presentation).toBe('diff-panel')

    const { container } = render(<GhostPreviewAmber />)
    const style = container.querySelector('style')
    expect(style).toBeTruthy()
    const css = style!.textContent ?? ''
    // One distinct startChar per affected event (5 events → 5 distinct
    // data-startchar values), all recolored amber. The selector targets
    // the child shapes (path/ellipse/rect) + the group, so we count
    // DISTINCT startChars rather than selector occurrences.
    const distinct = new Set(
      [...css.matchAll(/data-startchar="(\d+)"/g)].map((m) => m[1]),
    )
    expect(distinct.size).toBe(5)
    expect(css).toMatch(/fill: var\(--ghost-amber/)
  })

  it('renders nothing when none of the affected ids resolve in the candidate score', () => {
    seedProposal(['does-not-exist'])
    const { container } = render(<GhostPreviewAmber />)
    expect(container.querySelector('style')).toBeNull()
  })

  // Real-abcjs integration: the emitted selector must actually match the
  // noteheads abcjs renders + ScorePanel tags. A pure-string assertion
  // (above) can't catch a startChar/selector mismatch — this can, and is
  // the case the diff-panel fix exists for.
  it('emits a selector that matches the rendered noteheads for a DIFF-PANEL proposal', async () => {
    seedProposal(['a0', 'a1', 'a2', 'a3', 'a4'])
    expect(useChatStore.getState().pendingProposal?.presentation).toBe('diff-panel')
    const abc = useChatStore.getState().pendingProposal!.abc

    const { container } = render(
      <>
        <ScorePanel abc={abc} interactive publishVisual />
        <GhostPreviewAmber />
      </>,
    )

    // abcjs renders async; wait for ScorePanel to tag data-startchar.
    await waitFor(
      () => {
        if (container.querySelectorAll('[data-startchar]').length === 0) {
          throw new Error('not tagged yet')
        }
      },
      { timeout: 3000 },
    )

    // ScorePanel's SVG carries abcjs's own <style> too, so pick the
    // amber one by content rather than the first <style> in the tree.
    const amberStyle = Array.from(container.querySelectorAll('style')).find((s) =>
      (s.textContent ?? '').includes('--ghost-amber'),
    )
    expect(amberStyle).toBeTruthy()
    const css = amberStyle!.textContent ?? ''
    // 5 affected events → 5 distinct note groups in the rendered DOM.
    const distinct = [
      ...new Set([...css.matchAll(/data-startchar="(\d+)"/g)].map((m) => m[1])),
    ]
    expect(distinct.length).toBe(5)
    for (const sc of distinct) {
      expect(container.querySelectorAll(`.abcjs-note[data-startchar="${sc}"]`).length).toBe(1)
    }
    // The recolor selector targets REAL rendered child shapes (noteheads/
    // stems) — at least one shape per affected note actually matches.
    const shapeSelector = css.split('{')[0].trim()
    expect(container.querySelectorAll(shapeSelector).length).toBeGreaterThanOrEqual(5)
  })
})
