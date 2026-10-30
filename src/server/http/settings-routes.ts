import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  disconnect,
  getConnectionInfo,
  saveTokens,
  setDefaults,
  setSite,
  getAccessToken,
  getValidToken,
  isConnected,
  RECONNECT_MSG,
} from '../confluence/connection-store';
import { ConfluenceError, listSpaces, searchPages, type ClientCtx } from '../confluence/confluence-client';
import { DomainError } from '../errors';
import { AtlassianHttpError, buildAuthorizeUrl, exchangeCode, listSites } from '../confluence/oauth';
import { safeEqual, randomId } from '../security/tokens';
import type { AppDeps } from './app';

const OWNER_COOKIE = 'owner';
const STATE_COOKIE = 'oauth_state';
const STATE_PATH = '/api/settings/atlassian';

const defaultsSchema = z.object({
  spaceId: z.string().min(1).max(200),
  spaceName: z.string().min(1).max(200),
  parentId: z.string().max(200).nullish(),
  parentTitle: z.string().max(200).nullish(),
});

const pagesQuerySchema = z.object({ spaceId: z.string().min(1).max(200), q: z.string().max(200).optional() });

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, db } = deps;
  const secure = config.publicBaseUrl.startsWith('https://');

  const isOwner = (req: FastifyRequest): boolean => {
    const raw = req.cookies[OWNER_COOKIE];
    if (!raw) return false;
    const u = req.unsignCookie(raw);
    return u.valid && u.value === '1';
  };

  const requireOwner = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isOwner(req)) return reply.code(401).send({ error: 'unauthorized' });
  };

  const requireAtlassian = async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = await requireOwner(req, reply);
    if (denied) return denied;
    if (!config.atlassian) return reply.code(404).send({ error: 'not_found' });
  };

  /** Runs an Atlassian call; an expired/revoked connection becomes a 403 reconnect response. */
  const guarded = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DomainError) return reply.code(403).send({ error: 'forbidden', message: err.message });
      if (err instanceof AtlassianHttpError && err.status >= 400 && err.status < 500) {
        return reply.code(403).send({ error: 'forbidden', message: RECONNECT_MSG });
      }
      throw err;
    }
  };

  /** Confluence call for the owner picker; not connected (or no site) is 409, a rejected token is 403 reconnect. */
  const withConfluence = async <T>(reply: FastifyReply, fn: (c: ClientCtx) => Promise<T>): Promise<T | FastifyReply> => {
    if (!(await isConnected(db))) return reply.code(409).send({ error: 'not_connected' });
    try {
      return await fn({ fetch: deps.fetch, ...(await getAccessToken(deps)) });
    } catch (err) {
      if (err instanceof DomainError) return reply.code(403).send({ error: 'forbidden', message: err.message });
      if (err instanceof ConfluenceError && err.status >= 400 && err.status < 500) {
        const message = err.status === 401 ? RECONNECT_MSG : `Confluence request failed (${err.status})`;
        return reply.code(403).send({ error: 'forbidden', message });
      }
      throw err;
    }
  };

  const owner = { preHandler: requireOwner };
  const atlassian = { preHandler: requireAtlassian };

  app.post(
    '/api/settings/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = (req.body ?? {}) as { secret?: unknown };
      if (typeof body.secret !== 'string' || !safeEqual(body.secret, config.ownerSecret)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      reply.setCookie(OWNER_COOKIE, '1', {
        signed: true,
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge: 8 * 60 * 60,
      });
      return { ok: true };
    },
  );

  app.post('/api/settings/logout', async (_req, reply) => {
    reply.clearCookie(OWNER_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/settings', owner, async () => ({
    ...(await getConnectionInfo(db)),
    atlassianConfigured: config.atlassian !== null,
  }));

  app.get('/api/settings/atlassian/connect', atlassian, async (_req, reply) => {
    const state = randomId(16);
    reply.setCookie(STATE_COOKIE, state, {
      signed: true,
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: STATE_PATH,
      maxAge: 10 * 60,
    });
    return reply.redirect(buildAuthorizeUrl(config, state), 302);
  });

  app.get('/api/settings/atlassian/callback', atlassian, async (req, reply) => {
    const q = req.query as { code?: unknown; state?: unknown; error?: unknown };
    const raw = req.cookies[STATE_COOKIE];
    const cookie = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie(STATE_COOKIE, { path: STATE_PATH });
    if (
      !cookie?.valid ||
      !cookie.value ||
      typeof q.state !== 'string' ||
      !safeEqual(q.state, cookie.value)
    ) {
      return reply.code(400).send({ error: 'invalid_state' });
    }
    if (typeof q.error === 'string') {
      return reply.redirect('/settings?error=atlassian_denied', 302);
    }
    if (typeof q.code !== 'string' || !q.code) {
      return reply.code(400).send({ error: 'invalid_input', message: 'code is required' });
    }
    try {
      const tokens = await exchangeCode(deps, q.code);
      const previous = await getConnectionInfo(db);
      await saveTokens(db, config.encryptionKey, tokens, deps.now());
      const sites = await listSites(deps, tokens.accessToken);
      if (sites.length === 1) {
        await setSite(db, sites[0]!, deps.now());
      } else if (!sites.some((s) => s.id === previous.site?.id)) {
        await setSite(db, null, deps.now());
      }
    } catch (err) {
      app.log.error({ err }, 'atlassian oauth callback failed');
      return reply.redirect('/settings?error=atlassian_failed', 302);
    }
    return reply.redirect('/settings', 302);
  });

  app.get('/api/settings/atlassian/sites', atlassian, async (_req, reply) => {
    const info = await getConnectionInfo(db);
    if (!info.connected) return reply.code(409).send({ error: 'not_connected' });
    return guarded(reply, async () => ({ sites: await listSites(deps, await getValidToken(deps)) }));
  });

  app.put('/api/settings/atlassian/site', atlassian, async (req, reply) => {
    const body = (req.body ?? {}) as { id?: unknown };
    if (typeof body.id !== 'string') {
      return reply.code(400).send({ error: 'invalid_input', message: 'id must be a string' });
    }
    const info = await getConnectionInfo(db);
    if (!info.connected) return reply.code(409).send({ error: 'not_connected' });
    return guarded(reply, async () => {
      const site = (await listSites(deps, await getValidToken(deps))).find((s) => s.id === body.id);
      if (!site) return reply.code(400).send({ error: 'invalid_input', message: 'unknown site' });
      await setSite(db, site, deps.now());
      return { ok: true };
    });
  });

  app.put('/api/settings/defaults', atlassian, async (req, reply) => {
    const parsed = defaultsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.issues[0]?.message ?? 'invalid' });
    }
    const d = parsed.data;
    const saved = await setDefaults(
      db,
      {
        spaceId: d.spaceId,
        spaceName: d.spaceName,
        parentId: d.parentId || null,
        parentTitle: d.parentTitle || null,
      },
      deps.now(),
    );
    if (!saved) return reply.code(409).send({ error: 'not_connected' });
    return { ok: true };
  });

  app.post('/api/settings/atlassian/disconnect', atlassian, async () => {
    await disconnect(db);
    return { ok: true };
  });

  app.get('/api/settings/confluence/spaces', atlassian, async (req, reply) => {
    const { q } = req.query as { q?: unknown };
    return withConfluence(reply, async (c) => ({ spaces: await listSpaces(c, typeof q === 'string' ? q : undefined) }));
  });

  app.get('/api/settings/confluence/pages', atlassian, async (req, reply) => {
    const parsed = pagesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.issues[0]?.message ?? 'invalid' });
    }
    const { spaceId, q } = parsed.data;
    return withConfluence(reply, async (c) => ({ pages: await searchPages(c, spaceId, q ?? '') }));
  });
}
