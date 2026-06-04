// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetForTesting,
  enqueue,
  flushBeacon,
  flushSync,
  getPendingCount,
  setAdapter,
  subscribeToPending,
} from '@/lib/chat/persistenceQueue'
import type { Score } from '@/lib/music/types'

const SCORE_A: Score = {
  title: 'A',
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
    },
  ],
}
const SCORE_B: Score = { ...SCORE_A, title: 'B' }
const SCORE_C: Score = { ...SCORE_A, title: 'C' }

let fetchMock: ReturnType<typeof vi.fn>
let currentHead: string | undefined

beforeEach(() => {
  __resetForTesting()
  currentHead = undefined
  setAdapter({
    getHead: () => currentHead,
    setHead: (id) => {
      currentHead = id
    },
  })
  fetchMock = vi.fn()
  // @ts-expect-error — overriding global fetch for tests
  globalThis.fetch = fetchMock
})

afterEach(() => {
  __resetForTesting()
  vi.unstubAllGlobals()
})

function okResponse(versionIds: string[]) {
  return {
    ok: true,
    status: 201,
    json: async () => ({ versionIds }),
  } as Response
}

function staleParentResponse(currentHead: string | null) {
  return {
    ok: false,
    status: 409,
    json: async () => ({ code: 'stale_parent', currentHead }),
  } as Response
}

function networkError(): never {
  throw new Error('network down')
}

describe('persistenceQueue', () => {
  it('coalesces same-coalesceKey enqueues — only the latest score is sent', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(['v-1']))
    enqueue({ chatId: 'c1', score: SCORE_A, source: 'edit', coalesceKey: 'k1' })
    enqueue({ chatId: 'c1', score: SCORE_B, source: 'edit', coalesceKey: 'k1' })
    enqueue({ chatId: 'c1', score: SCORE_C, source: 'edit', coalesceKey: 'k1' })
    expect(getPendingCount()).toBe(1) // 3 enqueues coalesced into 1 job
    await flushSync(1000)
    const call = fetchMock.mock.calls[0]
    const body = JSON.parse((call[1] as RequestInit).body as string)
    expect(body.versions).toHaveLength(1)
    expect(body.versions[0].score.title).toBe('C')
  })

  it('keeps separate jobs for different coalesceKeys', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(['v-1', 'v-2']))
    enqueue({ chatId: 'c1', score: SCORE_A, source: 'edit', coalesceKey: 'k1' })
    enqueue({ chatId: 'c1', score: SCORE_B, source: 'edit', coalesceKey: 'k2' })
    await flushSync(1000)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.versions).toHaveLength(2)
    expect(body.versions[0].score.title).toBe('A')
    expect(body.versions[1].score.title).toBe('B')
  })

  it('updates head from the last versionId in the response', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(['v-1', 'v-2']))
    enqueue({ chatId: 'c1', score: SCORE_A, source: 'edit', coalesceKey: 'k1' })
    enqueue({ chatId: 'c1', score: SCORE_B, source: 'edit', coalesceKey: 'k2' })
    await flushSync(1000)
    expect(currentHead).toBe('v-2')
  })

  it('rewrites baseParentVersionId and retries once on 409 stale_parent', async () => {
    fetchMock
      .mockResolvedValueOnce(staleParentResponse('actual-head'))
      .mockResolvedValueOnce(okResponse(['v-fresh']))
    currentHead = 'stale-head'
    enqueue({ chatId: 'c1', score: SCORE_A, source: 'edit', coalesceKey: 'k1' })
    await flushSync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(firstBody.baseParentVersionId).toBe('stale-head')
    expect(secondBody.baseParentVersionId).toBe('actual-head')
    expect(currentHead).toBe('v-fresh')
  })

  it('retries with backoff on 5xx, succeeds on the third attempt', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) } as Response)
      .mockResolvedValueOnce(okResponse(['v-eventually']))
    enqueue({ chatId: 'c1', score: SCORE_A, source: 'edit', coalesceKey: 'k1' })
    // Use a long timeout because backoff sleeps 1s + 2s.
    await flushSync(8000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(currentHead).toBe('v-eventually')
  }, 12000)

  it('drops on non-5xx non-409 (4xx client error), no retry', async () => {
    // text() is required by the diagnostic path in flushOne (4xx logs
     // the response body so the failure is debuggable from the console).
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => '{"code":"invalid_request","error":"bad shape"}',
    } as Response)
    enqueue({ chatId: 'c1', score: SCORE_A, source: 'edit', coalesceKey: 'k1' })
    await flushSync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getPendingCount()).toBe(0)
  })

  it('retries on network failure with backoff', async () => {
    fetchMock
      .mockImplementationOnce(networkError)
      .mockResolvedValueOnce(okResponse(['v-recovered']))
    enqueue({ chatId: 'c1', score: SCORE_A, source: 'edit', coalesceKey: 'k1' })
    await flushSync(4000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(currentHead).toBe('v-recovered')
  }, 6000)

  it('flushBeacon uses navigator.sendBeacon and drains the queue', () => {
    const sendBeaconMock = vi.fn().mockReturnValue(true)
    vi.stubGlobal('navigator', { sendBeacon: sendBeaconMock })
    enqueue({ chatId: 'c1', score: SCORE_A, source: 'edit', coalesceKey: 'k1' })
    enqueue({ chatId: 'c1', score: SCORE_B, source: 'edit', coalesceKey: 'k2' })
    const result = flushBeacon()
    expect(result).toBe(true)
    expect(sendBeaconMock).toHaveBeenCalledTimes(1)
    const [url, blob] = sendBeaconMock.mock.calls[0]
    expect(url).toBe('/api/sessions/c1/versions/batch')
    expect(blob).toBeInstanceOf(Blob)
    expect(getPendingCount()).toBe(0)
  })

  it('flushBeacon falls back to keepalive fetch when sendBeacon refuses', () => {
    const sendBeaconMock = vi.fn().mockReturnValue(false)
    vi.stubGlobal('navigator', { sendBeacon: sendBeaconMock })
    enqueue({ chatId: 'c1', score: SCORE_A, source: 'edit', coalesceKey: 'k1' })
    const result = flushBeacon()
    expect(result).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.keepalive).toBe(true)
  })

  it('flushBeacon is a no-op when queue is empty', () => {
    expect(flushBeacon()).toBe(false)
  })

  it('subscribers fire on enqueue and flush', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(['v-1']))
    const cb = vi.fn()
    const unsub = subscribeToPending(cb)
    enqueue({ chatId: 'c1', score: SCORE_A, source: 'edit', coalesceKey: 'k1' })
    expect(cb).toHaveBeenCalled()
    cb.mockReset()
    await flushSync(1000)
    expect(cb).toHaveBeenCalled() // batch take + flushing toggle
    unsub()
  })

  it('cross-session enqueues are flushed in separate batches', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(['v-c1']))
      .mockResolvedValueOnce(okResponse(['v-c2']))
    enqueue({ chatId: 'c1', score: SCORE_A, source: 'edit', coalesceKey: 'k1' })
    enqueue({ chatId: 'c2', score: SCORE_B, source: 'edit', coalesceKey: 'k1' })
    await flushSync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('/c1/')
    expect(fetchMock.mock.calls[1][0]).toContain('/c2/')
  })
})
