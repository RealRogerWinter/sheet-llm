import { NextResponse } from 'next/server'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { getRequestUser } from '@/lib/auth/session'
import { attachRecoveryHeader } from '@/lib/auth/attachRecovery'
import { getDb } from '@/lib/db'
import { messages, sessions } from '@/lib/db/schema'
import type { SessionSummary } from '@/lib/shared/types'
import { checkSameOrigin } from '@/app/api/chat/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * List sessions owned by the current user, most-recently-active first.
 *
 * Each row carries a one-line preview snippet derived from the latest user
 * message (if any) — useful for sidebar rendering without an N+1 fetch.
 */
export async function GET(request: Request) {
  const origin = checkSameOrigin(request)
  if (!origin.ok) return origin.res

  const session = await getRequestUser()
  const { userId } = session
  const db = getDb()

  const url = new URL(request.url)
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT))

  // One query: sessions + a denormalized count of message rows so the
  // sidebar can hide empty drafts. The preview snippet is fetched per
  // session in a second query — acceptable up to a few hundred sessions;
  // if it gets hot we'll roll the snippet into a column on write.
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      createdAt: sessions.createdAt,
      lastMessageAt: sessions.lastMessageAt,
      headVersionId: sessions.headVersionId,
      forkedFromSessionId: sessions.forkedFromSessionId,
      messageCount: sql<number>`(SELECT COUNT(*) FROM ${messages} WHERE ${messages.sessionId} = ${sessions.id})`,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .orderBy(desc(sessions.lastMessageAt))
    .limit(limit)

  const summaries: SessionSummary[] = []
  for (const row of rows) {
    // Best-effort preview: first ~80 chars of the most recent user
    // message. Unconditional query (Drizzle's COUNT subquery type comes
    // back as bigint-or-string depending on driver tier, so don't gate
    // on it) — the LIMIT 1 + index on (session_id, seq) makes the empty
    // case fast.
    const lastUser = await db
      .select({ contentJson: messages.contentJson })
      .from(messages)
      .where(and(eq(messages.sessionId, row.id), eq(messages.role, 'user')))
      .orderBy(desc(messages.seq))
      .limit(1)
      .get()
    const preview = lastUser ? extractTextPreview(lastUser.contentJson) : undefined
    summaries.push({
      id: row.id,
      title: row.title ?? null,
      lastMessageAt: row.lastMessageAt,
      createdAt: row.createdAt,
      messageCount: Number(row.messageCount),
      headVersionId: row.headVersionId ?? null,
      forkedFromSessionId: row.forkedFromSessionId ?? null,
      preview: preview ?? null,
    })
  }
  return attachRecoveryHeader(NextResponse.json({ sessions: summaries }), session)
}

/**
 * Best-effort: pluck the first text block from an Anthropic-shape
 * content_json blob and trim to 80 chars. Returns undefined on parse
 * failure or no text — we'd rather skip a preview than ship one with
 * the wrong shape.
 */
function extractTextPreview(contentJson: string): string | undefined {
  try {
    const blocks = JSON.parse(contentJson) as Array<{ type: string; text?: string }>
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const trimmed = block.text.trim()
        return trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * POST: create a new empty session for the current user. Returns the
 * new session id. Used by the sidebar's "+ New score" button.
 */
export async function POST(request: Request) {
  const origin = checkSameOrigin(request)
  if (!origin.ok) return origin.res

  const session = await getRequestUser()
  const { userId } = session
  const db = getDb()
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await db.insert(sessions).values({
    id,
    userId,
    createdAt: ts,
    updatedAt: ts,
    lastMessageAt: ts,
  })
  // Return the same shape as a list row would, so the client can splice
  // it into the sidebar without a refetch.
  const summary: SessionSummary = {
    id,
    title: null,
    lastMessageAt: ts,
    createdAt: ts,
    messageCount: 0,
    headVersionId: null,
    forkedFromSessionId: null,
    preview: null,
  }
  return attachRecoveryHeader(
    NextResponse.json({ session: summary }, { status: 201 }),
    session,
  )
}
