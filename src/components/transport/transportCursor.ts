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
  // abcjs aggregates every glyph sounding at this beat into ev.elements, one
  // group per voice in VOICE-DECLARATION order. scoreToAbcWithMap always emits
  // the primary staff (treble) before secondStaff (bass), so the last valid
  // glyph is the lowest staff — the bass note that follow-score previously left
  // off-screen because it only scrolled the first (treble) glyph (SHE-7). Track
  // the bottom-most glyph instead. NB: this relies on that top-to-bottom emit
  // order (true for every score this app generates); it is not a general
  // vertical sort of arbitrary ABC where a lower voice could be declared first.
  let bottomPlaying: HTMLElement | undefined
  if (ev.elements) {
    for (const group of ev.elements) {
      for (const el of group) {
        if (el && el.classList) {
          el.classList.add('abcjs-note-playing')
          bottomPlaying = el
        }
      }
    }
  }
  const state = useChatStore.getState()
  if (state.followPlayback && bottomPlaying) {
    // Revealing the lowest glyph with block:'nearest' brings the bass into view
    // while keeping the staves above it visible whenever the grand staff fits;
    // when it can't, the bass (the staff the user couldn't see) wins. One
    // scrollIntoView per beat avoids competing smooth-scroll animations.
    bottomPlaying.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
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
