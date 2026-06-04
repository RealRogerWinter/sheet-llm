/**
 * Best-effort server-side conversation reset. Local state is always
 * cleared (we own that); the DELETE just frees the in-process Map entry.
 * Network failures here are non-fatal — user intent is "start over".
 */
export async function resetSession(chatId: string | undefined): Promise<void> {
  if (!chatId) return
  try {
    await fetch(`/api/chat?chatId=${encodeURIComponent(chatId)}`, { method: 'DELETE' })
  } catch {
    // swallow — local clear already happened
  }
}
