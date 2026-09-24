/**
 * Integrator provenance: an optional, self-declared application id that the SDK
 * sends on quote and ingest requests. It lets the relayer tell live dApps apart
 * from scripts and tests when counting usage. It is NOT authentication: anyone
 * can send any id, so it is only ever used for attribution and rate-limit
 * bucketing, never for access control.
 */

/** Request header carrying the application id (case-insensitive on the wire). */
export const APP_ID_HEADER = 'X-Bosphor-App';

/**
 * A short slug: starts with a letter or digit, then letters, digits, `-`, `_`
 * or `.`, at most 64 characters in total. Case-insensitive.
 */
export const APP_ID_PATTERN = /^[a-z0-9][a-z0-9\-_.]{0,63}$/i;

/** Result of validating a raw header value. */
export type AppIdResult = { ok: true; appId: string | null } | { ok: false; message: string };

/**
 * Validate a raw `X-Bosphor-App` header value. A missing or blank header is
 * allowed and yields `null` (recorded as "no app"). A present but malformed
 * value is rejected so bad data never reaches the ledger. Ids are normalised to
 * lower case so `MyApp` and `myapp` count as one application.
 */
export function parseAppId(raw: string | string[] | undefined | null): AppIdResult {
  if (raw === undefined || raw === null) return { ok: true, appId: null };
  // A repeated header arrives as an array; take the first occurrence.
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  if (value.length === 0) return { ok: true, appId: null };
  if (!APP_ID_PATTERN.test(value)) {
    return {
      ok: false,
      message: `invalid ${APP_ID_HEADER} header: expected a slug matching ${APP_ID_PATTERN}`,
    };
  }
  return { ok: true, appId: value.toLowerCase() };
}
