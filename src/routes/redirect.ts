import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { readCookie } from '../lib/cookies.js';
import { type AppError, gone, notFound } from '../lib/errors.js';
import { MAX_ALIAS_LENGTH } from '../lib/shortCode.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { recordClick } from '../services/clickService.js';
import { getLinkByShortCode, type RedirectLink } from '../services/linkService.js';
import { verifyPassword } from '../services/passwordService.js';
import { signUnlockToken, verifyUnlockToken } from '../services/unlockTokenService.js';

export const redirectRouter = Router();

const shortCodeParamSchema = z.object({
  // No charset check here (unlike customAliasSchema at write time) — a
  // short code that can't possibly exist just falls through to the
  // ordinary "no such link" 404 below; this is a public route reachable
  // by anyone, and garbage input is expected, not exceptional.
  shortCode: z.string().min(1).max(MAX_ALIAS_LENGTH),
});

const unlockBodySchema = z.object({ password: z.string().min(1) }).strict();

const UNLOCK_COOKIE_MAX_AGE_MS = 30 * 60 * 1000; // keep in sync with unlockTokenService's UNLOCK_TOKEN_TTL

function cookieNameFor(shortCode: string): string {
  return `link_unlock_${shortCode}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Minimal, functional-only interstitial — no CSS, no framework. shortCode
 * is escaped even though customAliasSchema/generateShortCode already
 * restrict it to a safe charset at write time; costs nothing to also
 * harden the one place it's interpolated into HTML.
 */
function renderInterstitial(shortCode: string, errorMessage?: string): string {
  const safeShortCode = escapeHtml(shortCode);
  const errorHtml = errorMessage ? `<p>${escapeHtml(errorMessage)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Password required</title></head>
<body>
  <h1>This link is password protected</h1>
  ${errorHtml}
  <form method="POST" action="/${safeShortCode}/unlock">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" required autofocus>
    <button type="submit">Unlock</button>
  </form>
</body>
</html>`;
}

/**
 * The dead-state check that applies (in priority order), or null if the
 * link is currently live. Shared between GET and POST /unlock so both
 * agree on what "dead" means without duplicating the three branches.
 *
 * All three return 410, not 404 — the server knows exactly what this link
 * was and is deliberately declining to serve it, the same class of
 * outcome whether it was turned off, timed out, or ran out of clicks. See
 * Notes.md, "Phase 7: The Public Redirect" / "404 vs 410."
 */
function deadStateError(link: RedirectLink): AppError | null {
  if (!link.isActive) return gone('This link has been deactivated');
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) return gone('This link has expired');
  if (link.maxClicks !== null && link.clickCount >= link.maxClicks) {
    return gone('This link has reached its click limit');
  }
  return null;
}

redirectRouter.get('/:shortCode', validateParams(shortCodeParamSchema), async (req, res) => {
  const { shortCode } = shortCodeParamSchema.parse(req.validated?.params);
  const link = await getLinkByShortCode(shortCode);
  if (!link) throw notFound('Link not found');

  const deadError = deadStateError(link);
  if (deadError) throw deadError;

  if (link.passwordHash) {
    const token = readCookie(req.header('cookie'), cookieNameFor(shortCode));
    const verified = token ? verifyUnlockToken(token) : ({ ok: false } as const);
    if (!verified.ok || verified.linkId !== link.id) {
      res.status(200).type('html').send(renderInterstitial(shortCode));
      return;
    }
  }

  // Deliberately synchronous and timed separately from requestContext's
  // whole-request logging — this isolates the DB-write cost specifically,
  // which is the number Phase 10's queue will be measured against. See
  // Notes.md, "Synchronous side effects on a latency-critical path."
  const start = process.hrtime.bigint();
  await recordClick({
    linkId: link.id,
    referrer: req.header('referer') ?? null,
    userAgent: req.header('user-agent') ?? null,
  });
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  req.log.info({ linkId: link.id, durationMs }, 'Click recorded');

  // 302, never 301 — see Notes.md, "301 vs 302 vs 307/308." A 301 would be
  // cached by the browser essentially forever; every later click for that
  // visitor would never reach this server again, silently freezing click
  // counts, expiry, password gating, and destination edits all at once.
  res.redirect(302, link.destinationUrl);
});

redirectRouter.post(
  '/:shortCode/unlock',
  validateParams(shortCodeParamSchema),
  validateBody(unlockBodySchema),
  async (req, res) => {
    const { shortCode } = shortCodeParamSchema.parse(req.validated?.params);
    const { password } = unlockBodySchema.parse(req.validated?.body);
    const link = await getLinkByShortCode(shortCode);
    if (!link) throw notFound('Link not found');

    const deadError = deadStateError(link);
    if (deadError) throw deadError;

    if (!link.passwordHash) {
      res.redirect(302, `/${shortCode}`);
      return;
    }

    const valid = await verifyPassword(password, link.passwordHash);
    if (!valid) {
      res
        .status(401)
        .type('html')
        .send(renderInterstitial(shortCode, 'Incorrect password. Please try again.'));
      return;
    }

    res.cookie(cookieNameFor(shortCode), signUnlockToken(link.id), {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: UNLOCK_COOKIE_MAX_AGE_MS,
      path: `/${shortCode}`,
    });

    // Bounce back through GET rather than redirecting straight to the
    // destination here, so GET stays the single source of truth for dead-
    // state checks, click recording, and the final redirect — duplicating
    // that logic into this handler would create two places that must
    // independently agree on "what does a live, unlocked link look like."
    res.redirect(302, `/${shortCode}`);
  },
);
