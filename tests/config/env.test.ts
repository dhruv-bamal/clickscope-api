import { describe, expect, it } from 'vitest';
import { parseEnv, EnvValidationError } from '../../src/config/env.js';

describe('parseEnv', () => {
  it('accepts a fully valid environment', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PORT: '4000',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'warn',
      CORS_ORIGIN: 'https://app.example.com',
    });

    expect(config).toEqual({
      NODE_ENV: 'production',
      PORT: 4000, // coerced from string to number
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'warn',
      CORS_ORIGIN: ['https://app.example.com'],
    });
  });

  it('applies defaults for NODE_ENV, PORT, and LOG_LEVEL when omitted', () => {
    const config = parseEnv({
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('rejects a configuration missing the required DATABASE_URL', () => {
    const incompleteEnv = {
      NODE_ENV: 'development',
      PORT: '3000',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'info',
      CORS_ORIGIN: 'http://localhost:5173',
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
    };

    expect(() => parseEnv(invalidEnv)).toThrow(EnvValidationError);
  });

  it('rejects a malformed DATABASE_URL', () => {
    const invalidEnv = {
      DATABASE_URL: 'not-a-valid-url',
      REDIS_URL: 'redis://localhost:6379',
      CORS_ORIGIN: 'http://localhost:5173',
    };

    expect(() => parseEnv(invalidEnv)).toThrow(EnvValidationError);
  });

  it('rejects an unsupported LOG_LEVEL', () => {
    const invalidEnv = {
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'verbose',
      CORS_ORIGIN: 'http://localhost:5173',
    };

    expect(() => parseEnv(invalidEnv)).toThrow(EnvValidationError);
  });

  describe('CORS_ORIGIN', () => {
    const baseEnv = {
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
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
