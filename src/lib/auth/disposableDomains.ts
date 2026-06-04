import { normalizeEmail } from '@/lib/auth/account'

/**
 * Static blocklist of common disposable / throwaway email domains. A best-effort
 * signup-spam brake — NOT exhaustive (the canonical defenses are the per-IP auth
 * limiter + the email send budget). Curated from the widely-mirrored
 * disposable-email lists; extend as abuse is observed. Subdomain-aware so
 * `foo.mailinator.com` is caught via its registrable parent.
 */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  '0815.ru', '10minutemail.com', '20minutemail.com', '33mail.com',
  'guerrillamail.com', 'guerrillamail.info', 'grr.la', 'sharklasers.com',
  'mailinator.com', 'mailinator.net', 'maildrop.cc', 'mailnesia.com',
  'mintemail.com', 'mohmal.com', 'trashmail.com', 'trashmail.de',
  'throwawaymail.com', 'tempmail.com', 'temp-mail.org', 'tempmailo.com',
  'getnada.com', 'nada.email', 'dispostable.com', 'fakeinbox.com',
  'yopmail.com', 'yopmail.fr', 'spam4.me', 'tutanota-temp.com',
  'emailondeck.com', 'mailcatch.com', 'inboxkitten.com', 'spamgourmet.com',
  'mytemp.email', 'burnermail.io', 'moakt.com', 'tempr.email',
  'discard.email', 'wegwerfmail.de', 'einrot.com', 'fakemailgenerator.com',
])

/** True when the email's domain (or a parent domain) is a known disposable. */
export function isDisposableEmail(email: string): boolean {
  const norm = normalizeEmail(email)
  const at = norm.lastIndexOf('@')
  if (at < 0) return false
  const domain = norm.slice(at + 1)
  if (!domain) return false
  if (DISPOSABLE_DOMAINS.has(domain)) return true
  // Catch subdomains of a blocked registrable domain (a.b.mailinator.com).
  const labels = domain.split('.')
  for (let i = 1; i < labels.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join('.'))) return true
  }
  return false
}
