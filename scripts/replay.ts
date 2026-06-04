/**
 * Forensic replay tool for a single orchestrator session.
 *
 * Usage:
 *   pnpm replay -- --session <session_id> [--unsafe-include-content]
 *
 * Reads `orchestrator_turns`, `messages`, and `score_versions` for the
 * session, ordered by created_at, and prints a turn-by-turn ledger
 * to stdout. By default user/assistant content is REDACTED — content
 * may contain copyrighted lyrics or PII, so the operator must opt in
 * with `--unsafe-include-content`.
 *
 * This script was built for M3.5 PR-1 in response to the triplet-demo
 * replacement bug, where the offending session's classification +
 * dispatch decision was unrecoverable from stdout logs.
 */
import { eq, inArray } from 'drizzle-orm'
import { ensureMigrationsApplied, getDb } from '@/lib/db'
import {
  messages as messagesTable,
  orchestratorTurns,
  scoreVersions,
} from '@/lib/db/schema'

interface CliArgs {
  sessionId: string
  unsafeIncludeContent: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let sessionId: string | undefined
  let unsafeIncludeContent = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session') {
      sessionId = argv[++i]
    } else if (a === '--unsafe-include-content') {
      unsafeIncludeContent = true
    } else if (a === '--help' || a === '-h') {
      printUsageAndExit(0)
    } else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`)
      printUsageAndExit(1)
    }
  }
  if (!sessionId) {
    console.error('missing required --session <session_id>')
    printUsageAndExit(1)
  }
  return { sessionId: sessionId as string, unsafeIncludeContent }
}

function printUsageAndExit(code: number): never {
  console.error('Usage: pnpm replay -- --session <session_id> [--unsafe-include-content]')
  process.exit(code)
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

/**
 * orchestrator_turns.created_at stores Unix epoch MILLISECONDS — unlike
 * most other tables (sessions, messages, score_versions) which use
 * seconds. The ms resolution is needed so multiple turns landing in the
 * same wall-second can be sorted deterministically.
 */
function fmtTs(unixMs: number): string {
  return new Date(unixMs).toISOString()
}

/** Render a nullable change-flag column. NULL means "diff was one-sided
 *  (e.g. fresh generation), so the question of 'did this change?'
 *  doesn't apply" — distinct from "no, it didn't change" (false/0). */
function fmtFlag(v: number | null | undefined): string {
  if (v === null || v === undefined) return '?'
  return v ? 'yes' : 'no'
}

interface ScoreSummary {
  key?: string
  meter?: string
  title?: string | null
  measures: number
}

function summarizeScoreJson(json: string | null | undefined): ScoreSummary | null {
  if (!json) return null
  try {
    const s = JSON.parse(json) as {
      key?: string
      meter?: string
      title?: string | null
      measures?: unknown[]
    }
    return {
      key: s.key,
      meter: s.meter,
      title: s.title ?? null,
      measures: Array.isArray(s.measures) ? s.measures.length : 0,
    }
  } catch {
    return null
  }
}

function fmtScoreLine(
  before: ScoreSummary | null,
  after: ScoreSummary | null,
  turn: { measureCountBefore: number | null; measureCountAfter: number | null },
): string {
  const beforeMc = before?.measures ?? turn.measureCountBefore ?? '?'
  const afterMc = after?.measures ?? turn.measureCountAfter ?? '?'
  const parts: string[] = [`${beforeMc} measures → ${afterMc} measures`]
  if (before && after) {
    if (before.key !== after.key) parts.push(`key ${before.key}→${after.key}`)
    if (before.meter !== after.meter) parts.push(`meter ${before.meter}→${after.meter}`)
    if ((before.title ?? null) !== (after.title ?? null)) {
      parts.push(`title→"${after.title ?? ''}"`)
    }
  }
  return parts.join(', ')
}

function summarizeAssistantPayload(json: string): string {
  try {
    const blocks = JSON.parse(json) as Array<{ type?: string; input?: unknown; text?: string }>
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
        const input = b.input as { key?: string; meter?: string; title?: string; measures?: unknown[] }
        const measures = Array.isArray(input.measures) ? input.measures.length : 0
        return `tool_use: { key: ${input.key ?? '?'}, meter: ${input.meter ?? '?'}, title: ${JSON.stringify(input.title ?? '')}, measures: ${measures} }`
      }
      if (b.type === 'text' && typeof b.text === 'string') {
        const text = b.text.length > 80 ? b.text.slice(0, 80) + '…' : b.text
        return `text: ${JSON.stringify(text)}`
      }
    }
    return '(no tool_use / text block)'
  } catch {
    return '(unparseable content_json)'
  }
}

function extractUserText(json: string): string | null {
  try {
    const blocks = JSON.parse(json) as Array<{ type?: string; text?: string }>
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') return b.text
    }
  } catch {
    return null
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const db = getDb()
  // Apply pending migrations before any query. On a fresh checkout the
  // server boot path (instrumentation.ts) hasn't run yet, so the
  // orchestrator_turns table won't exist and the next select would
  // crash with "no such table". Idempotent across processes.
  ensureMigrationsApplied(db)

  const turns = db
    .select()
    .from(orchestratorTurns)
    .where(eq(orchestratorTurns.sessionId, args.sessionId))
    .all()
    .sort((a, b) => a.createdAt - b.createdAt)

  if (turns.length === 0) {
    console.log(`No orchestrator turns recorded for session ${args.sessionId}.`)
    return
  }

  // messages.seq is a monotonic, uniqueIndex-backed canonical order.
  // We previously sorted by createdAt, but that's integer-second
  // resolution, so two messages in the same wall-second paired
  // non-deterministically. seq is the right field.
  const sessionMessages = db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, args.sessionId))
    .all()
    .sort((a, b) => a.seq - b.seq)

  console.log(`# Session ${args.sessionId} — ${turns.length} turn(s)`)
  console.log('')

  // Pair each turn with the closest preceding user message (heuristic:
  // first user message whose createdAt <= turn.createdAt and is not yet
  // claimed by an earlier turn). Same for the assistant message —
  // matched on message_id when set, else first assistant >= turn.createdAt.
  //
  // Unit reconciliation: orchestrator_turns.createdAt is MS, but
  // messages.createdAt is SECONDS. We compare in ms space by
  // upconverting the message timestamps.
  const userMessages = sessionMessages.filter((m) => m.role === 'user')
  const assistantMessages = sessionMessages.filter((m) => m.role === 'assistant')
  let userCursor = 0
  let assistantCursor = 0

  // PR-7 (review M4): pre-fetch all score_versions referenced by any
  // turn's before/after pointer in a SINGLE query, instead of issuing
  // 2N point queries inside the per-turn loop. Most replays hit the
  // same versions repeatedly (an extend turn's `before` is usually
  // the previous turn's `after`); the pre-fetch dedups via Set and
  // the lookup map.
  const versionIds = new Set<string>()
  for (const t of turns) {
    if (t.beforeScoreVersionId) versionIds.add(t.beforeScoreVersionId)
    if (t.afterScoreVersionId) versionIds.add(t.afterScoreVersionId)
  }
  const versionRows =
    versionIds.size > 0
      ? db
          .select()
          .from(scoreVersions)
          .where(inArray(scoreVersions.id, Array.from(versionIds)))
          .all()
      : []
  const versionById = new Map(versionRows.map((r) => [r.id, r]))

  for (const t of turns) {
    let user = undefined as typeof userMessages[number] | undefined
    while (
      userCursor < userMessages.length &&
      userMessages[userCursor].createdAt * 1000 <= t.createdAt
    ) {
      user = userMessages[userCursor++]
    }
    let assistant = t.messageId
      ? assistantMessages.find((m) => m.id === t.messageId)
      : undefined
    if (!assistant) {
      while (
        assistantCursor < assistantMessages.length &&
        assistantMessages[assistantCursor].createdAt * 1000 < t.createdAt
      ) {
        assistantCursor++
      }
      assistant = assistantMessages[assistantCursor]
    }

    const before = t.beforeScoreVersionId
      ? summarizeScoreJson(versionById.get(t.beforeScoreVersionId)?.scoreJson)
      : null
    const after = t.afterScoreVersionId
      ? summarizeScoreJson(versionById.get(t.afterScoreVersionId)?.scoreJson)
      : null

    console.log(
      `[${fmtTs(t.createdAt)}] turn ${shortId(t.id)} — ` +
        `handler=${t.handler ?? '?'} model=${t.handlerModel ?? '-'} ` +
        `status=${t.finalStatus} latency=${(t.latencyMs / 1000).toFixed(2)}s`,
    )
    const conf =
      t.classificationConfidence !== null && t.classificationConfidence !== undefined
        ? `conf=${t.classificationConfidence.toFixed(2)}`
        : 'conf=?'
    const dispatch = t.composePatchDispatch ? ` dispatch=${t.composePatchDispatch}` : ''
    console.log(
      `  classification: ${t.classificationKind ?? 'unknown'} ${conf}${dispatch}`,
    )
    if (
      before !== null ||
      after !== null ||
      t.measureCountBefore !== null ||
      t.measureCountAfter !== null
    ) {
      console.log(`  score: ${fmtScoreLine(before, after, t)}`)
    }
    if (t.retainedEventRatio !== null && t.retainedEventRatio !== undefined) {
      console.log(`  retained-event-ratio: ${t.retainedEventRatio.toFixed(2)}`)
    }
    // Show the metadata-change flags. '?' means the diff was one-sided
    // (e.g. fresh generation with no prior score) — semantically
    // distinct from 'no', which would imply the field was preserved.
    if (
      t.keyChanged !== null && t.keyChanged !== undefined ||
      t.meterChanged !== null && t.meterChanged !== undefined ||
      t.titleChanged !== null && t.titleChanged !== undefined
    ) {
      console.log(
        `  metadata-changed: key=${fmtFlag(t.keyChanged)} ` +
          `meter=${fmtFlag(t.meterChanged)} title=${fmtFlag(t.titleChanged)}`,
      )
    }
    if (t.error) {
      console.log(`  error: ${t.error}`)
    }
    if (t.appliedOpsCount !== null && t.appliedOpsCount !== undefined) {
      console.log(`  applied-ops: ${t.appliedOpsCount}`)
    }
    if (
      t.inputTokens !== null ||
      t.outputTokens !== null ||
      t.cachedInputTokens !== null
    ) {
      console.log(
        `  tokens: in=${t.inputTokens ?? '-'} cached=${t.cachedInputTokens ?? '-'} out=${t.outputTokens ?? '-'}`,
      )
    }

    if (user) {
      if (args.unsafeIncludeContent) {
        const text = extractUserText(user.contentJson) ?? '(no text)'
        console.log(`  user prompt: ${JSON.stringify(text)}`)
      } else {
        console.log('  user prompt: [REDACTED — pass --unsafe-include-content to see]')
      }
    }
    if (assistant && args.unsafeIncludeContent) {
      console.log(`  assistant: ${summarizeAssistantPayload(assistant.contentJson)}`)
    }
    console.log('')
  }
}

main().catch((e) => {
  console.error('[replay] error:', e)
  process.exit(1)
})
