'use client'

import { useEffect, useRef, useState } from 'react'
import { useChatStore, effectiveActiveDuration, type ActiveAccidental, type BaseDuration } from '@/lib/chat/state'
import { KeySchema, type Clef, type Pitch } from '@/lib/music/types'
import { ALLOWED_DENOMINATORS, METER_PRESETS, isValidMeter, MAX_NUMERATOR } from '@/lib/music/meter'
import { smartInsertNote } from '@/lib/music/smartInsertNote'
import {
  getActiveStaffClef,
  getMeasureCount,
  getStaffClef,
  getStaffCount,
} from '@/lib/music/scoreAccessors'
import ChordPalette from './ChordPalette'
import ScoreMetadataPopover, { type ScoreMetadataPatch } from './ScoreMetadataPopover'
import StavesControl from './StavesControl'
import SubMenu from './SubMenu'
import VoicesControl from './VoicesControl'
import styles from './EditorToolbar.module.css'

const KEYS = KeySchema.options
const CUSTOM_METER_VALUE = '__custom__'

// Picker glyphs share the vocabulary used in NoteFloatingMenu so the
// "before" and "after" placement UIs feel like the same toolset.
const PICKER_DURATIONS: Array<{ key: BaseDuration; label: string; title: string }> = [
  { key: 'whole', label: '𝅝', title: 'Whole (6)' },
  { key: 'half', label: '𝅗𝅥', title: 'Half (5)' },
  { key: 'quarter', label: '♩', title: 'Quarter (4)' },
  { key: 'eighth', label: '♪', title: 'Eighth (3)' },
  { key: 'sixteenth', label: '𝅘𝅥𝅯', title: 'Sixteenth (2)' },
  { key: '32nd', label: '𝅘𝅥𝅰', title: 'Thirty-second (1)' },
]

const PICKER_ACCIDENTALS: Array<{ key: Exclude<ActiveAccidental, 'none'>; label: string; title: string }> = [
  { key: 'sharp', label: '♯', title: 'Sharp (=)' },
  { key: 'natural', label: '♮', title: 'Natural (0)' },
  { key: 'flat', label: '♭', title: 'Flat (-)' },
]

// Dotted notation is only valid for the middle three values; the dot
// toggle is disabled for whole/sixteenth/32nd since the schema rejects
// those dotted variants.
const DOTTABLE_DURATIONS: BaseDuration[] = ['half', 'quarter', 'eighth']

function isPreset(meter: string): boolean {
  return (METER_PRESETS as readonly string[]).includes(meter)
}

function parseCustomMeter(meter: string): { num: number; den: number } {
  // Fall back to 4/4 for the custom-mode inputs whenever the current
  // meter isn't a plain n/d (e.g. it's "C" or "C|", or empty). The
  // user can adjust from there.
  const m = meter.match(/^(\d+)\/(\d+)$/)
  if (!m) return { num: 4, den: 4 }
  const num = Number(m[1])
  const den = Number(m[2])
  return {
    num: Number.isFinite(num) ? num : 4,
    den: ALLOWED_DENOMINATORS.includes(den as typeof ALLOWED_DENOMINATORS[number]) ? den : 4,
  }
}

