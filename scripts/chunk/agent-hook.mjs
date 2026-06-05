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
 * into the WSL distro (repo convention); on macOS/Linux they run natively. If
 * chunk (or WSL) isn't installed, the gate degrades to a non-blocking warning
 * instead of bricking the turn — run `scripts/chunk/bootstrap.sh` to opt in.
 * See docs/guides/chunk-sidecars.md.
 *
 * Hook exit-code contract (Claude Code): 2 = block the action and surface
 * stderr to the agent; 0 = allow. Internal launcher errors fail OPEN (exit 0)
 * so a bug in here never blocks a contributor's work.
 *
 * Usage (from a hook command): node <this> commit-gate | stop-gate
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const GATE = process.argv[2] ?? ''
const IS_WINDOWS = process.platform === 'win32'

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

/** C:\\a\\b -> /mnt/c/a/b, so a Windows repo path is reachable inside WSL. */
function toWslPath(winPath) {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(winPath)
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : winPath
}

/**
 * Run a bash command line in the repo. On Windows this shells into WSL (where
 * chunk + the Linux toolchain live); elsewhere it runs bash directly. Output is
 * captured (not streamed) so this launcher's own stdout stays empty — the hook
 * contract parses hook stdout as JSON on exit 0. ~/.local/bin is prepended to
 * PATH because bootstrap.sh installs chunk there.
 */
function runInRepo(bashCmd) {
  const prelude = 'export PATH="$HOME/.local/bin:$PATH"; '
  if (IS_WINDOWS) {
    const line = `cd '${toWslPath(REPO_ROOT)}' && ${prelude}${bashCmd}`
    return spawnSync('wsl.exe', ['-e', 'bash', '-lc', line], { encoding: 'utf8' })
  }
  return spawnSync('bash', ['-lc', prelude + bashCmd], { cwd: REPO_ROOT, encoding: 'utf8' })
}

/** True if `name` resolves on PATH in the (possibly WSL) Linux environment. */
function hasCommand(name) {
  return runInRepo(`command -v ${name} >/dev/null 2>&1`).status === 0
}

/** Forward a finished child's captured output into the transcript (stderr). */
function echo(result) {
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd()
  if (out) process.stderr.write(out + '\n')
}

try {
  const event = readEvent()

  if (GATE === 'commit-gate') {
    // The matcher is just "Bash"; do the command-level filtering here so it
    // behaves the same whether or not the agent supports `if` rule matchers.
    const isBash = (event.tool_name ?? '') === 'Bash'
    const cmd = event.tool_input?.command ?? ''
    if (!isBash || !/\bgit\s+commit\b/.test(cmd)) allow()

    if (!hasCommand('pnpm')) {
      allow('pnpm not found in the Linux env — skipping the pre-commit typecheck gate (run scripts/chunk/bootstrap.sh).')
    }
    const r = runInRepo('pnpm typecheck')
    if (r.status !== 0) {
      echo(r)
      block('pnpm typecheck failed — fix the type errors before committing.')
    }
    allow('✓ typecheck passed (chunk commit-gate)')
  }

  if (GATE === 'stop-gate') {
    // A Stop hook that blocks re-enters on the next stop attempt; bail out when
    // we're already inside that loop to avoid spinning.
    if (event.stop_hook_active === true) allow()

    if (!hasCommand('chunk')) {
      allow('chunk not installed — skipping sidecar validation (run scripts/chunk/bootstrap.sh to enable inner-loop sidecars).')
    }
    const r = runInRepo('chunk validate')
    if (r.status !== 0) {
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
