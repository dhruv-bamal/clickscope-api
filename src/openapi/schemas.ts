import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Patches ZodType.prototype with .openapi() — called here, at the top of
// the first module that needs it, rather than in registry.ts, since
// prototype extension must run before ANY .openapi() call anywhere, and
// this file's schemas below are evaluated as soon as this module is
// imported (ESM import order, not statement order within registry.ts,
// decides when that happens).
extendZodWithOpenApi(z);

/**
 * Response-shape Zod schemas for the OpenAPI spec. Unlike the REQUEST
 * schemas in src/routes/*.ts (which validate real traffic and drive this
 * spec directly), nothing in this file executes at runtime — none of
 * AuthUser (src/services/authService.ts), Link (src/services/linkService.ts),
 * or HealthReport (src/services/health.ts) are Zod-validated today, since
 * they're internal service return types, not request input.
 *
 * DRIFT RISK: these schemas can silently diverge from the real service
 * return types if a field is added/renamed/removed on one side and not
 * the other — nothing here would catch that automatically. This is the
 * same category of problem the sibling clickscope-web repo already
 * flags for its own hand-written src/types/api.ts, one layer removed.
 * tests/openapi/spec.test.ts's route/status-code coverage tests reduce
 * but do not eliminate this risk — they catch a missing route or status
 * code, not a mismatched field. Two ways to close this later, out of
 * scope for this phase: (1) make AuthUser/Link themselves z.infer<> from
 * a schema instead of a hand-written interface, or (2) a contract test
 * that validates a real service response against these schemas. See
 * Notes.md, "Phase 14a: Observability & API Documentation."
 */

export const AuthUserSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    emailVerified: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('AuthUser');

export const LinkSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    shortCode: z.string(),
    destinationUrl: z.string().url(),
    expiresAt: z.string().datetime().nullable(),
    maxClicks: z.number().int().nullable(),
    clickCount: z.number().int(),
    isActive: z.boolean(),
    isPasswordProtected: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Link');

export const PaginationSchema = z
  .object({
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    hasMore: z.boolean(),
  })
  .openapi('Pagination');

export const LinkClickStatsSchema = z
  .object({
    linkId: z.string().uuid(),
    days: z.number().int(),
    stats: z.array(z.object({ day: z.string(), clicks: z.number().int() })),
  })
  .openapi('LinkClickStats');

const dependencyStatusSchema = z.object({
  status: z.enum(['ok', 'error']),
  latencyMs: z.number(),
});

export const HealthReportSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    checks: z.object({
      database: dependencyStatusSchema,
      redis: dependencyStatusSchema,
      queue: z.object({
        status: z.enum(['ok', 'degraded', 'error']),
        latencyMs: z.number(),
        waiting: z.number().int(),
      }),
    }),
  })
  .openapi('HealthReport');

/**
 * Matches src/middleware/errorHandler.ts's exact response envelope —
 * reused across every non-2xx response registration in registry.ts.
 */
export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi('ErrorEnvelope');
