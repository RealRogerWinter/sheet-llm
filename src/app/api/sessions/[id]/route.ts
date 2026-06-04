import { NextResponse } from 'next/server'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getRequestUser } from '@/lib/auth/session'
import { attachRecoveryHeader } from '@/lib/auth/attachRecovery'
import { getDb } from '@/lib/db'
import { messages, sessions } from '@/lib/db/schema'
import { deleteConversation } from '@/lib/llm/conversations'
import type { SessionSummary } from '@/lib/shared/types'
import { checkSameOrigin, errorResponse } from '@/app/api/chat/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 4 * 1024
const MAX_TITLE_LEN = 120

// `title` can be null to explicitly clear; an empty string normalizes to
// null server-side too (matches the "empty title = untitled" UX expectation).
const PatchSchema = z.object({
  title: z.string().max(MAX_TITLE_LEN).nullable(),
})

/**
 * PATCH /api/sessions/[id] — rename a session.
 * Ownership-scoped: 404 when the session doesn't exist OR belongs to
 * another user OR is soft-deleted. Empty / whitespace-only titles
 * normalize to NULL so the sidebar falls back to its preview-based
 * `titleFor` heuristic.
 */
export async function PATCH(
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
  if (!sessionId) {
    return errorResponse('invalid_request', 400, 'Missing sessionId')
  }

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return errorResponse('invalid_request', 400, 'Could not read request body')
  }
  let body: z.infer<typeof PatchSchema>
  try {
    body = PatchSchema.parse(JSON.parse(raw))
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Invalid request body'
    return errorResponse('invalid_request', 400, msg)
  }

  const session = await getRequestUser()
  const { userId } = session
  const db = getDb()
  const ts = Math.floor(Date.now() / 1000)

  // Normalize: whitespace-only / empty title → null (no row distinction
  // between "explicitly cleared" and "never set"; matches the sidebar's
  // titleFor fallback chain).
  const normalizedTitle =
    body.title === null || body.title.trim().length === 0
      ? null
      : body.title.trim()

  const result = await db
    .update(sessions)
    .set({ title: normalizedTitle, updatedAt: ts })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        isNull(sessions.deletedAt),
      ),
    )
    .returning({
      id: sessions.id,
      title: sessions.title,
      lastMessageAt: sessions.lastMessageAt,
      createdAt: sessions.createdAt,
      headVersionId: sessions.headVersionId,
      forkedFromSessionId: sessions.forkedFromSessionId,
    })
  if (result.length === 0) {
    return errorResponse('chat_not_found', 404, 'Session not found')
  }
  const row = result[0]

  // messageCount + preview pulled with one extra query — sidebar splices
  // the returned summary in place, so we want the same shape as GET.
  const countRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(messages)
    .where(eq(messages.sessionId, row.id))
    .get()
  const messageCount = Number(countRow?.count ?? 0)
  let preview: string | null = null
  if (messageCount > 0) {
    const lastUser = await db
      .select({ contentJson: messages.contentJson })
      .from(messages)
      .where(and(eq(messages.sessionId, row.id), eq(messages.role, 'user')))
      .orderBy(desc(messages.seq))
      .limit(1)
      .get()
    if (lastUser) {
      try {
        const blocks = JSON.parse(lastUser.contentJson) as Array<{
          type: string
          text?: string
        }>
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string') {
            const t = b.text.trim()
            preview = t.length > 80 ? t.slice(0, 80) + '…' : t
            break
          }
        }
      } catch {
        preview = null
      }
    }
  }

  const summary: SessionSummary = {
    id: row.id,
    title: row.title ?? null,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    messageCount,
    headVersionId: row.headVersionId ?? null,
    forkedFromSessionId: row.forkedFromSessionId ?? null,
    preview,
  }
  return attachRecoveryHeader(
    NextResponse.json({ session: summary }, { status: 200 }),
    session,
  )
}

/**
 * DELETE /api/sessions/[id] — soft-delete a session.
 * Idempotent: returns 204 even when the session doesn't exist or is
 * already deleted. Defense in depth — the existence of another user's
 * session must NOT leak via a 404 vs 204 distinction here, so the
 * userId scope is enforced inside `deleteConversation`.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const origin = checkSameOrigin(request)
  if (!origin.ok) return origin.res

  const { id: sessionId } = await ctx.params
  if (!sessionId) {
    return errorResponse('invalid_request', 400, 'Missing sessionId')
  }

  const session = await getRequestUser()
  await deleteConversation(session.userId, sessionId)
  return attachRecoveryHeader(new NextResponse(null, { status: 204 }), session)
}
