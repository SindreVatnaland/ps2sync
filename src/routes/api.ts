// JSON API. Feeds the polling UI and handles per-game/job actions.
import { createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { asc, desc, eq } from 'drizzle-orm';
import { DATA_DIR } from '../lib/paths.js';
import { db } from '../db/index.js';
import { games, jobs as jobsTable } from '../db/schema.js';
import * as gamedb from '../lib/gamedb.js';
import * as jobs from '../lib/jobs.js';
import { deleteGame, purgeSmallPs1, refreshCoverArt } from '../lib/place.js';
import { setOverclock, getOverclock, applyGameFix, gameFixLabel, isValidFixFile, OC_LEVELS, CHEAT_TOGGLES, getCheats, setCheat } from '../lib/fixes.js';
import { oplId } from '../lib/art.js';
import { storageSummary } from '../lib/storage.js';
import { listApps, checkApps, installApp, CATALOG } from '../lib/apps.js';
import { popsStatus, installPops, pushPopsConfig } from '../lib/pops.js';
import { getServerLanIp, setServerLanIp, isValidLanIp, getAppsAutoUpdate, setAppsAutoUpdate } from '../lib/settings.js';
import { libraryTablesHtml } from '../ui/views.js';
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

  // Upload a POPStarter per-game fix (CHEATS.TXT / PATCH_#.BIN / TROJAN_#.BIN) into the
  // game's own folder on the share, where POPStarter reads it on next launch. PS1 only.
  // Names are forced ALL-CAPS (POPStarter requires it) and the folder is 0777 so both
  // POPStarter (samba guest) and this write coexist.
  app.post<{ Params: { id: string } }>('/api/games/:id/patch', async (req, reply) => {
    const game = db.select().from(games).where(eq(games.id, req.params.id)).get();
    if (!game) return reply.code(404).send({ error: 'no such game' });
    if (game.console !== 'ps1') return reply.code(400).send({ error: 'patches are PS1-only (POPStarter)' });
    const folder = path.join(DATA_DIR, game.stagedPath.replace(/\.vcd$/i, '')); // POPStarter names it after the VCD, sans ext
    await fsp.mkdir(folder, { recursive: true });
    await fsp.chmod(folder, 0o777).catch(() => {});
    const saved: string[] = [];
    const rejected: string[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = path.basename(part.filename || '').toUpperCase();
      if (!name) {
        part.file.resume();
        continue;
      }
      if (!isValidFixFile(name)) {
        rejected.push(name); // only real POPStarter fix files allowed
        part.file.resume();
        continue;
      }
      await pipeline(part.file, createWriteStream(path.join(folder, name)));
      saved.push(name);
    }
    if (saved.length === 0) {
      return reply.code(400).send({
        error: rejected.length
          ? `Not POPStarter fix files: ${rejected.join(', ')}. Allowed: CHEATS.TXT, PATCH_#.BIN, TROJAN_#.BIN, VMCDIR.TXT, DISCS.TXT`
          : 'no file uploaded',
      });
    }
    return { game: game.title, folder: path.basename(folder), saved, rejected };
  });

  // Set/clear a PS1 game's CPU overclock (level 0 = off; otherwise a value in OC_LEVELS).
  // Writes/removes TROJAN_2.BIN in the game's folder — smooths PS1 stutter/slowdown.
  app.post<{ Params: { id: string }; Body: { level?: number } }>('/api/games/:id/overclock', async (req, reply) => {
    const game = db.select().from(games).where(eq(games.id, req.params.id)).get();
    if (!game) return reply.code(404).send({ error: 'no such game' });
    if (game.console !== 'ps1') return reply.code(400).send({ error: 'overclock is PS1-only (POPStarter)' });
    const level = Number(req.body?.level ?? 0);
    if (level !== 0 && !(OC_LEVELS as readonly number[]).includes(level)) {
      return reply.code(400).send({ error: `unknown overclock level: ${level}` });
    }
    await setOverclock(game.stagedPath, level);
    return { game: game.title, level };
  });

  // State for the per-game Tweaks modal: current overclock, whether a bundled fix
  // exists, and which fix files are currently in the game's folder.
  app.get<{ Params: { id: string } }>('/api/games/:id/fixes', async (req, reply) => {
    const game = db.select().from(games).where(eq(games.id, req.params.id)).get();
    if (!game) return reply.code(404).send({ error: 'no such game' });
    const folder = path.join(DATA_DIR, game.stagedPath.replace(/\.vcd$/i, ''));
    const files = (await fsp.readdir(folder).catch(() => [] as string[])).filter(isValidFixFile).sort();
    return {
      title: game.title,
      ps1: game.console === 'ps1',
      overclock: game.console === 'ps1' ? getOverclock(game.stagedPath) : 0,
      levels: OC_LEVELS,
      fixLabel: gameFixLabel(oplId(game.serial)),
      cheats: CHEAT_TOGGLES,
      activeCheats: game.console === 'ps1' ? getCheats(game.stagedPath) : [],
      files,
    };
  });

  // Toggle a whitelisted CHEATS.TXT command (e.g. the CDDA audio fix) on/off for a game.
  app.post<{ Params: { id: string }; Body: { command?: string; on?: boolean } }>('/api/games/:id/cheat', async (req, reply) => {
    const game = db.select().from(games).where(eq(games.id, req.params.id)).get();
    if (!game) return reply.code(404).send({ error: 'no such game' });
    if (game.console !== 'ps1') return reply.code(400).send({ error: 'cheats are PS1-only (POPStarter)' });
    const command = String(req.body?.command || '');
    const on = !!req.body?.on;
    try {
      await setCheat(game.stagedPath, command, on);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return { command, on };
  });

  // Remove one fix file from a game's folder (the modal's per-file "remove").
  app.post<{ Params: { id: string }; Body: { name?: string } }>('/api/games/:id/patch/remove', async (req, reply) => {
    const game = db.select().from(games).where(eq(games.id, req.params.id)).get();
    if (!game) return reply.code(404).send({ error: 'no such game' });
    const name = path.basename(String(req.body?.name || '')).toUpperCase();
    if (!isValidFixFile(name)) return reply.code(400).send({ error: 'not a fix file' });
    const folder = path.join(DATA_DIR, game.stagedPath.replace(/\.vcd$/i, ''));
    await fsp.rm(path.join(folder, name), { force: true }).catch(() => {});
    return { removed: name };
  });

  // Apply the curated bundled fix for a PS1 game (if one exists for its boot id).
  app.post<{ Params: { id: string } }>('/api/games/:id/fix', async (req, reply) => {
    const game = db.select().from(games).where(eq(games.id, req.params.id)).get();
    if (!game) return reply.code(404).send({ error: 'no such game' });
    if (game.console !== 'ps1') return reply.code(400).send({ error: 'fixes are PS1-only (POPStarter)' });
    const id = oplId(game.serial);
    if (!gameFixLabel(id)) return reply.code(404).send({ error: `no bundled fix for ${game.title}` });
    const saved = await applyGameFix(game.stagedPath, id);
    return { game: game.title, saved };
  });

  // Rendered library tables (HTML fragment) — the UI swaps this in when a job
  // finishes, so the library updates without a full page reload.
  app.get('/api/library', async (_req, reply) => {
    const rows = db.select().from(games).orderBy(asc(games.console), asc(games.title)).all();
    reply.type('text/html; charset=utf-8');
    return libraryTablesHtml(rows);
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

  // Server's LAN IP, shown in the guide as OPL's SMB address. Editable there.
  app.get('/api/settings', async () => ({ serverLanIp: getServerLanIp(), appsAutoUpdate: getAppsAutoUpdate() }));
  app.post<{ Body: { serverLanIp?: string } }>('/api/settings', async (req, reply) => {
    const ip = (req.body?.serverLanIp ?? '').trim();
    if (!isValidLanIp(ip)) {
      return reply.code(400).send({ error: 'Enter a valid IPv4 address, e.g. 192.168.1.10' });
    }
    setServerLanIp(ip);
    return { serverLanIp: getServerLanIp() };
  });

  // Delete an organised game: remove its file from DVD/CD/POPS and drop the row.
  app.post<{ Params: { id: string } }>('/api/games/:id/delete', async (req, reply) => {
    const game = db.select().from(games).where(eq(games.id, req.params.id)).get();
    if (!game) return reply.code(404).send({ error: 'game not found' });
    await deleteGame(game);
    return { ok: true };
  });

  // Delete a single job + its scratch files (e.g. a failed/canceled upload).
  app.post<{ Params: { id: string } }>('/api/jobs/:id/delete', async (req, reply) => {
    const job = db.select().from(jobsTable).where(eq(jobsTable.id, req.params.id)).get();
    if (!job) return reply.code(404).send({ error: 'job not found' });
    await jobs.deleteJob(job.id);
    return { ok: true };
  });

  // Clear all finished/failed/duplicate jobs at once.
  app.post('/api/jobs/clear', async () => ({ cleared: await jobs.clearFinishedJobs() }));

  // Homebrew apps: catalog + on-disk state, and "download latest into APPS/".
  app.get('/api/apps', async () => listApps());

  // Same list, enriched with the latest available version (cached GitHub lookup)
  // so the UI can flag updates. Slower than /api/apps — called on demand.
  app.get('/api/apps/check', async () => checkApps());

  app.post<{ Params: { key: string } }>('/api/apps/:key/install', async (req, reply) => {
    try {
      return await installApp(req.params.key);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Toggle "auto-install minor updates".
  app.post<{ Body: { enabled?: boolean } }>('/api/apps/auto-update', async (req) => {
    setAppsAutoUpdate(!!req.body?.enabled);
    return { appsAutoUpdate: getAppsAutoUpdate() };
  });

  // Re-fetch box art for games missing a cover (index-matched against libretro).
  app.post('/api/covers/refresh', async () => refreshCoverArt());

  // PS1/POPStarter status: which POPS core files are present + game/launcher counts.
  app.get('/api/pops', async () => popsStatus());

  // Clean up bogus tiny PS1 "games" (< 50 MB) — e.g. .bin assets from an
  // extracted-game archive that got ingested one-per-file.
  app.post('/api/pops/purge', async () => ({ removed: await purgeSmallPs1(50 * 1024 * 1024) }));

  // Push POPStarter's SMB config onto the PS2's memory card over FTP (PS2Net).
  app.post<{ Body: { ps2ip?: string } }>('/api/pops/push-config', async (req, reply) => {
    try {
      return await pushPopsConfig(req.body?.ps2ip ?? '');
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // One-click: fetch the whole POPStarter core into POPS/ and generate launchers.
  app.post('/api/pops/install', async (_req, reply) => {
    try {
      return await installPops();
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // One-click "set up everything": every catalog app + the POPStarter core.
  // Best-effort — reports what succeeded and what failed rather than aborting.
  app.post('/api/apps/install-all', async () => {
    const done: string[] = [];
    const errors: string[] = [];
    for (const a of CATALOG) {
      try {
        await installApp(a.key);
        done.push(a.name);
      } catch (err) {
        errors.push(`${a.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      const p = await installPops();
      done.push(`POPStarter core (${p.placed.length} files, ${p.launchers} launchers)`);
    } catch (err) {
      errors.push(`POPStarter core: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { done, errors };
  });
}
