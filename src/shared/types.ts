export type ErrorCode = 'not_found' | 'forbidden' | 'board_closed' | 'vote_limit_reached' | 'invalid_input' | 'rate_limited' | 'internal';
export type Ack = { ok: true } | { ok: false; error: ErrorCode; message: string };
/** endsAt = epoch ms */
export type TimerState = { status: 'idle' | 'running' | 'paused'; durationMs: number; endsAt: number | null; remainingMs: number };
export type TimerAction = { type: 'start'; durationMs: number } | { type: 'pause' } | { type: 'resume' } | { type: 'reset' } | { type: 'addMinute' };
export type NoteView = { id: string; columnIndex: number; text: string; authorPublicId: string; authorName: string; isPublic: boolean; isMine: boolean; votes: number; myVotes: number; createdAt: string; sharedAt: string | null };
export type ParticipantView = { publicId: string; name: string; online: boolean; isMe: boolean };
export type ActionItemView = { id: string; text: string; owner: string; noteId: string | null; canEdit: boolean; createdAt: string };
export type ExportStatus = 'not_connected' | 'idle' | 'pending' | 'success' | 'conflict' | 'failed';
export type ExportView = { status: ExportStatus; pageUrl: string | null; error: string | null; spaceId: string | null; spaceName: string | null; parentId: string | null; parentTitle: string | null };
export type BoardSnapshot = {
  id: string;
  name: string;
  status: 'open' | 'closed';
  columns: string[];
  voteLimit: number;
  votesRemaining: number;
  notes: NoteView[];
  participants: ParticipantView[];
  actionItems: ActionItemView[];
  timer: TimerState;
  isAdmin: boolean;
  /** admin only */
  export: ExportView | null;
  serverNow: number;
};
export type JoinAuth = { boardId: string; participantId: string; name: string; adminToken?: string };
export interface ClientToServer {
  'note:add'(p: { columnIndex: number; text: string }, ack: (a: Ack) => void): void;
  'note:edit'(p: { noteId: string; text: string }, ack: (a: Ack) => void): void;
  'note:delete'(p: { noteId: string }, ack: (a: Ack) => void): void;
  'note:share'(p: { noteId: string }, ack: (a: Ack) => void): void;
  'vote:add'(p: { noteId: string }, ack: (a: Ack) => void): void;
  'vote:remove'(p: { noteId: string }, ack: (a: Ack) => void): void;
  'action:add'(p: { text: string; owner: string; noteId: string | null }, ack: (a: Ack) => void): void;
  'action:edit'(p: { id: string; text: string; owner: string }, ack: (a: Ack) => void): void;
  'action:delete'(p: { id: string }, ack: (a: Ack) => void): void;
  'participant:rename'(p: { name: string }, ack: (a: Ack) => void): void;
  'admin:renameColumn'(p: { columnIndex: number; name: string }, ack: (a: Ack) => void): void;
  'admin:setVoteLimit'(p: { limit: number }, ack: (a: Ack) => void): void;
  'admin:timer'(p: TimerAction, ack: (a: Ack) => void): void;
  'admin:close'(p: {}, ack: (a: Ack) => void): void;
  'admin:reopen'(p: {}, ack: (a: Ack) => void): void;
  'admin:delete'(p: {}, ack: (a: Ack) => void): void;
}
export interface ServerToClient {
  'board:state'(s: BoardSnapshot): void;
  'board:deleted'(): void;
}
