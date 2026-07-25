// Drizzle sqlite-core schema. Column names match the SQL exactly.
// Raw DDL that actually creates these tables lives in db/index.ts.
import { sqliteTable, text, integer, real, unique } from 'drizzle-orm/sqlite-core';
import type { Console, Media, JobKind, JobState } from '../types.js';

export const games = sqliteTable(
  'games',
  {
    id: text('id').primaryKey(), // uuid
    serial: text('serial').notNull(), // disc serial, e.g. SLUS-20946
    console: text('console').$type<Console>().notNull(), // 'ps1' | 'ps2'
    title: text('title').notNull(),
    media: text('media').$type<Media>().notNull(), // 'dvd' | 'cd' | 'pops'
    sizeBytes: integer('size_bytes').notNull(),
    stagedPath: text('staged_path').notNull(), // relative to DATA_DIR, e.g. "DVD/Game [SLUS-20946].iso"
    createdAt: integer('created_at').notNull(),
  },
  (t) => [unique().on(t.serial, t.console)],
);

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(), // uuid
  kind: text('kind').$type<JobKind>().notNull(), // 'upload' | 'url'
  source: text('source'), // original filename or URL
  state: text('state').$type<JobState>().notNull(),
  gameId: text('game_id'), // FK to games.id once identified
  progress: real('progress'), // 0..1, nullable
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
