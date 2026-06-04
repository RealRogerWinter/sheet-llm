'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { useSubmitPrompt } from '@/lib/chat/useSubmitPrompt'
import type { TargetRegion } from '@/lib/shared/types'
import { usePromptPhase, type PromptPhase } from '@/lib/chat/usePromptPhase'
import { usePromptHistory } from '@/lib/chat/usePromptHistory'
import { createBlankScore } from './import/createBlankScore'
import SuggestionChips from './SuggestionChips'
import EditsIncludedHint from './editor/EditsIncludedHint'
import styles from './PromptBar.module.css'

export default function PromptBar() {
  const [input, setInput] = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // D5: the deterministic measure region armed by the latest AI seed. Kept
  // in a ref (not state — it never drives render) and attached to the next
  // submit only while the input is still derived from the seed text.
  const armedSeedRef = useRef<{ text: string; region: TargetRegion } | undefined>(undefined)

  const abc = useChatStore((s) => s.abc)
  const lastImport = useChatStore((s) => s.lastImport)
  const historyPointer = useChatStore((s) => s.historyPointer)
  const aiSeed = useChatStore((s) => s.aiSeed)
  const { submit: doSubmit, pending } = useSubmitPrompt()
  const phase = usePromptPhase()
  const history = usePromptHistory()
  const isFreshImport = lastImport !== undefined && historyPointer === 0
  const isBlankCanvas = isFreshImport && lastImport?.format === 'blank'

  // M29: a context-menu "Edit with AI" seed pre-fills + focuses the input
  // (without sending) so the user supplies intent before submitting.
  useEffect(() => {
    if (!aiSeed) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- responding to the aiSeed dispatch bus
    setInput(aiSeed.text)
    armedSeedRef.current = aiSeed.targetRegion
      ? { text: aiSeed.text, region: aiSeed.targetRegion }
      : undefined
    const el = inputRef.current
    if (el) {
      el.focus()
      el.setSelectionRange(aiSeed.text.length, aiSeed.text.length)
    }
  }, [aiSeed])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const message = input.trim()
    if (!message || pending) return
    // Attach the armed region (D5) only when the message still derives from
    // the seed text — if the user cleared it and typed something unrelated,
    // the region no longer applies. Consume it either way.
    const armed = armedSeedRef.current
    armedSeedRef.current = undefined
    const targetRegion =
      armed && message.startsWith(armed.text.trim()) ? armed.region : undefined
    setInput('')
    history.reset()
    await doSubmit(message, targetRegion ? { targetRegion } : undefined)
    inputRef.current?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowUp') {
      const prev = history.previous(input)
      if (prev !== undefined) {
        e.preventDefault()
        setInput(prev)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      const nxt = history.next()
      if (nxt !== undefined) {
        e.preventDefault()
        setInput(nxt)
      }
    }
  }

  function onChipPick(prompt: string) {
    setInput(prompt)
    inputRef.current?.focus()
  }

  return (
    <div className={styles.bar}>
      {!abc && (
        <p className={styles.headline}>What should we compose today?</p>
      )}

      <form onSubmit={onSubmit} className={styles.form}>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={
            isBlankCanvas
              ? 'Describe a melody or ask for help…'
              : isFreshImport
                ? 'Refine the imported score…'
                : abc
                  ? 'Refine the score…'
                  : 'Describe a melody, key, mood…'
          }
          aria-label="Music request"
          className={styles.input}
        />
        <button
          type="submit"
          disabled={pending || !input.trim()}
          className={styles.sendButton}
          data-phase={phase}
          aria-label={ariaLabelForPhase(phase)}
        >
          <SendButtonContent phase={phase} />
        </button>
      </form>

      <EditsIncludedHint active={focused || input.length > 0} />

      {!abc && (
        <>
          <SuggestionChips onPick={onChipPick} />
          <button
            type="button"
            className={styles.blankLink}
            onClick={() => {
              void createBlankScore()
            }}
          >
            or start with a blank score
          </button>
        </>
      )}
      {isFreshImport && !isBlankCanvas && (
        <SuggestionChips onPick={onChipPick} variant="imported" />
      )}
      {isBlankCanvas && <SuggestionChips onPick={onChipPick} variant="blank" />}
    </div>
  )
}

function ariaLabelForPhase(phase: PromptPhase): string {
  switch (phase) {
    case 'composing':
    case 'sending':
      return 'Generating'
    case 'arriving':
      return 'Rendering score'
    case 'done':
      return 'Done'
    default:
      return 'Send'
  }
}

function SendButtonContent({ phase }: { phase: PromptPhase }) {
  if (phase === 'composing' || phase === 'sending' || phase === 'arriving') {
    return (
      <span className={styles.pulse} aria-hidden="true">
        <span /><span /><span />
      </span>
    )
  }
  if (phase === 'done') {
    return (
      <span className={styles.check} aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 7.5l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    )
  }
  return <span>Send</span>
}
