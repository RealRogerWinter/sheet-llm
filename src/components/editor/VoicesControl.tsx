'use client'

import { useChatStore } from '@/lib/chat/state'
import { getVoiceCount, voiceHasContent } from '@/lib/music/scoreAccessors'
import styles from './VoicesControl.module.css'

interface VoicesControlProps {
  staffIdx: number
}

const MAX_VOICES_PER_STAFF = 4 // primary + 3 extras

/**
 * Per-staff voice management. Renders one chip per voice (V1..VN) and a
 * `+ Voice` button that's disabled at the cap. Extra voices (V2+) get
 * an inline × button; removing a voice with notes surfaces the existing
 * UndoToast pattern (matching PR A's Grand→Single behavior).
 *
 * V1 (the primary) has no × — to "remove voice 1" the user must remove
 * the whole staff via the Staves control.
 *
 * Clicking a chip moves the active selection to that voice (first
 * measure / first event), so subsequent +Note / +Chord / keyboard
 * input targets the right voice.
 */
export default function VoicesControl({ staffIdx }: VoicesControlProps) {
  const editedScore = useChatStore((s) => s.editedScore)
  const selection = useChatStore((s) => s.selection)
  const applyEdit = useChatStore((s) => s.applyEdit)
  const select = useChatStore((s) => s.select)
  const pending = useChatStore((s) => s.pending)
  const showStatusMessage = useChatStore((s) => s.showStatusMessage)
  const showUndoToast = useChatStore((s) => s.showUndoToast)

  if (!editedScore) return null
  const voiceCount = getVoiceCount(editedScore, staffIdx)
  if (voiceCount === 0) return null

  const activeVoiceIdx =
    (selection?.staffIdx ?? 0) === staffIdx ? (selection?.voiceIdx ?? 0) : -1
  const atCap = voiceCount >= MAX_VOICES_PER_STAFF

  function onAdd() {
    if (!editedScore || atCap) return
    applyEdit({ kind: 'addVoice', staffIdx })
    const newVoiceIdx = voiceCount // pre-add count = post-add index
    showStatusMessage(`Added voice V${newVoiceIdx + 1}`)
    // Move selection to the new voice's first event so the next +Note
    // targets it.
    select({ staffIdx, voiceIdx: newVoiceIdx, measureIdx: 0, eventIdx: 0, pitchIdx: 0 })
  }

  function onRemove(voiceIdx: number) {
    if (!editedScore || voiceIdx < 1) return
    const hadContent = voiceHasContent(editedScore, staffIdx, voiceIdx)
    applyEdit({ kind: 'removeVoice', staffIdx, voiceIdx })
    if (hadContent) {
      showUndoToast(`Voice V${voiceIdx + 1} removed`)
    } else {
      showStatusMessage(`Removed empty voice V${voiceIdx + 1}`)
    }
  }

  function onChipClick(voiceIdx: number) {
    select({ staffIdx, voiceIdx, measureIdx: 0, eventIdx: 0, pitchIdx: 0 })
  }

  return (
    <div className={styles.group} role="group" aria-label={`Staff ${staffIdx + 1} voices`}>
      <span className={styles.chips}>
        {Array.from({ length: voiceCount }, (_, voiceIdx) => {
          const isActive = activeVoiceIdx === voiceIdx
          return (
            <span
              key={voiceIdx}
              className={`${styles.chip} ${isActive ? styles.chipActive : ''}`}
            >
              <button
                type="button"
                className={styles.chipLabel}
                title={`Activate voice V${voiceIdx + 1}`}
                onClick={() => onChipClick(voiceIdx)}
                disabled={pending}
              >
                V{voiceIdx + 1}
              </button>
              {voiceIdx >= 1 && (
                <button
                  type="button"
                  className={styles.chipRemove}
                  title={`Remove voice V${voiceIdx + 1}`}
                  aria-label={`Remove voice V${voiceIdx + 1}`}
                  onClick={() => onRemove(voiceIdx)}
                  disabled={pending}
                >
                  ×
                </button>
              )}
            </span>
          )
        })}
      </span>
      <button
        type="button"
        className={styles.addButton}
        title={atCap ? 'Maximum 4 voices per staff' : 'Add an empty voice to this staff'}
        onClick={onAdd}
        disabled={pending || atCap}
      >
        + Voice
      </button>
    </div>
  )
}
