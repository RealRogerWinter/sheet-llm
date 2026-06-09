import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  appendMessages,
  getConversation,
  hasConversation,
} from '@/lib/llm/conversations'
import { getDb } from '@/lib/db'
import { sessions } from '@/lib/db/schema'
import { getRequestUser } from '@/lib/auth/session'
import { attachRecoveryHeader } from '@/lib/auth/attachRecovery'
import type { AssistantContentBlock, ChatMessage, UserContentBlock } from '@/lib/llm/wrapper'
import { RENDER_SCORE_TOOL_NAME } from '@/lib/llm/renderScoreTool'
import { ScoreSchema, type Score } from '@/lib/music/types'
import { ValidationError } from '@/lib/music/errors'
import { scoreToAbc } from '@/lib/music/scoreToAbc'
import { validateAbc, validateScore } from '@/lib/music/validateScore'
import { scoreHash } from '@/lib/orchestrator/scoreVersion'
import { recordTurnOutcome } from '@/lib/orchestrator/turnOutcome'
import { summarizeScore } from '@/lib/shared/scoreSummary'
import type { RevertResponse, TranscriptTurn } from '@/lib/shared/types'
import {
  UuidSchema,
  checkSameOrigin,
  errorResponse,
  synthToolUseId,
} from '@/app/api/chat/route'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 1024

const RevertRequestSchema = z.object({
  chatId: UuidSchema,
  toolUseId: z.string().min(1).max(128),
})

const REVERT_INTRO_TEXT = 'Reverted to an earlier version.'
/**
 * Synthetic user prompt anchoring the revert seed turn. Anthropic's
 * Messages API enforces strict user→assistant alternation, so the
 * appended assistant render_score must be preceded by a user turn.
 * `prepareMessagesForLLM` drops this pair (matched by the synthetic
 * `toolu_orch_*` id) before the next LLM call.
 */
const REVERT_USER_PROMPT = 'Revert to the previous version of this score.'

function findScoreByToolUseId(
  transcript: ChatMessage[],
  toolUseId: string,
): Score | undefined {
  for (const msg of transcript) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id === toolUseId) {
        const parsed = ScoreSchema.safeParse(block.input)
        return parsed.success ? parsed.data : undefined
      }
    }
  }
  return undefined
}

/**
 * In-place revert: append a synthetic user+assistant pair to the EXISTING
 * chat that carries a copy of the chosen historical score. Bumps the
 * session's head_version_id to the freshly-cloned score_versions row
 * (source = 'revert'). The original transcript is preserved — the revert
 * shows up as one more turn at the tail.
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
    parsed = RevertRequestSchema.parse(JSON.parse(text))
  } catch {
    return errorResponse('invalid_request', 400, 'Invalid request body')
  }

  const session = await getRequestUser()
  const { userId } = session
  if (!(await hasConversation(userId, parsed.chatId))) {
    return errorResponse('chat_not_found', 404, 'Chat not found')
  }
  const transcript = (await getConversation(userId, parsed.chatId))!
  const score = findScoreByToolUseId(transcript, parsed.toolUseId)
  if (!score) {
    return errorResponse('chat_not_found', 404, 'Score not found for the given toolUseId')
  }

  // Defensive: re-validate stored score (legacy transcripts may predate
  // current schema). Same posture as fork's seed validation.
  try {
    validateScore(score)
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResponse('validation_failed', 422, `Stored score failed validation: ${e.message}`)
    }
    throw e
  }

  let abc: string
  try {
    abc = scoreToAbc(score)
    await validateAbc(abc)
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResponse('validation_failed', 422, e.message)
    }
    throw e
  }

  // SHE-18 PR1 — capture the head BEFORE the revert so we can label the
  // turn that emitted it as `reverted` (the user is undoing it). Read it now;
  // appendMessages below moves the head to the freshly-cloned revert row.
  const headBeforeRevert = (await getDb()
    .select({ headVersionId: sessions.headVersionId })
    .from(sessions)
    .where(eq(sessions.id, parsed.chatId))
    .get())?.headVersionId

  const seedToolUseId = synthToolUseId()
  const userContent: UserContentBlock[] = [{ type: 'text', text: REVERT_USER_PROMPT }]
  const assistantContent: AssistantContentBlock[] = [
    { type: 'text', text: REVERT_INTRO_TEXT },
    {
      type: 'tool_use',
      id: seedToolUseId,
      name: RENDER_SCORE_TOOL_NAME,
      input: score as unknown as Record<string, unknown>,
    },
  ]
  // appendMessages handles the atomic insert: synthetic user+assistant
  // rows + new score_versions row (source='revert') chained to the prior
  // head + sessions.headVersionId bump — all in one transaction.
  await appendMessages(
    userId,
    parsed.chatId,
    [
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    ],
    { scoreSource: 'revert' },
  )

  // SHE-18 PR1 — the version we just undid is a negative training signal.
  // Best-effort; no-op if its turn was a manual edit / earlier revert.
  if (headBeforeRevert) {
    await recordTurnOutcome(headBeforeRevert, 'reverted')
  }

  // Re-read head to surface the new score_versions.id to the client so
  // it can use it as parentVersionId for the next manual-edit POST.
  const headRow = await getDb()
    .select({ headVersionId: sessions.headVersionId })
    .from(sessions)
    .where(eq(sessions.id, parsed.chatId))
    .get()
  const headVersionId = headRow?.headVersionId
  if (!headVersionId) {
    // Should never happen — appendMessages just bumped the head.
    return errorResponse('internal_error', 500, 'Head version not found after revert')
  }

  const newTurn: Extract<TranscriptTurn, { role: 'assistant'; kind: 'render_score' }> = {
    role: 'assistant',
    kind: 'render_score',
    introText: REVERT_INTRO_TEXT,
    scoreSummary: summarizeScore(score),
    toolUseId: seedToolUseId,
    scoreHash: scoreHash(score),
  }

  const body: RevertResponse = {
    chatId: parsed.chatId,
    abc,
    scoreJson: score,
    introText: REVERT_INTRO_TEXT,
    toolUseId: seedToolUseId,
    headVersionId,
    newTurn,
  }
  return attachRecoveryHeader(NextResponse.json(body), session)
}
