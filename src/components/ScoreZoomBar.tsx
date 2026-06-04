'use client'

import {
  canZoomIn,
  canZoomOut,
  DEFAULT_ZOOM,
  useEditorPrefsStore,
} from '@/lib/editor/prefsStore'
import styles from './ScoreZoomBar.module.css'

/**
 * Zoom controls for the score view (M22-PR-1). Buttons step through the
 * discrete ZOOM_LEVELS ladder; the percentage display doubles as a
 * "reset to 100%" affordance when the current zoom is non-default.
 */
export default function ScoreZoomBar() {
  const zoom = useEditorPrefsStore((s) => s.zoom)
  const zoomIn = useEditorPrefsStore((s) => s.zoomIn)
  const zoomOut = useEditorPrefsStore((s) => s.zoomOut)
  const resetZoom = useEditorPrefsStore((s) => s.resetZoom)
  const atDefault = zoom === DEFAULT_ZOOM
  const pct = Math.round(zoom * 100)

  return (
    <div
      className={styles.bar}
      role="group"
      aria-label="Score zoom"
      title="Zoom — Ctrl/⌘ + scroll, or pinch"
    >
      <button
        type="button"
        className={styles.button}
        onClick={zoomOut}
        disabled={!canZoomOut(zoom)}
        aria-label="Zoom out"
        title="Zoom out"
      >
        −
      </button>
      <button
        type="button"
        className={styles.level}
        onClick={resetZoom}
        aria-label={atDefault ? `Zoom: ${pct}%` : `Reset zoom to 100% (currently ${pct}%)`}
        aria-disabled={atDefault}
        title={atDefault ? 'Zoom level' : 'Reset to 100%'}
      >
        {pct}%
      </button>
      <button
        type="button"
        className={styles.button}
        onClick={zoomIn}
        disabled={!canZoomIn(zoom)}
        aria-label="Zoom in"
        title="Zoom in"
      >
        +
      </button>
    </div>
  )
}
