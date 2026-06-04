// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import type { ChatMessage } from '@/lib/llm/wrapper'

// The route imports auth/session at module load; stub it so the import
// is side-effect free for this pure-function unit test.
vi.mock('@/lib/auth/session', () => ({ getOrCreateUserId: vi.fn() }))

const { countUserTextTurns } = await import('@/app/api/chat/route')

const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (): ChatMessage => ({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
const refinement = (id: string, text: string): ChatMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: '' }, { type: 'text', text }],
})

describe('countUserTextTurns (M25-PR-2 turn-burn fix)', () => {
  it('counts answered user turns', () => {
    expect(countUserTextTurns([user('1'), assistant(), user('2'), assistant()])).toBe(2)
  })

  it('does NOT count a trailing orphan user turn (failed/in-flight attempt)', () => {
    expect(countUserTextTurns([user('1'), assistant(), user('orphan')])).toBe(1)
  })

  it('does NOT count consecutive orphan retries (the lockout scenario)', () => {
    // A user who retried a failing prompt 3x: zero answered turns, so the
    // chat is NOT consumed toward the 20-turn cap.
    expect(countUserTextTurns([user('try1'), user('try2'), user('try3')])).toBe(0)
  })

  it('counts a refinement turn once it is answered', () => {
    expect(countUserTextTurns([user('1'), assistant(), refinement('x', '2'), assistant()])).toBe(2)
  })

  it('still reaches the cap at 20 genuinely-answered turns', () => {
    const t: ChatMessage[] = []
    for (let i = 0; i < 20; i++) {
      t.push(user(`${i}`))
      t.push(assistant())
    }
    expect(countUserTextTurns(t)).toBe(20)
    // ...and 20 answered + a trailing orphan retry is still 20 (not 21).
    t.push(user('orphan retry'))
    expect(countUserTextTurns(t)).toBe(20)
  })
})
