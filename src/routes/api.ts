// JSON API. Feeds the polling UI and handles per-game/job actions.
import type { FastifyInstance } from 'fastify';
import { asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { games, jobs as jobsTable } from '../db/schema.js';
import * as gamedb from '../lib/gamedb.js';
import { deleteGame } from '../lib/place.js';
import { storageSummary } from '../lib/storage.js';
import type { Console } from '../types.js';

interface SearchResult {
  serial: string;
  title: string;
  console: Console;
  inLibrary: boolean;
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Healthcheck — must stay auth-exempt (see server.ts).
  app.get('/health', async () => ({ ok: true }));

  // Recent + active jobs, newest activity first (polled every 2s by app.js).
  // Left-join the game (once identified/placed) to surface console + serial.
  app.get('/api/jobs', async () => {
    return db
      .select({
        id: jobsTable.id,
        kind: jobsTable.kind,
        source: jobsTable.source,
        state: jobsTable.state,
        progress: jobsTable.progress,
        error: jobsTable.error,
        updatedAt: jobsTable.updatedAt,
        console: games.console,
        serial: games.serial,
        title: games.title,
      })
      .from(jobsTable)
      .leftJoin(games, eq(jobsTable.gameId, games.id))
      .orderBy(desc(jobsTable.updatedAt))
      .limit(100)
      .all();
  });

  // Full library.
  app.get('/api/games', async () => {
    return db.select().from(games).orderBy(asc(games.console), asc(games.title)).all();
  });

  // Metadata search: the PS2 serial catalogue (PCSX2 GameIndex) plus the local
  // library. Reference only — no download links. ensureDb() fetches the catalogue
  // on first use.
  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (q.length < 2) return [] as SearchResult[];
    await gamedb.ensureDb();
    const lc = q.toLowerCase();

    // Local library first, flagged so the UI can badge "in library".
    const local: SearchResult[] = db
      .select()
      .from(games)
      .all()
      .filter((g) => g.title.toLowerCase().includes(lc) || g.serial.toLowerCase().includes(lc))
      .map((g) => ({ serial: g.serial, title: g.title, console: g.console, inLibrary: true }));

    const seen = new Set(local.map((r) => `${r.console}:${r.serial}`));
    const catalogue: SearchResult[] = gamedb
      .searchGames(q)
      .map((h): SearchResult => ({ serial: h.serial, title: h.title, console: h.console ?? 'ps2', inLibrary: false }))
      .filter((r) => !seen.has(`${r.console}:${r.serial}`));

    return [...local, ...catalogue].slice(0, 60);
  });

  // Shared /data disk usage (polled by the UI).
  app.get('/api/storage', async () => storageSummary());

  // Delete an organised game: remove its file from DVD/CD/POPS and drop the row.
  app.post<{ Params: { id: string } }>('/api/games/:id/delete', async (req, reply) => {
    const game = db.select().from(games).where(eq(games.id, req.params.id)).get();
    if (!game) return reply.code(404).send({ error: 'game not found' });
    await deleteGame(game);
    return { ok: true };
  });
}
