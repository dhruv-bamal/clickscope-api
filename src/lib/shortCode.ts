import { customAlphabet } from 'nanoid';
import { z } from 'zod';

/**
 * 62 characters, no ambiguity-trimming (e.g. excluding 0/O/1/l) — short
 * codes here are never read aloud or hand-transcribed, only copy-pasted or
 * clicked, so the full alphabet is available for maximum collision
 * resistance at a given length. See Notes.md "Collision probability and
 * why the DB constraint is the real guarantee" for the 62^7 math.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const DEFAULT_SHORT_CODE_LENGTH = 7;
const generateId = customAlphabet(ALPHABET, DEFAULT_SHORT_CODE_LENGTH);

export const MIN_ALIAS_LENGTH = 3;
export const MAX_ALIAS_LENGTH = 32;

/**
 * Custom aliases that would shadow a real (or foreseeable) API path segment.
 * Matters once Phase 7 mounts a flat `/:shortCode` redirect route — without
 * this list, a user could register `/api/links` with alias "health" and the
 * redirect route would never distinguish it from the real health-check path.
 * See Notes.md "Reserved words and route shadowing".
 */
export const RESERVED_SHORT_CODES: ReadonlySet<string> = new Set([
  'api',
  'health',
  'docs',
  'auth',
  'login',
  'signup',
  'admin',
  'static',
  'assets',
  'favicon.ico',
  'robots.txt',
]);

export function isReservedShortCode(code: string): boolean {
  return RESERVED_SHORT_CODES.has(code.toLowerCase());
}

/**
 * Generates a random, URL-safe short code. NOT guaranteed unique — the
 * database's UNIQUE constraint on links.short_code is the actual
 * correctness guarantee; callers (linkService.createLink) catch a 23505 on
 * insert and retry with a fresh code. A pre-check SELECT here would only
 * narrow, not close, the race between two concurrent creates picking the
 * same code.
 */
export function generateShortCode(): string {
  return generateId();
}

export const customAliasSchema = z
  .string()
  .min(MIN_ALIAS_LENGTH, `Alias must be at least ${MIN_ALIAS_LENGTH} characters`)
  .max(MAX_ALIAS_LENGTH, `Alias must be at most ${MAX_ALIAS_LENGTH} characters`)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Alias may only contain letters, numbers, hyphens, and underscores')
  .refine((alias) => !isReservedShortCode(alias), {
    message: 'This alias is reserved and cannot be used',
  });
