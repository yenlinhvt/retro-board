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
import { registerBoardRoutes } from './board-routes';

export type AppDeps = { config: Config; db: Db; now: () => number; fetch: typeof fetch };

export async function buildApp(
  deps: AppDeps,
): Promise<{ app: FastifyInstance; io: Server<ClientToServer, ServerToClient> }> {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.cookie', 'req.query.admin', 'req.headers["x-admin-token"]'],
    },
  });

  await app.register(fastifyCookie, { secret: deps.config.sessionSecret });
  await app.register(fastifyRateLimit, { global: false });

  registerBoardRoutes(app, deps);

  const clientDir = path.resolve(process.cwd(), 'dist/client');
  const hasClient = fs.existsSync(clientDir);
  if (hasClient) {
    await app.register(fastifyStatic, { root: clientDir });
  }

  app.setNotFoundHandler((req, reply) => {
    const isReserved = req.url.startsWith('/api') || req.url.startsWith('/socket.io');
    if (hasClient && req.method === 'GET' && !isReserved) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  const io = new Server<ClientToServer, ServerToClient>(app.server);
  app.addHook('onClose', async () => {
    await io.close();
  });

  return { app, io };
}
