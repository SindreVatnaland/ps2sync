// Opens the SQLite db, enables WAL, and runs idempotent DDL at import time so
// no build-time migration step is needed. Exports the drizzle `db` and raw `sqlite`.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.js';
import * as schema from './schema.js';

const dbDir = path.join(config.DATA_DIR, 'db');
mkdirSync(dbDir, { recursive: true });

export const sqlite = new Database(path.join(dbDir, 'ps2-sync.sqlite'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// ponytail: raw CREATE TABLE IF NOT EXISTS instead of drizzle-kit migrations.
// Ceiling: any column change to schema.ts must be mirrored here by hand.
// Upgrade path: `drizzle-kit generate` + a migrate() call once the schema churns.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  serial      TEXT NOT NULL,
  console     TEXT NOT NULL,
  title       TEXT NOT NULL,
  media       TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  staged_path TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(serial, console)
);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  source      TEXT,
  state       TEXT NOT NULL,
  game_id     TEXT,
  progress    REAL,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- App-level settings (key/value).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export const db = drizzle(sqlite, { schema });
