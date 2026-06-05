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

// This script lives at <repo>/scripts/chunk/agent-hook.mjs, so the launcher's
// own repo root is two directories up — derived from the script's location,
// independent of any env var, so it's identical for every agent (Claude Code,
// Cursor, Codex, …) regardless of how they invoke hooks. NOTE: this is the
// *fallback* root for command-availability checks; the gates themselves run in
// the work tree the hook event targets (its cwd's git toplevel), so commits made
// inside a linked worktree are validated against the worktree — see runForGate.
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
 *
 * `startDir` is the native (Windows on win32) directory to start from, defaulting
 * to REPO_ROOT — the launcher's own checkout. When `worktreeRelative` is true we
 * then `cd` to that directory's git toplevel, so a gate validates the *worktree*
 * actually being committed rather than the main checkout the script lives in
 * (see runForGate). Resolving the toplevel in the same shell avoids round-
 * tripping the path through WSL translation.
 */
function runInRepo(bashCmd, { startDir = REPO_ROOT, worktreeRelative = false } = {}) {
  const prelude = 'export PATH="$HOME/.local/bin:$PATH"; '
  const start = IS_WINDOWS ? toWslPath(startDir) : startDir
  // If the requested startDir is unusable, fall back to REPO_ROOT before failing.
  const fallback = IS_WINDOWS ? toWslPath(REPO_ROOT) : REPO_ROOT
  const cdToStart =
    start === fallback
      ? `cd ${shq(start)} || exit ${CD_FAIL}`
      : `cd ${shq(start)} 2>/dev/null || cd ${shq(fallback)} || exit ${CD_FAIL}`
  // `git rev-parse --show-toplevel` from a linked worktree prints the worktree
  // root; on failure (not a work tree) the `&&` short-circuits and we stay put.
  const cdToTree = worktreeRelative
    ? `; __r="$(git rev-parse --show-toplevel 2>/dev/null)" && cd "$__r"`
    : ''
  const line = `${cdToStart}${cdToTree}; ${prelude}${bashCmd}`
  return IS_WINDOWS
    ? spawnSync('wsl.exe', ['-e', 'bash', '-lc', line], { encoding: 'utf8' })
    : spawnSync('bash', ['-lc', line], { encoding: 'utf8' })
}

/**
 * Run a gate command (typecheck / chunk validate) in the work tree the hook
 * event actually targets. `eventCwd` is the hook's cwd — the worktree when the
 * agent is committing inside one, the main checkout otherwise — so resolving its
 * git toplevel makes the gate see the right files. Falls back to REPO_ROOT when
 * cwd is missing.
 */
function runForGate(bashCmd, eventCwd) {
  return runInRepo(bashCmd, { startDir: eventCwd || REPO_ROOT, worktreeRelative: true })
}

// --- stop-gate diff-skip ----------------------------------------------------
// `chunk validate` boots a CircleCI sidecar and runs the FULL gate suite
// (`pnpm typecheck` + `pnpm test`) over the whole repo on EVERY turn — it is not
// diff-aware. When a turn only touched files that cannot change a typecheck/test
// outcome (docs, operational scripts), that sidecar run is pure cost with no new
// signal. We skip it in that case. Conservative by construction: anything we
// can't classify as inert — and any failure to compute the diff — runs the gate.

// Files that, when changed, CANNOT affect `tsc --noEmit` or `vitest`. A path is
// inert only if it matches one of these AND is not a TESTABLE_EXT file (below).
const DEFAULT_INERT_GLOBS = ['**/*.md', '**/*.mdx', '**/*.txt', 'docs/**', 'scripts/**']

// tsc compiles **/*.{ts,tsx,mts,cts} (see tsconfig `include`), and tests import
// .ts helpers even from scripts/ (e.g. tests import scripts/*.ts). So any file
// with one of these extensions ALWAYS forces the gate, even under an inert dir.
const TESTABLE_EXT = /\.(ts|tsx|mts|cts)$/

