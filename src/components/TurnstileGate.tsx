'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './TurnstileGate.module.css'

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
 * Presentation: the widget lives in a fixed full-screen overlay that always
 * CENTERS it. While `appearance:'interaction-only'` keeps the widget invisible
 * during a managed auto-pass, nothing shows. When Cloudflare actually needs an
 * interactive challenge it fires `before-interactive-callback` → we dim the rest
 * of the page behind a backdrop and frame the (centered) challenge, then clear
 * the backdrop on success / `after-interactive-callback` / error. The widget box
 * itself is always interactable, so even if those callbacks don't fire the
 * challenge still appears centered and solvable (just without the dim) — a safe
 * degradation, never a trapped or unclickable page.
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
  // True only while Cloudflare is showing an INTERACTIVE challenge the user must
  // complete — drives the page-dimming backdrop. Stays false during a silent
  // managed auto-pass (the common case), so the page is never dimmed needlessly.
  const [challengeActive, setChallengeActive] = useState(false)

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

    const setActive = (active: boolean) => {
      if (!cancelled) setChallengeActive(active)
    }

    const fail = (msg: string) => {
      if (cancelled) return
      console.error('[turnstile] ' + msg)
      setStatus('error')
      setDetail(msg)
      setChallengeActive(false)
    }

    async function clear(token: string) {
      setActive(false)
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
          // Stay invisible unless Cloudflare actually needs an interactive
          // challenge; a managed auto-pass leaves nothing lingering on screen.
          appearance: 'interaction-only',
          callback: (token: string) => clear(token),
          // Fired right before / after the widget shows an interactive
          // challenge — the precise signal for when to dim the page.
          'before-interactive-callback': () => setActive(true),
          'after-interactive-callback': () => setActive(false),
          'error-callback': (code?: string) => {
            // Surfaces e.g. 110200 (domain not allowed) / 110100 (invalid sitekey)
            fail(`challenge error${code ? ' ' + code : ''}`)
            return true
          },
          'expired-callback': () => setActive(false),
          'timeout-callback': () => {
            setActive(false)
            window.turnstile?.reset(widgetIdRef.current ?? undefined)
          },
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

  // Show the framed box (and capture clicks) when a challenge is interactive OR
  // when we need to surface a load/verify error; dim the page only for an active
  // challenge. The widget container is always mounted + interactable so the
  // challenge is solvable even if the interactive callbacks never fire.
  const showBox = challengeActive || status === 'error'
  // Once we hold clearance and no challenge is active, hide the (always-mounted)
  // widget: in `interaction-only` mode Cloudflare leaves the solved widget's
  // "Success!" state rendered, which otherwise lingers centered on screen until
  // a refresh. We keep it mounted (not unmounted) so the periodic silent refresh
  // still runs; a later interactive refresh re-shows it via challengeActive.
  const cleared = status === 'cleared' && !challengeActive
  return (
    <div
      className={styles.overlay}
      data-active={challengeActive ? 'true' : undefined}
      data-show={showBox ? 'true' : undefined}
      data-cleared={cleared ? 'true' : undefined}
    >
      <div className={styles.backdrop} aria-hidden="true" />
      <div
        className={styles.box}
        role={challengeActive ? 'dialog' : undefined}
        aria-modal={challengeActive ? true : undefined}
        aria-label={challengeActive ? 'Verification required' : undefined}
      >
        <div ref={containerRef} />
        {status === 'error' && (
          <div role="status" className={styles.error}>
            Bot check failed to load{detail ? `: ${detail}` : ''}.
          </div>
        )}
      </div>
    </div>
  )
}
