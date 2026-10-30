import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config';
import { createTestDb } from '../test/helpers';
import { buildApp } from './app';

const env = {
  DATABASE_URL: 'postgres://x',
  PUBLIC_BASE_URL: 'https://retro.example.com',
  OWNER_SECRET: 'owner-secret-1234567',
  INVITE_CODES: 'alpha,beta',
  SESSION_SECRET: 's'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

let app: FastifyInstance;

beforeEach(async () => {
  const db = await createTestDb();
  ({ app } = await buildApp({ config: loadConfig(env), db, now: () => Date.now(), fetch }));
});
afterEach(async () => {
  await app.close();
});

const create = (payload: unknown) => app.inject({ method: 'POST', url: '/api/boards', payload: payload as object });

test('creates board with valid invite code', async () => {
  const r = await create({ name: 'Sprint', inviteCode: 'beta' });
  expect(r.statusCode).toBe(201);
  const body = r.json();
  expect(body.participantUrl).toBe(`https://retro.example.com/b/${body.boardId}`);
  expect(body.adminUrl).toBe(`https://retro.example.com/b/${body.boardId}?admin=${body.adminToken}`);
});

test('rejects bad invite code with 403', async () => {
  const r = await create({ name: 'Sprint', inviteCode: 'nope' });
  expect(r.statusCode).toBe(403);
  expect(r.json()).toEqual({ error: 'forbidden' });
});

test('rejects missing invite code and non-string fields', async () => {
  expect((await create({ name: 'Sprint' })).statusCode).toBe(403);
  expect((await create({ name: 5, inviteCode: 'alpha' })).statusCode).toBe(400);
});

test('invalid board name gives 400 invalid_input', async () => {
  const r = await create({ name: '   ', inviteCode: 'alpha' });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toBe('invalid_input');
});

test('rate limits creation attempts after 10/min', async () => {
  for (let i = 0; i < 10; i++) expect((await create({ name: 'S', inviteCode: 'bad' })).statusCode).toBe(403);
  expect((await create({ name: 'S', inviteCode: 'bad' })).statusCode).toBe(429);
});

test('healthz', async () => {
  const r = await app.inject({ method: 'GET', url: '/healthz' });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ ok: true });
});

test('unknown api route is 404 json', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/nope' });
  expect(r.statusCode).toBe(404);
  expect(r.json().error).toBe('not_found');
});
