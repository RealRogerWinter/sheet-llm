'use client'

import { useEffect } from 'react'
import { useChatStore } from '@/lib/chat/state'
import styles from './CheatSheet.module.css'

const SECTIONS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: 'Selection',
    rows: [
      ['Click', 'Select a note'],
      ['Esc', 'Clear selection'],
    ],
  },
  {
    title: 'Pitch',
    rows: [
      ['↑ / ↓', 'Up/down a step'],
      ['Shift+↑ / Shift+↓', 'Up/down an octave'],
      ['Vertical drag', 'Retune note'],
      ['Shift+vertical drag', 'Retune by octave'],
    ],
  },
  {
    title: 'Reorder',
    rows: [
      ['Horizontal drag', 'Move note (across barline OK)'],
      ['Esc during drag', 'Cancel'],
    ],
  },
  {
    title: 'Duration',
    rows: [
      ['1 / 2 / 3', '32nd / 16th / 8th'],
      ['4 / 5 / 6', 'Quarter / Half / Whole'],
    ],
  },
  {
    title: 'Accidentals',
    rows: [
      ['=', 'Sharp'],
      ['-', 'Flat'],
      ['0', 'Natural'],
    ],
  },
  {
    title: 'Edit',
    rows: [
      ['Delete / Backspace', 'Remove selected note'],
      ['Shift+Delete / Shift+Backspace', 'Remove the bar (or selected range)'],
      ['Ctrl/Cmd+D', 'Duplicate the bar (or selected range)'],
      ['Ctrl/Cmd+click bar', 'Select a measure for bar-level ops'],
      ['Ctrl/Cmd+Shift+click bar', 'Extend the measure range to that bar'],
      ['Drag a selected bar', 'Move the range to a new position'],
      ['Esc', 'Clear selection / cancel drag'],
      ['Ctrl/Cmd+Z', 'Undo'],
      ['Ctrl/Cmd+Shift+Z', 'Redo'],
    ],
  },
  {
    title: 'Chords',
    rows: [
      ['c', 'Open chord palette'],
      ['Shift+A … Shift+G', 'Stack pitch into chord'],
      ['Alt+click staff', 'Force new note instead of stack'],
      ['Click chord pitch', 'Focus that pitch (per-notehead)'],
    ],
  },
  {
    title: 'Spans',
    rows: [
      ['Shift+W', 'Hairpin (crescendo / diminuendo)'],
      ['Shift+S', 'Slur'],
      ['Shift+L', 'Tempo span (accel. / rit.)'],
      ['Shift+U', 'Octave span (8va / 8vb / 15ma / 15mb)'],
      ['Shift+G', 'Glissando'],
      ['Shift+Z', 'Trill line (tr~~~ extension)'],
      ['Shift+X', 'Tremolo between two notes'],
    ],
  },
  {
    title: 'Playback',
    rows: [
      ['▶ in floating menu', 'Play from selected note'],
    ],
  },
]

export default function CheatSheet() {
  const cheatSheetOpen = useChatStore((s) => s.cheatSheetOpen)
  const toggleCheatSheet = useChatStore((s) => s.toggleCheatSheet)

  // Esc to close.
  useEffect(() => {
    if (!cheatSheetOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') toggleCheatSheet()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [cheatSheetOpen, toggleCheatSheet])

  if (!cheatSheetOpen) return null

  return (
    <>
      <div className={styles.backdrop} onClick={toggleCheatSheet} />
      <aside className={styles.panel} role="dialog" aria-label="Keyboard shortcuts">
        <div className={styles.header}>
          <span className={styles.title}>Shortcuts</span>
          <button type="button" className={styles.close} onClick={toggleCheatSheet} aria-label="Close">
            ×
          </button>
        </div>
        {SECTIONS.map((section) => (
          <div key={section.title} className={styles.section}>
            <div className={styles.sectionTitle}>{section.title}</div>
            {section.rows.map(([k, v]) => (
              <div key={k} className={styles.row}>
                <span>{v}</span>
                <span className={styles.key}>{k}</span>
              </div>
            ))}
          </div>
        ))}
      </aside>
    </>
  )
}
