/**
 * SHE-8 — the one canonical env-flag truthiness reader for SERVER-side flags.
 *
 * Before this, truthiness was duplicated ad-hoc (`readBool`, `readExplicitFalse`,
 * inline `v === '1' || v?.toLowerCase() === 'true'`, bare `=== '1'`), each
 * subtly different — so `FLAG=off` / `FLAG=no` silently left a default-ON flag
 * ON, a real operator footgun.
 *
 * Canonical mapping (case-insensitive, trimmed):
 *   - `1` `true` `yes` `on`            → true
 *   - `0` `false` `no` `off`           → false
 *   - unset / empty / any other string → `opts.defaultOn ?? false`
 *
 * Read FRESH on every call (no module-load cache) so a host-level env flip takes
 * effect on the next request without a redeploy — matching the orchestrator's
 * existing flag discipline.
 *
 * SERVER-ONLY: it reads `process.env[name]` with a DYNAMIC key, which Next.js
 * cannot statically inline into a client bundle — so do NOT use this for
 * `NEXT_PUBLIC_*` flags read in client components (those must keep a literal
 * `process.env.NEXT_PUBLIC_X` access). It is also pure (zero imports), so core /
 * orchestrator code may import it freely.
 */
const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const FALSY = new Set(['0', 'false', 'no', 'off'])

export function isFlagEnabled(name: string, opts?: { defaultOn?: boolean }): boolean {
  const raw = process.env[name]
  if (raw === undefined) return opts?.defaultOn ?? false
  const v = raw.trim().toLowerCase()
  if (TRUTHY.has(v)) return true
  if (FALSY.has(v)) return false
  // Unset/empty or an unrecognized value falls back to the declared default —
  // we never treat an unknown string as "on".
  return opts?.defaultOn ?? false
}
