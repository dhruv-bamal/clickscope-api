import cors from 'cors';
import helmet from 'helmet';
import { config } from '../config/index.js';

/**
 * Helmet's default header set. Concretely, what each blocks:
 *  - Strict-Transport-Security: forces the browser to always use HTTPS
 *    for this origin from now on, blocking SSL-stripping downgrade
 *    attacks.
 *  - X-Content-Type-Options: nosniff — stops the browser from
 *    MIME-sniffing a response into executing as something other than its
 *    declared Content-Type (part of a class of XSS where an "image"
 *    upload gets sniffed and run as script).
 *  - Content-Security-Policy (helmet's conservative default) — restricts
 *    which origins scripts/styles/etc. may load from, shrinking XSS blast
 *    radius.
 *  - X-Frame-Options / frame-ancestors — blocks this page from being
 *    embedded in another site's <iframe>, mitigating clickjacking.
 *  - Referrer-Policy — limits how much of this API's URLs leak to
 *    third-party sites via the Referer header.
 * See Notes.md, "Phase 3: API Foundation" for the full writeup.
 */
export const securityHeaders = helmet();

/**
 * CORS is a browser-enforced restriction on which origins' JavaScript may
 * read a cross-origin response — it does nothing to stop a non-browser
 * client (curl, a server-to-server call) from calling this API directly;
 * the request still executes regardless of CORS headers. It is not an
 * authentication or authorization mechanism.
 *
 * config.CORS_ORIGIN is validated at startup (src/config/env.ts) to be a
 * non-empty list of explicit origins and never "*" — a wildcard would
 * tell every website's JavaScript, from any origin, that it may read this
 * API's responses in a victim user's browser session. `credentials` is
 * left at its default (false): no auth mechanism exists yet to decide
 * cookie- vs bearer-token-based auth, and turning on credentialed
 * cross-origin requests before that's decided would widen the security
 * surface for no current benefit.
 */
export const corsMiddleware = cors({
  origin: config.CORS_ORIGIN,
});
