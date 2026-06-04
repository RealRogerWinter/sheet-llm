import { NextResponse } from 'next/server'
import { eq, and } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '@/lib/db'
import { sessions, scoreVersions } from '@/lib/db/schema'
import { getRequestUser } from '@/lib/auth/session'
import { attachRecoveryHeader } from '@/lib/auth/attachRecovery'
import { hasConversation } from '@/lib/llm/conversations'
import { ScoreSchema } from '@/lib/music/types'
import { scoreHash } from '@/lib/orchestrator/scoreVersion'
import type { ConfirmReplacementResponse } from '@/lib/shared/types'
import {
  UuidSchema,
  checkSameOrigin,
  errorResponse,
} from '@/app/api/chat/route'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 2 * 1024

const ConfirmRequestSchema = z.object({
  chatId: UuidSchema,
  candidateVersionId: UuidSchema,
  decision: z.enum(['accept', 'reject', 'dont_ask_again_this_session']),
})

/**
 * M3.5-PR-4 — confirm or reject a replacement-flagged turn.
 *
 * The orchestrator marked the previous /api/chat turn as
 * `requiresConfirmation: true`, persisted the candidate
 * score_versions row, but DID NOT advance sessions.head_version_id.
 * The UI surfaced a modal; the user's choice flows here.
 *
 * Decisions:
 *   accept                       — advance the head to the candidate.
 *   reject                       — write a `revert` row pointing at
 *                                   the prior head; head stays at
 *                                   prior head. (Candidate becomes
 *                                   orphan, matching the existing
 *                                   score_versions chain semantics
 *                                   for undone-then-replaced branches
 *                                   — see project_codebase_arch.md.)
 *   dont_ask_again_this_session  — same as accept + flip
 *                                   sessions.replacement_gate_suppressed
 *                                   so the orchestrator skips the gate
 *                                   for subsequent turns in this session.
 */
export async function POST(request: Request) {
  const origin = checkSameOrigin(request)
  if (!origin.ok) return origin.res

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    return errorResponse('invalid_request', 413, 'Request body too large')
  }

  let text: string
  try {
    text = await request.text()
  } catch {
    return errorResponse('invalid_request', 400, 'Could not read request body')
  }
  if (text.length > MAX_BODY_BYTES) {
    return errorResponse('invalid_request', 413, 'Request body too large')
  }

  let parsed
  try {
    parsed = ConfirmRequestSchema.parse(JSON.parse(text))
  } catch {
    return errorResponse('invalid_request', 400, 'Invalid request body')
  }

  const session = await getRequestUser()
  const { userId } = session
  if (!(await hasConversation(userId, parsed.chatId))) {
    return errorResponse('chat_not_found', 404, 'Chat not found')
  }

  const db = getDb()

  // Resolve the candidate row + confirm it belongs to this session.
  const candidate = await db
    .select({
      id: scoreVersions.id,
      sessionId: scoreVersions.sessionId,
      scoreJson: scoreVersions.scoreJson,
    })
    .from(scoreVersions)
    .where(
      and(
        eq(scoreVersions.id, parsed.candidateVersionId),
        eq(scoreVersions.sessionId, parsed.chatId),
      ),
    )
    .limit(1)
    .get()
  if (!candidate) {
    return errorResponse(
      'chat_not_found',
      404,
      'Candidate score version not found for this session',
    )
  }

  // Resolve current head so we can either skip a no-op accept, write a
  // revert chained to it, or detect when the session's head has already
  // been advanced past the candidate (concurrent confirm POST or
  // sidebar action). All three decisions read the head first.
  const sessionRow = await db
    .select({
      head: sessions.headVersionId,
      gateSuppressed: sessions.replacementGateSuppressed,
    })
    .from(sessions)
    .where(eq(sessions.id, parsed.chatId))
    .get()
  if (!sessionRow) {
    return errorResponse('chat_not_found', 404, 'Chat not found')
  }
  const priorHead = sessionRow.head ?? null

  const nowSec = Math.floor(Date.now() / 1000)

  if (parsed.decision === 'accept' || parsed.decision === 'dont_ask_again_this_session') {
    // Advance the head pointer to the candidate. If the head has
    // already been moved by some concurrent path (manual edit, etc.),
    // we still set it — the user explicitly asked for replacement and
    // the candidate row stays linked to its parent regardless.
    const update: Record<string, unknown> = {
      headVersionId: parsed.candidateVersionId,
      updatedAt: nowSec,
      lastMessageAt: nowSec,
    }
    if (parsed.decision === 'dont_ask_again_this_session') {
      update.replacementGateSuppressed = 1
    }
    await db.update(sessions).set(update).where(eq(sessions.id, parsed.chatId)).run()

    const body: ConfirmReplacementResponse = {
      chatId: parsed.chatId,
      headVersionId: parsed.candidateVersionId,
      replacementGateSuppressed:
        parsed.decision === 'dont_ask_again_this_session' || sessionRow.gateSuppressed === 1,
    }
    return attachRecoveryHeader(NextResponse.json(body), session)
  }

  // decision === 'reject'
  //
  // Write a `revert` score_versions row pointing at the PRIOR head
  // (re-asserting "this is still the current score"). The candidate
  // row remains in DB as an orphan branch — matching the existing
  // chain semantics. Head stays at the revert row's id (which equals
  // the prior head's content), so the client's freshness check
  // continues to match.
  if (!priorHead) {
    // Edge case: candidate appeared without any prior head. This
    // shouldn't be reachable in practice (no prior head ⇒ nothing to
    // confirm against; the gate only fires when beforeScore exists).
    // Returning an empty-string headVersionId would corrupt downstream
    // type expectations, so surface the inconsistent state as a 409
    // instead of pretending things are fine.
    return errorResponse(
      'invalid_request',
      409,
      'Cannot reject replacement when there is no prior head version',
    )
  }

  // Re-hash the prior head's score to keep CAS chains coherent.
  const priorHeadRow = await db
    .select({ scoreJson: scoreVersions.scoreJson })
    .from(scoreVersions)
    .where(eq(scoreVersions.id, priorHead))
    .limit(1)
    .get()
  if (!priorHeadRow) {
    return errorResponse('internal_error', 500, 'Prior head row missing')
  }
  let priorScore
  try {
    priorScore = ScoreSchema.parse(JSON.parse(priorHeadRow.scoreJson))
  } catch {
    return errorResponse('internal_error', 500, 'Prior head score malformed')
  }

  const revertId = crypto.randomUUID()
  const hash = scoreHash(priorScore)
  await db
    .insert(scoreVersions)
    .values({
      id: revertId,
      sessionId: parsed.chatId,
      parentVersionId: priorHead,
      scoreJson: JSON.stringify(priorScore),
      scoreHash: hash,
      source: 'revert',
      createdAt: nowSec,
      schemaVersion: 1,
    })
    .run()

  await db
    .update(sessions)
    .set({
      headVersionId: revertId,
      updatedAt: nowSec,
      lastMessageAt: nowSec,
    })
    .where(eq(sessions.id, parsed.chatId))
    .run()

  const body: ConfirmReplacementResponse = {
    chatId: parsed.chatId,
    headVersionId: revertId,
    replacementGateSuppressed: sessionRow.gateSuppressed === 1,
  }
  return attachRecoveryHeader(NextResponse.json(body), session)
}
