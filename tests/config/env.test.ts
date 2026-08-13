import { describe, expect, it } from 'vitest';
import { parseEnv, EnvValidationError } from '../../src/config/env.js';

// A fixed 40-character value satisfying JWT_SECRET's 32-char minimum —
// reused across every fixture below that needs "otherwise fully valid."
const VALID_JWT_SECRET = 'test-jwt-secret-at-least-32-characters!';

describe('parseEnv', () => {
  it('accepts a fully valid environment', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PORT: '4000',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'warn',
      CORS_ORIGIN: 'https://app.example.com',
      JWT_SECRET: VALID_JWT_SECRET,
      JWT_EXPIRES_IN: '1d',
      BCRYPT_COST: '10',
    });

    expect(config).toEqual({
      NODE_ENV: 'production',
      PORT: 4000, // coerced from string to number
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'warn',
      CORS_ORIGIN: ['https://app.example.com'],
      JWT_SECRET: VALID_JWT_SECRET,
      JWT_EXPIRES_IN: '1d',
      BCRYPT_COST: 10, // coerced from string to number
    });
  });

  it('applies defaults for NODE_ENV, PORT, LOG_LEVEL, JWT_EXPIRES_IN, and BCRYPT_COST when omitted', () => {
    const config = parseEnv({
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: VALID_JWT_SECRET,
    });

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.JWT_EXPIRES_IN).toBe('7d');
    expect(config.BCRYPT_COST).toBe(12);
  });

  it('rejects a configuration missing the required DATABASE_URL', () => {
    const incompleteEnv = {
      NODE_ENV: 'development',
      PORT: '3000',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'info',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: VALID_JWT_SECRET,
    };

    expect(() => parseEnv(incompleteEnv)).toThrow(EnvValidationError);
  });

  it('names the missing variable in the error message', () => {
    const incompleteEnv = {
      NODE_ENV: 'development',
      PORT: '3000',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'info',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: VALID_JWT_SECRET,
    };

    expect.assertions(2);
    try {
      parseEnv(incompleteEnv);
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).toContain('DATABASE_URL');
    }
  });

  it('rejects a non-numeric PORT', () => {
    const invalidEnv = {
      PORT: 'not-a-number',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: VALID_JWT_SECRET,
    };

    expect(() => parseEnv(invalidEnv)).toThrow(EnvValidationError);
  });

  it('rejects a malformed DATABASE_URL', () => {
    const invalidEnv = {
      DATABASE_URL: 'not-a-valid-url',
      REDIS_URL: 'redis://localhost:6379',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: VALID_JWT_SECRET,
    };

    expect(() => parseEnv(invalidEnv)).toThrow(EnvValidationError);
  });

  it('rejects an unsupported LOG_LEVEL', () => {
    const invalidEnv = {
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'verbose',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: VALID_JWT_SECRET,
    };

    expect(() => parseEnv(invalidEnv)).toThrow(EnvValidationError);
  });

  describe('JWT_SECRET', () => {
    const baseEnv = {
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      CORS_ORIGIN: 'http://localhost:5173',
    };

    it('rejects a configuration missing JWT_SECRET (no default — see src/config/env.ts)', () => {
      expect(() => parseEnv(baseEnv)).toThrow(EnvValidationError);
    });

    it('rejects a JWT_SECRET shorter than 32 characters', () => {
      expect(() => parseEnv({ ...baseEnv, JWT_SECRET: 'too-short' })).toThrow(EnvValidationError);
    });

    it('accepts a JWT_SECRET of exactly 32 characters', () => {
      const exactly32 = 'a'.repeat(32);
      const config = parseEnv({ ...baseEnv, JWT_SECRET: exactly32 });
      expect(config.JWT_SECRET).toBe(exactly32);
    });
  });

  describe('CORS_ORIGIN', () => {
    const baseEnv = {
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: VALID_JWT_SECRET,
    };

    it('rejects a configuration missing CORS_ORIGIN', () => {
      expect(() => parseEnv(baseEnv)).toThrow(EnvValidationError);
    });

    it('parses a single origin into a one-element array', () => {
      const config = parseEnv({ ...baseEnv, CORS_ORIGIN: 'http://localhost:5173' });
      expect(config.CORS_ORIGIN).toEqual(['http://localhost:5173']);
    });

    it('parses a comma-separated list into multiple origins, trimming whitespace', () => {
      // Phase 16 needs both a production and a preview-deployment origin
      // allowed simultaneously — this is the case that exercises it.
      const config = parseEnv({
        ...baseEnv,
        CORS_ORIGIN: 'https://app.example.com, https://preview.example.com',
      });

      expect(config.CORS_ORIGIN).toEqual([
        'https://app.example.com',
        'https://preview.example.com',
      ]);
    });

    it('rejects a wildcard origin', () => {
      expect(() => parseEnv({ ...baseEnv, CORS_ORIGIN: '*' })).toThrow(EnvValidationError);
    });

    it('rejects a wildcard mixed into an otherwise valid list', () => {
      expect(() => parseEnv({ ...baseEnv, CORS_ORIGIN: 'https://app.example.com,*' })).toThrow(
        EnvValidationError,
      );
    });

    it('rejects a non-URL entry in the list', () => {
      expect(() =>
        parseEnv({ ...baseEnv, CORS_ORIGIN: 'https://app.example.com,not-a-url' }),
      ).toThrow(EnvValidationError);
    });
  });
});
