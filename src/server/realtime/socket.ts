import type { Server } from 'socket.io';
import { z } from 'zod';
import type { Ack, BoardSnapshot, ClientToServer, ServerToClient } from '../../shared/types';
import { addActionItem, deleteActionItem, editActionItem } from '../actions/action-item-service';
import {
  assertOpen,
  closeBoard,
  deleteBoard,
  getBoard,
  renameColumn,
  reopenBoard,
  setVoteLimit,
  verifyAdmin,
} from '../boards/board-service';
import { renameParticipant, upsertParticipant } from '../boards/participant-service';
import { DomainError } from '../errors';
import type { AppDeps } from '../http/app';
import { addNote, deleteNote, editNote, shareNote } from '../notes/note-service';
import { applyTimer } from '../timer/timer-service';
import { addVote, removeVote } from '../votes/vote-service';
import { createPresence } from './presence';
import { createRateLimiter } from './rate-limit';
import { buildSnapshot } from './snapshot';

export type RealtimeLogger = { error(obj: object, msg: string): void };

export type RealtimeDeps = AppDeps & {
  isConfluenceConnected: () => Promise<boolean>;
  onClosed: (boardId: string) => void;
  log: RealtimeLogger;
};

export type Realtime = { broadcastBoard(boardId: string): Promise<void> };

type SocketData = { boardId: string; participantId: string; publicId: string; isAdmin: boolean };
type IO = Server<ClientToServer, ServerToClient>;

const MAX_PARTICIPANT_ID = 100;

const str = z.string();
const noPayload = z.unknown();
const payloads = {
  'note:add': z.object({ columnIndex: z.number(), text: str }),
  'note:edit': z.object({ noteId: str, text: str }),
  'note:delete': z.object({ noteId: str }),
  'note:share': z.object({ noteId: str }),
  'vote:add': z.object({ noteId: str }),
  'vote:remove': z.object({ noteId: str }),
  'action:add': z.object({ text: str, owner: str, noteId: str.nullable() }),
  'action:edit': z.object({ id: str, text: str, owner: str }),
  'action:delete': z.object({ id: str }),
  'participant:rename': z.object({ name: str }),
  'admin:renameColumn': z.object({ columnIndex: z.number(), name: str }),
  'admin:setVoteLimit': z.object({ limit: z.number() }),
  'admin:timer': z.discriminatedUnion('type', [
    z.object({ type: z.literal('start'), durationMs: z.number() }),
    z.object({ type: z.literal('pause') }),
    z.object({ type: z.literal('resume') }),
    z.object({ type: z.literal('reset') }),
    z.object({ type: z.literal('addMinute') }),
  ]),
  'admin:close': noPayload,
  'admin:reopen': noPayload,
  'admin:delete': noPayload,
} satisfies Record<keyof ClientToServer, z.ZodType>;

type EventName = keyof typeof payloads;
type Payload<E extends EventName> = z.infer<(typeof payloads)[E]>;

const room = (boardId: string): string => `board:${boardId}`;
const fail = (error: Exclude<Ack, { ok: true }>['error'], message: string): Ack => ({ ok: false, error, message });

