// Handle derivation. Keep this free of MCP/WS/network imports so tests can
// pull in the helpers without booting the full plugin.

export function deriveBaseHandle(email: string): string {
  return `@${email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`;
}

/**
 * Nth variant of a handle. Attempt 1 is the base handle; attempts 2+ append
 * the attempt number, so `@arvind` → `@arvind2`, `@arvind3`, etc.
 * Values below 1 are treated as attempt 1 (defensive; the retry loop will
 * never call with zero or negative, but the pure function stays total).
 */
export function handleVariant(base: string, attempt: number): string {
  if (attempt <= 1) return base;
  return `${base}${attempt}`;
}

export const HANDLE_RETRY_MAX_ATTEMPTS = 10;

/**
 * Identify whether a saved auth record belongs to the same user who is
 * attempting to log in now.
 *
 * Preferred match is email-based — email is the true identity the server
 * binds to a handle, so it works regardless of whether the user landed
 * on @base or @baseN after a collision.
 *
 * Legacy fallback: auth.json files written by plugin < 1.3.5 don't carry
 * an email field. For those, fall back to comparing the derived handle
 * against the saved handle (the pre-1.3.5 behavior). The next successful
 * login backfills email so subsequent calls use the email path.
 */
export function isSameUser(
  saved: { handle?: string; email?: string } | null | undefined,
  email: string,
  derivedHandle: string,
): boolean {
  if (!saved) return false;
  if (saved.email) return saved.email === email;
  return saved.handle === derivedHandle;
}
