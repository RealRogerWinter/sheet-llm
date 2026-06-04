'use client'

import { create } from 'zustand'
import type { ChatDebugOverrides, ChatDebugPayload } from '@/lib/shared/types'

export type OrchestratorOverride = 'auto' | 'on' | 'off' | 'shadow'

/**
 * Debug-panel paywall toggle. `auto` sends no override (the server resolves
 * the tier from env / entitlement); `free` forces the bounded ≤4-bar
 * generation (paywall ON); `pro` forces full sectional / whole-score
 * generation (paywall OFF). The server still lets the operator
 * `SL_FORCE_FREE_TIER` kill switch override a `pro` request.
 */
export type GenerationTierOverride = 'auto' | 'free' | 'pro'

interface DebugStore {
  /** Per-request orchestrator override. 'auto' = let the server decide. */
  orchestratorOverride: OrchestratorOverride
  /** Optional model id override. Empty string = no override. */
  modelOverride: string
  /**
   * Optional Anthropic API key, supplied via the debug panel for quick
   * local testing without having to restart the dev server with a new
   * env var. Empty string = no override (use server's env). Held in
   * memory only — intentionally NOT persisted to localStorage.
   */
  apiKeyOverride: string
  /** Last debug payload from a chat response. */
  lastDebug: ChatDebugPayload | undefined
  /** Visibility of the panel UI. */
  panelOpen: boolean
  /**
   * Client-side kill switch for the composing / per-note reveal
   * animation. When false, ScoreStage shows the legacy pending dim and
   * ScorePanel skips the FOUC-safe opacity hide so notes appear
   * instantly. Default true; lives only in-memory so a refresh resets.
   */
  revealAnimationEnabled: boolean
  /**
   * Per-request paywall-tier override. 'auto' = let the server resolve the
   * tier (default). Lives only in-memory so a refresh resets to 'auto'.
   */
  generationTierOverride: GenerationTierOverride

  setOrchestratorOverride: (v: OrchestratorOverride) => void
  setModelOverride: (v: string) => void
  setApiKeyOverride: (v: string) => void
  setLastDebug: (d: ChatDebugPayload | undefined) => void
  togglePanel: () => void
  setPanelOpen: (v: boolean) => void
  setRevealAnimationEnabled: (v: boolean) => void
  setGenerationTierOverride: (v: GenerationTierOverride) => void
}

export const useDebugStore = create<DebugStore>((set) => ({
  orchestratorOverride: 'auto',
  modelOverride: '',
  apiKeyOverride: '',
  lastDebug: undefined,
  panelOpen: true,
  revealAnimationEnabled: true,
  generationTierOverride: 'auto',

  setOrchestratorOverride: (v) => set({ orchestratorOverride: v }),
  setModelOverride: (v) => set({ modelOverride: v }),
  setApiKeyOverride: (v) => set({ apiKeyOverride: v }),
  setLastDebug: (d) => set({ lastDebug: d }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPanelOpen: (v) => set({ panelOpen: v }),
  setRevealAnimationEnabled: (v) => set({ revealAnimationEnabled: v }),
  setGenerationTierOverride: (v) => set({ generationTierOverride: v }),
}))

/**
 * Build the `debug` field for the chat request from the current
 * store state. Returns undefined when nothing is overridden, so we
 * don't ship empty objects to the server.
 */
export function buildDebugOverrides(
  o: OrchestratorOverride,
  modelOverride: string,
  apiKeyOverride: string,
  generationTierOverride: GenerationTierOverride = 'auto',
): ChatDebugOverrides | undefined {
  const out: ChatDebugOverrides = {}
  if (o !== 'auto') out.orchestrator = o
  if (modelOverride.trim().length > 0) out.modelOverride = modelOverride.trim()
  if (apiKeyOverride.trim().length > 0) out.apiKey = apiKeyOverride.trim()
  if (generationTierOverride !== 'auto') out.generationTier = generationTierOverride
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Returns true when the debug panel should be available in the UI.
 * Enabled in dev (NODE_ENV=development) OR when explicitly turned on
 * via NEXT_PUBLIC_DEBUG_PANEL=true (also accepts '1').
 */
export function isDebugPanelEnabled(): boolean {
  if (process.env.NODE_ENV === 'development') return true
  const flag = process.env.NEXT_PUBLIC_DEBUG_PANEL
  return flag === 'true' || flag === '1'
}
