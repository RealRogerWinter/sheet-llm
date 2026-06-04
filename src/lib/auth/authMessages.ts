/**
 * Server error-code → human copy. The auth UI NEVER shows a raw `HTTP 429` or a
 * server `code` (today `SettingsContent` leaks raw status — this is the fix);
 * every form funnels its server response through here so messaging is friendly
 * and consistent. Unknown codes get a safe generic fallback.
 */
const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Email or password is incorrect.',
  email_taken: 'An account with that email already exists. Try signing in.',
  disposable_email: 'Please sign up with a non-disposable email address.',
  invalid_request: 'Please check the form and try again.',
  invalid_token: 'That link is invalid or has expired — request a new one.',
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
  bot_check_required: 'Please complete the bot check and try again.',
  already_authenticated: 'You are already signed in.',
  unauthenticated: 'Please sign in first.',
  not_found: 'Accounts are not available right now.',
  no_email: 'This account has no email to verify.',
  no_password: 'This account has no password yet — use "Forgot password" to set one first.',
  email_failed: 'We could not send the email. Please try again shortly.',
  // OAuth callback (?oauth_error=…)
  email_unverified: 'Your provider account has no verified email, so we can’t sign you in.',
  email_taken_unverified:
    'An account with that email already exists. Sign in or reset your password first, then link this provider.',
  oauth_already_linked: 'That account is already linked to a different user.',
  claim_conflict: 'Something changed while signing in. Please try again.',
  denied: 'Sign-in was cancelled.',
  state: 'Your sign-in session expired. Please try again.',
  exchange: 'Sign-in failed. Please try again.',
}

const GENERIC = 'Something went wrong. Please try again.'

export function authMessage(code: string | null | undefined, fallback = GENERIC): string {
  if (!code) return fallback
  return MESSAGES[code] ?? fallback
}

/** Best-effort: pull a `{ code }` out of an error response and map it to copy. */
export async function errorMessageFromResponse(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { code?: unknown }
    if (typeof body?.code === 'string') return authMessage(body.code)
  } catch {
    // body wasn't JSON
  }
  if (res.status === 429) return authMessage('rate_limited')
  return GENERIC
}
