import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import type { ClientToServer, ServerToClient } from '../../shared/types';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { attachRealtime, type Realtime } from '../realtime/socket';
import { registerBoardRoutes } from './board-routes';
import { registerSettingsRoutes } from './settings-routes';

export type AppDeps = {
  config: Config;
  db: Db;
  now: () => number;
  fetch: typeof fetch;
  logStream?: NodeJS.WritableStream;
  isConfluenceConnected?: () => Promise<boolean>;
  onClosed?: (boardId: string) => void;
};

export async function buildApp(
  deps: AppDeps,
): Promise<{ app: FastifyInstance; io: Server<ClientToServer, ServerToClient>; realtime: Realtime }> {
  const app = Fastify({
    trustProxy: deps.config.trustProxy,
    logger: {
      level: process.env.NODE_ENV === 'test' && !deps.logStream ? 'silent' : 'info',
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      // Log the path only: the query string can carry the admin token.
      serializers: {
        req: (req: { method: string; url: string; ip?: string }) => ({
          method: req.method,
          url: req.url.split('?')[0],
          remoteAddress: req.ip,
        }),
      },
      redact: ['req.headers.cookie', 'req.query.admin', 'req.headers["x-admin-token"]'],
    },
  });

  await app.register(fastifyCookie, { secret: deps.config.sessionSecret });
  await app.register(fastifyRateLimit, { global: false });

  registerBoardRoutes(app, deps);
  registerSettingsRoutes(app, deps);

  const clientDir = path.resolve(process.cwd(), 'dist/client');
  const hasClient = fs.existsSync(clientDir);
  if (hasClient) {
    await app.register(fastifyStatic, { root: clientDir });
  }

  app.setNotFoundHandler((req, reply) => {
    const urlPath = req.url.split('?')[0] ?? '';
    const isReserved = ['/api', '/socket.io'].some((p) => urlPath === p || urlPath.startsWith(`${p}/`));
    if (hasClient && req.method === 'GET' && !isReserved) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  const io = new Server<ClientToServer, ServerToClient>(app.server);
  app.addHook('onClose', async () => {
    await io.close();
  });
  const { broadcastBoard } = attachRealtime(io, {
    ...deps,
    isConfluenceConnected: deps.isConfluenceConnected ?? (async () => false),
    onClosed: deps.onClosed ?? (() => {}),
    log: app.log,
  });

  return { app, io, realtime: { broadcastBoard } };
}
