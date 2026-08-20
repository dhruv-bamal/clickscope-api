import { readFileSync } from 'node:fs';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { beforeAll, describe, expect, it } from 'vitest';

// registry.ts transitively imports the route files, which import
// src/config/index.js — same env-loading dance as every other test that
// touches src/app.js, so a dynamic import deferred to beforeAll (after
// loadEnvFile) is used instead of a static top-level import.
let generateOpenApiDocument: typeof import('../../src/openapi/registry.js').generateOpenApiDocument;

beforeAll(async () => {
  process.loadEnvFile('.env.test');
  ({ generateOpenApiDocument } = await import('../../src/openapi/registry.js'));
});

/**
 * Every route this API actually serves, with the exact status codes it
 * can return — see src/routes/*.ts. /docs and /openapi.json themselves
 * are deliberately excluded from the spec (see src/openapi/registry.ts).
 */
const ROUTES: { method: string; path: string; statusCodes: number[] }[] = [
  { method: 'get', path: '/', statusCodes: [200] },
  { method: 'get', path: '/health', statusCodes: [200, 503] },
  { method: 'post', path: '/api/auth/signup', statusCodes: [201, 400, 409, 429, 500] },
  { method: 'post', path: '/api/auth/login', statusCodes: [200, 400, 401, 429, 500] },
  { method: 'get', path: '/api/auth/google', statusCodes: [302] },
  { method: 'get', path: '/api/auth/google/callback', statusCodes: [302, 400, 409, 500] },
  { method: 'get', path: '/api/auth/me', statusCodes: [200, 401, 500] },
  { method: 'post', path: '/api/links', statusCodes: [201, 400, 401, 409, 429, 500] },
  { method: 'get', path: '/api/links', statusCodes: [200, 400, 401, 500] },
  { method: 'get', path: '/api/links/{id}', statusCodes: [200, 400, 401, 404, 500] },
  { method: 'get', path: '/api/links/{id}/stats', statusCodes: [200, 400, 401, 404, 500] },
  { method: 'patch', path: '/api/links/{id}', statusCodes: [200, 400, 401, 404, 500] },
  { method: 'delete', path: '/api/links/{id}', statusCodes: [204, 400, 401, 404, 500] },
  { method: 'get', path: '/{shortCode}', statusCodes: [200, 302, 404, 410, 500] },
  { method: 'post', path: '/{shortCode}/unlock', statusCodes: [302, 400, 401, 404, 410, 429, 500] },
];

describe('generated OpenAPI document', () => {
  it('is a valid OpenAPI 3.0 document', async () => {
    // SwaggerParser.validate mutates/dereferences its input, so a clone
    // is passed — this test shouldn't affect any other test's copy of
    // the generated document.
    const document = structuredClone(generateOpenApiDocument());

    await expect(SwaggerParser.validate(document as never)).resolves.toBeDefined();
  });

  it.each(ROUTES)('covers $method $path', ({ method, path: routePath }) => {
    const document = generateOpenApiDocument();

    expect(document.paths?.[routePath]).toBeDefined();
    expect(document.paths?.[routePath]?.[method as 'get']).toBeDefined();
  });

  it.each(ROUTES)(
    'documents exactly the status codes $statusCodes for $method $path',
    ({ method, path: routePath, statusCodes }) => {
      const document = generateOpenApiDocument();
      const operation = document.paths?.[routePath]?.[method as 'get'];

      const documentedCodes = Object.keys(operation?.responses ?? {})
        .map(Number)
        .sort((a, b) => a - b);
      const expectedCodes = [...statusCodes].sort((a, b) => a - b);

      expect(documentedCodes).toEqual(expectedCodes);
    },
  );

  it('marks every auth-required route with the bearerAuth security scheme', () => {
    const document = generateOpenApiDocument();
    const authRoutes = [
      ['get', '/api/auth/me'],
      ['post', '/api/links'],
      ['get', '/api/links'],
      ['get', '/api/links/{id}'],
      ['get', '/api/links/{id}/stats'],
      ['patch', '/api/links/{id}'],
      ['delete', '/api/links/{id}'],
    ] as const;

    for (const [method, routePath] of authRoutes) {
      const operation = document.paths?.[routePath]?.[method];
      expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    }
  });

  it('the committed openapi.json matches a freshly generated document', () => {
    // A local staleness guard: if a route or schema changes and nobody
    // re-runs `npm run openapi:generate`, this fails on the next `npm
    // test` — a reminder rather than a silent drift.
    const committedPath = path.join(process.cwd(), 'openapi.json');
    const committed: unknown = JSON.parse(readFileSync(committedPath, 'utf-8'));
    const fresh: unknown = JSON.parse(JSON.stringify(generateOpenApiDocument()));

    expect(committed).toEqual(fresh);
  });
});
