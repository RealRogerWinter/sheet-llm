#!/usr/bin/env node
// ============================================================================
// live-smoke.mjs — HTTP smoke test against a RUNNING sheet-llm dev server.
//
// !!! WARNING: THIS MAKES REAL, PAID LLM CALLS. !!!
//
// Each prompt below hits POST /api/chat on a live server, which dispatches to
// the orchestrator and calls Anthropic with your configured ANTHROPIC_API_KEY.
// Running it costs real money (the LARGE 16-bar grand-staff prompt in
// particular drives tens of thousands of output tokens). It is GATED behind
// SL_RUN_LIVE_SMOKE=1 so it never runs by accident in CI or a casual `node`.
//
// Usage:
//   SL_RUN_LIVE_SMOKE=1 node scripts/live-smoke.mjs
//   SL_RUN_LIVE_SMOKE=1 SL_SMOKE_BASE_URL=http://localhost:3000 node scripts/live-smoke.mjs
//
// Prereqs:
//   - A dev server already running (e.g. `pnpm dev`) and reachable at the base
//     URL. This script does NOT start a server.
//   - ANTHROPIC_API_KEY configured on that server (else it serves the stub
//     client, which still returns a valid score — the smoke test passes but
//     does NOT exercise the real generation path).
//
// What it checks:
//   - SMALL  "a one-octave C major scale"
//   - MEDIUM "a 4-bar cheerful melody in G major"
//   - LARGE  the exact production-bug regression prompt
//            "a driving blues-funk rhythm in grand staff. 16 bars with a
//             turnaround at the end"
//   PASS = HTTP 200 carrying BOTH scoreJson AND abc. FAIL = any 5xx, or a 200
//   missing a score. The LARGE case is the regression guard for the
//   max_tokens-truncation 500 ("expected array, received undefined").
//
//   After each successful generation it optionally fires a refinement POST
//   that echoes the returned scoreJson back as `editedScore` (reusing the same
//   chatId) to smoke the request-body-size path. A 413 is reported distinctly
//   (the server's MAX_BODY_BYTES is 24KB; a large grand-staff round-trip can
//   exceed it).
//
// Exit code: non-zero if ANY generation check FAILs. Refinement 413/errors are
// reported but, being a known secondary issue, do not by themselves fail the
// run unless a generation also failed.
//
// Notes on server contract (src/app/api/chat/route.ts):
//   - The same-origin guard only runs when BOTH Origin and Host headers are
//     present (route.ts ~86-88). global fetch does NOT set an Origin header for
//     same-machine requests, so we deliberately send none and the check is
//     skipped — no cookie/CSRF dance required.
//   - The server creates an anonymous user on first request
//     (getOrCreateUserId, route.ts ~293), so no auth/cookies are needed.
//   - Success body shape: { chatId, abc, scoreJson, toolUseId, ... }
//     (route.ts ~619-628; ChatResponse in src/lib/shared/types.ts ~87-92).
// ============================================================================

const BASE_URL = process.env.SL_SMOKE_BASE_URL || 'http://localhost:3000'
const CHAT_URL = `${BASE_URL.replace(/\/+$/, '')}/api/chat`

// Per-request ceiling. The LARGE prompt can run close to the server's
// maxDuration=60 (route.ts ~50); give the client generous headroom so a slow
// (but successful) generation isn't misreported as a transport failure. The
// fetch's own latency is always printed regardless.
const REQUEST_TIMEOUT_MS = 120_000

const TRUNCATE_BODY_CHARS = 800

/** ANSI helpers — degrade to plain text when not a TTY. */
const useColor = process.stdout.isTTY
const c = {
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
}

/** GATE — refuse to run unless explicitly opted in. Exit 0 (a skip, not a
 *  failure) so an accidental invocation in a pipeline is a no-op, not a break. */
if (process.env.SL_RUN_LIVE_SMOKE !== '1') {
  console.log(
    [
      c.yellow('live-smoke: SKIPPED.'),
      '',
      'This script makes REAL, PAID LLM calls against a running server.',
      'It is gated to prevent accidental spend.',
      '',
      'To run it intentionally:',
      c.bold('  SL_RUN_LIVE_SMOKE=1 node scripts/live-smoke.mjs'),
      '',
      `(Target base URL: ${BASE_URL} — override with SL_SMOKE_BASE_URL.)`,
    ].join('\n'),
  )
  process.exit(0)
}

