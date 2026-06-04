'use client'

import { useState } from 'react'
import { useDebugStore, isDebugPanelEnabled } from '@/lib/debug/debugStore'
import type { OrchestratorOverride, GenerationTierOverride } from '@/lib/debug/debugStore'
import { quickImportFromUrl, quickImportText } from './import/quickImport'
import styles from './DebugPanel.module.css'

/**
 * One-click import shortcuts surfaced in the debug panel. URLs point
 * at fixtures under public/samples (served verbatim). The synthetic
 * 'long score' is generated client-side to exercise the truncation
 * choice path without needing a separate fixture file.
 */
const SAMPLE_IMPORTS: Array<{
  label: string
  load: () => Promise<string>
  note?: string
}> = [
  {
    label: 'Twinkle Twinkle',
    load: () => quickImportFromUrl('/samples/twinkle.abc'),
  },
  {
    label: 'Greensleeves',
    load: () => quickImportFromUrl('/samples/greensleeves.abc'),
    note: '6/8 minor with chromatic accidentals',
  },
  {
    label: 'Bach Minuet',
    load: () => quickImportFromUrl('/samples/bach-minuet.abc'),
    note: '3/4',
  },
  {
    label: 'Chord stack',
    load: () =>
      quickImportText(
        'X:1\nT:Chord stack demo\nM:4/4\nL:1/4\nK:C\n[CEG][CEG][CFA][CEG]|[DFA][DFA][DGB][DFA]|',
        'chord-stack.abc',
        'abc',
      ),
    note: 'block chords',
  },
  {
    label: 'Triplets',
    load: () =>
      quickImportText(
        'X:1\nT:Triplet demo\nM:4/4\nL:1/8\nK:C\n(3CDE F2 G2 A2|(3DEF G2 A2 B2|',
        'triplets.abc',
        'abc',
      ),
  },
]

const MODEL_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Default (orchestrator decides)', value: '' },
  // Anthropic
  { label: 'Anthropic Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  { label: 'Anthropic Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { label: 'Anthropic Opus 4.7', value: 'claude-opus-4-7' },
  // Groq (PR C)
  { label: 'Groq gpt-oss-20b', value: 'openai/gpt-oss-20b' },
  { label: 'Groq gpt-oss-120b', value: 'openai/gpt-oss-120b' },
]

const ORCHESTRATOR_OPTIONS: Array<{ label: string; value: OrchestratorOverride }> = [
  { label: 'Auto (server default)', value: 'auto' },
  { label: 'Force on (primary)', value: 'on' },
  { label: 'Force off (legacy path)', value: 'off' },
  { label: 'Shadow (legacy wins; orchestrator logs)', value: 'shadow' },
]

const GENERATION_TIER_OPTIONS: Array<{ label: string; value: GenerationTierOverride }> = [
  { label: 'Auto (server default)', value: 'auto' },
  { label: 'On — free tier (bounded ≤4 bars)', value: 'free' },
  { label: 'Off — pro tier (full generation)', value: 'pro' },
]

