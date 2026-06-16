import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import TurnstileGate from '@/components/TurnstileGate'

type RenderOpts = Record<string, (...args: unknown[]) => unknown> & { sitekey?: string }

// Drives the Cloudflare Turnstile widget from the test: we capture the options
// object passed to `turnstile.render` so we can fire its callbacks the way
// Cloudflare would, then assert how the gate's overlay reacts.
describe('TurnstileGate — overlay dismissal', () => {
  let renderOpts: RenderOpts | null

  beforeEach(() => {
    renderOpts = null
    ;(window as unknown as { turnstile: unknown }).turnstile = {
      render: (_el: HTMLElement, opts: RenderOpts) => {
        renderOpts = opts
        return 'widget-1'
      },
      reset: vi.fn(),
      remove: vi.fn(),
    }
    // GET /api/turnstile → enabled + public site key; POST → verification ok.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET') {
          return new Response(JSON.stringify({ enabled: true, siteKey: '0xtest' }), { status: 200 })
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as unknown as { turnstile?: unknown }).turnstile
    vi.restoreAllMocks()
  })

  it('hides the widget as soon as the challenge is cleared (no lingering until refresh)', async () => {
    const { container } = render(<TurnstileGate />)
    const overlay = () => container.firstChild as HTMLElement

    // Runtime config fetched → the widget renders and we capture its callbacks.
    await waitFor(() => expect(renderOpts).not.toBeNull())

    // Cloudflare needs an interactive challenge → the gate frames + dims it.
    await act(async () => {
      renderOpts!['before-interactive-callback']()
    })
    expect(overlay()).toHaveAttribute('data-active', 'true')

    // The user completes the challenge → Cloudflare delivers a token. After the
    // gate exchanges it for clearance, the interactive framing must be gone AND
    // the widget marked dismissed, so Cloudflare's success state can't linger
    // on screen until the user refreshes.
    await act(async () => {
      await renderOpts!.callback('tok')
    })

    await waitFor(() => {
      expect(overlay()).not.toHaveAttribute('data-active', 'true')
      expect(overlay()).toHaveAttribute('data-cleared', 'true')
    })
  })
})
