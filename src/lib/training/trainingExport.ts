import { and, eq, gt, lt, desc, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import type { getDb } from '@/lib/db'
import {
  messages,
  orchestratorTurns,
  scoreVersions,
  trainingPairs,
} from '@/lib/db/schema'
import { ScoreSchema, type Score } from '@/lib/music/types'

/**
 * One row of the neutral training-export JSONL (SHE-18 PR5). Anonymized: it
 * carries NO user/session/message/request identifier — only the opaque
 * `sessionHash` (from training_pairs) survives, for dedup/grouping. The `id`
 * is the turn UUID (not PII). `userText` is the raw prompt and MAY contain
 * user free-text PII — see the redaction note in scripts/export-training-pairs.
 */
export interface TrainingExportRow {
  id: string
  sessionHash: string
  userText: string | null
  beforeScore: Score | null
  afterScore: Score
  classification: string | null
  model: string | null
  /** 'accepted' (explicitly confirmed) or 'kept' (NULL outcome = implicitly
   *  kept). 'reverted' rows are filtered out; 'superseded' is reserved (the
   *  routes already write an explicit accepted/reverted, so it is not derived
   *  here today). */
  outcome: string
  preservationOk: boolean | null
  retainedEventRatio: number | null
  replacementBlocked: boolean
  replacementReasons: string[] | null
  tokens: { input: number | null; output: number | null }
  createdAt: number
}

export interface ExportOptions {
  /** Incremental watermark: only rows with captured_at > this are exported. */
  sinceCapturedAt?: number
  /** Cap the batch size (ordered by captured_at asc). */
  limit?: number
}

/** Drop the only PII-bearing reason variant — `title 'X' → 'Y'` embeds the
 *  user-authored before-score title. The others (key/meter/measure-count) are
 *  safe low-cardinality strings. */
export function scrubReasons(reasons: string[]): string[] {
  return reasons.filter((r) => !/^title /.test(r))
}

/**
 * Anonymize a Score for export by dropping the score-level AUTHORSHIP free-text
 * — `title`/`composer`/`arranger`/`lyricist`/`copyright` (identity/attribution,
 * ~zero music-edit training signal) and `annotations` (free-text rehearsal/
 * expression marks). None of these are part of `hashMeasure`, so the
 * preservation round-trip is unaffected. The MUSICAL structure (key, meter,
 * measures, events, spans, …) is kept verbatim. Per-event `lyrics` are KEPT
 * (they're musical content + part of the measure hash); like `userText`, they
 * remain a documented free-text surface a future redaction pass may scrub.
 */
export function redactScore(score: Score): Score {
  const copy: Score = { ...score }
  delete copy.title
  delete copy.composer
  delete copy.arranger
  delete copy.lyricist
  delete copy.copyright
  delete copy.annotations
  return copy
}

function parseScore(json: string | null | undefined): Score | null {
  if (!json) return null
  const parsed = ScoreSchema.safeParse(JSON.parse(json))
  return parsed.success ? parsed.data : null
}

function userTextFromContent(json: string): string | null {
  try {
    const blocks = JSON.parse(json) as Array<{ type?: string; text?: string }>
    for (const b of blocks) if (b.type === 'text' && typeof b.text === 'string') return b.text
  } catch {
    /* fall through */
  }
  return null
}

/**
 * Join training_pairs ⨝ orchestrator_turns ⨝ score_versions ⨝ messages and
 * project the anonymized training tuple. Filters to turns that are USABLE
 * training data: consented (a marker exists), `final_status='ok'`, an emitted
 * score (`after_score_version_id` present), and NOT explicitly rejected
 * (`outcome IS NULL` = implicitly kept, OR `outcome='accepted'`). Identifiers
 * are never projected. Ordered by captured_at asc; returns the max captured_at
 * seen as the next incremental watermark.
 */
export function exportTrainingPairs(
  db: ReturnType<typeof getDb>,
  opts: ExportOptions = {},
): { rows: TrainingExportRow[]; watermark: number; skipped: number } {
  const markerWhere = and(
    opts.sinceCapturedAt !== undefined
      ? gt(trainingPairs.capturedAt, opts.sinceCapturedAt)
      : undefined,
  )

  const base = db
    .select({
      turnId: orchestratorTurns.id,
      sessionHash: trainingPairs.sessionHash,
      capturedAt: trainingPairs.capturedAt,
      classification: orchestratorTurns.classificationKind,
      model: orchestratorTurns.handlerModel,
      afterVersionId: orchestratorTurns.afterScoreVersionId,
      retainedEventRatio: orchestratorTurns.retainedEventRatio,
      replacementBlocked: orchestratorTurns.replacementBlocked,
      outcome: orchestratorTurns.outcome,
      preservationOk: orchestratorTurns.preservationOk,
      replacementReasons: orchestratorTurns.replacementReasons,
      inputTokens: orchestratorTurns.inputTokens,
      outputTokens: orchestratorTurns.outputTokens,
      createdAt: orchestratorTurns.createdAt,
    })
    .from(trainingPairs)
    .innerJoin(orchestratorTurns, eq(trainingPairs.turnId, orchestratorTurns.id))
    .where(
      and(
        markerWhere,
        eq(orchestratorTurns.finalStatus, 'ok'),
        // must have emitted a score
        isNotNull(orchestratorTurns.afterScoreVersionId),
        // not explicitly rejected: NULL (implicitly kept) or accepted
        or(isNull(orchestratorTurns.outcome), eq(orchestratorTurns.outcome, 'accepted')),
      ),
    )
    .orderBy(trainingPairs.capturedAt)
    .all()

  // Apply `limit` WITHOUT splitting a group of equal captured_at: the watermark
  // is max(captured_at) over emitted rows and the next run filters strictly
  // greater, so cutting a same-ms group in half would permanently skip the
  // tail. Extend the slice to include the whole final captured_at group.
  let limited = base
  if (opts.limit !== undefined && base.length > opts.limit) {
    const boundary = base[opts.limit - 1].capturedAt
    let end = opts.limit
    while (end < base.length && base[end].capturedAt === boundary) end++
    limited = base.slice(0, end)
  }
  if (limited.length === 0) return { rows: [], watermark: opts.sinceCapturedAt ?? 0, skipped: 0 }

  // Batch-fetch the after versions (+ their parents = the before scores) and
  // the assistant messages that carry each after version (for userText).
  const afterIds = limited.map((t) => t.afterVersionId as string)
  const afterVersions = db
    .select()
    .from(scoreVersions)
    .where(inArray(scoreVersions.id, afterIds))
    .all()
  const afterById = new Map(afterVersions.map((v) => [v.id, v]))
  const parentIds = afterVersions.map((v) => v.parentVersionId).filter((p): p is string => !!p)
  const parentById = new Map(
    (parentIds.length
      ? db.select().from(scoreVersions).where(inArray(scoreVersions.id, parentIds)).all()
      : []
    ).map((v) => [v.id, v]),
  )

  const rows: TrainingExportRow[] = []
  let watermark = opts.sinceCapturedAt ?? 0
  let skipped = 0 // rows dropped because a stored score wouldn't parse
  for (const t of limited) {
    const afterVer = afterById.get(t.afterVersionId as string)
    const afterScore = parseScore(afterVer?.scoreJson)
    if (!afterScore) {
      // unparseable / missing after-score — skip rather than emit garbage.
      skipped++
      continue
    }
    // A parent we wrote that won't parse would silently look like a fresh-gen
    // (null before) and skew the round-trip — count it so a corpus-wide
    // corruption is visible rather than silent.
    let beforeScore: Score | null = null
    if (afterVer?.parentVersionId) {
      const parentJson = parentById.get(afterVer.parentVersionId)?.scoreJson
      beforeScore = parseScore(parentJson)
      if (parentJson && beforeScore === null) skipped++
    }

    // userText: the user prompt preceding the assistant message that carries
    // this after version (messages.score_version_id is the live link).
    const assistantMsg = db
      .select({ sessionId: messages.sessionId, seq: messages.seq })
      .from(messages)
      .where(eq(messages.scoreVersionId, t.afterVersionId as string))
      .limit(1)
      .get()
    let userText: string | null = null
    if (assistantMsg) {
      const userMsg = db
        .select({ contentJson: messages.contentJson })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, assistantMsg.sessionId),
            eq(messages.role, 'user'),
            // a real prompt, never a synthetic orch/revert turn.
            eq(messages.isSynthetic, 0),
            lt(messages.seq, assistantMsg.seq),
          ),
        )
        .orderBy(desc(messages.seq))
        .limit(1)
        .get()
      userText = userMsg ? userTextFromContent(userMsg.contentJson) : null
    }

    const reasons = t.replacementReasons
      ? scrubReasons(JSON.parse(t.replacementReasons) as string[])
      : null

    rows.push({
      id: t.turnId,
      sessionHash: t.sessionHash,
      userText: userText || null, // '' (empty text block) → null
      beforeScore: beforeScore ? redactScore(beforeScore) : null,
      afterScore: redactScore(afterScore),
      classification: t.classification,
      model: t.model,
      outcome: t.outcome ?? 'kept',
      preservationOk: t.preservationOk === null ? null : t.preservationOk === 1,
      retainedEventRatio: t.retainedEventRatio,
      replacementBlocked: t.replacementBlocked === 1,
      replacementReasons: reasons,
      tokens: { input: t.inputTokens, output: t.outputTokens },
      createdAt: t.createdAt,
    })
    if (t.capturedAt > watermark) watermark = t.capturedAt
  }

  return { rows, watermark, skipped }
}
