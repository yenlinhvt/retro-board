import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { createBoard } from '../boards/board-service';
import { DomainError } from '../errors';
import { matchesAny } from '../security/tokens';
import type { AppDeps } from './app';

export function registerBoardRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, db } = deps;
  const baseUrl = config.publicBaseUrl.replace(/\/+$/, '');

  app.get('/healthz', async (_req, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
      return { ok: true };
    } catch (err) {
      app.log.error({ err }, 'health check failed');
      return reply.code(503).send({ ok: false });
    }
  });

  app.post(
    '/api/boards',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = (req.body ?? {}) as { name?: unknown; inviteCode?: unknown };
      if (typeof body.inviteCode !== 'string' || !matchesAny(body.inviteCode, config.inviteCodes)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'invalid_input', message: 'name must be a string' });
      }
      try {
        const { board, adminToken } = await createBoard(db, { name: body.name, defaults: null });
        const participantUrl = `${baseUrl}/b/${board.id}`;
        return reply.code(201).send({
          boardId: board.id,
          adminToken,
          participantUrl,
          adminUrl: `${participantUrl}?admin=${adminToken}`,
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'invalid_input') {
          return reply.code(400).send({ error: 'invalid_input', message: err.message });
        }
        throw err;
      }
    },
  );
}
