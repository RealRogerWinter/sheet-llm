'use client'

import { useChatStore } from '@/lib/chat/state'
import { resolveClickPosition } from '@/lib/music/scoreToAbcWithMap'

export interface NoteTimingEvent {
  elements?: HTMLElement[][]
  startCharArray?: number[]
  milliseconds?: number
  type?: string
}

export function clearHighlight() {
  if (typeof document === 'undefined') return
  document
    .querySelectorAll('.abcjs-note-playing')
    .forEach((el) => el.classList.remove('abcjs-note-playing'))
}

// Module-scoped event handler — abcjs binds the callback object once
// inside TimingCallbacks and never re-reads it. Closures over hook
// state would capture stale store values; reading via getState() on
// every invocation avoids that trap.
export function handleEvent(ev: NoteTimingEvent | null) {
  clearHighlight()
  if (!ev) return
  let firstPlaying: HTMLElement | undefined
  if (ev.elements) {
    for (const group of ev.elements) {
      for (const el of group) {
        if (el && el.classList) {
          el.classList.add('abcjs-note-playing')
          if (!firstPlaying) firstPlaying = el
        }
      }
    }
  }
  const state = useChatStore.getState()
  if (state.followPlayback && firstPlaying) {
    firstPlaying.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }
  const startChar = ev.startCharArray?.[0]
  if (startChar === undefined || !state.editMap) return
  const pos = resolveClickPosition(state.editMap, startChar)
  if (pos) state.setPlaybackPosition({ measureIdx: pos.measureIdx, eventIdx: pos.eventIdx })
}

export function handleFinished() {
  clearHighlight()
  const state = useChatStore.getState()
  state.setPlaying(false)
  state.setPlaybackPosition(undefined)
}
