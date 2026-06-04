import { NextResponse } from 'next/server'
import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
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

const MAX_BODY_BYTES = 32 * 1024
const SOURCES = ['llm', 'edit', 'import', 'fork-seed'] as const

const VersionWriteSchema = z.object({
  // Mandatory CAS token. The server REQUIRES this on every edit write so
  // last-write-wins concurrent edits can never silently overwrite each
  // other — see plan §"Concurrency model".
  parentVersionId: z.string().min(1).max(64).nullable(),
  score: ScoreSchema,
  abc: z.string().max(64 * 1024).optional(),
  source: z.enum(SOURCES),
  coalesceKey: z.string().min(1).max(64).optional(),
  idempotencyKey: z.string().min(1).max(64),
})

type VersionWriteBody = z.infer<typeof VersionWriteSchema>

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

  let body: VersionWriteBody
  try {
    body = VersionWriteSchema.parse(JSON.parse(raw))
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Invalid request body'
    return errorResponse('invalid_request', 400, msg)
  }

  // Defense-in-depth semantic validation (duration sums, tuplets,
  // bar-alignment). ScoreSchema is shape-only.
  try {
    validateScore(body.score)
  } catch (e) {
    const msg = e instanceof ValidationError ? e.message : 'Invalid score'
    return errorResponse('invalid_request', 400, msg)
  }

  const session = await getRequestUser()
  const response = await writeVersion(session.userId, sessionId, body)
  return attachRecoveryHeader(response, session)
}

/**
 * Insert one score_versions row, gated by:
 *   - ownership check (user can't write to another user's session)
 *   - idempotency dedup (same key → return the existing row's id)
 *   - CAS on sessions.head_version_id (caller's parentVersionId must match)
 *
 * Returns 200 with `{ versionId }` on success, 409 with
 * `{ code: 'stale_parent', currentHead }` on CAS mismatch.
 */
async function writeVersion(
  userId: string,
  sessionId: string,
  body: VersionWriteBody,
): Promise<NextResponse> {
  const db = getDb()
  const ts = Math.floor(Date.now() / 1000)

  // 1. Ownership + load current head in one query.
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

  // 2. Idempotency: if the client has already POSTed this exact write,
  // return the prior row instead of erroring on UNIQUE constraint or
  // creating a duplicate. Safe to check outside a transaction because
  // idempotency_key is UNIQUE — even if a concurrent write lands between
  // the SELECT and our INSERT, the INSERT will hit the constraint and
  // we'll fall back to the same lookup.
  const existing = await db
    .select({ id: scoreVersions.id })
    .from(scoreVersions)
    .where(eq(scoreVersions.idempotencyKey, body.idempotencyKey))
    .limit(1)
    .get()
  if (existing) {
    return NextResponse.json({ versionId: existing.id }, { status: 200 })
  }

  // 3. CAS check. parentVersionId === null means "I believe the session
  // has no head yet" (newly-created session, no LLM turn). Otherwise
  // the value must equal the session's current head.
  if (body.parentVersionId !== session.headVersionId) {
    return NextResponse.json(
      {
        code: 'stale_parent',
        error: 'Session head moved since you read it; reconcile and retry.',
        currentHead: session.headVersionId ?? null,
      },
      { status: 409 },
    )
  }

  // 4. Insert + bump head in a transaction. Same hash dedup that
  // appendMessages relies on is preserved by idempotency_key UNIQUE.
  const versionId = crypto.randomUUID()
  const hash = scoreHash(body.score)
  try {
    db.transaction((tx) => {
      tx.insert(scoreVersions)
        .values({
          id: versionId,
          sessionId,
          parentVersionId: body.parentVersionId,
          scoreJson: JSON.stringify(body.score),
          scoreHash: hash,
          source: body.source,
          coalesceKey: body.coalesceKey ?? null,
          idempotencyKey: body.idempotencyKey,
          createdAt: ts,
        })
        .run()
      // Re-check head INSIDE the transaction to defeat the read-then-write
      // race: two concurrent writers both see head=H, both pass step 3,
      // both reach this transaction. Whichever lands second will see
      // head no longer equals body.parentVersionId and we abort.
      const fresh = tx
        .select({ head: sessions.headVersionId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get()
      if (!fresh || fresh.head !== body.parentVersionId) {
        throw new StaleParentError(fresh?.head ?? null)
      }
      // Belt-and-suspenders SQL-level CAS in addition to the JS check
      // above. SQL `NULL = NULL` is false, so we need isNull() for the
      // newly-created-session case.
      const headCas =
        body.parentVersionId === null
          ? isNull(sessions.headVersionId)
          : eq(sessions.headVersionId, body.parentVersionId)
      const result = tx
        .update(sessions)
        .set({ headVersionId: versionId, updatedAt: ts, lastMessageAt: ts })
        .where(and(eq(sessions.id, sessionId), headCas))
        .run()
      if (result.changes !== 1) {
        // Lost the race between our JS check and this UPDATE.
        throw new StaleParentError(null)
      }
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
    // Idempotency-key race: a concurrent identical POST won. Re-read.
    const reread = await db
      .select({ id: scoreVersions.id })
      .from(scoreVersions)
      .where(eq(scoreVersions.idempotencyKey, body.idempotencyKey))
      .limit(1)
      .get()
    if (reread) {
      return NextResponse.json({ versionId: reread.id }, { status: 200 })
    }
    throw e
  }

  return NextResponse.json({ versionId }, { status: 201 })
}

class StaleParentError extends Error {
  constructor(public currentHead: string | null) {
    super('Stale parent')
    this.name = 'StaleParentError'
  }
}
