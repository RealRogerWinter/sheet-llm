'use client'

import { useChatStore } from '@/lib/chat/state'

/**
 * Renders a thin vertical line at the current drag snap target — the
 * visual feedback for free-position drag (Phase 4). The line is fixed-
 * positioned to viewport coordinates so it doesn't fight abcjs's SVG
 * transform; on a horizontal drag the dragged notehead translates with
 * the pointer (driven directly by useNoteDrag), and this line shows
 * where release would commit.
 *
 * Subscribes only to `dragSnapTarget` — re-renders only when the snap
 * point actually changes (which useNoteDrag throttles to boundary
 * crossings via sameTarget(...)).
 *
 * Mount it as a sibling of the score container (ScorePanel). When no
 * drag is in flight, this component returns null and contributes no
 * DOM.
 */
export function DragPreviewOverlay() {
  const target = useChatStore((s) => s.dragSnapTarget)
  if (!target) return null
  return (
    <div
      aria-hidden
      data-testid="drag-snap-indicator"
      style={{
        position: 'fixed',
        left: target.clientX - 1,
        top: 0,
        width: 2,
        height: '100vh',
        background: 'rgba(72, 187, 120, 0.75)',
        pointerEvents: 'none',
        zIndex: 100,
      }}
    />
  )
}
