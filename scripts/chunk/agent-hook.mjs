#!/usr/bin/env node
/**
 * Cross-platform chunk agent-hook launcher.
 *
 * Wired into every agent's hook config (see .claude/settings.json) so that
 * chunk's inner-loop validation runs for whoever works in this repo:
 *
 *   • commit-gate (PreToolUse on `git commit`) -> fast local `pnpm typecheck`.
 *   • stop-gate   (Stop)                        -> `chunk validate`, which runs
 *     the gate commands on a remote CircleCI sidecar microVM that mirrors CI.
 *
 * chunk-cli only ships for macOS/Linux, so on Windows the gates are dispatched
 * into the WSL distro (repo convention); on macOS/Linux they run natively.
 *
 * Fail-OPEN by design: if chunk / pnpm / a usable shell (e.g. WSL) is missing or
 * can't be launched, the gate prints a hint and exits 0 (non-blocking) so an
 * un-onboarded or broken-WSL machine is never bricked. Only a *clean* non-zero
 * from the actual validation command blocks (exit 2). Run
 * `scripts/chunk/bootstrap.sh` to opt in. See docs/guides/chunk-sidecars.md.
 *
 * Hook exit-code contract (Claude Code): 2 = block + surface stderr to the
 * agent; 0 = allow. Internal launcher errors also exit 0.
 *
 * Usage (from a hook command): node <this> commit-gate | stop-gate
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const GATE = process.argv[2] ?? ''
const IS_WINDOWS = process.platform === 'win32'

// Sentinel exit status meaning "the `cd <repo>` itself failed" (bad path /
// translation) as opposed to the gate command failing — treated as unavailable.
const CD_FAIL = 97

// This script lives at <repo>/scripts/chunk/agent-hook.mjs, so the repo root is
// two directories up — derived from the script's own location, independent of
// the hook's cwd or any env var. That keeps it identical for every agent
// (Claude Code, Cursor, Codex, …) regardless of how they invoke hooks.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Block the action (exit 2) with a message the agent will see on stderr. */
function block(message) {
  process.stderr.write(`[chunk-hook] ${message}\n`)
  process.exit(2)
}

/** Allow the action (exit 0), optionally leaving a breadcrumb in the transcript. */
function allow(note) {
  if (note) process.stderr.write(`[chunk-hook] ${note}\n`)
  process.exit(0)
}

/** Best-effort parse of the hook event JSON piped on stdin (fd 0). */
function readEvent() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

/** POSIX single-quote a string so it's safe to embed in a shell command line. */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** C:\\a\\b -> /mnt/c/a/b, so a Windows repo path is reachable inside WSL. */
function toWslPath(winPath) {
  // Drop a Windows extended-length / device prefix first (\\?\C:\… , \\.\C:\…).
  const p = winPath.replace(/^\\\\[?.]\\/, '')
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(p)
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p
}

/**
 * Run a bash command line in the repo. On Windows this shells into WSL (where
 * chunk + the Linux toolchain live); elsewhere it runs bash directly. Output is
 * captured (not streamed) so this launcher's own stdout stays empty — the hook
 * contract parses hook stdout as JSON on exit 0. ~/.local/bin is prepended to
 * PATH because bootstrap.sh installs chunk there. A failed `cd` exits CD_FAIL so
 * the caller can tell a path problem apart from a real gate failure.
 */
function runInRepo(bashCmd) {
  const prelude = 'export PATH="$HOME/.local/bin:$PATH"; '
  const target = IS_WINDOWS ? toWslPath(REPO_ROOT) : REPO_ROOT
  const line = `cd ${shq(target)} || exit ${CD_FAIL}; ${prelude}${bashCmd}`
  return IS_WINDOWS
    ? spawnSync('wsl.exe', ['-e', 'bash', '-lc', line], { encoding: 'utf8' })
    : spawnSync('bash', ['-lc', line], { encoding: 'utf8' })
}

/**
 * Classify a spawnSync result:
 *   'pass'        — the gate ran and exited 0
 *   'fail'        — the gate ran and exited non-zero (real failure -> block)
 *   'unavailable' — we couldn't actually run the gate (no shell/WSL, spawn
 *                   error, killed, or `cd` failed) -> fail open / allow
 */
function classify(r) {
  if (r.error || r.status === null || r.status === CD_FAIL) return 'unavailable'
  return r.status === 0 ? 'pass' : 'fail'
}

/** True only if `name` resolves on PATH in the (possibly WSL) Linux env. */
function hasCommand(name) {
  return classify(runInRepo(`command -v ${shq(name)} >/dev/null 2>&1`)) === 'pass'
}

/** Forward a finished child's captured output into the transcript (stderr). */
function echo(result) {
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd()
  if (out) process.stderr.write(out + '\n')
}

/** Does this Bash command invoke `git commit` (and not `commit-tree`/`-graph`)? */
function isGitCommit(cmd) {
  // Allows intervening flags (`git -c user.x=y commit`, `git --no-pager commit`)
  // and requires `commit` to end at a space/EOL so `commit-tree` doesn't match.
  return /\bgit\s+(?:-\S+\s+|-c\s+\S+\s+)*commit(?:\s|$)/.test(cmd)
}

try {
  const event = readEvent()

  if (GATE === 'commit-gate') {
    // The matcher is just "Bash"; filter to `git commit` here so it behaves the
    // same whether or not the agent supports `if` rule matchers.
    const isBash = (event.tool_name ?? '') === 'Bash'
    if (!isBash || !isGitCommit(event.tool_input?.command ?? '')) allow()

    if (!hasCommand('pnpm')) {
      allow('pnpm not found in the Linux env — skipping the pre-commit typecheck gate (run scripts/chunk/bootstrap.sh).')
    }
    const r = runInRepo('pnpm typecheck')
    const verdict = classify(r)
    if (verdict === 'unavailable') {
      allow('could not run the typecheck gate (no usable shell/WSL) — skipping.')
    }
    if (verdict === 'fail') {
      echo(r)
      block('pnpm typecheck failed — fix the type errors before committing.')
    }
    allow('✓ typecheck passed (chunk commit-gate)')
  }

  if (GATE === 'stop-gate') {
    // A Stop hook that blocks re-enters on the next stop attempt; bail out when
    // we're already inside that loop. (Claude Code also force-stops after 8
    // consecutive Stop blocks, as a backstop.)
    if (event.stop_hook_active === true) allow()

    if (!hasCommand('chunk')) {
      allow('chunk not installed — skipping sidecar validation (run scripts/chunk/bootstrap.sh to enable inner-loop sidecars).')
    }
    const r = runInRepo('chunk validate')
    const verdict = classify(r)
    if (verdict === 'unavailable') {
      allow('could not run chunk validate (no usable shell/WSL) — skipping sidecar validation.')
    }
    if (verdict === 'fail') {
      echo(r)
      block('chunk validate failed on the sidecar — address the failures above before ending the turn.')
    }
    allow('✓ chunk validate passed on the sidecar (stop-gate)')
  }

  // Unknown / missing gate name — no-op.
  allow()
} catch (err) {
  // Never let a launcher bug block a contributor; fail open with a breadcrumb.
  allow(`launcher error (ignored): ${err?.message ?? err}`)
}
