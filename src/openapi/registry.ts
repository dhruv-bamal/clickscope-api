import { OpenApiGeneratorV3, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { serviceName, serviceVersion } from '../lib/serviceInfo.js';
import {
  googleCallbackQuerySchema,
  loginSchema,
  signupSchema,
} from '../routes/auth.js';
import {
  createLinkSchema,
  idParamSchema,
  linkStatsQuerySchema,
  listLinksQuerySchema,
  updateLinkSchema,
} from '../routes/links.js';
import { shortCodeParamSchema, unlockBodySchema } from '../routes/redirect.js';
import {
  AuthUserSchema,
  ErrorEnvelopeSchema,
  HealthReportSchema,
  LinkClickStatsSchema,
  LinkSchema,
  PaginationSchema,
} from './schemas.js';

/**
 * Generates the OpenAPI spec from the same Zod schemas that already
 * validate real traffic (src/routes/*.ts) plus the response schemas in
 * ./schemas.ts — see Notes.md, "Phase 14a: Observability & API
 * Documentation" / "Generating an OpenAPI Spec from Existing Zod
 * Schemas, Not Hand-Writing One" for why this closes the drift risk a
 * hand-maintained spec can't: a route whose Zod schema changes produces
 * a different generated spec the next time `npm run openapi:generate`
 * runs, rather than silently disagreeing with a document nobody
 * remembered to update.
 */
const registry = new OpenAPIRegistry();

const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

const AUTH_SECURITY = [{ [bearerAuth.name]: [] }];

/** Express's `:param` path syntax, converted to OpenAPI's `{param}`. */
function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function jsonContent(schema: z.ZodTypeAny) {
  return { content: { 'application/json': { schema } } };
}

function errorResponse(description: string) {
  return { description, ...jsonContent(ErrorEnvelopeSchema) };
}

// --- GET / (liveness) ---
registry.registerPath({
  method: 'get',
  path: '/',
  tags: ['meta'],
  summary: 'Liveness probe',
  description: 'Answers "is this process running," with zero dependency checks.',
  responses: {
    200: {
      description: 'The process is running.',
      ...jsonContent(z.object({ name: z.string(), version: z.string() })),
    },
  },
});

// --- GET /health (readiness) ---
registry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['meta'],
  summary: 'Readiness probe',
  description:
    'Checks Postgres, Redis, and click-recording queue depth. Returns 503 (not just a body field) when any dependency is degraded, so a standard orchestrator health check can key off HTTP status alone.',
  responses: {
    200: { description: 'Every dependency is healthy.', ...jsonContent(HealthReportSchema) },
    503: { description: 'At least one dependency is degraded.', ...jsonContent(HealthReportSchema) },
  },
});

// --- POST /api/auth/signup ---
registry.registerPath({
  method: 'post',
  path: '/api/auth/signup',
  tags: ['auth'],
  summary: 'Create an account with email and password',
  request: { body: jsonContent(signupSchema) },
  responses: {
    201: {
      description: 'Account created.',
      ...jsonContent(z.object({ user: AuthUserSchema, token: z.string() })),
    },
    400: errorResponse('Validation failed.'),
    409: errorResponse('An account with this email already exists.'),
    429: errorResponse('Rate limit exceeded.'),
    500: errorResponse('Internal server error.'),
  },
});

