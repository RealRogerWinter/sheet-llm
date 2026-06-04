/**
 * Client gate for the right-click context menu (M27).
 *
 * Default-ON kill switch (flipped on in M27-PR-6): the menu is live
 * unless `NEXT_PUBLIC_SL_CONTEXT_MENU` is exactly `'off'`. Read at CALL
 * time (not module load) so tests can toggle `process.env` per case
 * and so the value reflects the build-time inlined `NEXT_PUBLIC_*`.
 *
 * Mirrors the client-flag kill-switch precedent `NEXT_PUBLIC_BALANCED_EDITS`
 * (see `lib/chat/state.ts`).
 */
export function isContextMenuEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SL_CONTEXT_MENU !== 'off'
}

/**
 * Client gate for the M28 clipboard (Cut / Copy / Paste in the context
 * menu). Default-ON kill switch (flipped on in M28-PR-5): live unless
 * `NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD` is exactly `'off'`.
 */
export function isClipboardEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SL_CONTEXT_CLIPBOARD !== 'off'
}

/**
 * Client gate for the M29 AI entry points ("Edit with AI" / "Regenerate" /
 * "Explain" rows in the context menu). Default-ON kill switch (flipped on
 * in M29-PR-4): live unless `NEXT_PUBLIC_SL_CONTEXT_AI` is exactly `'off'`.
 */
export function isAiEntryEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SL_CONTEXT_AI !== 'off'
}
