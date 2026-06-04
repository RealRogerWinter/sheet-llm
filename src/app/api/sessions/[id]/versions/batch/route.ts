import { NextResponse } from 'next/server'
import { z } from 'zod'
import { eq, inArray } from 'drizzle-orm'
import { getRequestUser } from '@/lib/auth/session'
import { attachRecoveryHeader } from '@/lib/auth/attachRecovery'
import { getDb } from '@/lib/db'
import { scoreVersions, sessions } from '@/lib/db/schema'
import { ScoreSchema } from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'
import { ValidationError } from '@/lib/music/errors'
import { scoreHash } from '@/lib/orchestrator/scoreVersion'
import { checkSameOrigin, errorResponse } from '@/app/api/chat/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Generous because this endpoint also serves the beforeunload sendBeacon
// path, where the queue may hold ~minutes of accumulated edits. The
// per-score MAX_SCORE_JSON_BYTES check below is the meaningful DOS
// defense — this just caps the outer batch envelope.
const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_VERSIONS_PER_BATCH = 64
// Per-version score JSON ceiling. A full symphony movement at SATB
// serializes to ~100 KB; 1 MB is ~10× headroom while still blocking a
// runaway producer (LLM hallucination, infinite-loop client bug) from
// flooding the writer with multi-MB rows that would blow up the
// renderer downstream anyway.
const MAX_SCORE_JSON_BYTES = 1 * 1024 * 1024
const SOURCES = ['llm', 'edit', 'import', 'fork-seed'] as const

const VersionEntrySchema = z.object({
  idempotencyKey: z.string().min(1).max(64),
  score: ScoreSchema,
  abc: z.string().max(64 * 1024).optional(),
  source: z.enum(SOURCES),
  coalesceKey: z.string().min(1).max(64).optional(),
})

const BatchSchema = z.object({
  baseParentVersionId: z.string().min(1).max(64).nullable(),
  versions: z.array(VersionEntrySchema).min(1).max(MAX_VERSIONS_PER_BATCH),
})

type BatchBody = z.infer<typeof BatchSchema>

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const origin = checkSameOrigin(request)
  if (!origin.ok) return origin.res

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    return errorResponse('invalid_request', 413, 'Request body too large')
  }

  const { id: sessionId } = await ctx.params
  if (!sessionId || sessionId.length > 64) {
    return errorResponse('invalid_request', 400, 'Invalid sessionId')
  }

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return errorResponse('invalid_request', 400, 'Could not read request body')
  }
  if (raw.length > MAX_BODY_BYTES) {
    return errorResponse('invalid_request', 413, 'Request body too large')
  }

  let body: BatchBody
  try {
    body = BatchSchema.parse(JSON.parse(raw))
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Invalid request body'
    return errorResponse('invalid_request', 400, msg)
  }

  // Per-version size cap — measured AFTER schema parse so the check
  // runs on the validated shape, not on attacker-controlled padding
  // (extra keys are stripped by zod before this point). Returns 413
  // rather than 400 so the client can distinguish "rejected for size"
  // from "rejected for shape" without parsing the error body.
  for (let i = 0; i < body.versions.length; i++) {
    const size = JSON.stringify(body.versions[i].score).length
    if (size > MAX_SCORE_JSON_BYTES) {
      return errorResponse(
        'invalid_request',
        413,
        `versions[${i}].score is ${size} bytes; the cap is ${MAX_SCORE_JSON_BYTES}`,
      )
    }
  }

  // Defense-in-depth semantic validation. ScoreSchema is shape-only;
  // measure-duration sums, tuplet completeness, and bar-alignment are
  // enforced by validateScore. Without this, a client bug (or a stale
  // editOperations path) could persist an invalid score that downstream
  // renderers / playback can't make sense of.
  for (let i = 0; i < body.versions.length; i++) {
    try {
      validateScore(body.versions[i].score)
    } catch (e) {
      const msg = e instanceof ValidationError ? e.message : 'Invalid score'
      return errorResponse('invalid_request', 400, `versions[${i}]: ${msg}`)
    }
  }

  const session = await getRequestUser()
  const response = await writeBatch(session.userId, sessionId, body)
  return attachRecoveryHeader(response, session)
}

