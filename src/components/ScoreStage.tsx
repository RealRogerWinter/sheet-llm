'use client'

import { useEffect, useRef, useState } from 'react'
import ScorePanel from './ScorePanel'
import TransportHost from './transport/TransportHost'
import BlankStaff from './BlankStaff'
import ComposingStaff from './ComposingStaff'
import { useNoteClickHandler } from './editor/useNoteClickHandler'
import { publishVisualObj } from './editor/useVisualObjRegistry'
import { useChatStore } from '@/lib/chat/state'
import { useDebugStore } from '@/lib/debug/debugStore'
import styles from './ScoreStage.module.css'

interface ScoreStageProps {
  abc: string | undefined
  pending: boolean
  lastPrompt?: string
}

export default function ScoreStage({ abc, pending, lastPrompt }: ScoreStageProps) {
  const [outgoing, setOutgoing] = useState<string | undefined>(undefined)
  const prevAbcRef = useRef<string | undefined>(undefined)
  const epoch = useChatStore((s) => s.epoch)
  const revealStartedAt = useChatStore((s) => s.revealStartedAt)
  const streamProgress = useChatStore((s) => s.streamProgress)
  const prevEpochRef = useRef<number>(epoch)
  const clickListener = useNoteClickHandler()
  const revealAnimationEnabled = useDebugStore((s) => s.revealAnimationEnabled)
  // While a sectional generation streams in, the score grows section by
  // section. It is NOT final, so render it read-only: an edit now would be
  // clobbered by the next incoming section. Editing unlocks on the terminal
  // `done` frame (resolveRequest clears streamProgress).
  const streaming = streamProgress !== undefined

  // Crossfade only when epoch advances (a fresh LLM response replaced
  // the score). Local edits change `abc` but not `epoch`, so they
  // re-render the same ScorePanel in place without a fade.
  useEffect(() => {
    if (prevEpochRef.current !== epoch && prevAbcRef.current) {
      setOutgoing(prevAbcRef.current)
      const t = setTimeout(() => setOutgoing(undefined), 250)
      prevEpochRef.current = epoch
      prevAbcRef.current = abc
      return () => clearTimeout(t)
    }
    prevEpochRef.current = epoch
    prevAbcRef.current = abc
  }, [epoch, abc])

  // When the score is cleared (e.g., New Score), drop the published
  // visualObj so SynthHost stops referencing a stale tune.
  useEffect(() => {
    if (!abc) publishVisualObj(undefined)
  }, [abc])

  const showBlank = !abc && !outgoing
  const revealActive = revealAnimationEnabled && revealStartedAt !== null
  // Editing surface keeps its dim+desaturate while waiting; the hero
  // surface lets ComposingStaff carry the wait so we don't double-dim
  // the blank substrate underneath it.
  const showLegacyDim = pending && (!revealAnimationEnabled || !!abc)
  const showComposingHero = pending && !abc && !outgoing && revealAnimationEnabled
  const showComposingOverlay = pending && !!abc && revealAnimationEnabled

  return (
    <div
      className={`${styles.stage} ${showBlank ? styles.stageBare : ''} ${showLegacyDim ? styles.pending : ''} ${showComposingOverlay ? styles.editingComposing : ''}`}
      role="region"
      aria-label="Sheet music score"
      aria-live="polite"
      aria-atomic="false"
    >
      <span style={{ position: 'absolute', left: '-9999px' }}>
        {showComposingHero || showComposingOverlay ? 'Composing your score' : ''}
        {abc && lastPrompt ? `Score updated: ${lastPrompt}` : ''}
      </span>

      {showBlank && !showComposingHero && <BlankStaff className={styles.blank} />}
      {showComposingHero && <ComposingStaff className={styles.blank} />}

      {outgoing && (
        <div className={`${styles.layer} ${styles.layerStacked} ${styles.outgoing}`} key="outgoing">
          <ScorePanel abc={outgoing} />
        </div>
      )}

      {abc && (
        <div
          className={`${styles.layer} ${outgoing ? styles.layerStacked : ''} ${styles.incoming}`}
          key="incoming"
          data-revealing={revealActive ? 'true' : undefined}
        >
          <ScorePanel
            abc={abc}
            clickListener={streaming ? undefined : clickListener}
            interactive={!streaming}
            publishVisual
            reveal={revealAnimationEnabled && !streaming}
          />
        </div>
      )}

      {showComposingOverlay && (
        <div className={styles.composingOverlay} key="composing-overlay">
          <ComposingStaff variant="overlay" />
        </div>
      )}

      {abc && <TransportHost />}
    </div>
  )
}
