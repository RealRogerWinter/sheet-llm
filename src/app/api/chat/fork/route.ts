import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  appendMessages,
  createConversation,
  getConversation,
  hasConversation,
} from '@/lib/llm/conversations'
import { getDb } from '@/lib/db'
import { messages as messagesTable } from '@/lib/db/schema'
import { getRequestUser } from '@/lib/auth/session'
import { attachRecoveryHeader } from '@/lib/auth/attachRecovery'
import type { AssistantContentBlock, ChatMessage, UserContentBlock } from '@/lib/llm/wrapper'
import { RENDER_SCORE_TOOL_NAME } from '@/lib/llm/renderScoreTool'
import { ScoreSchema, type Score } from '@/lib/music/types'
import { ValidationError } from '@/lib/music/errors'
import { scoreToAbc } from '@/lib/music/scoreToAbc'
import { validateAbc, validateScore } from '@/lib/music/validateScore'
import type { ForkResponse } from '@/lib/shared/types'
import {
  UuidSchema,
  checkSameOrigin,
  errorResponse,
  forkSeedToolUseId,
} from '@/app/api/chat/route'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 1024

const ForkRequestSchema = z.object({
  fromChatId: UuidSchema,
  toolUseId: z.string().min(1).max(128),
})

const RESTORE_INTRO_TEXT = 'Restored from an earlier version.'
/**
 * The synthetic user prompt that anchors the seed assistant turn.
 * Required because Anthropic's Messages API enforces strict
 * user-first / user-assistant alternation — a bare `[assistant]`
 * transcript would be rejected when the next refinement turn fires.
 */
const RESTORE_USER_PROMPT = 'Restore the previous version of this score.'

/**
 * Find the assistant `tool_use` block within a transcript whose id matches.
 * Returns the parsed Score, or undefined if not found / not parseable.
 */
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
 * Fork a chat: create a fresh chatId seeded with a single synthetic
 * assistant turn carrying the chosen historical score. The original
 * chatId is untouched, so the user can still go back to it. Subsequent
 * refinements on the new chat anchor to the freshly-minted toolUseId.
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
    parsed = ForkRequestSchema.parse(JSON.parse(text))
  } catch {
    return errorResponse('invalid_request', 400, 'Invalid request body')
  }

  const session = await getRequestUser()
  const { userId } = session
  if (!(await hasConversation(userId, parsed.fromChatId))) {
    return errorResponse('chat_not_found', 404, 'Source chat not found')
  }
  const source = (await getConversation(userId, parsed.fromChatId))!
  const score = findScoreByToolUseId(source, parsed.toolUseId)
  if (!score) {
    return errorResponse('chat_not_found', 404, 'Score not found for the given toolUseId')
  }

  // Defensive: re-validate before seeding. Stored scores should already
  // be valid (POST validates before persisting), but a corrupted /
  // legacy transcript would otherwise poison the forked chat.
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

  // Look up the score_versions.id for the source toolUseId so the new
  // session's `forked_from_version_id` records the exact branch point.
  // M4 needs this for the pointer-model fork; one indexed query via
  // `messages_tool_use`.
  const sourceMessage = await getDb()
    .select({ scoreVersionId: messagesTable.scoreVersionId })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.sessionId, parsed.fromChatId),
        eq(messagesTable.toolUseId, parsed.toolUseId),
      ),
    )
    .limit(1)
    .get()

  const newChatId = await createConversation(userId, {
    forkedFromSessionId: parsed.fromChatId,
    forkedFromVersionId: sourceMessage?.scoreVersionId ?? null,
  })
  const seedToolUseId = forkSeedToolUseId()
  const userContent: UserContentBlock[] = [{ type: 'text', text: RESTORE_USER_PROMPT }]
  const assistantContent: AssistantContentBlock[] = [
    { type: 'text', text: RESTORE_INTRO_TEXT },
    {
      type: 'tool_use',
      id: seedToolUseId,
      name: RENDER_SCORE_TOOL_NAME,
      input: score as unknown as Record<string, unknown>,
    },
  ]
  // Tag the seed score's source as 'fork-seed' so M4's pointer-model
  // refactor can tell at a glance which versions were copy-on-write
  // checkpoints vs. genuine LLM/edit outputs.
  await appendMessages(
    userId,
    newChatId,
    [
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    ],
    { scoreSource: 'fork-seed' },
  )

  const body: ForkResponse = {
    chatId: newChatId,
    abc,
    scoreJson: score,
    introText: RESTORE_INTRO_TEXT,
    toolUseId: seedToolUseId,
  }
  return attachRecoveryHeader(NextResponse.json(body), session)
}
