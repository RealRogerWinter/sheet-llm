'use client'

import { useEffect, useRef } from 'react'

/**
 * Renders a Cloudflare Turnstile widget (managed mode) and exchanges the token
 * for a server-side clearance cookie (POST /api/turnstile) so the LLM-cost
 * routes accept this client. Periodically re-runs the challenge to keep the
 * ~30-min clearance fresh, so a normal session never sees a `bot_check_required`.
 *
 * Renders nothing when `siteKey` is empty (Turnstile not configured), so the app
 * is unchanged on non-Turnstile deploys. The site key is public (it ships to the
 * browser by design); the secret key stays server-side.
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const REFRESH_MS = 25 * 60 * 1000 // before the 30-min clearance cookie expires

// Minimal shape of the global Turnstile API we use.
interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  reset: (id?: string) => void
  remove: (id?: string) => void
}
declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

export default function TurnstileGate({ siteKey }: { siteKey: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!siteKey) return
    let cancelled = false

    async function clear(token: string) {
      try {
        await fetch('/api/turnstile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        })
      } catch {
        /* network hiccup — the next refresh retries */
      }
    }

    function render() {
      if (cancelled || widgetIdRef.current || !window.turnstile || !containerRef.current) return
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (token: string) => clear(token),
        'error-callback': () => {},
        'timeout-callback': () => window.turnstile?.reset(widgetIdRef.current ?? undefined),
      })
    }

    const existing = document.querySelector(`script[src^="${SCRIPT_SRC.split('?')[0]}"]`)
    if (window.turnstile) {
      render()
    } else if (!existing) {
      const s = document.createElement('script')
      s.src = SCRIPT_SRC
      s.async = true
      s.defer = true
      s.onload = render
      document.head.appendChild(s)
    } else {
      existing.addEventListener('load', render, { once: true })
    }

    const iv = setInterval(() => {
      try {
        window.turnstile?.reset(widgetIdRef.current ?? undefined)
      } catch {
        /* ignore */
      }
    }, REFRESH_MS)

    return () => {
      cancelled = true
      clearInterval(iv)
      try {
        window.turnstile?.remove(widgetIdRef.current ?? undefined)
      } catch {
        /* ignore */
      }
      widgetIdRef.current = null
    }
  }, [siteKey])

  if (!siteKey) return null
  // Managed mode is non-interactive for most visitors; kept in a corner so a
  // challenge is reachable if Cloudflare decides to present one.
  return (
    <div
      ref={containerRef}
      style={{ position: 'fixed', bottom: 8, right: 8, zIndex: 2147483646 }}
      aria-hidden="true"
    />
  )
}
