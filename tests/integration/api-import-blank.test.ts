// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import {
  TEST_USER_ID,
  installTestDb,
  mockAuthSession,
} from '../factories/testEnv'

vi.mock('@/lib/auth/session', () => mockAuthSession())

const { POST } = await import('@/app/api/import/route')
const { getConversation, hasConversation } = await import(
  '@/lib/llm/conversations'
)
const { BLANK_SCORE } = await import('@/lib/music/types')

function jsonRequest(body: unknown) {
  return new Request('http://localhost:3000/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('/api/import POST format:blank', () => {
  installTestDb()

  it('seeds a chat with the BLANK_SCORE and a real toolUseId', async () => {
    const res = await POST(jsonRequest({ format: 'blank' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.chatId).toMatch(/^[0-9a-f-]+$/i)
    expect(await hasConversation(TEST_USER_ID, data.chatId)).toBe(true)
    expect(data.importFormat).toBe('blank')
    expect(data.toolUseId).toMatch(/^toolu_orch_/)
    expect(data.abc).toContain('K:C')
    expect(data.scoreJson).toEqual(BLANK_SCORE)
    expect(data.introText).toMatch(/blank/i)
    expect(data.warnings).toEqual([])

    // The seeded transcript should be [user, assistant(text+tool_use)],
    // with the assistant's tool_use carrying the BLANK_SCORE — this is
    // what the chat route's `extractHeadScore` needs to find on the
    // first refinement turn.
    const transcript = (await getConversation(TEST_USER_ID, data.chatId))!
    expect(transcript).toHaveLength(2)
    expect(transcript[0].role).toBe('user')
    expect(transcript[1].role).toBe('assistant')
    const toolUse = transcript[1].content.find((b) => b.type === 'tool_use')
    expect(toolUse).toBeDefined()
    expect((toolUse as { id: string }).id).toBe(data.toolUseId)
    expect((toolUse as { input: unknown }).input).toEqual(BLANK_SCORE)
  })

  it('does not require a text field for blank', async () => {
    const res = await POST(jsonRequest({ format: 'blank' }))
    expect(res.status).toBe(200)
  })

  it('still requires text for non-blank formats', async () => {
    const res = await POST(jsonRequest({ format: 'abc' }))
    expect(res.status).toBe(400)
  })

  it('ignores extra fields harmlessly on blank requests', async () => {
    const res = await POST(
      jsonRequest({ format: 'blank', filename: 'ignored.txt', text: '' }),
    )
    // text:'' is empty but format is blank so the refine should pass.
    expect(res.status).toBe(200)
  })
})
