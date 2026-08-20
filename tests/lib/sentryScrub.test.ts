import type { ErrorEvent } from '@sentry/node';
import { describe, expect, it } from 'vitest';
import { scrubSentryEvent } from '../../src/lib/sentryScrub.js';

// scrubSentryEvent has no transitive dependency on src/config (it only
// imports a type from @sentry/node), so no loadEnvFile/dynamic-import
// dance is needed here — unlike most other tests in this suite.

function buildFixtureEvent(): ErrorEvent {
  return {
    request: {
      headers: {
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.super-secret-jwt-payload.sig',
        Cookie: 'link_unlock_abc123=some-signed-token',
        'user-agent': 'Mozilla/5.0 (benign, should survive)',
      },
      cookies: {
        link_unlock_abc123: 'some-signed-token',
      },
      data: {
        email: 'user@example.com',
        password: 'hunter2',
        token: 'some-raw-token-value',
      },
      query_string: 'state=abc123&code=SECRET_OAUTH_CODE&foo=bar',
    },
    extra: {
      note: 'benign extra context',
      jwt: 'another-jwt-value-that-should-be-redacted',
    },
  } as ErrorEvent;
}

describe('scrubSentryEvent', () => {
  it('redacts Authorization and Cookie headers', () => {
    const scrubbed = scrubSentryEvent(buildFixtureEvent());

    expect(scrubbed.request?.headers?.Authorization).toBe('[REDACTED]');
    expect(scrubbed.request?.headers?.Cookie).toBe('[REDACTED]');
  });

  it('redacts request.cookies', () => {
    const scrubbed = scrubSentryEvent(buildFixtureEvent());

    expect(scrubbed.request?.cookies?.link_unlock_abc123).toBe('[REDACTED]');
  });

  it('redacts password and token fields in the request body', () => {
    const scrubbed = scrubSentryEvent(buildFixtureEvent());

    const data = scrubbed.request?.data as Record<string, unknown>;
    expect(data.password).toBe('[REDACTED]');
    expect(data.token).toBe('[REDACTED]');
    // A benign field alongside the sensitive ones is left untouched —
    // proof the scrub is targeted, not a blanket wipe of request.data.
    expect(data.email).toBe('user@example.com');
  });

  it('strips the OAuth "code" query parameter while leaving "state" and other params intact', () => {
    const scrubbed = scrubSentryEvent(buildFixtureEvent());

    const params = new URLSearchParams(scrubbed.request?.query_string as string);
    expect(params.has('code')).toBe(false);
    expect(params.get('state')).toBe('abc123');
    expect(params.get('foo')).toBe('bar');
  });

  it('redacts a jwt field nested in event.extra', () => {
    const scrubbed = scrubSentryEvent(buildFixtureEvent());

    expect(scrubbed.extra?.jwt).toBe('[REDACTED]');
    expect(scrubbed.extra?.note).toBe('benign extra context');
  });

  it('leaves an unrelated benign header untouched', () => {
    const scrubbed = scrubSentryEvent(buildFixtureEvent());

    expect(scrubbed.request?.headers?.['user-agent']).toBe(
      'Mozilla/5.0 (benign, should survive)',
    );
  });

  it('does not mutate the original event object', () => {
    const original = buildFixtureEvent();
    const originalAuthHeader = original.request?.headers?.Authorization;

    scrubSentryEvent(original);

    expect(original.request?.headers?.Authorization).toBe(originalAuthHeader);
    expect(original.request?.headers?.Authorization).not.toBe('[REDACTED]');
  });

  it('is a no-op on an event with no request/extra fields', () => {
    const bareEvent: ErrorEvent = { message: 'a bare error with no request context' };

    expect(() => scrubSentryEvent(bareEvent)).not.toThrow();
    expect(scrubSentryEvent(bareEvent).message).toBe(bareEvent.message);
  });
});
