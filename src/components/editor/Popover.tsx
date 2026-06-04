'use client'

import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { useViewportRect } from '@/lib/ui/useViewportRect'
import styles from './Popover.module.css'

export interface PopoverProps {
  open: boolean
  /** Viewport coords for the anchor (typically the selected event). */
  anchorX: number
  anchorY: number
  /**
   * Estimated rendered height/width — drives viewport clamping so the
   * popover doesn't render off-screen. Over-estimates are safer than
   * under-estimates (under-estimating can let the bottom clip when the
   * popover should have flipped above).
   */
  estimatedHeight?: number
  estimatedWidth?: number
  /** Accessible label exposed on role="dialog". */
  ariaLabel: string
  onClose: () => void
  /**
   * Optional CSS class merged onto the popover root — use for width
   * overrides or popover-specific tweaks.
   */
  className?: string
  /** Inline-style overrides; merged AFTER computed left/top. */
  style?: CSSProperties
  children: ReactNode
}

const DEFAULT_HEIGHT = 200
const DEFAULT_WIDTH = 320

/**
 * Shared popover shell — owns viewport-clamped positioning, Escape-
 * to-close, mouseDown containment, and the common visual frame
 * (border, shadow, fade-in, padding). Substrate for the Shift+letter
 * popovers (DynamicsPopover, TechniquePopover, OrnamentMenuPopover,
 * ChordPalette today; M5-M10 fingerings / meter / key / tempo next).
 *
 * Positioning rule: prefer below the anchor unless that would clip
 * the viewport bottom; otherwise flip above. Horizontal: center on
 * the anchor, clamped 8px from either edge.
 */
export default function Popover({
  open,
  anchorX,
  anchorY,
  estimatedHeight = DEFAULT_HEIGHT,
  estimatedWidth = DEFAULT_WIDTH,
  ariaLabel,
  onClose,
  className,
  style,
  children,
}: PopoverProps) {
  // Reactive viewport size — re-clamps the popover on resize / rotate /
  // mobile-keyboard / pinch instead of going stale at the render-time
  // innerWidth/innerHeight it was first positioned with.
  const viewport = useViewportRect()

  // Close on Escape. The handler stop-propagates so the surrounding
  // NoteFloatingMenu Escape watcher doesn't also fire and dismiss
  // the selection underneath us.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  // Fall back to window.* if the reactive rect hasn't resolved yet (e.g. the
  // SSR 0,0 snapshot on a synchronous first open before the store reads).
  const vw = viewport.width || window.innerWidth
  const vh = viewport.height || window.innerHeight
  const wantBelow = anchorY + estimatedHeight < vh - 8
  const top = wantBelow
    ? Math.min(anchorY + 8, vh - estimatedHeight - 8)
    : Math.max(8, anchorY - estimatedHeight - 8)
  const left = Math.max(8, Math.min(anchorX - estimatedWidth / 2, vw - estimatedWidth - 8))

  return (
    <div
      className={className ? `${styles.popover} ${className}` : styles.popover}
      role="dialog"
      aria-label={ariaLabel}
      style={{ left, top, ...style }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}
