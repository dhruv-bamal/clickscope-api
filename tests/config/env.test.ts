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
    });

    expect(config).toEqual({
      NODE_ENV: 'production',
      PORT: 4000, // coerced from string to number
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'warn',
    });
  });

  it('applies defaults for NODE_ENV, PORT, and LOG_LEVEL when omitted', () => {
    const config = parseEnv({
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
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
    };

    expect(() => parseEnv(incompleteEnv)).toThrow(EnvValidationError);
  });

  it('names the missing variable in the error message', () => {
    const incompleteEnv = {
      NODE_ENV: 'development',
      PORT: '3000',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'info',
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
    };

    expect(() => parseEnv(invalidEnv)).toThrow(EnvValidationError);
  });

  it('rejects a malformed DATABASE_URL', () => {
    const invalidEnv = {
      DATABASE_URL: 'not-a-valid-url',
      REDIS_URL: 'redis://localhost:6379',
    };

    expect(() => parseEnv(invalidEnv)).toThrow(EnvValidationError);
  });

  it('rejects an unsupported LOG_LEVEL', () => {
    const invalidEnv = {
      DATABASE_URL: 'postgres://user:pass@localhost:5432/clickscope',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'verbose',
    };

    expect(() => parseEnv(invalidEnv)).toThrow(EnvValidationError);
  });
});
