/**
 * Email helpers for the waitlist. Normalization (trim + lowercase) is the dedupe
 * key, so it is applied by the store before persisting and by the controller
 * before validating. Validation is intentionally simple: one @, a dotted domain,
 * no whitespace, RFC-practical length cap.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;
  return EMAIL_RE.test(email);
}