export default function DebugPanel() {
  const enabled = isDebugPanelEnabled()
  const panelOpen = useDebugStore((s) => s.panelOpen)
  const togglePanel = useDebugStore((s) => s.togglePanel)
  const orchestratorOverride = useDebugStore((s) => s.orchestratorOverride)
  const modelOverride = useDebugStore((s) => s.modelOverride)
  const apiKeyOverride = useDebugStore((s) => s.apiKeyOverride)
  const lastDebug = useDebugStore((s) => s.lastDebug)
  const generationTierOverride = useDebugStore((s) => s.generationTierOverride)
  const setOrchestratorOverride = useDebugStore((s) => s.setOrchestratorOverride)
  const setModelOverride = useDebugStore((s) => s.setModelOverride)
  const setApiKeyOverride = useDebugStore((s) => s.setApiKeyOverride)
  const setGenerationTierOverride = useDebugStore((s) => s.setGenerationTierOverride)
  const revealAnimationEnabled = useDebugStore((s) => s.revealAnimationEnabled)
  const setRevealAnimationEnabled = useDebugStore((s) => s.setRevealAnimationEnabled)
  const [importBusy, setImportBusy] = useState<string | undefined>(undefined)
  const [importStatus, setImportStatus] = useState<string | undefined>(undefined)

  async function runQuickImport(label: string, fn: () => Promise<string>) {
    setImportBusy(label)
    setImportStatus(undefined)
    try {
      const status = await fn()
      setImportStatus(`${label}: ${status}`)
    } catch (e) {
      setImportStatus(`${label}: ${e instanceof Error ? e.message : 'error'}`)
    } finally {
      setImportBusy(undefined)
    }
  }

  if (!enabled) return null

  if (!panelOpen) {
    return (
      <button
        type="button"
        className={`${styles.panel} ${styles.minimized}`}
        onClick={togglePanel}
        aria-label="Open debug panel"
      >
        <span className={styles.title}>debug</span>
      </button>
    )
  }

  return (
    <div className={styles.panel} role="complementary" aria-label="Debug panel">
      <div
        className={styles.header}
        onClick={togglePanel}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') togglePanel()
        }}
      >
        <span className={styles.title}>Debug</span>
        <button
          type="button"
          className={styles.headerToggle}
          onClick={(e) => {
            e.stopPropagation()
            togglePanel()
          }}
          aria-label="Collapse debug panel"
        >
          ✕
        </button>
      </div>

      <div className={styles.body}>
        <div className={styles.section}>
          <label htmlFor="dbg-orch" className={styles.label}>
            Orchestrator
          </label>
          <select
            id="dbg-orch"
            className={styles.select}
            value={orchestratorOverride}
            onChange={(e) => setOrchestratorOverride(e.target.value as OrchestratorOverride)}
          >
            {ORCHESTRATOR_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.section}>
          <label htmlFor="dbg-tier" className={styles.label}>
            Paywall mode
          </label>
          <select
            id="dbg-tier"
            className={styles.select}
            value={generationTierOverride}
            onChange={(e) => setGenerationTierOverride(e.target.value as GenerationTierOverride)}
          >
            {GENERATION_TIER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.section}>
          <label htmlFor="dbg-model" className={styles.label}>
            Model override
          </label>
          <select
            id="dbg-model"
            className={styles.select}
            value={MODEL_PRESETS.some((p) => p.value === modelOverride) ? modelOverride : ''}
            onChange={(e) => setModelOverride(e.target.value)}
          >
            {MODEL_PRESETS.map((opt) => (
              <option key={opt.value || 'default'} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.section}>
          <label htmlFor="dbg-apikey" className={styles.label}>
            Anthropic API key (dev only)
          </label>
          <input
            id="dbg-apikey"
            type="password"
            className={styles.input}
            value={apiKeyOverride}
            onChange={(e) => setApiKeyOverride(e.target.value)}
            placeholder="sk-ant-… (overrides server env)"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className={styles.section}>
          <span className={styles.label}>Reveal animation</span>
          <label className={styles.row}>
            <input
              type="checkbox"
              checked={revealAnimationEnabled}
              onChange={(e) => setRevealAnimationEnabled(e.target.checked)}
            />
            <span>Enable composing staff + per-note reveal</span>
          </label>
        </div>

        <div className={styles.section}>
          <span className={styles.label}>Quick imports</span>
          <div className={styles.quickRow}>
            {SAMPLE_IMPORTS.map((s) => (
              <button
                key={s.label}
                type="button"
                className={styles.quickChip}
                onClick={() => runQuickImport(s.label, s.load)}
                disabled={importBusy !== undefined}
                title={s.note ?? s.label}
              >
                {importBusy === s.label ? '…' : s.label}
              </button>
            ))}
          </div>
          {importStatus && <div className={styles.quickStatus}>{importStatus}</div>}
        </div>

        <div className={styles.section}>
          <span className={styles.label}>Last response</span>
          {lastDebug ? (
            <div className={styles.kv}>
              <span className={styles.kvKey}>API key</span>
              <span
                className={
                  lastDebug.keyConfigured
                    ? `${styles.kvVal} ${styles.ok}`
                    : `${styles.kvVal} ${styles.refuse}`
                }
              >
                {lastDebug.keyConfigured ? 'configured' : 'MISSING — using stub'}
              </span>
              <span className={styles.kvKey}>tier keys</span>
              <span className={styles.kvVal}>
                {(['small', 'medium', 'large'] as const).map((tier) => (
                  <span
                    key={tier}
                    className={lastDebug.keyStatus[tier] ? styles.ok : styles.refuse}
                    style={{ marginRight: 8 }}
                  >
                    {tier}:{lastDebug.keyStatus[tier] ? '✓' : '✗'}
                  </span>
                ))}
              </span>
              <span className={styles.kvKey}>legacy client</span>
              <span
                className={
                  lastDebug.legacyClient === 'real'
                    ? styles.kvVal
                    : `${styles.kvVal} ${styles.fell}`
                }
              >
                {lastDebug.legacyClient}
              </span>
              <span className={styles.kvKey}>mode</span>
              <span className={styles.kvVal}>{lastDebug.mode}</span>
              <span className={styles.kvKey}>tier</span>
              <span className={styles.kvVal}>{lastDebug.generationTier ?? '—'}</span>
              <span className={styles.kvKey}>handler</span>
              <span
                className={
                  lastDebug.fellThrough
                    ? `${styles.kvVal} ${styles.fell}`
                    : lastDebug.handler === 'refuse'
                      ? `${styles.kvVal} ${styles.refuse}`
                      : `${styles.kvVal} ${styles.ok}`
                }
              >
                {lastDebug.handler}
                {lastDebug.fellThrough ? ' (fell through)' : ''}
              </span>
              <span className={styles.kvKey}>model</span>
              <span className={styles.kvVal}>{lastDebug.model ?? '— (no LLM)'}</span>
              <span className={styles.kvKey}>latency</span>
              <span className={styles.kvVal}>{lastDebug.latencyMs} ms</span>
              {lastDebug.fellThrough && lastDebug.fallThroughReason && (
                <>
                  <span className={styles.kvKey}>fell-through</span>
                  <span className={`${styles.kvVal} ${styles.fell}`}>
                    {lastDebug.fallThroughReason}
                  </span>
                </>
              )}
              {lastDebug.fallThroughError && (
                <>
                  <span className={styles.kvKey}>error</span>
                  <span className={`${styles.kvVal} ${styles.refuse}`}>
                    {lastDebug.fallThroughError}
                  </span>
                </>
              )}
              {lastDebug.classification && (
                <>
                  <span className={styles.kvKey}>kind</span>
                  <span className={styles.kvVal}>{lastDebug.classification.kind}</span>
                  <span className={styles.kvKey}>scope</span>
                  <span className={styles.kvVal}>{lastDebug.classification.scope}</span>
                  <span className={styles.kvKey}>complexity</span>
                  <span className={styles.kvVal}>{lastDebug.classification.complexity}</span>
                  <span className={styles.kvKey}>confidence</span>
                  <span className={styles.kvVal}>
                    {lastDebug.classification.confidence.toFixed(2)}
                  </span>
                  {lastDebug.classification.reason && (
                    <>
                      <span className={styles.kvKey}>reason</span>
                      <span className={styles.kvVal}>{lastDebug.classification.reason}</span>
                    </>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className={styles.empty}>(no requests yet)</div>
          )}
        </div>
      </div>
    </div>
  )
}
