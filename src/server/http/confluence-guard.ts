import type { FastifyReply } from 'fastify';
import { ConfluenceError, type ClientCtx } from '../confluence/confluence-client';
import { getAccessToken, RECONNECT_MSG } from '../confluence/connection-store';
import { DomainError } from '../errors';
import type { AppDeps } from './app';

/** Runs a Confluence call; an expired connection or a 4xx from Atlassian becomes a 403 with a message. */
export async function withConfluence<T>(
  deps: AppDeps,
  reply: FastifyReply,
  fn: (c: ClientCtx) => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await fn({ fetch: deps.fetch, ...(await getAccessToken(deps)) });
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.code === 'forbidden') return reply.code(403).send({ error: 'forbidden', message: err.message });
      return reply.code(409).send({ error: 'not_connected' });
    }
    if (err instanceof ConfluenceError && err.status >= 400 && err.status < 500) {
      const message = err.status === 401 ? RECONNECT_MSG : `Confluence request failed (${err.status})`;
      return reply.code(403).send({ error: 'forbidden', message });
    }
    throw err;
  }
}
