'use client'

import { useCallback, useRef } from 'react'
import { useChatStore } from './state'

/**
 * Shell-style history navigation for prompt inputs.
 *
 * The user's past prompts come from the chat store's `turns` array
 * (filtered to user turns). The cursor convention:
 *   -1     → "live" position, showing what the user is currently typing
 *    0     → most recent past prompt
 *    N-1   → oldest
 *
 * On the first ArrowUp the in-progress draft is stashed so a round-trip
 * back via ArrowDown restores exactly what the user had typed. Submitting
 * resets the cursor + stash so the next history dive starts fresh.
 *
 * The hook returns absolute setters rather than just the strings so each
 * input owns its own value state — the hook itself is stateless from the
 * input's perspective (no controlled mirror, no re-renders on every key).
 */
export function usePromptHistory() {
  const turns = useChatStore((s) => s.turns)
  const cursorRef = useRef<number>(-1)
  const stashRef = useRef<string>('')

  const previous = useCallback(
    (currentValue: string): string | undefined => {
      // Walk the turns array right-to-left (newest first) so we never
      // materialize a large reversed copy on every keystroke.
      const userTexts: string[] = []
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i]
        if (t.role === 'user' && t.text) userTexts.push(t.text)
      }
      if (userTexts.length === 0) return undefined
      if (cursorRef.current === -1) {
        stashRef.current = currentValue
        cursorRef.current = 0
      } else if (cursorRef.current < userTexts.length - 1) {
        cursorRef.current += 1
      } else {
        return undefined
      }
      return userTexts[cursorRef.current]
    },
    [turns],
  )

  const next = useCallback((): string | undefined => {
    if (cursorRef.current === -1) return undefined
    if (cursorRef.current === 0) {
      cursorRef.current = -1
      return stashRef.current
    }
    cursorRef.current -= 1
    const userTexts: string[] = []
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]
      if (t.role === 'user' && t.text) userTexts.push(t.text)
    }
    return userTexts[cursorRef.current]
  }, [turns])

  const reset = useCallback(() => {
    cursorRef.current = -1
    stashRef.current = ''
  }, [])

  return { previous, next, reset }
}