export default function EditorToolbar() {
  const editedScore = useChatStore((s) => s.editedScore)
  const scoreJson = useChatStore((s) => s.scoreJson)
  const selection = useChatStore((s) => s.selection)
  const applyEdit = useChatStore((s) => s.applyEdit)
  const applyScore = useChatStore((s) => s.applyScore)
  const undo = useChatStore((s) => s.undo)
  const redo = useChatStore((s) => s.redo)
  const resetEditsToLLM = useChatStore((s) => s.resetEditsToLLM)
  const historyPointer = useChatStore((s) => s.historyPointer)
  const historyLen = useChatStore((s) => s.history.length)
  const activeDuration = useChatStore((s) => s.activeDuration)
  const activeDotted = useChatStore((s) => s.activeDotted)
  const activeAccidental = useChatStore((s) => s.activeAccidental)
  const setActiveDuration = useChatStore((s) => s.setActiveDuration)
  const toggleActiveDotted = useChatStore((s) => s.toggleActiveDotted)
  const setActiveAccidental = useChatStore((s) => s.setActiveAccidental)

  const currentMeter = editedScore?.meter ?? '4/4'
  const meterIsPreset = isPreset(currentMeter)
  const [customMode, setCustomMode] = useState(!meterIsPreset)
  const [customNum, setCustomNum] = useState(() => parseCustomMeter(currentMeter).num)
  const [customDen, setCustomDen] = useState(() => parseCustomMeter(currentMeter).den)
  const chordPaletteOpen = useChatStore((s) => s.chordPaletteOpen)
  const setChordPaletteOpen = useChatStore((s) => s.setChordPaletteOpen)
  const [chordAnchor, setChordAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const chordTriggerRef = useRef<HTMLButtonElement>(null)

  // Score Info popover (M8-PR-5) — edits Score-level metadata
  // (title / composer / arranger / lyricist / copyright) via a
  // single setScoreMetadata op so the whole patch lands as one
  // undo-history entry.
  const [scoreInfoOpen, setScoreInfoOpen] = useState(false)
  const [scoreInfoAnchor, setScoreInfoAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const scoreInfoTriggerRef = useRef<HTMLButtonElement>(null)

  // Score-setup controls (key / meter / tempo / staves / clefs /
  // voices) collapse behind a single Setup submenu so the toolbar's
  // high-frequency note-entry + insert controls stay prominent. Single
  // open-state value: 'setup' | null.
  const [activeSubmenu, setActiveSubmenu] = useState<'setup' | null>(null)

  // M23-PR-2: open Score Info when the command palette publishes a
  // matching request. The palette doesn't know our toolbar trigger
  // ref, so we anchor to the trigger ourselves (same behavior as a
  // click on the toolbar button). Effect depends on the request object
  // (which includes a bumped nonce on every publish) so back-to-back
  // "Open Score Info" commands re-open the popover rather than
  // no-opping after the first.
  const paletteRequest = useChatStore((s) => s.paletteRequest)
  useEffect(() => {
    if (paletteRequest?.kind !== 'open-score-info') return
    const r = scoreInfoTriggerRef.current?.getBoundingClientRect()
    if (r) {
      setScoreInfoAnchor({ x: r.left + r.width / 2, y: r.bottom })
    }
    setScoreInfoOpen(true)
    // Clear via getState() rather than a selector dep so the effect
    // depends only on the request itself (Zustand setters ARE stable
    // across renders, but keeping the dep array minimal documents that
    // the clear is a side-effect and not a reactivity input).
    useChatStore.getState().setPaletteRequest(undefined)
  }, [paletteRequest])

  // When the palette is opened via the `c` keyboard shortcut (or
  // any non-button source), seed the anchor near the toolbar
  // trigger so it appears in a predictable place.
  useEffect(() => {
    if (!chordPaletteOpen) return
    if (chordAnchor.x !== 0 || chordAnchor.y !== 0) return
    const r = chordTriggerRef.current?.getBoundingClientRect()
    if (r) setChordAnchor({ x: r.left + r.width / 2, y: r.bottom })
  }, [chordPaletteOpen, chordAnchor])

  // Sync custom mode + inputs when the score's meter changes from
  // outside the toolbar (LLM edits, undo/redo, score reload).
  useEffect(() => {
    if (!isPreset(currentMeter)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing toolbar UI when meter changes from outside (LLM edits, undo/redo, reload)
      setCustomMode(true)
      const parsed = parseCustomMeter(currentMeter)
      setCustomNum(parsed.num)
      setCustomDen(parsed.den)
    }
  }, [currentMeter])

  if (!editedScore) return null

  const canUndo = historyPointer > 0
  const canRedo = historyPointer < historyLen - 1
  const hasEdits = scoreJson !== undefined && historyPointer > 0
  const customMeterStr = `${customNum}/${customDen}`
  const customMeterValid = isValidMeter(customMeterStr)

  const dispatchCustomMeter = (n: number, d: number) => {
    const next = `${n}/${d}`
    if (isValidMeter(next) && next !== editedScore.meter) {
      applyEdit({ kind: 'changeMeter', meter: next as typeof editedScore.meter })
    }
  }

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Score editor">
      <SubMenu
        open={activeSubmenu === 'setup'}
        label="Setup"
        title="Key, meter, tempo, staves, clefs, voices"
        ariaLabel="Score setup"
        onOpen={() => setActiveSubmenu('setup')}
        onClose={() => setActiveSubmenu(null)}
        layout="column"
        estimatedWidth={260}
        estimatedHeight={340}
      >
      <div className={styles.group}>
        <span className={styles.label}>Key</span>
        <select
          className={styles.select}
          value={editedScore.key}
          onChange={(e) => applyEdit({ kind: 'changeKey', key: e.target.value as typeof editedScore.key })}
          aria-label="Key signature"
        >
          {KEYS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>

      <div className={styles.group}>
        <span className={styles.label}>Meter</span>
        <select
          className={styles.select}
          value={customMode ? CUSTOM_METER_VALUE : editedScore.meter}
          onChange={(e) => {
            const v = e.target.value
            if (v === CUSTOM_METER_VALUE) {
              setCustomMode(true)
              return
            }
            setCustomMode(false)
            applyEdit({ kind: 'changeMeter', meter: v as typeof editedScore.meter })
          }}
          aria-label="Time signature"
          title="Pick a preset or choose Custom… for odd meters like 5/4, 7/8, 11/8"
        >
          {METER_PRESETS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
          <option value={CUSTOM_METER_VALUE}>Custom…</option>
        </select>
        {customMode && (
          <span className={styles.meterCustomGroup} role="group" aria-label="Custom time signature">
            <input
              type="number"
              className={`${styles.numberInput} ${styles.meterNumInput}`}
              value={customNum}
              min={1}
              max={MAX_NUMERATOR}
              aria-label="Numerator"
              aria-invalid={!customMeterValid}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (!Number.isFinite(n)) return
                setCustomNum(n)
                dispatchCustomMeter(n, customDen)
              }}
            />
            <span className={styles.meterSlash} aria-hidden="true">/</span>
            <select
              className={styles.select}
              value={customDen}
              aria-label="Denominator"
              onChange={(e) => {
                const d = Number(e.target.value)
                setCustomDen(d)
                dispatchCustomMeter(customNum, d)
              }}
            >
              {ALLOWED_DENOMINATORS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </span>
        )}
      </div>

      <div className={styles.group}>
        <span className={styles.label}>Tempo</span>
        <input
          type="number"
          className={styles.numberInput}
          value={editedScore.tempo_bpm ?? 100}
          min={30}
          max={240}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n) && n >= 30 && n <= 240) {
              applyEdit({ kind: 'changeTempo', tempo_bpm: n })
            }
          }}
          aria-label="Tempo BPM"
        />
      </div>

      <StavesControl />

      {getStaffCount(editedScore) === 1 ? (
        <>
          <div className={styles.group}>
            <span className={styles.label}>Clef</span>
            <select
              className={styles.select}
              value={getStaffClef(editedScore, 0)}
              onChange={(e) =>
                applyEdit({
                  kind: 'changeClef',
                  clef: e.target.value as Clef,
                  staffIdx: 0,
                })
              }
              aria-label="Staff clef"
              title="Treble (G clef) or bass (F clef). Notes keep their pitches; only the staff display changes."
            >
              <option value="treble">Treble</option>
              <option value="bass">Bass</option>
            </select>
          </div>
          <VoicesControl staffIdx={0} />
        </>
      ) : (
        <>
          <div className={styles.group}>
            <span className={styles.label}>Top</span>
            <select
              className={styles.select}
              value={getStaffClef(editedScore, 0)}
              onChange={(e) =>
                applyEdit({
                  kind: 'changeClef',
                  clef: e.target.value as Clef,
                  staffIdx: 0,
                })
              }
              aria-label="Top staff clef"
            >
              <option value="treble">Treble</option>
              <option value="bass">Bass</option>
            </select>
            <VoicesControl staffIdx={0} />
          </div>
          <div className={styles.group}>
            <span className={styles.label}>Bottom</span>
            <select
              className={styles.select}
              value={getStaffClef(editedScore, 1)}
              onChange={(e) =>
                applyEdit({
                  kind: 'changeClef',
                  clef: e.target.value as Clef,
                  staffIdx: 1,
                })
              }
              aria-label="Bottom staff clef"
            >
              <option value="treble">Treble</option>
              <option value="bass">Bass</option>
            </select>
            <VoicesControl staffIdx={1} />
          </div>
        </>
      )}
      </SubMenu>

      <span className={styles.divider} />

      <div className={styles.group} role="group" aria-label="Note picker">
        <span className={styles.label}>Note</span>
        {PICKER_DURATIONS.map(({ key, label, title }) => (
          <button
            key={key}
            type="button"
            className={`${styles.pickerButton} ${activeDuration === key ? styles.pickerButtonActive : ''}`}
            title={title}
            aria-pressed={activeDuration === key}
            onClick={() => setActiveDuration(key)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className={`${styles.pickerButton} ${activeDotted ? styles.pickerButtonActive : ''}`}
          title="Dotted (adds half the value again). Applies to half, quarter, eighth."
          aria-pressed={activeDotted}
          disabled={!DOTTABLE_DURATIONS.includes(activeDuration)}
          onClick={toggleActiveDotted}
        >
          .
        </button>
        {PICKER_ACCIDENTALS.map(({ key, label, title }) => (
          <button
            key={key}
            type="button"
            className={`${styles.pickerButton} ${activeAccidental === key ? styles.pickerButtonActive : ''}`}
            title={title}
            aria-pressed={activeAccidental === key}
            onClick={() => setActiveAccidental(activeAccidental === key ? 'none' : key)}
          >
            {label}
          </button>
        ))}
      </div>

      <span className={styles.divider} />

      <button
        type="button"
        className={styles.iconButton}
        title="Append empty measure"
        onClick={() =>
          applyEdit({ kind: 'insertMeasureAfter', measureIdx: getMeasureCount(editedScore) - 1 })
        }
      >
        + Measure
      </button>

      <button
        type="button"
        className={styles.iconButton}
        title="Append a note using the picker settings, respecting bar lines"
        onClick={() => {
          const activeStaffIdx = selection?.staffIdx ?? 0
          const activeVoiceIdx = selection?.voiceIdx ?? 0
          const activeClef = getActiveStaffClef(editedScore, activeStaffIdx)
          const seed: Pitch =
            activeClef === 'bass'
              ? { step: 'C', octave: 3 }
              : { step: 'C', octave: 4 }
          if (activeAccidental !== 'none') seed.accidental = activeAccidental
          const result = smartInsertNote(
            editedScore,
            undefined,
            {
              pitches: [seed],
              duration: effectiveActiveDuration(activeDuration, activeDotted),
            },
            activeStaffIdx,
            activeVoiceIdx,
          )
          applyScore(result.score, {
            selection: result.newSelection,
            statusMessage: result.statusMessage,
          })
        }}
      >
        + Note
      </button>

      <button
        ref={chordTriggerRef}
        type="button"
        className={styles.iconButton}
        title="Insert a chord — pick a root and quality"
        onClick={() => {
          const r = chordTriggerRef.current?.getBoundingClientRect()
          if (r) setChordAnchor({ x: r.left + r.width / 2, y: r.bottom })
          setChordPaletteOpen(true)
        }}
      >
        + Chord
      </button>

      <ChordPalette
        open={chordPaletteOpen}
        anchorX={chordAnchor.x}
        anchorY={chordAnchor.y}
        scoreKey={editedScore.key}
        onClose={() => setChordPaletteOpen(false)}
        onSubmit={(pitches: Pitch[]) => {
          const activeStaffIdx = selection?.staffIdx ?? 0
          const activeVoiceIdx = selection?.voiceIdx ?? 0
          const result = smartInsertNote(
            editedScore,
            undefined,
            { pitches, duration: 'quarter' },
            activeStaffIdx,
            activeVoiceIdx,
          )
          applyScore(result.score, {
            selection: result.newSelection,
            statusMessage: result.statusMessage ?? `Inserted chord (${pitches.length} pitches)`,
          })
        }}
      />

      <span className={styles.divider} />

      <button
        type="button"
        className={styles.iconButton}
        title="Undo (Ctrl+Z)"
        onClick={undo}
        disabled={!canUndo}
        aria-label="Undo"
      >
        ↶
      </button>
      <button
        type="button"
        className={styles.iconButton}
        title="Redo (Ctrl+Shift+Z)"
        onClick={redo}
        disabled={!canRedo}
        aria-label="Redo"
      >
        ↷
      </button>

      {hasEdits && (
        <button
          type="button"
          className={styles.iconButton}
          title="Discard your edits and restore the LLM's last response"
          onClick={resetEditsToLLM}
        >
          Reset to AI
        </button>
      )}

      <button
        ref={scoreInfoTriggerRef}
        type="button"
        className={styles.iconButton}
        title="Edit score info (title, composer, copyright)"
        aria-label="Score info"
        onClick={() => {
          const r = scoreInfoTriggerRef.current?.getBoundingClientRect()
          if (r) setScoreInfoAnchor({ x: r.left + r.width / 2, y: r.bottom })
          setScoreInfoOpen(true)
        }}
      >
        ℹ
      </button>

      <ScoreMetadataPopover
        open={scoreInfoOpen}
        anchorX={scoreInfoAnchor.x}
        anchorY={scoreInfoAnchor.y}
        current={editedScore}
        onClose={() => setScoreInfoOpen(false)}
        onSubmit={(patch: ScoreMetadataPatch) => {
          // Skip dispatch when the patch is empty (the user opened
          // and closed without changes, OR cleared then restored a
          // field to the same value). Avoids a no-op undo entry.
          const hasAnyField = Object.values(patch).some((v) => v !== undefined)
          if (hasAnyField) {
            applyEdit({ kind: 'setScoreMetadata', patch })
          }
          setScoreInfoOpen(false)
        }}
      />
    </div>
  )
}
