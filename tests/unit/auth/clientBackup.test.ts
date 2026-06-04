import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootRestoreIfNeeded,
  clearBackup,
  installBackupInterceptor,
} from '@/lib/auth/clientBackup'
import { RECOVERY_HEADER, RECOVERY_STORAGE_KEY } from '@/lib/auth/recovery'

const FRESH_EXP = Date.now() + 365 * 24 * 60 * 60 * 1000

function writeBackup(token: string, exp = FRESH_EXP) {
  window.localStorage.setItem(
    RECOVERY_STORAGE_KEY,
    JSON.stringify({ token, exp }),
  )
}

function getBackup(): { token: string; exp: number } | null {
  const raw = window.localStorage.getItem(RECOVERY_STORAGE_KEY)
  return raw ? JSON.parse(raw) : null
}

let originalFetch: typeof globalThis.fetch
const reloadSpy = vi.fn()

function clearAllCookies() {
  if (typeof document === 'undefined') return
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim()
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
    }
  }
}

beforeEach(() => {
  window.localStorage.clear()
  clearAllCookies()
  originalFetch = globalThis.fetch
  reloadSpy.mockReset()
  // jsdom 23+ wraps `location` in a Location accessor; replacing
  // `.reload` directly raises a property-descriptor error. Stub the
  // whole `location` value instead.
  vi.stubGlobal('location', {
    ...window.location,
    reload: reloadSpy,
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.unstubAllGlobals()
})

describe('installBackupInterceptor', () => {
  it('stashes the X-Session-Recovery header into localStorage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('ok', {
        status: 200,
        headers: { [RECOVERY_HEADER]: 'tok-from-server-realistic-length-over-twenty-chars' },
      }),
    )
    globalThis.fetch = fetchMock
    installBackupInterceptor()
    await globalThis.fetch('/some-api')
    const stored = getBackup()
    expect(stored?.token).toBe('tok-from-server-realistic-length-over-twenty-chars')
    expect(stored?.exp).toBeGreaterThan(Date.now())
  })

  it('does not stash when the header is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    globalThis.fetch = fetchMock
    installBackupInterceptor()
    await globalThis.fetch('/some-api')
    expect(getBackup()).toBeNull()
  })

  it('is idempotent — double install does not double-wrap', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('ok', {
        status: 200,
        headers: { [RECOVERY_HEADER]: 'tok-once-realistic-length-over-twenty-chars' },
      }),
    )
    globalThis.fetch = fetchMock
    installBackupInterceptor()
    installBackupInterceptor()
    installBackupInterceptor()
    await globalThis.fetch('/some-api')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('bootRestoreIfNeeded', () => {
  it('is a no-op when no backup is present', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    await bootRestoreIfNeeded()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clears stale backups (past expiry) without calling restore', async () => {
    writeBackup('stale-token', Date.now() - 1)
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    await bootRestoreIfNeeded()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getBackup()).toBeNull()
  })

  it('POSTs the backup and reloads on 204', async () => {
    writeBackup('valid-tok')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    )
    globalThis.fetch = fetchMock
    await bootRestoreIfNeeded()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/auth/restore')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ token: 'valid-tok' })
    expect(reloadSpy).toHaveBeenCalledOnce()
  })

  it('clears the backup on 401 (bad/expired token)', async () => {
    writeBackup('bad-tok')
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }))
    await bootRestoreIfNeeded()
    expect(getBackup()).toBeNull()
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('clears the backup on 410 (user deleted)', async () => {
    writeBackup('orphan-tok')
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 410 }))
    await bootRestoreIfNeeded()
    expect(getBackup()).toBeNull()
  })

  it('clears the backup on 409 (already consumed)', async () => {
    writeBackup('replayed-tok')
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 409 }))
    await bootRestoreIfNeeded()
    expect(getBackup()).toBeNull()
  })

  it('KEEPS the backup on 429 (rate-limited, retry next boot)', async () => {
    writeBackup('rate-limited-tok')
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 429 }))
    await bootRestoreIfNeeded()
    expect(getBackup()?.token).toBe('rate-limited-tok')
  })

  it('KEEPS the backup on network error', async () => {
    writeBackup('keep-on-net-fail')
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'))
    await bootRestoreIfNeeded()
    expect(getBackup()?.token).toBe('keep-on-net-fail')
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('short-circuits (no fetch) when the sl_present sentinel cookie is set', async () => {
    // This is the fix for the infinite-reload loop. With a valid session
    // (sentinel cookie present), bootRestoreIfNeeded must NOT post — the
    // server would happily re-mint a fresh recovery token + nonce, the
    // interceptor would stash it, the reload would trigger the next
    // boot, and the loop would chew through the per-IP rate-limit.
    document.cookie = 'sl_present=1; path=/'
    writeBackup('would-trigger-loop-without-sentinel-guard')
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    await bootRestoreIfNeeded()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(reloadSpy).not.toHaveBeenCalled()
    // Backup is still around for the eventual cookie-loss event.
    expect(getBackup()?.token).toBe('would-trigger-loop-without-sentinel-guard')
  })
})

describe('clearBackup', () => {
  it('removes the backup from localStorage', () => {
    writeBackup('to-be-cleared')
    expect(getBackup()).not.toBeNull()
    clearBackup()
    expect(getBackup()).toBeNull()
  })

  it('is a no-op when nothing is stored', () => {
    expect(() => clearBackup()).not.toThrow()
  })
})
