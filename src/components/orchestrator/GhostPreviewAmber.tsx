'use client'

import { useMemo } from 'react'
import { useChatStore, type PendingProposal } from '@/lib/chat/state'
import { scoreToAbcWithMap } from '@/lib/music/scoreToAbcWithMap'
import { findEventLocationById } from '@/lib/music/scoreAccessors'

/**
 * M24 — AI ghost preview amber recolor (score-level).
 *
 * Injects a single `<style>` tag that recolors the affected noteheads
 * of a pending proposal warm-amber, directly on the score. It is
 * mounted once in Hero, independent of the accept/reject chrome, so
 * the recolor applies to BOTH presentations:
 *
 *   - inline (≤4 events)    — pairs with GhostPreviewOverlay's toolbar.
 *   - diff-panel (≥5 events) — pairs with GhostPreviewPanel's docked
 *     list. The list alone says *what* changed but not *where* on the
 *     score; the amber recolor restores that spatial cue. (Before this
 *     was inline-only, so large edits showed no on-score highlight —
 *     the user saw Accept/Reject but couldn't tell which notes moved.)
 *
 * Mechanism: abcjs note/rest SVGs already carry `data-startchar`
 * (stamped by `ScorePanel.tagNoteheadsWithStartChar` for the drag
 * system). We resolve each affected event id → SourceMap `startChar`
 * and emit `.abcjs-note[data-startchar="N"], .abcjs-rest[data-startchar="N"]`
 * recolor selectors, piggybacking on that attribute rather than
 * walking the DOM. Because Hero renders the candidate's abc while a
 * proposal is pending (M24-PR-3b), the rendered `data-startchar`
 * values line up with the candidate-derived SourceMap offsets.
 */
export function GhostPreviewAmber() {
  const proposal = useChatStore((s) => s.pendingProposal)
  const amberCss = useAmberStyleSheet(proposal)
  if (!amberCss) return null
  return <style>{amberCss}</style>
}

/**
 * Build a `<style>`-body string of selectors targeting the abcjs SVG
 * notes/rests whose source `startChar` corresponds to an affected
 * event id in the candidate score.
 *
 * Presentation-agnostic: the recolor applies to every pending
 * proposal, not just the inline (≤4-event) case.
 *
 * Returns undefined when there is no proposal, it has no affected ids,
 * or none of the affected ids resolve to a position in the candidate
 * score (defensive — a bad proposal shouldn't crash the page).
 */
export function useAmberStyleSheet(
  proposal: PendingProposal | undefined,
): string | undefined {
  return useMemo(() => {
    if (!proposal) return undefined
    if (proposal.affectedEventIds.length === 0) return undefined
    let map
    try {
      ;({ map } = scoreToAbcWithMap(proposal.candidateScore))
    } catch {
      return undefined
    }
    const startChars = new Set<number>()
    for (const id of proposal.affectedEventIds) {
      const loc = findEventLocationById(proposal.candidateScore, id)
      if (!loc) continue
      const range = map.byEvent.get(
        `${loc.staffIdx}:${loc.voiceIdx}:${loc.measureIdx}:${loc.eventIdx}`,
      )
      if (range) startChars.add(range.startChar)
    }
    if (startChars.size === 0) return undefined
    const chars = [...startChars]
    // Group elements (the `<g class="abcjs-note" data-startchar>`): carry
    // the glow filter so the whole glyph haloes amber.
    const groupSelectors = chars
      .flatMap((sc) => [
        `.abcjs-note[data-startchar="${sc}"]`,
        `.abcjs-rest[data-startchar="${sc}"]`,
      ])
      .join(', ')
    // The VISIBLE shapes (notehead/stem/rest paths, ellipses, rects) must
    // be recolored directly — recoloring only the `<g>` and relying on
    // `fill` inheritance does NOT repaint abcjs noteheads in the browser.
    // This mirrors the project's only other notehead recolor, the
    // playback highlight in `src/styles/abcjs-overlay.css`
    // (`.abcjs-note-playing path, ellipse, rect { fill: … !important }`).
    // `!important` beats any inline/presentation `fill` abcjs emits.
    const shapeSelectors = chars
      .flatMap((sc) =>
        ['.abcjs-note', '.abcjs-rest'].flatMap((base) =>
          ['path', 'ellipse', 'rect'].map(
            (shape) => `${base}[data-startchar="${sc}"] ${shape}`,
          ),
        ),
      )
      .join(', ')
    return [
      `${shapeSelectors} { fill: var(--ghost-amber, #c2570a) !important; stroke: var(--ghost-amber, #c2570a) !important; }`,
      `${groupSelectors} { fill: var(--ghost-amber, #c2570a) !important; filter: drop-shadow(0 0 3px var(--ghost-amber, #c2570a)); }`,
    ].join('\n')
  }, [proposal])
}
