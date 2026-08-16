import { DatabaseError } from 'pg';
import { query } from '../db/pool.js';
import { conflict, internal } from '../lib/errors.js';
import { generateShortCode } from '../lib/shortCode.js';

/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

/** How many times createLink retries a freshly-generated code after a collision. */
const MAX_GENERATION_ATTEMPTS = 5;

const LINK_COLUMNS = `
  id, user_id, short_code, destination_url, expires_at, max_clicks,
  click_count, is_active, created_at, updated_at
`;

export interface Link {
  id: string;
  userId: string;
  shortCode: string;
  destinationUrl: string;
  expiresAt: Date | null;
  maxClicks: number | null;
  clickCount: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface LinkRow {
  id: string;
  user_id: string;
  short_code: string;
  destination_url: string;
  expires_at: Date | null;
  max_clicks: number | null;
  click_count: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toLink(row: LinkRow): Link {
  return {
    id: row.id,
    userId: row.user_id,
    shortCode: row.short_code,
    destinationUrl: row.destination_url,
    expiresAt: row.expires_at,
    maxClicks: row.max_clicks,
    clickCount: row.click_count,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateLinkInput {
  destinationUrl: string;
  customAlias?: string;
  expiresAt?: Date | null;
  maxClicks?: number | null;
}

/**
 * Inserts one link row with the given short code. Returns null (not a
 * thrown error) on a 23505 unique-violation, so both createLink call sites
 * — the custom-alias path (one attempt, then a definite 409) and the
 * generated-code path (up to MAX_GENERATION_ATTEMPTS retries with a fresh
 * code each time) — can treat "this code is taken" as data, not an
 * exception, and decide what to do about it themselves.
 */
async function insertLink(
  userId: string,
  shortCode: string,
  input: CreateLinkInput,
): Promise<LinkRow | null> {
  try {
    const result = await query<LinkRow>(
      `INSERT INTO links (user_id, short_code, destination_url, expires_at, max_clicks)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${LINK_COLUMNS}`,
      [userId, shortCode, input.destinationUrl, input.expiresAt ?? null, input.maxClicks ?? null],
    );
    const inserted = result.rows[0];
    if (!inserted) {
      throw new Error('Insert returned no row');
    }
    return inserted;
  } catch (err) {
    if (err instanceof DatabaseError && err.code === UNIQUE_VIOLATION) {
      return null;
    }
    throw err;
  }
}

/**
 * Creates a link, either under a caller-chosen alias or a randomly
 * generated code.
 *
 * Custom alias: a pre-check SELECT gives a fast, friendly 409 for the
 * common case, but it's not the correctness guarantee — two concurrent
 * requests for the same alias can both pass it before either INSERTs. The
 * insert's 23505 catch (inside insertLink) is what actually closes that
 * race; a null return there means "lost the race since the pre-check",
 * converted to the same 409 a sequential duplicate would get.
 *
 * Generated code: no pre-check at all, because a pre-check can't do
 * anything useful here — the whole point of a fresh random code is that
 * nothing has looked for it before. Every attempt goes straight to INSERT
 * and retries on a 23505, up to MAX_GENERATION_ATTEMPTS times. See
 * Notes.md for why 62^7 possible codes makes exhausting every retry
 * astronomically unlikely outside of a real bug (e.g. an alphabet or
 * length regression).
 */
export async function createLink(userId: string, input: CreateLinkInput): Promise<Link> {
  if (input.customAlias) {
    const existing = await query<{ id: string }>('SELECT id FROM links WHERE short_code = $1', [
      input.customAlias,
    ]);
    if (existing.rows[0]) {
      throw conflict('This alias is already taken');
    }

    const row = await insertLink(userId, input.customAlias, input);
    if (!row) {
      throw conflict('This alias is already taken');
    }
    return toLink(row);
  }

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const row = await insertLink(userId, generateShortCode(), input);
    if (row) {
      return toLink(row);
    }
  }
  throw internal('Failed to generate a unique short code after multiple attempts');
}

export interface ListLinksOptions {
  limit: number;
  offset: number;
}

export interface ListLinksResult {
  links: Link[];
  total: number;
}

/**
 * Lists a caller's own links, newest first. WHERE user_id = $1 is the
 * entire ownership guarantee — there is no code path that can fetch a
 * link belonging to another user, because no query here is ever built
 * without that clause.
 */
export async function listLinks(userId: string, options: ListLinksOptions): Promise<ListLinksResult> {
  const [rowsResult, countResult] = await Promise.all([
    query<LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM links
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [userId, options.limit, options.offset],
    ),
    query<{ count: number }>('SELECT count(*)::int AS count FROM links WHERE user_id = $1', [userId]),
  ]);

  return {
    links: rowsResult.rows.map(toLink),
    total: countResult.rows[0]?.count ?? 0,
  };
}

/**
 * Fetches one link, scoped to its owner in the query itself
 * (WHERE id = $1 AND user_id = $2). Returns null for both "no such link"
 * and "this link belongs to someone else" — the two cases are
 * indistinguishable on purpose (see Notes.md, "403 vs. 404"), so callers
 * can't accidentally leak the difference even if they tried.
 */
export async function getLink(userId: string, linkId: string): Promise<Link | null> {
  const result = await query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM links WHERE id = $1 AND user_id = $2`,
    [linkId, userId],
  );
  const row = result.rows[0];
  return row ? toLink(row) : null;
}

export interface UpdateLinkInput {
  destinationUrl?: string;
  expiresAt?: Date | null;
  maxClicks?: number | null;
  isActive?: boolean;
}

/**
 * Partially updates a link, scoped to its owner in the query itself. Only
 * fields present as keys on `input` are written — the route layer is
 * responsible for turning "field absent from the request body" into "key
 * absent from this object" (see src/routes/links.ts), so `undefined` here
 * always means "leave unchanged" and `null` always means "clear this
 * field", never the other way around.
 *
 * An input with no fields set is a valid no-op PATCH: skips the UPDATE
 * entirely and just returns the current row via getLink, rather than
 * running `UPDATE links SET updated_at = now() WHERE ...` for no other
 * reason than to bump a timestamp nothing actually changed.
 */
export async function updateLink(
  userId: string,
  linkId: string,
  input: UpdateLinkInput,
): Promise<Link | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (input.destinationUrl !== undefined) {
    values.push(input.destinationUrl);
    setClauses.push(`destination_url = $${values.length}`);
  }
  if (input.expiresAt !== undefined) {
    values.push(input.expiresAt);
    setClauses.push(`expires_at = $${values.length}`);
  }
  if (input.maxClicks !== undefined) {
    values.push(input.maxClicks);
    setClauses.push(`max_clicks = $${values.length}`);
  }
  if (input.isActive !== undefined) {
    values.push(input.isActive);
    setClauses.push(`is_active = $${values.length}`);
  }

  if (setClauses.length === 0) {
    return getLink(userId, linkId);
  }

  setClauses.push('updated_at = now()');
  values.push(linkId, userId);

  const result = await query<LinkRow>(
    `UPDATE links
     SET ${setClauses.join(', ')}
     WHERE id = $${values.length - 1} AND user_id = $${values.length}
     RETURNING ${LINK_COLUMNS}`,
    values,
  );
  const row = result.rows[0];
  return row ? toLink(row) : null;
}

/**
 * Deletes a link, scoped to its owner in the query itself. Returns false
 * (not a thrown error) for both "no such link" and "not yours" — the
 * route layer converts that uniformly into a 404.
 */
export async function deleteLink(userId: string, linkId: string): Promise<boolean> {
  const result = await query('DELETE FROM links WHERE id = $1 AND user_id = $2 RETURNING id', [
    linkId,
    userId,
  ]);
  return result.rows.length > 0;
}
