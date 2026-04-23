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