/** Truncate a string for display, annotating how much was dropped. */
function truncate(s, max = TRUNCATE_BODY_CHARS) {
  if (typeof s !== 'string') s = String(s)
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n${c.dim(`... [truncated ${s.length - max} more chars]`)}`
}

/**
 * POST JSON to /api/chat. Deliberately sends NO Origin header so the server's
 * same-origin guard is skipped (route.ts ~86-88). Returns a normalized result:
 *   { ok, status, latencyMs, json, rawText, transportError }
 * `ok` here is purely the fetch-completed flag; PASS/FAIL is judged by callers.
 */
async function postChat(payload) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const started = Date.now()
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      // content-type MUST be application/json — the route reads the raw body
      // then JSON.parses it (route.ts ~276/286). No Origin header on purpose.
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started
    const rawText = await res.text()
    let json
    try {
      json = JSON.parse(rawText)
    } catch {
      json = undefined
    }
    return { ok: true, status: res.status, latencyMs, json, rawText }
  } catch (err) {
    const latencyMs = Date.now() - started
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')
    return {
      ok: false,
      status: 0,
      latencyMs,
      json: undefined,
      rawText: '',
      transportError: aborted
        ? `request aborted after ${REQUEST_TIMEOUT_MS}ms client timeout`
        : `transport error: ${err && err.message ? err.message : String(err)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Pretty fixed-width seconds. */
function secs(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Run one generation check. Returns { pass, chatId, scoreJson } so the caller
 * can chain a refinement against the produced score.
 */
async function runGeneration(label, message) {
  console.log(`\n${c.bold(`[${label}]`)} POST ${CHAT_URL}`)
  console.log(c.dim(`  prompt: ${JSON.stringify(message)}`))

  const r = await postChat({ message })

  // Transport-level failure (server down, client timeout, DNS, etc.).
  if (!r.ok) {
    console.log(`  ${c.red('FAIL')} (no response)  latency=${secs(r.latencyMs)}`)
    console.log(c.dim(`  ${r.transportError}`))
    return { pass: false, chatId: undefined, scoreJson: undefined }
  }

  const hasScore = !!(r.json && r.json.scoreJson)
  const hasAbc = !!(r.json && typeof r.json.abc === 'string' && r.json.abc.length > 0)
  const is2xx = r.status >= 200 && r.status < 300
  const is5xx = r.status >= 500
  const pass = is2xx && hasScore && hasAbc

  const statusLabel = pass ? c.green('PASS') : c.red('FAIL')
  console.log(
    `  ${statusLabel}  status=${r.status}  latency=${secs(r.latencyMs)}  ` +
      `scoreJson=${hasScore ? 'yes' : 'no'}  abc=${hasAbc ? 'yes' : 'no'}`,
  )

  if (!pass) {
    // Surface WHY. The headline regression manifests as a 5xx whose body
    // includes "Orchestrator failed: ... expected array, received undefined".
    if (is5xx) {
      console.log(c.dim('  (5xx — server-side error; this is the failure class for the regression bug)'))
    } else if (is2xx && !pass) {
      console.log(c.dim('  (200 but missing scoreJson and/or abc — not a usable generation)'))
    }
    console.log(c.dim('  response body:'))
    console.log(
      truncate(r.rawText)
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    )
  }

  // Light extra signal on a pass: how big the score is + whether we ran near
  // the server's maxDuration (a clue the bug "fix" could flip 500 -> timeout).
  if (pass) {
    const measures =
      r.json.scoreJson && Array.isArray(r.json.scoreJson.measures)
        ? r.json.scoreJson.measures.length
        : '?'
    const detail = `measures=${measures}, abc=${r.json.abc.length}B`
    console.log(c.dim(`  produced: ${detail}`))
    if (r.latencyMs > 55_000) {
      console.log(
        c.yellow(`  WARN: latency ${secs(r.latencyMs)} is close to server maxDuration=60s — large pieces risk timeout.`),
      )
    }
  }

  return {
    pass,
    chatId: r.json ? r.json.chatId : undefined,
    scoreJson: r.json ? r.json.scoreJson : undefined,
  }
}

/**
 * Smoke the request-body-size path: echo the produced score back up as
 * `editedScore` on the SAME chatId, with a trivial follow-up instruction.
 * This is the heavy round-trip that route.ts MAX_BODY_BYTES (24KB) can reject
 * with 413 (route.ts ~269-272 / ~280-282). We report that 413 distinctly
 * rather than treating it as a generation failure.
 *
 * Returns { kind } where kind is one of:
 *   'pass'        — 200 with a score (refinement succeeded)
 *   'too_large'   — 413 (body exceeded the server limit; the known sibling)
 *   'soft_fail'   — any other non-2xx / missing-score (reported, non-fatal)
 *   'skipped'     — no prior score/chatId to refine
 */
async function runRefinementEcho(label, gen) {
  if (!gen.pass || !gen.chatId || !gen.scoreJson) {
    console.log(`  ${c.dim(`[${label} · refine] skipped (no usable prior score)`)}`)
    return { kind: 'skipped' }
  }

  const payloadStr = JSON.stringify({
    chatId: gen.chatId,
    message: 'Leave it exactly as is.',
    editedScore: gen.scoreJson,
  })
  const approxKb = (Buffer.byteLength(payloadStr, 'utf8') / 1024).toFixed(1)
  console.log(`  ${c.dim(`[${label} · refine] echoing score back as editedScore (~${approxKb}KB body)`)}`)

  const r = await postChat({
    chatId: gen.chatId,
    message: 'Leave it exactly as is.',
    editedScore: gen.scoreJson,
  })

  if (!r.ok) {
    console.log(`    ${c.red('refine FAIL')} (no response)  ${r.transportError}`)
    return { kind: 'soft_fail' }
  }

  if (r.status === 413) {
    console.log(
      `    ${c.yellow('refine 413 PAYLOAD-TOO-LARGE')}  latency=${secs(r.latencyMs)}  ` +
        `(body ~${approxKb}KB > server MAX_BODY_BYTES=24KB)`,
    )
    return { kind: 'too_large' }
  }

  const hasScore = !!(r.json && r.json.scoreJson)
  const is2xx = r.status >= 200 && r.status < 300
  if (is2xx && hasScore) {
    console.log(`    ${c.green('refine PASS')}  status=${r.status}  latency=${secs(r.latencyMs)}`)
    return { kind: 'pass' }
  }

  console.log(`    ${c.yellow('refine soft-FAIL')}  status=${r.status}  latency=${secs(r.latencyMs)}`)
  console.log(c.dim('    response body:'))
  console.log(
    truncate(r.rawText)
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n'),
  )
  return { kind: 'soft_fail' }
}

async function main() {
  console.log(c.bold('live-smoke: hitting a RUNNING sheet-llm server (REAL, PAID LLM calls)'))
  console.log(c.dim(`  base URL: ${BASE_URL}`))
  console.log(c.dim(`  endpoint: ${CHAT_URL}`))

  const cases = [
    { label: 'SMALL', message: 'a one-octave C major scale' },
    { label: 'MEDIUM', message: 'a 4-bar cheerful melody in G major' },
    {
      label: 'LARGE',
      message: 'a driving blues-funk rhythm in grand staff. 16 bars with a turnaround at the end',
    },
  ]

  const genResults = []
  const refineResults = []

  for (const { label, message } of cases) {
    const gen = await runGeneration(label, message)
    genResults.push({ label, pass: gen.pass })
    const refine = await runRefinementEcho(label, gen)
    refineResults.push({ label, kind: refine.kind })
  }

  // ---- Summary -----------------------------------------------------------
  console.log(`\n${c.bold('==== SUMMARY ====')}`)
  for (const g of genResults) {
    const tag = g.pass ? c.green('PASS') : c.red('FAIL')
    console.log(`  generate  ${g.label.padEnd(7)} ${tag}`)
  }
  for (const rf of refineResults) {
    let tag
    if (rf.kind === 'pass') tag = c.green('PASS')
    else if (rf.kind === 'too_large') tag = c.yellow('413 (too large)')
    else if (rf.kind === 'skipped') tag = c.dim('skipped')
    else tag = c.yellow('soft-FAIL')
    console.log(`  refine    ${rf.label.padEnd(7)} ${tag}`)
  }

  const genPassCount = genResults.filter((g) => g.pass).length
  const anyGenFail = genResults.some((g) => !g.pass)
  console.log(
    `\n  generations: ${genPassCount}/${genResults.length} passed` +
      (anyGenFail ? c.red('  <- FAILURES present') : c.green('  <- all green')),
  )

  // Exit code: only generation FAILs are fatal. Refinement 413 is the known
  // secondary issue and is reported, not fatal.
  process.exit(anyGenFail ? 1 : 0)
}

main().catch((err) => {
  // Belt-and-suspenders: any uncaught error is itself a smoke failure.
  console.error(c.red(`\nlive-smoke: unexpected error: ${err && err.stack ? err.stack : err}`))
  process.exit(1)
})
