import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { Ack, BoardSnapshot, ClientToServer } from '../../shared/types';

export type BoardStatus = 'connecting' | 'connected' | 'reconnecting' | 'not_found' | 'deleted' | 'rejected';
export type BoardAuth = { participantId: string; name: string; adminToken?: string };

/** Minimal socket surface the hook needs; lets tests inject a fake. */
export interface BoardSocket {
  /** False once socket.io-client stopped reconnecting by itself (e.g. after the server rejected the handshake). */
  readonly active: boolean;
  on(event: string, handler: (...args: any[]) => void): unknown;
  emit(event: string, ...args: any[]): unknown;
  disconnect(): unknown;
  connect(): unknown;
}

/** getAuth returns the latest auth so reconnect handshakes carry current values (e.g. a renamed participant). */
export type SocketFactory = (boardId: string, auth: BoardAuth, getAuth: () => BoardAuth) => BoardSocket;

export const defaultSocketFactory: SocketFactory = (boardId, _auth, getAuth) =>
  io({ auth: (cb) => cb({ boardId, ...getAuth() }), transports: ['websocket', 'polling'] });

/** Emit shape shared by panels; BoardPage supplies one that also toasts failures. */
export type Emit = <E extends keyof ClientToServer>(event: E, payload: Parameters<ClientToServer[E]>[0]) => Promise<Ack>;

export const EMIT_TIMEOUT_MS = 10_000;
/** Delays before retrying a handshake the server rejected; the last one repeats. */
export const HANDSHAKE_RETRY_MS = [1_000, 2_000, 5_000, 10_000];

export function useBoard(
  boardId: string,
  auth: BoardAuth | null,
  socketFactory: SocketFactory = defaultSocketFactory,
) {
  const [state, setState] = useState<BoardSnapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [status, setStatus] = useState<BoardStatus>('connecting');
  const socketRef = useRef<BoardSocket | null>(null);

  const participantId = auth?.participantId;
  const adminToken = auth?.adminToken;
  const hasAuth = auth !== null;
  const authRef = useRef(auth);
  authRef.current = auth;

  useEffect(() => {
    if (!hasAuth) return;
    setState(null);
    setStatus('connecting');
    let ended = false;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const initial: BoardAuth = { participantId: participantId!, name: authRef.current!.name, adminToken };
    const socket = socketFactory(boardId, initial, () => authRef.current ?? initial);
    socketRef.current = socket;

    socket.on('board:state', (s: BoardSnapshot) => {
      if (ended) return;
      retries = 0;
      setState(s);
      setReceivedAt(Date.now());
      setStatus('connected');
    });
    socket.on('board:deleted', () => {
      ended = true;
      setStatus('deleted');
    });
    socket.on('disconnect', (reason?: string) => {
      if (ended) return;
      setStatus('reconnecting');
      // socket.io does not auto-reconnect after a server-initiated disconnect.
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect_error', (err: Error) => {
      if (ended) return;
      if (err.message === 'not_found') {
        ended = true;
        setStatus('not_found');
        socket.disconnect();
      } else if (err.message === 'invalid_input') {
        // Retrying the same handshake cannot succeed; the page offers a reload.
        ended = true;
        setStatus('rejected');
        socket.disconnect();
      } else {
        setStatus((prev) => (prev === 'connecting' ? prev : 'reconnecting'));
        // socket.io-client does not reconnect by itself after the server middleware rejected the handshake.
        if (!socket.active) {
          const delay = HANDSHAKE_RETRY_MS[Math.min(retries, HANDSHAKE_RETRY_MS.length - 1)]!;
          retries++;
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            if (!ended) socket.connect();
          }, delay);
        }
      }
    });

    return () => {
      ended = true;
      clearTimeout(retryTimer);
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [boardId, hasAuth, participantId, adminToken, socketFactory]);

  const emit = useCallback(
    <E extends keyof ClientToServer>(event: E, payload: Parameters<ClientToServer[E]>[0]): Promise<Ack> =>
      new Promise<Ack>((resolve) => {
        const socket = socketRef.current;
        if (!socket) {
          resolve({ ok: false, error: 'internal', message: 'Not connected' });
          return;
        }
        const timer = setTimeout(
          () => resolve({ ok: false, error: 'internal', message: 'Request timed out' }),
          EMIT_TIMEOUT_MS,
        );
        socket.emit(event, payload, (ack: Ack) => {
          clearTimeout(timer);
          resolve(ack);
        });
      }),
    [],
  );

  return { state, receivedAt, status, emit };
}