// --- POST /api/auth/login ---
registry.registerPath({
  method: 'post',
  path: '/api/auth/login',
  tags: ['auth'],
  summary: 'Log in with email and password',
  request: { body: jsonContent(loginSchema) },
  responses: {
    200: {
      description: 'Login succeeded.',
      ...jsonContent(z.object({ user: AuthUserSchema, token: z.string() })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Invalid email or password.'),
    429: errorResponse('Rate limit exceeded.'),
    500: errorResponse('Internal server error.'),
  },
});

// --- GET /api/auth/google ---
registry.registerPath({
  method: 'get',
  path: '/api/auth/google',
  tags: ['auth'],
  summary: 'Start the Google OAuth flow',
  description: 'Not a JSON endpoint — redirects the browser to Google\'s consent screen.',
  responses: {
    302: { description: "Redirect to Google's OAuth consent screen." },
  },
});

// --- GET /api/auth/google/callback ---
registry.registerPath({
  method: 'get',
  path: '/api/auth/google/callback',
  tags: ['auth'],
  summary: 'Google OAuth callback',
  description:
    'Not a JSON endpoint. On success or denial, redirects to FRONTEND_URL (the issued JWT is carried in the URL fragment, never a query parameter or response body).',
  request: { query: googleCallbackQuerySchema },
  responses: {
    302: { description: 'Redirect back to the frontend, with or without an issued token.' },
    400: errorResponse('Invalid or expired OAuth state, or missing authorization code.'),
    409: errorResponse('An account with this email already exists with a password.'),
    500: errorResponse('Internal server error.'),
  },
});

// --- GET /api/auth/me ---
registry.registerPath({
  method: 'get',
  path: '/api/auth/me',
  tags: ['auth'],
  summary: 'Get the current authenticated user',
  security: AUTH_SECURITY,
  responses: {
    200: { description: 'The authenticated user.', ...jsonContent(z.object({ user: AuthUserSchema })) },
    401: errorResponse('Missing, invalid, or expired token.'),
    500: errorResponse('Internal server error.'),
  },
});

// --- POST /api/links ---
registry.registerPath({
  method: 'post',
  path: '/api/links',
  tags: ['links'],
  summary: 'Create a short link',
  security: AUTH_SECURITY,
  request: { body: jsonContent(createLinkSchema) },
  responses: {
    201: { description: 'Link created.', ...jsonContent(z.object({ link: LinkSchema })) },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Missing, invalid, or expired token.'),
    409: errorResponse('The requested custom alias is already taken.'),
    429: errorResponse('Rate limit exceeded.'),
    500: errorResponse('Internal server error.'),
  },
});

// --- GET /api/links ---
registry.registerPath({
  method: 'get',
  path: '/api/links',
  tags: ['links'],
  summary: "List the authenticated user's links",
  security: AUTH_SECURITY,
  request: { query: listLinksQuerySchema },
  responses: {
    200: {
      description: 'A page of links.',
      ...jsonContent(z.object({ links: z.array(LinkSchema), pagination: PaginationSchema })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Missing, invalid, or expired token.'),
    500: errorResponse('Internal server error.'),
  },
});

// --- GET /api/links/:id ---
registry.registerPath({
  method: 'get',
  path: '/api/links/{id}',
  tags: ['links'],
  summary: 'Get a link by id',
  security: AUTH_SECURITY,
  request: { params: idParamSchema },
  responses: {
    200: { description: 'The link.', ...jsonContent(z.object({ link: LinkSchema })) },
    400: errorResponse('Validation failed (id must be a UUID).'),
    401: errorResponse('Missing, invalid, or expired token.'),
    404: errorResponse('Link not found (or not owned by the caller).'),
    500: errorResponse('Internal server error.'),
  },
});

// --- GET /api/links/:id/stats ---
registry.registerPath({
  method: 'get',
  path: '/api/links/{id}/stats',
  tags: ['links'],
  summary: 'Get daily click stats for a link',
  security: AUTH_SECURITY,
  request: { params: idParamSchema, query: linkStatsQuerySchema },
  responses: {
    200: { description: 'Daily click counts.', ...jsonContent(LinkClickStatsSchema) },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Missing, invalid, or expired token.'),
    404: errorResponse('Link not found (or not owned by the caller).'),
    500: errorResponse('Internal server error.'),
  },
});

// --- PATCH /api/links/:id ---
registry.registerPath({
  method: 'patch',
  path: '/api/links/{id}',
  tags: ['links'],
  summary: 'Update a link',
  security: AUTH_SECURITY,
  request: { params: idParamSchema, body: jsonContent(updateLinkSchema) },
  responses: {
    200: { description: 'The updated link.', ...jsonContent(z.object({ link: LinkSchema })) },
    400: errorResponse('Validation failed (including unknown fields).'),
    401: errorResponse('Missing, invalid, or expired token.'),
    404: errorResponse('Link not found (or not owned by the caller).'),
    500: errorResponse('Internal server error.'),
  },
});

// --- DELETE /api/links/:id ---
registry.registerPath({
  method: 'delete',
  path: '/api/links/{id}',
  tags: ['links'],
  summary: 'Delete a link',
  security: AUTH_SECURITY,
  request: { params: idParamSchema },
  responses: {
    204: { description: 'Link deleted.' },
    400: errorResponse('Validation failed (id must be a UUID).'),
    401: errorResponse('Missing, invalid, or expired token.'),
    404: errorResponse('Link not found (or not owned by the caller).'),
    500: errorResponse('Internal server error.'),
  },
});

// --- GET /:shortCode (public redirect) ---
registry.registerPath({
  method: 'get',
  path: '/{shortCode}',
  tags: ['redirect'],
  summary: 'Resolve a short link',
  description:
    'Redirects to the destination URL. If the link is password-protected and not yet unlocked (see the unlock cookie set by POST /{shortCode}/unlock), returns an HTML interstitial form (200) instead of redirecting.',
  request: { params: shortCodeParamSchema },
  responses: {
    200: {
      description: 'Password-protected link, not yet unlocked: an HTML interstitial form.',
      content: { 'text/html': { schema: z.string() } },
    },
    302: { description: 'Redirect to the destination URL.' },
    404: errorResponse('No link with this short code.'),
    410: errorResponse('The link is deactivated, expired, or has reached its click limit.'),
    500: errorResponse('Internal server error.'),
  },
});

// --- POST /:shortCode/unlock ---
registry.registerPath({
  method: 'post',
  path: '/{shortCode}/unlock',
  tags: ['redirect'],
  summary: 'Submit a password to unlock a protected link',
  request: { params: shortCodeParamSchema, body: jsonContent(unlockBodySchema) },
  responses: {
    302: {
      description:
        'Correct password (or the link has no password): sets an unlock cookie and redirects back to GET /{shortCode}.',
    },
    400: errorResponse('Validation failed.'),
    401: {
      description: 'Incorrect password: an HTML interstitial form with an error message.',
      content: { 'text/html': { schema: z.string() } },
    },
    404: errorResponse('No link with this short code.'),
    410: errorResponse('The link is deactivated, expired, or has reached its click limit.'),
    429: errorResponse('Rate limit exceeded.'),
    500: errorResponse('Internal server error.'),
  },
});

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: serviceName,
      version: serviceVersion,
      description:
        'Click Scope: URL shortening service with link analytics. Generated from the Zod schemas that validate real traffic — see Notes.md, "Phase 14a: Observability & API Documentation."',
    },
    servers: [{ url: '/' }],
  });
}

export { toOpenApiPath };
