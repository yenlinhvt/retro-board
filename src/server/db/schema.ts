import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { DEFAULT_VOTE_LIMIT } from '../../shared/constants';
import { IDLE_TIMER } from '../../shared/timer';
import type { TimerState } from '../../shared/types';

export const boards = pgTable('boards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  adminTokenHash: text('admin_token_hash').notNull(),
  status: text('status').$type<'open' | 'closed'>().notNull().default('open'),
  columns: jsonb('columns').$type<string[]>().notNull(),
  voteLimit: integer('vote_limit').notNull().default(DEFAULT_VOTE_LIMIT),
  timer: jsonb('timer').$type<TimerState>().notNull().default(IDLE_TIMER),
  confluenceSpaceId: text('confluence_space_id'),
  confluenceSpaceName: text('confluence_space_name'),
  confluenceParentId: text('confluence_parent_id'),
  confluenceParentTitle: text('confluence_parent_title'),
  confluencePageId: text('confluence_page_id'),
  confluencePageVersion: integer('confluence_page_version'),
  confluencePageUrl: text('confluence_page_url'),
  exportStatus: text('export_status').notNull().default('idle'),
  exportError: text('export_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const participants = pgTable(
  'participants',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    publicId: text('public_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [unique('participants_board_client_unique').on(t.boardId, t.clientId)],
);

export const notes = pgTable(
  'notes',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
    columnIndex: integer('column_index').notNull(),
    text: text('text').notNull(),
    isPublic: boolean('is_public').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    sharedAt: timestamp('shared_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index('notes_board_idx').on(t.boardId)],
);

export const votes = pgTable(
  'votes',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
    noteId: text('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
    participantId: text('participant_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index('votes_board_participant_idx').on(t.boardId, t.participantId)],
);

export const actionItems = pgTable('action_items', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  owner: text('owner').notNull().default(''),
  noteId: text('note_id').references(() => notes.id, { onDelete: 'set null' }),
  createdBy: text('created_by').notNull().references(() => participants.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const atlassianConnection = pgTable('atlassian_connection', {
  id: integer('id').primaryKey(),
  cloudId: text('cloud_id'),
  siteUrl: text('site_url'),
  siteName: text('site_name'),
  accessTokenEnc: text('access_token_enc').notNull(),
  refreshTokenEnc: text('refresh_token_enc').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  defaultSpaceId: text('default_space_id'),
  defaultSpaceName: text('default_space_name'),
  defaultParentId: text('default_parent_id'),
  defaultParentTitle: text('default_parent_title'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export type Board = typeof boards.$inferSelect;
export type Participant = typeof participants.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Vote = typeof votes.$inferSelect;
export type ActionItem = typeof actionItems.$inferSelect;
