'use client'

import { useRef, useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import ScoreStage from './ScoreStage'
import ExportBar from './ExportBar'
import ScoreZoomBar from './ScoreZoomBar'
import PromptBar from './PromptBar'
import LastPromptLabel from './LastPromptLabel'
import LastConfirmationLabel from './LastConfirmationLabel'
import ErrorToast from './ErrorToast'
import EditorToolbar from './editor/EditorToolbar'
import NoteFloatingMenu from './editor/NoteFloatingMenu'
import { ContextMenu } from './editor/ContextMenu'
import EditedPill from './editor/EditedPill'
import Coachmark from './editor/Coachmark'
import CheatSheet from './editor/CheatSheet'
import CommandPalette from './editor/CommandPalette'
import { useCommandPalette } from './editor/useCommandPalette'
import { useScoreWheelZoom } from './editor/useScoreWheelZoom'
import { usePinchZoom } from './editor/usePinchZoom'
import UndoToast from './editor/UndoToast'
import { MeasureDeleteConfirmModal } from './editor/MeasureDeleteConfirmModal'
import StatusStrip from './editor/StatusStrip'
import BlankScoreHint from './editor/BlankScoreHint'
import { ReplacementConfirmModal } from './orchestrator/ReplacementConfirmModal'
import { GhostPreviewAmber } from './orchestrator/GhostPreviewAmber'
import { GhostPreviewOverlay } from './orchestrator/GhostPreviewOverlay'
import { ResumeProposalToast } from './orchestrator/ResumeProposalToast'
import styles from './Hero.module.css'

export default function Hero() {
  const abc = useChatStore((s) => s.abc)
  const pending = useChatStore((s) => s.pending)
  const lastPrompt = useChatStore((s) => s.lastPrompt)
  const scoreJson = useChatStore((s) => s.scoreJson)
  // MusicXML export should reflect the user's CURRENT edits, not the
  // LLM baseline; fall back to scoreJson if editedScore isn't set
  // (e.g. legacy persisted sessions where the migration didn't run).
  const editedScore = useChatStore((s) => s.editedScore)
  const exportScore = editedScore ?? scoreJson

  // M24-PR-3b — AI ghost preview. When a proposal is pending, render
  // the candidate's abc in ScoreStage so the user SEES the AI's
  // proposed changes. editedScore / scoreJson stay at the pre-proposal
  // state until the user accepts (PR-3c handles the network
  // roundtrip + score swap). Both presentations (inline / diff-panel)
  // swap; the difference is overlay treatment (PR-3c / PR-4).
  //
  // Export Bar deliberately uses the user's CURRENT (pre-proposal)
  // score so an in-progress export doesn't capture an un-accepted
  // proposal. Same with the title shown in the export bar.
  const pendingProposal = useChatStore((s) => s.pendingProposal)
  const displayedAbc = pendingProposal?.abc ?? abc

  // M23-PR-1: ⌘K command palette. Available regardless of whether a
  // score is loaded (so users without a score can still use it to,
  // e.g., open the cheat sheet). Keybind fires globally.
  const [paletteOpen, setPaletteOpen] = useState(false)
  useCommandPalette(() => setPaletteOpen(true))

  // Ctrl/⌘ + wheel (and trackpad pinch) zoom the score; plain wheel is
  // left alone so the page still scrolls. Only active with a score.
  const scoreAreaRef = useRef<HTMLDivElement>(null)
  useScoreWheelZoom(scoreAreaRef, !!abc)
  // Two-finger pinch-zoom for touchscreens (the wheel handler only covers
  // trackpad pinch via synthesized ctrlKey-wheel).
  usePinchZoom(scoreAreaRef, !!abc)

  return (
    <main className={styles.hero}>
      {abc && <EditorToolbar />}

      <div ref={scoreAreaRef} className={`${styles.scoreArea} ${!abc ? styles.empty : ''}`}>
        {abc && (
          <div className={styles.viewportTools}>
            <ScoreZoomBar />
          </div>
        )}
        <ScoreStage abc={displayedAbc} pending={pending} lastPrompt={lastPrompt} />
        {abc && <BlankScoreHint />}
        {abc && <StatusStrip />}
        {abc && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
            <EditedPill />
          </div>
        )}
        {abc && <ExportBar abc={abc} title={scoreJson?.title} score={exportScore} />}
      </div>

      <div className={styles.promptArea}>
        <ErrorToast />
        <PromptBar />
        {abc && <LastConfirmationLabel />}
        {abc && <LastPromptLabel prompt={lastPrompt} />}
      </div>

      <NoteFloatingMenu />
      <ContextMenu />
      <Coachmark />
      <CheatSheet />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <UndoToast />
      <MeasureDeleteConfirmModal />
      <ReplacementConfirmModal />
      <GhostPreviewAmber />
      <GhostPreviewOverlay />
      <ResumeProposalToast />
    </main>
  )
}
