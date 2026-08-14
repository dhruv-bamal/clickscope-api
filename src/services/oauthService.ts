import { OAuth2Client } from 'google-auth-library';
import { config } from '../config/index.js';
import { badRequest } from '../lib/errors.js';

// openid: required to receive an id_token at all (this is what makes the
// request OpenID Connect rather than plain OAuth). email/profile: the two
// claims we actually need (email, email_verified) to find-or-create a
// user — we don't request anything broader (e.g. Drive/Calendar scopes).
const GOOGLE_SCOPES = ['openid', 'email', 'profile'];

const client = new OAuth2Client(
  config.GOOGLE_CLIENT_ID,
  config.GOOGLE_CLIENT_SECRET,
  config.GOOGLE_REDIRECT_URI,
);

export interface GoogleIdentity {
  googleId: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Builds Google's consent-screen URL for a given single-use state.
 * `generateAuthUrl` only assembles the query string (client_id, scope,
 * state, redirect_uri, response_type=code) — every parameter in it is one
 * we chose explicitly, nothing here is implicit.
 */
export function buildGoogleAuthUrl(state: string): string {
  return client.generateAuthUrl({ scope: GOOGLE_SCOPES, state });
}

/**
 * Exchanges an authorization code for Google's tokens, then verifies the
 * returned id_token (signature, audience, issuer, expiry) and extracts
 * the identity from it. Combines both calls into one function because
 * callers only ever need a verified identity — never the raw access/
 * refresh tokens, which stay inside this module and are never logged or
 * returned.
 */
export async function exchangeCodeForIdentity(code: string): Promise<GoogleIdentity> {
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw badRequest('Google did not return an identity token');
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw badRequest('Google identity token is missing required claims');
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified ?? false,
  };
}
