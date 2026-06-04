import type { EmailProvider } from './types'
import { consoleEmailProvider } from './console'
import { createResendProvider } from './resend'

/**
 * Email provider selection + the high-level send helpers (verification, reset,
 * password-changed). The rest of the auth code imports ONLY these helpers, never
 * a concrete provider.
 *
 * Selection: Resend when both RESEND_API_KEY and EMAIL_FROM are set, else the
 * console provider (dev/test). A test override (`setEmailProviderForTesting`)
 * wins over both. The selected provider is cached so we don't re-read env every
 * send; the override path bypasses the cache.
 */
let overrideProvider: EmailProvider | null = null
let cachedProvider: EmailProvider | null = null

export function getEmailProvider(): EmailProvider {
  if (overrideProvider) return overrideProvider
  if (cachedProvider) return cachedProvider
  const key = process.env.RESEND_API_KEY
  const from = process.env.EMAIL_FROM
  cachedProvider = key && from ? createResendProvider(key, from) : consoleEmailProvider
  return cachedProvider
}

/** Test seam: force a provider (e.g. a capturing fake), or pass undefined to reset. */
export function setEmailProviderForTesting(provider: EmailProvider | undefined): void {
  overrideProvider = provider ?? null
  cachedProvider = null
}

/**
 * Build the absolute base URL for an email link. Prefers APP_BASE_URL (set it in
 * prod behind a proxy where the request Origin may differ); otherwise derives
 * from the request URL's origin (correct for single-domain dev/v1).
 */
export function resolveAppBaseUrl(request: Request): string {
  const configured = process.env.APP_BASE_URL
  if (configured) return configured.replace(/\/+$/, '')
  try {
    return new URL(request.url).origin
  } catch {
    return ''
  }
}

const APP_NAME = 'sheet-llm'

export async function sendVerificationEmail(to: string, link: string): Promise<void> {
  await getEmailProvider().send({
    to,
    subject: `Verify your ${APP_NAME} email`,
    text:
      `Welcome to ${APP_NAME}!\n\n` +
      `Confirm this email address by opening:\n${link}\n\n` +
      `This link expires in 24 hours. If you didn't create an account, ignore this message.`,
  })
}

export async function sendPasswordResetEmail(to: string, link: string): Promise<void> {
  await getEmailProvider().send({
    to,
    subject: `Reset your ${APP_NAME} password`,
    text:
      `We received a request to reset your ${APP_NAME} password.\n\n` +
      `Reset it by opening:\n${link}\n\n` +
      `This link expires in 60 minutes and can be used once. If you didn't request ` +
      `this, ignore this message — your password is unchanged.`,
  })
}

export async function sendPasswordChangedEmail(to: string): Promise<void> {
  await getEmailProvider().send({
    to,
    subject: `Your ${APP_NAME} password was changed`,
    text:
      `Your ${APP_NAME} password was just changed and every other session was ` +
      `signed out.\n\nIf this was you, no action is needed. If it wasn't, reset ` +
      `your password immediately.`,
  })
}

export type { EmailMessage, EmailProvider } from './types'