/** Inert globs = built-in defaults plus any extra globs from SL_CHUNK_STOP_GATE_INERT. */
function inertGlobs() {
  const extra = (process.env.SL_CHUNK_STOP_GATE_INERT ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
  return [...DEFAULT_INERT_GLOBS, ...extra]
}

/**
 * Minimal glob -> RegExp for the patterns we use: `**` matches any chars
 * (including `/`) and optionally swallows a following `/`; `*` matches any chars
 * except `/`; everything else is literal. Paths from git use forward slashes on
 * every platform, so matching is uniform.
 */
function globToRegExp(glob) {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++ // `**/` also matches zero leading segments
      } else {
        re += '[^/]*'
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp(re + '$')
}

/** A changed path is inert (can't affect typecheck/test) if it matches an inert glob and isn't a tsc input. */
function isInert(file) {
  if (TESTABLE_EXT.test(file)) return false
  return inertGlobs().some((g) => globToRegExp(g).test(file))
}

// Line-ending + filemode normalization for the working-tree diff. On Windows the
// gate runs in WSL against the persistent /mnt/c checkout, which Git for Windows
// laid down with CRLF endings (autocrlf=true). WSL's git has autocrlf unset, so
// without this it sees EVERY text file as modified (CRLF working tree vs LF blob)
// and the changed-set becomes the whole repo — the gate would never skip. We make
// the comparison normalize CRLF the way git-bash does (and ignore filemode), so
// the diff reflects the turn's real changes. Harmless on macOS/Linux (no CRLF).
const GIT_DIFF = 'git -c core.autocrlf=true -c core.fileMode=false'

// One shell line producing the union of every path that differs from the CI base
// (origin/main): committed branch changes, the working tree (staged+unstaged),
// and untracked files. `__NO_BASE__` is emitted when origin/main can't be
// resolved, so the caller runs the gate rather than guessing from a partial set.
const CHANGED_FILES_CMD =
  'base="$(git merge-base HEAD origin/main 2>/dev/null)"; ' +
  'if [ -z "$base" ]; then echo __NO_BASE__; exit 0; fi; ' +
  '{ ' + GIT_DIFF + ' diff --name-only "$base" HEAD; ' +
  GIT_DIFF + ' diff --name-only HEAD; ' +
  'git ls-files --others --exclude-standard; } | sort -u'

/**
 * Decide whether the stop-gate can skip the sidecar run for this turn.
 * Returns { skip, reason }. Skips only when the full changed-file set was
 * computed AND every changed file is inert (or nothing changed). Any
 * uncertainty — diff failure, unknown base — returns skip:false (run the gate).
 */
function decideStopGateSkip(eventCwd) {
  const r = runForGate(CHANGED_FILES_CMD, eventCwd)
  if (classify(r) !== 'pass') return { skip: false, reason: 'could not compute the diff' }
  const out = (r.stdout ?? '').trim()
  if (out.includes('__NO_BASE__')) return { skip: false, reason: 'origin/main base unresolved' }
  const files = out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : []
  if (files.length === 0) return { skip: true, reason: 'no changes vs origin/main' }
  const testable = files.filter((f) => !isInert(f))
  if (testable.length === 0) {
    const shown = files.slice(0, 5).join(', ')
    const more = files.length > 5 ? `, +${files.length - 5} more` : ''
    return { skip: true, reason: `only inert files changed (${files.length}: ${shown}${more})` }
  }
  return { skip: false }
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
    // Typecheck the work tree being committed (the worktree, if the agent is in
    // one), not the launcher's own main checkout — see runForGate.
    const r = runForGate('pnpm typecheck', event.cwd)
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
    // chunk validate isn't diff-aware — it runs the whole suite on a sidecar
    // every turn. Skip that cost when nothing the turn changed could affect a
    // typecheck/test outcome. Set SL_CHUNK_STOP_GATE_NO_DIFF_SKIP=1 to always run.
    if (process.env.SL_CHUNK_STOP_GATE_NO_DIFF_SKIP !== '1') {
      const decision = decideStopGateSkip(event.cwd)
      if (decision.skip) allow(`skipping sidecar validation — ${decision.reason}.`)
    }
    // Validate the work tree the turn happened in (the worktree, if any) — see
    // runForGate — rather than the launcher's own main checkout.
    const r = runForGate('chunk validate', event.cwd)
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
