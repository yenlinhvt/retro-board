import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { Ack, BoardSnapshot, ClientToServer } from '../../shared/types';

export type BoardStatus = 'connecting' | 'connected' | 'reconnecting' | 'not_found' | 'deleted';
export type BoardAuth = { participantId: string; name: string; adminToken?: string };

/** Minimal socket surface the hook needs; lets tests inject a fake. */
export interface BoardSocket {
  on(event: string, handler: (...args: any[]) => void): unknown;
  emit(event: string, ...args: any[]): unknown;
  disconnect(): unknown;
  connect(): unknown;
}

export type SocketFactory = (boardId: string, auth: BoardAuth) => BoardSocket;

export const defaultSocketFactory: SocketFactory = (boardId, auth) =>
  io({ auth: { boardId, ...auth }, transports: ['websocket', 'polling'] });

export const EMIT_TIMEOUT_MS = 10_000;

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
  const name = auth?.name;
  const adminToken = auth?.adminToken;
  const hasAuth = auth !== null;

  useEffect(() => {
    if (!hasAuth) return;
    setState(null);
    setStatus('connecting');
    let ended = false;
    const socket = socketFactory(boardId, { participantId: participantId!, name: name!, adminToken });
    socketRef.current = socket;

    socket.on('board:state', (s: BoardSnapshot) => {
      if (ended) return;
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
      } else {
        setStatus((prev) => (prev === 'connecting' ? prev : 'reconnecting'));
      }
    });

    return () => {
      ended = true;
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [boardId, hasAuth, participantId, name, adminToken, socketFactory]);

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
