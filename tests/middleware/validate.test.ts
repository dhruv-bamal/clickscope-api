import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';
import { validateBody, validateParams, validateQuery } from '../../src/middleware/validate.js';

const createLinkBody = z.object({
  destinationUrl: z.string().url(),
  maxClicks: z.number().int().positive().optional(),
});

const listLinksQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
});

const linkParams = z.object({
  id: z.string().uuid(),
});

function buildApp() {
  const app = express();
  app.use(express.json());

  app.post('/links', validateBody(createLinkBody), (req, res) => {
    res.status(201).json({ received: req.validated?.body });
  });

  app.get('/links', validateQuery(listLinksQuery), (req, res) => {
    res.json({ received: req.validated?.query });
  });

  app.get('/links/:id', validateParams(linkParams), (req, res) => {
    res.json({ received: req.validated?.params });
  });

  app.use(createErrorHandler('development'));
  return app;
}

describe('validation middleware', () => {
  it('passes valid body through and makes the parsed value available on req.validated.body', async () => {
    const res = await request(buildApp())
      .post('/links')
      .send({ destinationUrl: 'https://example.com', maxClicks: 5 });

    expect(res.status).toBe(201);
    expect(res.body.received).toEqual({
      destinationUrl: 'https://example.com',
      maxClicks: 5,
    });
  });

  it('rejects an invalid body with 400 and field-level detail, not a raw Zod dump', async () => {
    const res = await request(buildApp()).post('/links').send({ destinationUrl: 'not-a-url' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.details).toEqual([
      { field: 'destinationUrl', message: expect.any(String) },
    ]);
    expect(res.body.error.details[0]).not.toHaveProperty('code');
    expect(res.body.error.details[0]).not.toHaveProperty('path');
  });

  it('reports every invalid field, not just the first', async () => {
    const res = await request(buildApp()).post('/links').send({});

    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toContain('destinationUrl');
  });

  it('validates query params — req.query is a getter in Express 5, so this exercises req.validated.query specifically', async () => {
    const res = await request(buildApp()).get('/links').query({ page: '2' });

    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ page: 2 }); // coerced string -> number
  });

  it('rejects an invalid query param with field-level detail', async () => {
    const res = await request(buildApp()).get('/links').query({ page: 'not-a-number' });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('page');
  });

  it('validates route params', async () => {
    const validId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const res = await request(buildApp()).get(`/links/${validId}`);

    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ id: validId });
  });

  it('rejects an invalid route param', async () => {
    const res = await request(buildApp()).get('/links/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('id');
  });
});
