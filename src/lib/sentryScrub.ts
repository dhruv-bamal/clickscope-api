import type { ErrorEvent } from '@sentry/node';

/**
 * Case-insensitive key names that must never reach Sentry verbatim,
 * wherever they appear in an event's headers, cookies, body, or extra
 * context. Sentry events are third-party-hosted; a leaked Authorization
 * header or password field there is exactly as bad as leaking it in a
 * public log stream, and error events are far more likely than routine
 * logs to carry a full request body (the thing that was being processed
 * when the error happened).
 */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'token',
  'jwt',
]);

const REDACTED = '[REDACTED]';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively redacts any key matching SENSITIVE_KEYS (case-insensitive)
 * at any depth. Returns a new value — never mutates the input — so a
 * scrubbed object never aliases the original event.
 */
function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactDeep);
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redactDeep(val);
    }
    return result;
  }
  return value;
}

/**
 * Redacts every value in a flat cookie map, regardless of key name.
 * event.request.cookies is the already-parsed Cookie header — every
 * entry in it is a cookie value by construction (this app's own
 * link_unlock_<shortCode> cookie included, see src/routes/redirect.ts),
 * so there's no benign key to preserve here the way there is in headers
 * or a request body; a name-based denylist would just miss
 * app-specific cookie names it doesn't know about.
 */
function redactCookies(cookies: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(cookies)) {
    result[key] = REDACTED;
  }
  return result;
}

/**
 * Strips the OAuth authorization `code` parameter from a Sentry
 * query-string value. Sentry stores query_string as a raw string, not a
 * parsed object, so it needs its own handling rather than falling out of
 * redactDeep's key-based walk — the sensitive thing here is a query
 * parameter *value* keyed by a completely unremarkable name ("code"),
 * not a structurally-recognizable field.
 */
function scrubQueryString(queryString: string): string {
  const params = new URLSearchParams(queryString);
  if (params.has('code')) {
    params.delete('code');
  }
  return params.toString();
}

/**
 * Sentry's beforeSend hook. Scrubs Authorization headers, JWT payloads,
 * password fields, the OAuth code query parameter, and cookies from an
 * event before it leaves the process. Returns a new event object; the
 * input is never mutated, so a caller (or a test) can compare against
 * the original untouched fixture.
 *
 * See tests/lib/sentryScrub.test.ts for proof this actually strips what
 * it claims, not just that the hook is registered.
 */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  const scrubbed: ErrorEvent = { ...event };

  if (event.request) {
    scrubbed.request = {
      ...event.request,
      ...(event.request.headers ? { headers: redactDeep(event.request.headers) as Record<string, string> } : {}),
      ...(event.request.cookies ? { cookies: redactCookies(event.request.cookies) } : {}),
      ...(event.request.data !== undefined ? { data: redactDeep(event.request.data) } : {}),
      ...(event.request.query_string !== undefined && typeof event.request.query_string === 'string'
        ? { query_string: scrubQueryString(event.request.query_string) }
        : {}),
    };
  }

  if (event.extra) {
    scrubbed.extra = redactDeep(event.extra) as Record<string, unknown>;
  }

  if (event.contexts) {
    scrubbed.contexts = redactDeep(event.contexts) as typeof event.contexts;
  }

  return scrubbed;
}
