import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORT_CODE_LENGTH,
  customAliasSchema,
  generateShortCode,
  isReservedShortCode,
} from '../../src/lib/shortCode.js';

// shortCode.ts has no transitive dependency on src/config, so no
// loadEnvFile/dynamic-import dance is needed here — unlike most other
// tests in this suite.

describe('generateShortCode', () => {
  it('returns a string of the expected length drawn from the expected alphabet', () => {
    // Regression guard: without this, swapping nanoid for a weaker
    // generator, shrinking the length, or widening the alphabet to include
    // URL-unsafe characters would pass every other test in the suite —
    // nothing else inspects a generated code's raw characters.
    const code = generateShortCode();
    expect(code).toHaveLength(DEFAULT_SHORT_CODE_LENGTH);
    expect(code).toMatch(/^[0-9A-Za-z]+$/);
  });

  it('never produces a character outside the expected alphabet across many calls', () => {
    for (let i = 0; i < 1000; i += 1) {
      expect(generateShortCode()).toMatch(/^[0-9A-Za-z]{7}$/);
    }
  });

  it('produces distinct values across calls', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateShortCode()));
    expect(codes.size).toBe(50);
  });
});

describe('isReservedShortCode', () => {
  it('matches a reserved word case-insensitively', () => {
    expect(isReservedShortCode('api')).toBe(true);
    expect(isReservedShortCode('API')).toBe(true);
    expect(isReservedShortCode('Admin')).toBe(true);
  });

  it('does not match a non-reserved word', () => {
    expect(isReservedShortCode('my-launch-page')).toBe(false);
  });
});

describe('customAliasSchema', () => {
  it('accepts a valid alias', () => {
    expect(customAliasSchema.safeParse('my-launch-page').success).toBe(true);
  });

  it('rejects an alias shorter than the minimum length', () => {
    expect(customAliasSchema.safeParse('ab').success).toBe(false);
  });

  it('rejects an alias longer than the maximum length', () => {
    expect(customAliasSchema.safeParse('a'.repeat(33)).success).toBe(false);
  });

  it('rejects disallowed characters', () => {
    expect(customAliasSchema.safeParse('has a space').success).toBe(false);
    expect(customAliasSchema.safeParse('has/slash').success).toBe(false);
    expect(customAliasSchema.safeParse('has.dot').success).toBe(false);
  });

  it('rejects a reserved word', () => {
    const result = customAliasSchema.safeParse('admin');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('This alias is reserved and cannot be used');
    }
  });
});
