'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Renders a Cloudflare Turnstile widget and exchanges its token for a
 * server-side clearance cookie (POST /api/turnstile) so the LLM-cost routes
 * accept this client. Periodically re-runs the challenge to keep the ~30-min
 * clearance fresh, so a normal session never sees a `bot_check_required`.
 *
 * Renders nothing when `siteKey` is empty (Turnstile not configured), so the
 * app is unchanged on non-Turnstile deploys. The site key is public (it ships
 * to the browser by design); the secret key stays server-side.
 *
 * This widget is **visible and self-diagnosing**: the script-load and render
 * failure modes are surfaced (console + a small on-screen note) instead of
 * being swallowed, because a silently-failing managed widget once blocked
 * every user with no signal. `data-cfasync="false"` keeps Cloudflare Rocket
 * Loader from deferring/mangling the api.js load.
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const REFRESH_MS = 25 * 60 * 1000 // before the 30-min clearance cookie expires

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

type GateStatus = 'loading' | 'ready' | 'cleared' | 'error'

export default function TurnstileGate() {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const [siteKey, setSiteKey] = useState<string>('')
  const [status, setStatus] = useState<GateStatus>('loading')
  const [detail, setDetail] = useState<string>('')

  // The root layout is statically prerendered, so the site key can't come from
  // a server-rendered prop (it would freeze the empty build-time env). Fetch the
  // runtime config from the API instead. The site key is public.
  useEffect(() => {
    let cancelled = false
    fetch('/api/turnstile', { method: 'GET' })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg: { enabled?: boolean; siteKey?: string } | null) => {
        if (!cancelled && cfg?.enabled && cfg.siteKey) setSiteKey(cfg.siteKey)
      })
      .catch(() => {
        /* Turnstile not reachable → stay ungated (server still enforces) */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!siteKey) return
    let cancelled = false

    const fail = (msg: string) => {
      if (cancelled) return
      console.error('[turnstile] ' + msg)
      setStatus('error')
      setDetail(msg)
    }

    async function clear(token: string) {
      try {
        const res = await fetch('/api/turnstile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        if (cancelled) return
        if (res.ok) {
          setStatus('cleared')
          setDetail('')
        } else {
          fail(`server rejected verification (HTTP ${res.status})`)
        }
      } catch {
        fail('network error posting to /api/turnstile')
      }
    }

    function renderWidget() {
      if (cancelled || widgetIdRef.current || !containerRef.current) return
      if (!window.turnstile) {
        fail('turnstile global missing after script load')
        return
      }
      try {
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token: string) => clear(token),
          'error-callback': (code?: string) => {
            // Surfaces e.g. 110200 (domain not allowed) / 110100 (invalid sitekey)
            fail(`challenge error${code ? ' ' + code : ''}`)
            return true
          },
          'timeout-callback': () =>
            window.turnstile?.reset(widgetIdRef.current ?? undefined),
        })
        if (!cancelled) setStatus((s) => (s === 'cleared' ? s : 'ready'))
      } catch (e) {
        fail('render threw (check sitekey / domain): ' + (e instanceof Error ? e.message : String(e)))
      }
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile]')
    if (window.turnstile) {
      renderWidget()
    } else if (!existing) {
      const s = document.createElement('script')
      s.src = SCRIPT_SRC
      s.async = true
      s.defer = true
      s.setAttribute('data-turnstile', '')
      s.setAttribute('data-cfasync', 'false') // exempt from Cloudflare Rocket Loader
      s.onload = renderWidget
      s.onerror = () => fail('failed to load challenges.cloudflare.com/api.js')
      document.head.appendChild(s)
    } else {
      existing.addEventListener('load', renderWidget, { once: true })
      if (window.turnstile) renderWidget()
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

  // Visible, bottom-right. Cloudflare draws nothing in the container when a
  // managed challenge auto-passes; if it needs interaction the user can see and
  // complete it; if it fails to load we show why.
  return (
    <div style={{ position: 'fixed', bottom: 12, right: 12, zIndex: 2147483646 }}>
      <div ref={containerRef} />
      {status === 'error' && (
        <div
          role="status"
          style={{
            marginTop: 6,
            maxWidth: 300,
            padding: '6px 8px',
            fontSize: 12,
            lineHeight: 1.3,
            color: '#7a1f1f',
            background: '#fde8e8',
            border: '1px solid #f5b5b5',
            borderRadius: 6,
          }}
        >
          Bot check failed to load{detail ? `: ${detail}` : ''}.
        </div>
      )}
    </div>
  )
}
