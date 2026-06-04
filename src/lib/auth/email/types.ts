/**
 * Transactional-email seam. Verification + password-reset mail goes through a
 * swappable EmailProvider so the rest of the auth code never imports Resend (or
 * any SDK) directly: tests inject a capturing provider, dev uses the console
 * provider, prod uses Resend. Keep this surface tiny.
 */
export interface EmailMessage {
  to: string
  subject: string
  /** Plain-text body — always set (some inboxes/clients prefer it; no tracking). */
  text: string
  /** Optional HTML body. */
  html?: string
}

export interface EmailProvider {
  /** A short id for logs ('console' | 'resend' | a test fake). */
  readonly name: string
  /**
   * Deliver one message. MUST reject on a hard failure so callers can log it;
   * callers decide whether a send failure is fatal (it never is for signup —
   * the user can resend later).
   */
  send(message: EmailMessage): Promise<void>
}
