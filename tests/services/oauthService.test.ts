import { LoginTicket, OAuth2Client } from 'google-auth-library';
import nock from 'nock';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// oauthService transitively imports src/config, same
// dynamic-import-after-loadEnvFile requirement as every file touching
// src/config.
let exchangeCodeForIdentity: typeof import('../../src/services/oauthService.js').exchangeCodeForIdentity;
let AppError: typeof import('../../src/lib/errors.js').AppError;
let clientId: string;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ exchangeCodeForIdentity } = await import('../../src/services/oauthService.js'));
  ({ AppError } = await import('../../src/lib/errors.js'));
  clientId = process.env.GOOGLE_CLIENT_ID ?? '';
});

afterEach(() => {
  nock.cleanAll();
  vi.restoreAllMocks();
});

// Only the token endpoint is faked with nock (a real outbound HTTPS call
// google-auth-library's getToken makes) — never the real Google API.
function mockTokenEndpoint(idToken = 'fake-id-token'): void {
  nock('https://oauth2.googleapis.com')
    .post('/token')
    .reply(200, {
      access_token: 'fake-access-token',
      id_token: idToken,
      expires_in: 3600,
      token_type: 'Bearer',
    });
}

// verifyIdToken performs real cryptographic signature verification
// against Google's live JWKS — faithfully testing that here would mean
// either hitting real Google endpoints (forbidden in tests) or hand-
// rolling an RSA keypair + fake JWKS server, exactly the crypto work the
// google-auth-library dependency decision chose to avoid hand-rolling in
// the first place. So it's stubbed directly: these tests prove our code
// calls it with the right arguments and handles its output correctly,
// not that the library's signature verification itself is correct (see
// Notes.md Phase 5 for the residual-gap discussion).
function mockVerifyIdToken(
  payload: Partial<import('google-auth-library').TokenPayload> | undefined,
): ReturnType<typeof vi.spyOn> {
  const ticket = payload
    ? new LoginTicket(undefined, {
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-user-123',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...payload,
      })
    : new LoginTicket();

  return vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue(ticket);
}

describe('oauthService.exchangeCodeForIdentity', () => {
  it('exchanges a code and returns the verified identity', async () => {
    mockTokenEndpoint();
    mockVerifyIdToken({ email: 'user@example.com', email_verified: true });

    const identity = await exchangeCodeForIdentity('a-valid-code');

    expect(identity).toEqual({
      googleId: 'google-user-123',
      email: 'user@example.com',
      emailVerified: true,
    });
  });

  it('defaults emailVerified to false when Google omits the claim', async () => {
    mockTokenEndpoint();
    mockVerifyIdToken({ email: 'user@example.com', email_verified: undefined });

    const identity = await exchangeCodeForIdentity('a-valid-code');
    expect(identity.emailVerified).toBe(false);
  });

  it('calls verifyIdToken with our GOOGLE_CLIENT_ID as the audience', async () => {
    mockTokenEndpoint();
    const spy = mockVerifyIdToken({ email: 'user@example.com', email_verified: true });

    await exchangeCodeForIdentity('a-valid-code');

    // This is the check that actually matters: verifyIdToken's return
    // value is a canned mock regardless of its arguments, so without this
    // assertion a regression that dropped or hardcoded `audience` would
    // pass every other test in this file while the real API silently
    // started accepting ID tokens minted for a different Google client.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ idToken: 'fake-id-token', audience: clientId }),
    );
  });

  it('throws badRequest when Google returns no id_token', async () => {
    nock('https://oauth2.googleapis.com')
      .post('/token')
      .reply(200, { access_token: 'fake-access-token', expires_in: 3600, token_type: 'Bearer' });

    await expect(exchangeCodeForIdentity('a-valid-code')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('throws badRequest when the verified token is missing required claims', async () => {
    mockTokenEndpoint();
    mockVerifyIdToken(undefined);

    await expect(exchangeCodeForIdentity('a-valid-code')).rejects.toBeInstanceOf(AppError);
  });
});
