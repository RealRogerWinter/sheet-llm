// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(async () => {
  const { setEmailProviderForTesting } = await import('@/lib/auth/email')
  setEmailProviderForTesting(undefined) // clear override + cached selection
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('email provider selection', () => {
  it('uses the console provider when RESEND_API_KEY/EMAIL_FROM are unset', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    vi.stubEnv('EMAIL_FROM', '')
    const { getEmailProvider, setEmailProviderForTesting } = await import('@/lib/auth/email')
    setEmailProviderForTesting(undefined)
    expect(getEmailProvider().name).toBe('console')
  })

  it('uses the resend provider when both are set', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key')
    vi.stubEnv('EMAIL_FROM', 'sheet-llm <noreply@example.com>')
    const { getEmailProvider, setEmailProviderForTesting } = await import('@/lib/auth/email')
    setEmailProviderForTesting(undefined)
    expect(getEmailProvider().name).toBe('resend')
  })
})

describe('console provider', () => {
  it('logs the link in dev but WITHHOLDS the body (token) in production', async () => {
    const { consoleEmailProvider } = await import('@/lib/auth/email/console')
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.stubEnv('NODE_ENV', 'development')
    await consoleEmailProvider.send({ to: 'u@x.com', subject: 's', text: 'reset-link?token=SECRET' })
    expect(info).toHaveBeenCalledWith(expect.stringContaining('reset-link?token=SECRET'))

    info.mockClear()
    warn.mockClear()
    vi.stubEnv('NODE_ENV', 'production')
    await consoleEmailProvider.send({ to: 'u@x.com', subject: 's', text: 'reset-link?token=SECRET' })
    expect(info).not.toHaveBeenCalled() // body never logged in prod
    expect(warn).toHaveBeenCalledTimes(1) // misconfig is surfaced
    expect(warn.mock.calls[0][0]).not.toContain('SECRET') // token withheld
  })
})

describe('resend provider', () => {
  it('POSTs to the Resend API with auth + from + to + subject + text', async () => {
    const fetchMock = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { createResendProvider } = await import('@/lib/auth/email/resend')
    const provider = createResendProvider('re_abc', 'sheet-llm <noreply@example.com>')
    await provider.send({ to: 'u@x.com', subject: 'Hi', text: 'body-text' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_abc')
    const payload = JSON.parse(init.body as string)
    expect(payload.from).toBe('sheet-llm <noreply@example.com>')
    expect(payload.to).toEqual(['u@x.com'])
    expect(payload.subject).toBe('Hi')
    expect(payload.text).toBe('body-text')
  })

  it('throws on a non-2xx response (caller logs; never leaks to the client)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 422 })),
    )
    const { createResendProvider } = await import('@/lib/auth/email/resend')
    const provider = createResendProvider('k', 'f@x.com')
    await expect(provider.send({ to: 'u@x.com', subject: 's', text: 't' })).rejects.toThrow(/422/)
  })
})

describe('email templates + resolveAppBaseUrl', () => {
  it('verification + reset emails carry the link; base URL honors APP_BASE_URL then falls back to origin', async () => {
    const sent: Array<{ to: string; subject: string; text: string }> = []
    const {
      setEmailProviderForTesting,
      sendVerificationEmail,
      sendPasswordResetEmail,
      resolveAppBaseUrl,
    } = await import('@/lib/auth/email')
    setEmailProviderForTesting({
      name: 'capture',
      async send(m) {
        sent.push(m)
      },
    })
    await sendVerificationEmail('u@x.com', 'https://app/verify-email?token=abc')
    await sendPasswordResetEmail('u@x.com', 'https://app/reset?token=def')
    expect(sent[0].to).toBe('u@x.com')
    expect(sent[0].text).toContain('https://app/verify-email?token=abc')
    expect(sent[1].text).toContain('https://app/reset?token=def')

    vi.stubEnv('APP_BASE_URL', 'https://configured.example.com/')
    expect(resolveAppBaseUrl(new Request('http://localhost:3000/api/auth/forgot'))).toBe(
      'https://configured.example.com', // trailing slash trimmed
    )
    vi.stubEnv('APP_BASE_URL', '')
    expect(resolveAppBaseUrl(new Request('http://localhost:3000/api/auth/forgot'))).toBe(
      'http://localhost:3000', // falls back to the request origin
    )
  })
})
