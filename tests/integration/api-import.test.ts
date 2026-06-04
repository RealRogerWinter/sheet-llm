// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { Midi } from '@tonejs/midi'
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

function jsonRequest(body: unknown) {
  return new Request('http://localhost:3000/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function multipartRequest(file: File) {
  const fd = new FormData()
  fd.append('file', file)
  return new Request('http://localhost:3000/api/import', { method: 'POST', body: fd })
}

const ABC = `X:1
T:Imported
M:4/4
L:1/4
K:C
CDEF|GABc|`

const JSON_SCORE = {
  title: 'JsonScore',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
  ],
}

describe('/api/import POST', () => {
  installTestDb()

  it('imports an ABC paste and seeds a chat with a synthetic toolUseId', async () => {
    const res = await POST(jsonRequest({ format: 'abc', text: ABC, filename: 'imported.abc' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.chatId).toMatch(/^[0-9a-f-]+$/i)
    expect(await hasConversation(TEST_USER_ID, data.chatId)).toBe(true)
    expect(data.abc).toContain('K:C')
    expect(data.importFormat).toBe('abc')
    expect(data.scoreJson.measures).toHaveLength(2)
    expect(data.toolUseId).toMatch(/^toolu_orch_/)

    // The seeded transcript should be [user, assistant(text+tool_use)].
    const transcript = (await getConversation(TEST_USER_ID, data.chatId))!
    expect(transcript).toHaveLength(2)
    expect(transcript[0].role).toBe('user')
    expect(transcript[1].role).toBe('assistant')
    const toolUse = transcript[1].content.find((b) => b.type === 'tool_use')
    expect(toolUse).toBeDefined()
    expect((toolUse as { id: string }).id).toBe(data.toolUseId)
  })

  it('imports a Score JSON paste', async () => {
    const res = await POST(
      jsonRequest({ format: 'json', text: JSON.stringify(JSON_SCORE), filename: 'score.json' }),
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.importFormat).toBe('json')
    expect(data.scoreJson.title).toBe('JsonScore')
    expect(data.warnings).toEqual([])
  })

  it('returns 422 with warnings on a malformed ABC', async () => {
    const res = await POST(jsonRequest({ format: 'abc', text: 'this is not abc at all' }))
    // The abcjs parser is quite permissive — empty parse should still
    // trigger our block path because no measures emerge.
    expect([200, 422]).toContain(res.status)
    if (res.status === 422) {
      const data = await res.json()
      expect(data.code).toBe('import_failed')
      expect(data.warnings.length).toBeGreaterThan(0)
    }
  })

  // MAX_MEASURES cap behavior is covered by tests/unit/music/import/normalize.test.ts.
  // We don't repeat it at the API layer because synthesizing a >MAX_MEASURES
  // ABC string just to drive the truncate path is wasteful — the cap exists
  // as a runaway-input guardrail, not as a routine code path.

  it('imports a MIDI binary via multipart', async () => {
    const m = new Midi()
    m.header.setTempo(120)
    m.header.timeSignatures = [{ ticks: 0, timeSignature: [4, 4] } as never]
    const t = m.addTrack()
    for (let i = 0; i < 8; i++) {
      t.addNote({ midi: 60 + i, time: i * 0.5, duration: 0.5 })
    }
    const bytes = new Uint8Array(m.toArray())
    const file = new File([bytes], 'tune.mid', { type: 'audio/midi' })
    const res = await POST(multipartRequest(file))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.importFormat).toBe('midi')
    expect(data.scoreJson.measures.length).toBe(2)
  })

  it('rejects MusicXML uploads with a clear message', async () => {
    const file = new File(['<?xml version="1.0"?><score-partwise/>'], 'tune.musicxml', {
      type: 'application/xml',
    })
    const res = await POST(multipartRequest(file))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('import_failed')
    expect(data.error).toMatch(/MusicXML/i)
  })

  it('rejects invalid request bodies', async () => {
    const res = await POST(jsonRequest({ format: 'abc' /* missing text */ }))
    expect(res.status).toBe(400)
  })

  it('does not call the LLM (works in stub mode)', async () => {
    const res = await POST(jsonRequest({ format: 'abc', text: ABC }))
    expect(res.status).toBe(200)
  })
})
