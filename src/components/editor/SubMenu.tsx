'use client'

import { useRef, useState, type ReactNode } from 'react'
import Popover from './Popover'
import styles from './SubMenu.module.css'

export interface SubMenuProps {
  /**
   * Whether this submenu's popover is currently open. The parent owns
   * a single `activeSubmenu: string | null` so only one submenu is open
   * at a time; this is `activeSubmenu === id`.
   */
  open: boolean
  /** Visible label on the inline trigger button. */
  label: string
  /** Tooltip on the trigger (kept terse — no per-button shortcuts). */
  title?: string
  /**
   * Whether ANY action inside the submenu is currently active on the
   * selection. Surfaces a subtle dot on the trigger so the row hints
   * that "something in here is set" without opening it.
   */
  active?: boolean
  /** Accessible label exposed on the popover dialog. */
  ariaLabel: string
  /** Open this submenu (closes any other). Called on trigger click. */
  onOpen: () => void
  /** Close this submenu. */
  onClose: () => void
  /** Width/height hints forwarded to the underlying Popover clamp math. */
  estimatedWidth?: number
  estimatedHeight?: number
  /**
   * Panel layout. 'grid' (default) wraps action buttons in a compact
   * flex-wrap grid; 'column' stacks labeled control rows vertically
   * (used by the toolbar Setup submenu for selects/inputs).
   */
  layout?: 'grid' | 'column'
  /** The grouped action buttons rendered inside the popover panel. */
  children: ReactNode
}

/**
 * A category submenu built on the shared [[Popover]]. Renders a labeled
 * trigger button inline in a toolbar row; clicking it opens a popover,
 * anchored at the trigger, containing a grouped set of action buttons.
 *
 * The parent manages open state with a single `activeSubmenu` value so
 * only one submenu is open at a time. Buttons that themselves open a
 * dedicated popover (DynamicsPopover, SlurPopover, …) should close this
 * submenu first (call `onClose`) before opening their target so the
 * dedicated popover anchors correctly rather than hiding behind us.
 */
export default function SubMenu({
  open,
  label,
  title,
  active = false,
  ariaLabel,
  onOpen,
  onClose,
  estimatedWidth = 220,
  estimatedHeight = 240,
  layout = 'grid',
  children,
}: SubMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Anchor captured at open time from the trigger's rect (read inside
  // the click handler, never during render — the react-hooks/refs lint
  // rule forbids ref access in render; this mirrors EditorToolbar's
  // ScoreInfo trigger pattern). Anchors at the horizontal center /
  // bottom of the trigger so the popover drops directly beneath it.
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

  const handleClick = () => {
    if (open) {
      onClose()
      return
    }
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setAnchor({ x: r.left + r.width / 2, y: r.bottom })
    onOpen()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''} ${active ? styles.triggerActive : ''}`}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={handleClick}
      >
        {label}
        <span className={styles.caret} aria-hidden="true">▾</span>
      </button>
      <Popover
        open={open}
        anchorX={anchor.x}
        anchorY={anchor.y}
        estimatedWidth={estimatedWidth}
        estimatedHeight={estimatedHeight}
        ariaLabel={ariaLabel}
        onClose={onClose}
        className={styles.panel}
      >
        <div
          className={layout === 'column' ? styles.column : styles.grid}
          role="group"
          aria-label={ariaLabel}
        >
          {children}
        </div>
      </Popover>
    </>
  )
}
