import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createBoard, verifyAdmin, type Board } from '../boards/board-service';
import { listSpaces, searchPages } from '../confluence/confluence-client';
import { getDefaults, isConnected } from '../confluence/connection-store';
import { exportBoard, type ExportDeps } from '../confluence/export-service';
import { boards } from '../db/schema';
import { DomainError } from '../errors';
import { matchesAny } from '../security/tokens';
import type { AppDeps } from './app';
import { withConfluence } from './confluence-guard';

const exportTargetSchema = z.object({
  spaceId: z.string().min(1).max(200),
  spaceName: z.string().min(1).max(200),
  parentId: z.string().max(200).nullish(),
  parentTitle: z.string().max(200).nullish(),
});
const exportSchema = z.object({ mode: z.enum(['auto', 'overwrite', 'new']) });
const pagesQuerySchema = z.object({ spaceId: z.string().min(1).max(200), q: z.string().max(200).optional() });

export function registerBoardRoutes(app: FastifyInstance, deps: AppDeps, exportDeps: ExportDeps): void {
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
        const { board, adminToken } = await createBoard(db, { name: body.name, defaults: await getDefaults(db) });
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

  /** Admin token valid for an existing board and Confluence connected; otherwise sends the error and returns null. */
  const confluenceAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<Board | null> => {
    const { id } = req.params as { id: string };
    const [board] = await db.select().from(boards).where(eq(boards.id, id));
    if (!board) {
      await reply.code(404).send({ error: 'not_found' });
      return null;
    }
    const token = req.headers['x-admin-token'];
    if (!verifyAdmin(board, typeof token === 'string' ? token : undefined)) {
      await reply.code(403).send({ error: 'forbidden' });
      return null;
    }
    if (!(await isConnected(db))) {
      await reply.code(409).send({ error: 'not_connected' });
      return null;
    }
    return board;
  };

  const invalid = (reply: FastifyReply, error: z.ZodError) =>
    reply.code(400).send({ error: 'invalid_input', message: error.issues[0]?.message ?? 'invalid' });

  app.get('/api/boards/:id/confluence/spaces', async (req, reply) => {
    if (!(await confluenceAdmin(req, reply))) return reply;
    const { q } = req.query as { q?: unknown };
    return withConfluence(deps, reply, async (c) => ({ spaces: await listSpaces(c, typeof q === 'string' ? q : undefined) }));
  });

  app.get('/api/boards/:id/confluence/pages', async (req, reply) => {
    if (!(await confluenceAdmin(req, reply))) return reply;
    const parsed = pagesQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { spaceId, q } = parsed.data;
    return withConfluence(deps, reply, async (c) => ({ pages: await searchPages(c, spaceId, q ?? '') }));
  });

  app.put('/api/boards/:id/export-target', async (req, reply) => {
    const board = await confluenceAdmin(req, reply);
    if (!board) return reply;
    const parsed = exportTargetSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const t = parsed.data;
    const parentId = t.parentId || null;
    // A new location means the next export creates a fresh page there instead of updating the old one.
    const moved = t.spaceId !== board.confluenceSpaceId || parentId !== board.confluenceParentId;
    await db
      .update(boards)
      .set({
        confluenceSpaceId: t.spaceId,
        confluenceSpaceName: t.spaceName,
        confluenceParentId: parentId,
        confluenceParentTitle: t.parentTitle || null,
        ...(moved ? { confluencePageId: null, confluencePageVersion: null, confluencePageUrl: null } : {}),
        ...(moved && board.exportStatus === 'conflict' ? { exportStatus: 'idle', exportError: null } : {}),
      })
      .where(eq(boards.id, board.id));
    await exportDeps.notify(board.id);
    return { ok: true };
  });

  app.post('/api/boards/:id/export', async (req, reply) => {
    const board = await confluenceAdmin(req, reply);
    if (!board) return reply;
    const parsed = exportSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    void exportBoard(exportDeps, board.id, parsed.data.mode);
    return reply.code(202).send({ ok: true });
  });
}
