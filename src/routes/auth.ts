import { Router } from 'express';
import { z } from 'zod';
import { unauthorized } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { getUserById, login, signup } from '../services/authService.js';

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
