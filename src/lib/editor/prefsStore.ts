'use client'

import { useEffect } from 'react'
import { create } from 'zustand'

const ZOOM_KEY = 'sheet-llm:editor:zoom'

/**
 * Discrete zoom steps. Zoom is implemented by REFLOW, not glyph
 * scaling: each level maps to an abcjs layout `staffwidth` via
 * `staffwidthForZoom`, and the responsive SVG scales that layout to fit
 * the container width (see `RenderScoreOptions.staffwidth` in
 * `@/lib/abc/synth`). A fixed ladder keeps the +/- buttons, the
 * percentage label, and wheel/pinch zoom predictable and avoids drift
 * from slider rounding. 1.0 is the native screen size; values off the
 * ladder fall back to the default on hydrate. The ladder reaches 3.0
 * because reflow makes deep zoom-in usable (one or two big measures per
 * line) without the horizontal scrolling the old glyph-scale zoom forced.
 */
export const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0] as const
export type ZoomLevel = (typeof ZOOM_LEVELS)[number]

export const DEFAULT_ZOOM: ZoomLevel = 1.0

/**
 * abcjs's native on-screen layout width in px (its `staffwidthScreen`
 * default — see abcjs/src/write/engraver-controller.js:58). At zoom 1.0
 * ScorePanel passes no staffwidth, so abcjs uses this value; anchoring
 * the zoom math here keeps zoom 1.0 pixel-identical to the pre-zoom
 * baseline.
 */
export const NATIVE_STAFFWIDTH = 740

/**
 * Translate a zoom level into the abcjs `staffwidth` (layout width in
 * px) that produces it. Zoom is reflow-based: rendering stays
 * responsive ('resize'), so on-screen magnification is
 * `containerWidth / staffwidth`. Dividing the native width by the zoom
 * factor therefore magnifies by exactly `zoom` relative to the 1.0
 * baseline — independent of the real container width — while abcjs
 * reflows measures-per-line to keep the score fitting the width (no
 * horizontal scroll). Larger zoom ⇒ smaller staffwidth ⇒ fewer, bigger
 * measures per line; smaller zoom ⇒ the reverse.
 */
export function staffwidthForZoom(zoom: number): number {
  return Math.round(NATIVE_STAFFWIDTH / zoom)
}

interface EditorPrefsStore {
  /** Current zoom level for the score view. Drives the abcjs layout
   *  `staffwidth` via `staffwidthForZoom` (NOT abcjs `scale`). */
  zoom: ZoomLevel
  setZoom: (z: ZoomLevel) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
}

function persistZoom(z: ZoomLevel): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ZOOM_KEY, String(z))
  } catch {
    /* private-mode / quota — ignore, in-memory state still wins */
  }
}

export const useEditorPrefsStore = create<EditorPrefsStore>((set, get) => ({
  zoom: DEFAULT_ZOOM,
  setZoom: (z) => {
    persistZoom(z)
    set({ zoom: z })
  },
  zoomIn: () => {
    const current = get().zoom
    const i = ZOOM_LEVELS.indexOf(current)
    const next = ZOOM_LEVELS[Math.min(i + 1, ZOOM_LEVELS.length - 1)]
    if (next !== current) get().setZoom(next)
  },
  zoomOut: () => {
    const current = get().zoom
    const i = ZOOM_LEVELS.indexOf(current)
    const next = ZOOM_LEVELS[Math.max(i - 1, 0)]
    if (next !== current) get().setZoom(next)
  },
  resetZoom: () => {
    if (get().zoom !== DEFAULT_ZOOM) get().setZoom(DEFAULT_ZOOM)
  },
}))

export function canZoomIn(z: ZoomLevel): boolean {
  return z !== ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
}

export function canZoomOut(z: ZoomLevel): boolean {
  return z !== ZOOM_LEVELS[0]
}

/**
 * Hydrate zoom from localStorage on mount. Writes happen inside
 * setZoom (the +/- buttons fire infrequently so a write per click is
 * fine), so this hook only needs to read on mount.
 *
 * Only dispatches when the stored value differs from the default —
 * matches useFollowPlaybackSync's pattern and avoids a wasted
 * re-render of ScorePanel for users who never changed zoom (the
 * store already starts at DEFAULT_ZOOM).
 *
 * If the stored value isn't on the ZOOM_LEVELS ladder (manual edits,
 * migrated from a future build with a finer ladder), silently fall
 * back to the default rather than write through an unsupported value.
 */
export function useEditorPrefsSync(): void {
  const setZoom = useEditorPrefsStore((s) => s.setZoom)
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const stored = window.localStorage.getItem(ZOOM_KEY)
      if (stored === null) return
      const n = Number(stored)
      if (!Number.isFinite(n)) return
      if (n === DEFAULT_ZOOM) return
      if ((ZOOM_LEVELS as readonly number[]).includes(n)) {
        setZoom(n as ZoomLevel)
      }
    } catch {
      /* private-mode / quota — ignore */
    }
  }, [setZoom])
}