export function attachRealtime(io: IO, deps: RealtimeDeps): Realtime {
  const { db } = deps;
  const presence = createPresence();
  const chains = new Map<string, Promise<void>>();

  async function broadcastNow(boardId: string): Promise<void> {
    const sockets = await io.in(room(boardId)).fetchSockets();
    if (sockets.length === 0) return;
    const opts = {
      onlinePublicIds: presence.online(boardId),
      confluenceConnected: await deps.isConfluenceConnected(),
      now: deps.now(),
    };
    const cache = new Map<string, Promise<BoardSnapshot>>();
    await Promise.all(
      sockets.map(async (s) => {
        const { participantId, isAdmin } = s.data as SocketData;
        const key = `${participantId}:${isAdmin}`;
        let snapshot = cache.get(key);
        if (!snapshot) {
          snapshot = buildSnapshot(db, boardId, { participantId, isAdmin }, opts);
          cache.set(key, snapshot);
        }
        s.emit('board:state', await snapshot);
      }),
    );
  }

  /** Broadcasts run one at a time per board so clients never receive an older state after a newer one. */
  function broadcastBoard(boardId: string): Promise<void> {
    const next = (chains.get(boardId) ?? Promise.resolve())
      .then(() => broadcastNow(boardId))
      .catch((err: unknown) => {
        if (err instanceof DomainError && err.code === 'not_found') return; // board deleted mid-broadcast
        deps.log.error({ err, boardId }, 'board broadcast failed');
      });
    chains.set(boardId, next);
    void next.then(() => {
      if (chains.get(boardId) === next) chains.delete(boardId);
    });
    return next;
  }

  io.use(async (socket, next) => {
    const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
    const { boardId, participantId, name, adminToken } = auth;
    if (
      typeof boardId !== 'string' ||
      typeof participantId !== 'string' ||
      participantId.length === 0 ||
      participantId.length > MAX_PARTICIPANT_ID ||
      typeof name !== 'string'
    ) {
      return next(new Error('invalid_input'));
    }
    try {
      const board = await getBoard(db, boardId);
      const participant = await upsertParticipant(db, boardId, participantId, name);
      const data: SocketData = {
        boardId,
        participantId: participant.id,
        publicId: participant.publicId,
        isAdmin: verifyAdmin(board, typeof adminToken === 'string' ? adminToken : undefined),
      };
      socket.data = data;
      next();
    } catch (err) {
      if (err instanceof DomainError) return next(new Error(err.code));
      deps.log.error({ err }, 'socket handshake failed');
      next(new Error('internal'));
    }
  });

  io.on('connection', (socket) => {
    const data = socket.data as SocketData;
    const { boardId, participantId, publicId } = data;
    const actor = { participantId, isAdmin: data.isAdmin };
    const limiter = createRateLimiter({ capacity: 30, refillPerSec: 3, now: deps.now });
    // Handlers validate payloads at runtime, so register them on an untyped view of the socket.
    const raw = socket as unknown as { on(event: string, listener: (payload: unknown, ack: unknown) => void): void };

    function handle<E extends EventName>(
      event: E,
      opts: { admin?: boolean; broadcast?: boolean; after?: () => void | Promise<void> },
      run: (p: Payload<E>) => Promise<unknown>,
    ): void {
      raw.on(event, async (payload: unknown, ack: unknown) => {
        if (typeof payload === 'function' && ack === undefined) {
          ack = payload;
          payload = undefined;
        }
        const reply = (a: Ack): void => {
          if (typeof ack === 'function') ack(a);
        };
        if (!limiter.take()) return reply(fail('rate_limited', 'Too many requests, slow down'));
        if (opts.admin && !data.isAdmin) return reply(fail('forbidden', 'Admin only'));
        const parsed = payloads[event].safeParse(payload);
        if (!parsed.success) return reply(fail('invalid_input', `Invalid payload for ${event}`));
        try {
          await run(parsed.data as Payload<E>);
        } catch (err) {
          if (err instanceof DomainError) return reply(fail(err.code, err.message));
          deps.log.error({ err, event, boardId }, 'socket handler failed');
          return reply(fail('internal', 'Something went wrong'));
        }
        reply({ ok: true });
        if (opts.broadcast !== false) await broadcastBoard(boardId);
        try {
          await opts.after?.();
        } catch (err) {
          deps.log.error({ err, event, boardId }, 'socket post-action hook failed');
        }
      });
    }

    handle('note:add', {}, (p) => addNote(db, boardId, participantId, p.columnIndex, p.text));
    handle('note:edit', {}, (p) => editNote(db, boardId, participantId, p.noteId, p.text));
    handle('note:delete', {}, (p) => deleteNote(db, boardId, actor, p.noteId));
    handle('note:share', {}, (p) => shareNote(db, boardId, participantId, p.noteId));
    handle('vote:add', {}, (p) => addVote(db, boardId, participantId, p.noteId));
    handle('vote:remove', {}, (p) => removeVote(db, boardId, participantId, p.noteId));
    handle('action:add', {}, (p) => addActionItem(db, boardId, participantId, p));
    handle('action:edit', {}, (p) => editActionItem(db, boardId, actor, p.id, p));
    handle('action:delete', {}, (p) => deleteActionItem(db, boardId, actor, p.id));
    handle('participant:rename', {}, async (p) => {
      assertOpen(await getBoard(db, boardId));
      await renameParticipant(db, participantId, p.name);
    });
    handle('admin:renameColumn', { admin: true }, (p) => renameColumn(db, boardId, p.columnIndex, p.name));
    handle('admin:setVoteLimit', { admin: true }, (p) => setVoteLimit(db, boardId, p.limit));
    handle('admin:timer', { admin: true }, (p) => applyTimer(db, boardId, p, deps.now()));
    handle('admin:close', { admin: true, after: () => deps.onClosed(boardId) }, () =>
      closeBoard(db, boardId, new Date(deps.now())),
    );
    handle('admin:reopen', { admin: true }, () => reopenBoard(db, boardId));
    handle(
      'admin:delete',
      { admin: true, broadcast: false, after: () => io.in(room(boardId)).disconnectSockets(true) },
      async () => {
        io.to(room(boardId)).emit('board:deleted');
        await deleteBoard(db, boardId);
      },
    );

    socket.on('disconnect', () => {
      presence.leave(boardId, publicId);
      void broadcastBoard(boardId);
    });

    void socket.join(room(boardId));
    presence.join(boardId, publicId);
    void broadcastBoard(boardId);
  });

  return { broadcastBoard };
}
