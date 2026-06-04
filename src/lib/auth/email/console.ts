import type { EmailMessage, EmailProvider } from './types'

/**
 * Dev/test fallback provider — selected whenever Resend is unconfigured
 * (RESEND_API_KEY / EMAIL_FROM unset). Logs the message to the server console
 * instead of sending.
 *
 * In DEVELOPMENT it logs the full body INCLUDING the verification / reset link,
 * so local flows are exercisable (copy the link out of the terminal). In
 * PRODUCTION — where falling back to console means Resend is MISCONFIGURED — it
 * NEVER logs the body (it carries a live single-use token): it warns loudly and
 * drops the mail, so the misconfiguration is visible without leaking tokens into
 * prod logs / log aggregation.
 */
export const consoleEmailProvider: EmailProvider = {
  name: 'console',
  async send(message: EmailMessage): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        `[email:console] PROD MISCONFIG: RESEND_API_KEY/EMAIL_FROM unset — dropping ` +
          `mail to=${message.to} subject=${JSON.stringify(message.subject)}. The body/link ` +
          `is withheld from logs; configure Resend to actually deliver email.`,
      )
      return
    }
    console.info(
      `[email:console] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}\n`,
    )
  },
}
