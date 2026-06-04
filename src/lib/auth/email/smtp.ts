import nodemailer from 'nodemailer'
import type { EmailMessage, EmailProvider } from './types'

/**
 * Generic SMTP provider (nodemailer) — works with any SMTP relay (Brevo, Amazon
 * SES SMTP, Postmark, etc.), so the app is never locked to one vendor's SDK.
 *
 * `from` is EMAIL_FROM (e.g. `sheet-llm <noreply@your-domain>`), whose domain
 * must be authenticated (SPF/DKIM) at the relay or mail lands in spam / is
 * rejected. Throws on a hard send failure so the caller logs it server-side; the
 * SMTP error detail is NEVER surfaced to the client.
 *
 * `secure`: true for implicit TLS on port 465; false for 587 (STARTTLS upgrade).
 */
export function createSmtpProvider(opts: {
  host: string
  port: number
  user: string
  pass: string
  secure: boolean
  from: string
}): EmailProvider {
  const transporter = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: { user: opts.user, pass: opts.pass },
  })
  return {
    name: 'smtp',
    async send(message: EmailMessage): Promise<void> {
      // nodemailer rejects the promise on a hard SMTP failure → propagates up.
      await transporter.sendMail({
        from: opts.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      })
    },
  }
}
