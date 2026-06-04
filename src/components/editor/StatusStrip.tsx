'use client'

import { useEffect } from 'react'
import { useChatStore } from '@/lib/chat/state'
import {
  getStaffClef,
  getStaffCount,
  getVoiceCount,
  getVoiceEventAt,
} from '@/lib/music/scoreAccessors'
import styles from './StatusStrip.module.css'

function describePitch(step: string, octave: number, accidental?: string): string {
  if (step === 'rest') return 'rest'
  const acc = accidental === 'sharp' ? '♯' : accidental === 'flat' ? '♭' : accidental === 'natural' ? '♮' : ''
  return `${step}${acc}${octave}`
}

export default function StatusStrip() {
  const editedScore = useChatStore((s) => s.editedScore)
  const selection = useChatStore((s) => s.selection)
  const historyPointer = useChatStore((s) => s.historyPointer)
  const scoreJson = useChatStore((s) => s.scoreJson)
  const statusMessage = useChatStore((s) => s.statusMessage)
  const showStatusMessage = useChatStore((s) => s.showStatusMessage)

  useEffect(() => {
    if (!statusMessage) return
    const t = setTimeout(() => showStatusMessage(undefined), 2_500)
    return () => clearTimeout(t)
  }, [statusMessage, showStatusMessage])

  if (!editedScore) return null

  const selectedEvent = selection
    ? getVoiceEventAt(
        editedScore,
        selection.staffIdx ?? 0,
        selection.voiceIdx ?? 0,
        selection.measureIdx,
        selection.eventIdx,
      )
    : undefined
  const selectedPitch = selectedEvent?.pitches[selection?.pitchIdx ?? 0]
  const hasEdits = scoreJson !== undefined && historyPointer > 0

  return (
    <div className={styles.strip} role="status" aria-live="polite">
      <div className={styles.left}>
        {selection && selectedPitch ? (
          <>
            {(() => {
              const staffIdx = selection.staffIdx ?? 0
              const voiceIdx = selection.voiceIdx ?? 0
              const clef = getStaffClef(editedScore, staffIdx)
              const showClef = clef === 'bass' || getStaffCount(editedScore) > 1
              const showVoice = getVoiceCount(editedScore, staffIdx) > 1
              return (
                <>
                  {showClef && (
                    <>
                      <span className={styles.value}>{clef === 'bass' ? 'Bass' : 'Treble'}</span>
                      <span>·</span>
                    </>
                  )}
                  {showVoice && (
                    <>
                      <span className={styles.value}>V{voiceIdx + 1}</span>
                      <span>·</span>
                    </>
                  )}
                </>
              )
            })()}
            <span>m.<span className={styles.value}>{selection.measureIdx + 1}</span></span>
            <span>·</span>
            <span className={styles.value}>{describePitch(selectedPitch.step, selectedPitch.octave, selectedPitch.accidental)}</span>
            <span>·</span>
            <span className={styles.value}>{selectedEvent?.duration}</span>
          </>
        ) : (
          <span>Click a note to edit</span>
        )}
        {statusMessage && (
          <>
            <span>·</span>
            <span className={styles.status}>{statusMessage}</span>
          </>
        )}
      </div>
      <div className={styles.right}>
        {hasEdits && <span className={styles.pill}>✎ edited</span>}
      </div>
    </div>
  )
}