async function writeBatch(
  userId: string,
  sessionId: string,
  body: BatchBody,
): Promise<NextResponse> {
  const db = getDb()
  const ts = Math.floor(Date.now() / 1000)

  // Ownership + load current head.
  const session = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      headVersionId: sessions.headVersionId,
      deletedAt: sessions.deletedAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
    .get()
  if (!session || session.userId !== userId || session.deletedAt != null) {
    return errorResponse('chat_not_found', 404, 'Session not found')
  }

  // Bulk-resolve any previously-seen idempotency keys so a retry of the
  // whole batch returns each version's existing id instead of throwing
  // on the UNIQUE constraint.
  const idemKeys = body.versions.map((v) => v.idempotencyKey)
  const existing = await db
    .select({ id: scoreVersions.id, idemKey: scoreVersions.idempotencyKey })
    .from(scoreVersions)
    .where(inArray(scoreVersions.idempotencyKey, idemKeys))
  const existingByKey = new Map<string, string>()
  for (const row of existing) {
    if (row.idemKey) existingByKey.set(row.idemKey, row.id)
  }

  // If EVERY entry was already written, short-circuit with the original
  // ids. Common when the client retries an unloaded beacon.
  if (existingByKey.size === body.versions.length) {
    const versionIds = body.versions.map((v) => existingByKey.get(v.idempotencyKey)!)
    return NextResponse.json({ versionIds }, { status: 200 })
  }

  // CAS pre-check (cheap fail-fast — re-checked inside the transaction).
  if (body.baseParentVersionId !== session.headVersionId) {
    return NextResponse.json(
      {
        code: 'stale_parent',
        error: 'Session head moved since you read it; reconcile and retry.',
        currentHead: session.headVersionId ?? null,
      },
      { status: 409 },
    )
  }

  // Build the chain inside one transaction: each new version's
  // parent_version_id is either the prior new version, OR the prior
  // EXISTING version (idempotent re-write of a contiguous prefix).
  const versionIds: string[] = []
  try {
    db.transaction((tx) => {
      // Re-verify head inside the transaction to defeat the read-then-write
      // race.
      const fresh = tx
        .select({ head: sessions.headVersionId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get()
      if (!fresh || fresh.head !== body.baseParentVersionId) {
        throw new StaleParentError(fresh?.head ?? null)
      }

      let prevId: string | null = body.baseParentVersionId
      for (const entry of body.versions) {
        const dedup = existingByKey.get(entry.idempotencyKey)
        if (dedup) {
          // Already exists. Advance the chain pointer but don't re-insert.
          // For this to be coherent, the existing row's parent_version_id
          // SHOULD equal prevId — if it doesn't, the client is replaying
          // a stale prefix on top of a divergent head; the CAS at the top
          // would normally have caught it, but it's still possible if the
          // prior batch was partial. Just trust the existing chain.
          prevId = dedup
          versionIds.push(dedup)
          continue
        }
        const id = crypto.randomUUID()
        tx.insert(scoreVersions)
          .values({
            id,
            sessionId,
            parentVersionId: prevId,
            scoreJson: JSON.stringify(entry.score),
            scoreHash: scoreHash(entry.score),
            source: entry.source,
            coalesceKey: entry.coalesceKey ?? null,
            idempotencyKey: entry.idempotencyKey,
            createdAt: ts,
          })
          .run()
        prevId = id
        versionIds.push(id)
      }

      // Final head is whatever the last entry resolved to.
      tx.update(sessions)
        .set({ headVersionId: prevId, updatedAt: ts, lastMessageAt: ts })
        .where(eq(sessions.id, sessionId))
        .run()
    })
  } catch (e) {
    if (e instanceof StaleParentError) {
      return NextResponse.json(
        {
          code: 'stale_parent',
          error: 'Session head moved while writing; reconcile and retry.',
          currentHead: e.currentHead,
        },
        { status: 409 },
      )
    }
    throw e
  }

  return NextResponse.json({ versionIds }, { status: 201 })
}

class StaleParentError extends Error {
  constructor(public currentHead: string | null) {
    super('Stale parent')
    this.name = 'StaleParentError'
  }
}
