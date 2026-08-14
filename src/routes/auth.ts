import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { consumeState, generateState, storeState } from '../lib/oauthState.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { findOrCreateOAuthUser, getUserById, login, signup } from '../services/authService.js';
import { buildGoogleAuthUrl, exchangeCodeForIdentity } from '../services/oauthService.js';

export const authRouter = Router();

const signupSchema = z.object({
  email: z.string().email('Must be a valid email address'),
  // Length only, no composition rules (must contain a symbol/digit/etc.).
  // NIST 800-63B considers complexity rules counterproductive: they push
  // users toward predictable substitutions (e.g. "Password1!") and get
  // written down more often, without meaningfully raising guess-resistance.
  // Length is the strongest lever available.
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// Login intentionally does NOT re-enforce min(8) — password policy is a
// signup-time concern. A too-short password on login just fails the bcrypt
// compare and produces the same generic 401 as any other wrong password;
// a separate validation error here would leak more than the vague login
// message intends to.
const loginSchema = z.object({
  email: z.string().email('Must be a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

authRouter.post('/signup', validateBody(signupSchema), async (req, res) => {
  const { email, password } = signupSchema.parse(req.validated?.body);
  const { user, token } = await signup(email, password);
  res.status(201).json({ user, token });
});

authRouter.post('/login', validateBody(loginSchema), async (req, res) => {
  const { email, password } = loginSchema.parse(req.validated?.body);
  const { user, token } = await login(email, password);
  res.status(200).json({ user, token });
});

// Google always echoes `state` back on the callback, on both a successful
// consent and a denial — so `state` is required regardless of which
// outcome this request represents. `code` is absent when the user denies
// consent; `error` (e.g. "access_denied") is present in exactly that case.
const googleCallbackQuerySchema = z.object({
  state: z.string({ required_error: 'Missing OAuth state parameter' }),
  code: z.string().optional(),
  error: z.string().optional(),
});

authRouter.get('/google', async (_req, res) => {
  const state = generateState();
  await storeState(state);
  res.redirect(buildGoogleAuthUrl(state));
});

authRouter.get(
  '/google/callback',
  validateQuery(googleCallbackQuerySchema),
  async (req, res) => {
    const { state, code, error } = googleCallbackQuerySchema.parse(req.validated?.query);

    // State is validated FIRST, before even looking at `error` — an
    // attacker forging a callback URL with error=access_denied and no
    // valid state must not be treated as a legitimate denial, and must
    // not reach the code-exchange step below either.
    const stateValid = await consumeState(state);
    if (!stateValid) {
      throw badRequest('Invalid or expired OAuth state');
    }

    // The user denying consent (or another provider-side error) is a
    // normal outcome, not a server error — send them back to the
    // frontend rather than throwing.
    if (error) {
      req.log.warn({ error }, 'Google OAuth callback returned an error');
      res.redirect(`${config.FRONTEND_URL}?error=oauth_denied`);
      return;
    }

    if (!code) {
      throw badRequest('Missing authorization code');
    }

    // Server-side only: the authorization code and Google's tokens never
    // reach the browser, only the verified identity extracted from them.
    const identity = await exchangeCodeForIdentity(code);

    // Throws 409 if this email already belongs to a password account —
    // see authService.findOrCreateOAuthUser for why we reject rather
    // than auto-link.
    const { token } = await findOrCreateOAuthUser(
      'google',
      identity.googleId,
      identity.email,
      identity.emailVerified,
    );

    // The token goes in the URL FRAGMENT, not a query parameter — a
    // fragment is never sent by the browser to any server (ours, a CDN,
    // or a proxy in between), so it can't leak into access logs or a
    // Referer header the way a query string would. The frontend reads it
    // from window.location.hash and should scrub it immediately with
    // history.replaceState (see Notes.md Phase 5 for the full tradeoff,
    // including the residual browser-history exposure this doesn't
    // eliminate, and more robust alternatives for later).
    res.redirect(`${config.FRONTEND_URL}#token=${encodeURIComponent(token)}`);
  },
);

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.userId!);
  if (!user) {
    // Token verified fine, but the user it names no longer exists (e.g.
    // deleted since the token was issued). Same message as a bad token —
    // deliberately — so a caller can't distinguish "broken token" from
    // "this account was removed" from the response alone.
    throw unauthorized('Invalid or expired token');
  }
  res.status(200).json({ user });
});
