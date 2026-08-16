import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { customAliasSchema } from '../lib/shortCode.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import {
  type CreateLinkInput,
  type UpdateLinkInput,
  createLink,
  deleteLink,
  getLink,
  listLinks,
  updateLink,
} from '../services/linkService.js';

export const linksRouter = Router();

const idParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

// http/https only — destinationUrl is redirected to verbatim in Phase 7.
// javascript:/data:/file: schemes would turn a stored link into a stored
// XSS payload or local-file read, so they're rejected here at write time
// rather than left for the redirect route to filter later.
const destinationUrlSchema = z
  .string()
  .url('destinationUrl must be a valid URL')
  .refine((url) => ['http:', 'https:'].includes(new URL(url).protocol), {
    message: 'destinationUrl must use http or https',
  });

const futureDateSchema = z.coerce
  .date()
  .refine((date) => date.getTime() > Date.now(), 'expiresAt must be in the future');

const createLinkSchema = z.object({
  destinationUrl: destinationUrlSchema,
  customAlias: customAliasSchema.optional(),
  expiresAt: futureDateSchema.optional(),
  maxClicks: z.number().int().positive('maxClicks must be a positive integer').optional(),
});

// .strict() rejects customAlias/shortCode in a PATCH body — the short code
// is immutable after creation; changing it would break every URL already
// shared under the old one.
const updateLinkSchema = z
  .object({
    destinationUrl: destinationUrlSchema.optional(),
    expiresAt: futureDateSchema.nullable().optional(),
    maxClicks: z.number().int().positive('maxClicks must be a positive integer').nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

const listLinksQuerySchema = z.object({
  limit: z.coerce.number().int().positive('limit must be a positive integer').default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().nonnegative('offset must be 0 or greater').default(0),
});

linksRouter.post('/', requireAuth, validateBody(createLinkSchema), async (req, res) => {
  const parsed = createLinkSchema.parse(req.validated?.body);

  const input: CreateLinkInput = { destinationUrl: parsed.destinationUrl };
  if (parsed.customAlias !== undefined) input.customAlias = parsed.customAlias;
  if (parsed.expiresAt !== undefined) input.expiresAt = parsed.expiresAt;
  if (parsed.maxClicks !== undefined) input.maxClicks = parsed.maxClicks;

  const link = await createLink(req.userId!, input);
  res.status(201).json({ link });
});

linksRouter.get('/', requireAuth, validateQuery(listLinksQuerySchema), async (req, res) => {
  const { limit: requestedLimit, offset } = listLinksQuerySchema.parse(req.validated?.query);
  // A limit above MAX_PAGE_SIZE is a hint that's too big, not a malformed
  // request — it's clamped rather than rejected, and the effective value
  // used is echoed back in `pagination.limit` so the caller can tell.
  // See Notes.md "Pagination: offset vs. cursor" for the reasoning.
  const limit = Math.min(requestedLimit, MAX_PAGE_SIZE);

  const { links, total } = await listLinks(req.userId!, { limit, offset });
  res.status(200).json({
    links,
    pagination: { total, limit, offset, hasMore: offset + links.length < total },
  });
});

linksRouter.get('/:id', requireAuth, validateParams(idParamSchema), async (req, res) => {
  const { id } = idParamSchema.parse(req.validated?.params);

  const link = await getLink(req.userId!, id);
  if (!link) {
    // Same 404 whether the link doesn't exist at all or belongs to another
    // user — a 403 here would confirm the id refers to a real link even
    // when the caller has no access to it. See Notes.md "403 vs. 404".
    throw notFound('Link not found');
  }
  res.status(200).json({ link });
});

linksRouter.patch(
  '/:id',
  requireAuth,
  validateParams(idParamSchema),
  validateBody(updateLinkSchema),
  async (req, res) => {
    const { id } = idParamSchema.parse(req.validated?.params);

    // Zod does not backfill keys absent from the input onto its parsed
    // output, so presence can be read straight off req.validated.body:
    // 'expiresAt' in body is true only when the client sent that key at
    // all (including explicit `null`), false when they omitted it
    // entirely. See Notes.md "PATCH vs. PUT" for the verified before/after.
    const body = req.validated?.body as Record<string, unknown>;
    const parsed = updateLinkSchema.parse(body);

    // destinationUrl/isActive are optional-only (no .nullable()), so
    // "present in the parsed output" and "present in the raw body" are the
    // same condition for them — checked directly for TS to narrow away
    // `undefined`. expiresAt/maxClicks are optional AND nullable, so only
    // the raw body's key presence distinguishes "absent" from "explicit
    // null"; parsed.expiresAt/maxClicks alone can't tell those apart.
    const input: UpdateLinkInput = {};
    if (parsed.destinationUrl !== undefined) input.destinationUrl = parsed.destinationUrl;
    if ('expiresAt' in body) input.expiresAt = parsed.expiresAt ?? null;
    if ('maxClicks' in body) input.maxClicks = parsed.maxClicks ?? null;
    if (parsed.isActive !== undefined) input.isActive = parsed.isActive;

    const link = await updateLink(req.userId!, id, input);
    if (!link) {
      throw notFound('Link not found');
    }
    res.status(200).json({ link });
  },
);

linksRouter.delete('/:id', requireAuth, validateParams(idParamSchema), async (req, res) => {
  const { id } = idParamSchema.parse(req.validated?.params);

  const deleted = await deleteLink(req.userId!, id);
  if (!deleted) {
    throw notFound('Link not found');
  }
  res.status(204).send();
});
