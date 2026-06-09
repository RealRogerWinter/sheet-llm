/**
 * SHE-18 PR5 — export the consented training corpus as neutral JSONL.
 *
 * Joins training_pairs ⨝ orchestrator_turns ⨝ score_versions ⨝ messages,
 * filters to USABLE turns (consented marker, final_status='ok', emitted score,
 * not explicitly reverted), ANONYMIZES (no session/user/message/request id or
 * error column survives — only the opaque session_hash), and writes one JSON
 * object per line. Incremental + idempotent: pass `--since <ms>` (the last
 * watermark) and only newer captures are emitted; the new watermark is printed
 * to STDERR so the caller (PR6 cron) can persist it. STDOUT is pure JSONL.
 *
 * Usage:
 *   pnpm export-training-pairs [--since <captured_at_ms>] [--limit <n>] [--out <file>]
 *
 * Anonymization: NO session/user/message/request id or `error` column is
 * emitted — only the opaque `sessionHash`. Score-level authorship free-text
 * (title/composer/arranger/lyricist/copyright) + `annotations` are redacted
 * from before/after scores, and `replacement_reasons` `title …` strings are
 * scrubbed.
 *
 * ⚠️ Residual free-text PII surface (documented, redaction DEFERRED): the raw
 * `userText` prompt and per-event `lyrics` are kept (they're the training
 * signal). Treat the output as sensitive; a redaction pass over these is a
 * follow-up. And per the SHE-18 decision, this data must not feed a training
 * run until a ToS/legal review clears it.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { ensureMigrationsApplied, getDb } from '@/lib/db'
import { exportTrainingPairs } from '@/lib/training/trainingExport'

/** Read a watermark file as a non-negative finite number, or undefined when
 *  absent/empty/garbage (degrade to a full export rather than NaN). */
function readWatermark(path: string): number | undefined {
  if (!existsSync(path)) return undefined
  const n = Number(readFileSync(path, 'utf8').trim())
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** Persist the watermark atomically (temp + rename) so an interrupted or
 *  overlapping run can't leave a torn value the next run would misread. */
function writeWatermark(path: string, value: number): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, String(value))
  renameSync(tmp, path)
}

interface CliArgs {
  since?: number
  limit?: number
  out?: string
  watermarkFile?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  const numArg = (name: string, raw: string | undefined): number => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) {
      console.error(`${name} requires a non-negative numeric value`)
      process.exit(1)
    }
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--since') args.since = numArg('--since', argv[++i])
    else if (a === '--limit') args.limit = numArg('--limit', argv[++i])
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--watermark-file') args.watermarkFile = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.error(
        'Usage: pnpm export-training-pairs [--since <ms>] [--limit <n>] [--out <file>] [--watermark-file <path>]',
      )
      process.exit(0)
    } else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`)
      process.exit(1)
    }
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const db = getDb()
  ensureMigrationsApplied(db)

  // --watermark-file makes the export a single idempotent cron command: read
  // the last watermark from the file (explicit --since wins if both given),
  // export only newer rows, then persist the new watermark back. First run
  // (no file yet) starts from 0.
  const priorWatermark = args.watermarkFile ? readWatermark(args.watermarkFile) : undefined
  const since = args.since ?? priorWatermark

  const { rows, watermark, skipped } = exportTrainingPairs(db, {
    ...(since !== undefined ? { sinceCapturedAt: since } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  })

  const jsonl = rows.map((r) => JSON.stringify(r)).join('\n')
  if (args.out) {
    writeFileSync(args.out, jsonl + (jsonl ? '\n' : ''))
    console.error(`export-training-pairs: wrote ${rows.length} row(s) → ${args.out}`)
  } else if (jsonl) {
    process.stdout.write(jsonl + '\n')
  }
  // Watermark to stderr so stdout stays pure JSONL; the cron persists it as the
  // next --since. `skipped` flags stored scores that wouldn't parse (should be
  // 0; a non-zero value signals corpus corruption worth investigating).
  console.error(
    `export-training-pairs: rows=${rows.length} skipped=${skipped} watermark=${watermark}`,
  )
  // Persist the new watermark for the next scheduled run. Only advance it
  // (never move backward) so a manual --since re-run can't rewind the cron.
  if (args.watermarkFile) {
    writeWatermark(args.watermarkFile, Math.max(priorWatermark ?? 0, watermark))
  }
}

const isEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('export-training-pairs.ts') ||
    process.argv[1].endsWith('export-training-pairs.js'))
if (isEntry) {
  try {
    main()
  } catch (e) {
    console.error('[export-training-pairs] error:', e)
    process.exit(1)
  }
}
