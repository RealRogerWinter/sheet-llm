import type { EmailMessage, EmailProvider } from './types'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

/**
 * Resend provider over the REST API (no SDK dependency — one `fetch`). `from` is
 * the verified sender (EMAIL_FROM, e.g. `sheet-llm <noreply@your-domain>`).
 * Throws on any non-2xx so the caller logs it server-side; Resend's error detail
 * is NEVER surfaced to the client.
 */
export function createResendProvider(apiKey: string, from: string): EmailProvider {
  return {
    name: 'resend',
    async send(message: EmailMessage): Promise<void> {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Resend send failed: ${res.status} ${detail.slice(0, 500)}`)
      }
    },
  }
}
