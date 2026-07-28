// Job orchestrator + state machine + boot reconcile. Drives one ingest through:
// download/receive -> extract -> identify -> dedupe -> (ps1: convert) -> place. Each
// step is a `jobs` row state transition so a crash is recoverable (reconcile() on
// boot). No job-queue library: plain async functions plus a tiny in-memory map that
// only holds live per-run scratch (the progress-throttle clock).
//
// ponytail: no concurrency cap — reconcile fires every stuck job at once, and a PS1
//   convert spawns a cue2pops process each. Fine for a homelab with a handful of
//   games. Upgrade path: a small p-limit-style semaphore around runPipeline.
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { jobs, type Job, type NewJob, type Game } from '../db/schema.js';
import type { Console, Media, JobState } from '../types.js';
import { incomingDir, incomingJobDir } from './paths.js';
import { downloadUrl, extractArchive } from './ingest.js';
import { identify } from './identify.js';
import { ensureCue, convertPs1 } from './convert.js';
import { checkDuplicate, placePs1, placePs2 } from './place.js';

// Whole-job progress bands: the bar spans the WHOLE job, not per-stage.
// download 0–0.30 · identify 0.35 · convert 0.40–0.90 (ps1 only) · place 0.95 · done 1.
const P_DOWNLOAD_END = 0.3;
const P_IDENTIFY = 0.35;
const P_CONVERT_START = 0.4;
const P_CONVERT_END = 0.9;
const P_PLACING = 0.95;

// Non-terminal states are re-queueable on boot; duplicate/ready/failed are terminal.
const NON_TERMINAL: JobState[] = ['pending', 'downloading', 'identifying', 'converting', 'placing'];

// Caller hints that override what we sniff from the disc (identify's overrides).
export interface JobOverrides {
  console?: Console;
  media?: Media;
}

// Live per-run scratch. Only holds the progress-throttle clock; everything durable
// lives in the `jobs` row so a restart can reconstruct from disk + DB alone.
const runState = new Map<string, { lastProgressWrite: number }>();

// --------------------------------------------------------------------------
// row helpers
// --------------------------------------------------------------------------

function getJob(id: string): Job | null {
  return db.select().from(jobs).where(eq(jobs.id, id)).get() ?? null;
}

function setState(id: string, state: JobState, extra: Partial<NewJob> = {}): void {
  db.update(jobs).set({ state, updatedAt: Date.now(), ...extra }).where(eq(jobs.id, id)).run();
}

// Throttle jobs.progress writes to at most ~1/second.
function makeProgressWriter(id: string): (fraction: number | null) => void {
  return (fraction) => {
    const st = runState.get(id);
    if (!st) return; // run already finished; ignore any late callback
    const now = Date.now();
    if (now - st.lastProgressWrite < 1000) return;
    st.lastProgressWrite = now;
    db.update(jobs).set({ progress: fraction, updatedAt: now }).where(eq(jobs.id, id)).run();
  };
}

// --------------------------------------------------------------------------
// public: create jobs
// --------------------------------------------------------------------------

// Insert a pending upload job. The routes layer streams the file into
// incomingJobDir(job.id) and then calls runJob(job.id).
export function createUploadJob(originalFilename: string): Job {
  const now = Date.now();
  const rows = db
    .insert(jobs)
    .values({ id: randomUUID(), kind: 'upload', source: originalFilename, state: 'pending', createdAt: now, updatedAt: now })
    .returning()
    .all();
  return rows[0];
}

// Insert a pending URL job and kick off the pipeline in the background (do NOT
// await this from the request handler — the download can take minutes).
export function createUrlJob(url: string, opts: JobOverrides = {}): Job {
  const now = Date.now();
  const rows = db
    .insert(jobs)
    .values({ id: randomUUID(), kind: 'url', source: url, state: 'pending', createdAt: now, updatedAt: now })
    .returning()
    .all();
  const job = rows[0];
  void runJob(job.id, opts);
  return job;
}

// --------------------------------------------------------------------------
// public: run / reconcile
// --------------------------------------------------------------------------

// Drive the full pipeline for a job. Never rejects — failure is recorded on the
// job row as state 'failed'. `opts` pins the console/media identify guessed.
export function runJob(id: string, opts: JobOverrides = {}): Promise<void> {
  return runPipeline(id, opts);
}

// Boot recovery: re-queue every non-terminal job and drop orphaned incoming dirs.
// Delete a job and its scratch dir (the uploaded file + _work). For clearing a
// finished/failed/canceled job. rm -f is idempotent, so it's safe even mid-run — the
// pipeline just errors harmlessly on the vanished dir. Staged games are separate rows.
export async function deleteJob(id: string): Promise<void> {
  await fsp.rm(incomingJobDir(id), { recursive: true, force: true });
  db.delete(jobs).where(eq(jobs.id, id)).run();
}

// Delete every terminal job (ready/failed/duplicate) + its scratch dir. Returns the
// count removed. Active jobs are left running.
export async function clearFinishedJobs(): Promise<number> {
  const terminal: JobState[] = ['ready', 'failed', 'duplicate'];
  const rows = db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.state, terminal)).all();
  for (const r of rows) await fsp.rm(incomingJobDir(r.id), { recursive: true, force: true });
  db.delete(jobs).where(inArray(jobs.state, terminal)).run();
  return rows.length;
}

export async function reconcile(): Promise<void> {
  const stuck = db.select().from(jobs).where(inArray(jobs.state, NON_TERMINAL)).all();
  const live = new Set(stuck.map((j) => j.id));

  // Sweep incoming dirs with no live job — leftovers from jobs that reached a
  // terminal state (or vanished) before the crash.
  let names: string[] = [];
  try {
    const entries = await fsp.readdir(incomingDir, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // incoming dir not created yet — nothing to sweep.
  }
  for (const name of names) {
    if (!live.has(name)) await fsp.rm(path.join(incomingDir, name), { recursive: true, force: true });
  }

  for (const job of stuck) {
    if (job.kind === 'url') {
      void runJob(job.id); // re-download from the stored URL
    } else if (await firstFileIn(incomingJobDir(job.id))) {
      void runJob(job.id); // uploaded file is still on disk
    } else {
      setState(job.id, 'failed', { error: 'ingest file missing after restart — re-add the upload' });
    }
  }
}

// --------------------------------------------------------------------------
// pipeline
// --------------------------------------------------------------------------

async function runPipeline(id: string, opts: JobOverrides): Promise<void> {
  const job = getJob(id);
  if (!job) return;
  runState.set(id, { lastProgressWrite: 0 });
  const progress = makeProgressWriter(id);
  const jobDir = incomingJobDir(id);
  const jobWork = path.join(jobDir, '_work'); // scratch: extracted images + converted .VCD

  try {
    // 1. Source: download for URL jobs, else the streamed upload file (in jobDir root).
    const source = await resolveSource(job, progress);

    // 2. Extract archives into the scratch subdir; one child job per extra game image.
    await fsp.rm(jobWork, { recursive: true, force: true }); // clear any stale scratch
    const images = selectImages(await extractArchive(source, jobWork));
    if (images.length === 0) throw new Error('archive contained no supported image files');
    const primary = images[0];
    for (const extra of images.slice(1)) await createChildJob(job, extra);

    // 3. Identify (serial from SYSTEM.CNF, title via gamedb), honouring overrides.
    setState(id, 'identifying', { progress: P_IDENTIFY, error: null });
    const info = await identify(primary, path.extname(primary), { console: opts.console, media: opts.media });

    // 4. Dedupe on (serial, console). On collision, stop at 'duplicate'.
    const dup = checkDuplicate(info.serial, info.console);
    if (dup) {
      setState(id, 'duplicate', { gameId: dup.id, progress: null, error: null });
      return;
    }

    // 5/6. PS1: convert .bin/.cue -> .VCD then place in POPS/. PS2: place the .iso in DVD/ or CD/.
    let game: Game;
    if (info.console === 'ps1') {
      setState(id, 'converting', { progress: P_CONVERT_START, error: null });
      await fsp.mkdir(jobWork, { recursive: true });
      const cuePath = await ensureCue(primary);
      const vcdPath = path.join(jobWork, 'converted.VCD');
      await convertPs1(cuePath, vcdPath, {
        onProgress: (f) => progress(P_CONVERT_START + (P_CONVERT_END - P_CONVERT_START) * f),
      });
      setState(id, 'placing', { progress: P_PLACING, error: null });
      const sizeBytes = (await fsp.stat(vcdPath)).size;
      game = await placePs1({ serial: info.serial, title: info.title, vcdPath, sizeBytes });
    } else {
      setState(id, 'placing', { progress: P_PLACING, error: null });
      // A PS2 CD dump can arrive as .bin/.cue; selectImages picks the .cue, but the
      // real image is the .bin it references — place that, not the ~85-byte cue text.
      let imageFile = primary;
      if (primary.toLowerCase().endsWith('.cue')) {
        const bin = (await cueBins(primary))[0];
        if (!bin) throw new Error('cue references no .bin file');
        imageFile = path.join(path.dirname(primary), bin);
      }
      const sizeBytes = (await fsp.stat(imageFile)).size;
      const media = info.media === 'cd' ? 'cd' : 'dvd'; // identify never returns 'pops' for ps2
      game = await placePs2({ serial: info.serial, console: 'ps2', title: info.title, media, isoPath: imageFile, sizeBytes });
    }

    setState(id, 'ready', { gameId: game.id, progress: 1, error: null });

    // 7. Success: the raw ingest + scratch are no longer needed.
    await fsp.rm(jobDir, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState(id, 'failed', { error: message.slice(0, 2000) });
    console.warn(`jobs: job ${id} failed: ${message}`);
  } finally {
    runState.delete(id);
  }
}

// Return the file to feed the pipeline: (re)download for URL jobs, or the streamed
// upload already sitting in the job's incoming dir.
async function resolveSource(job: Job, progress: (f: number | null) => void): Promise<string> {
  const dir = incomingJobDir(job.id);

  if (job.kind === 'url') {
    await fsp.rm(dir, { recursive: true, force: true }); // drop any partial + scratch from a prior attempt
    if (!job.source) throw new Error('url job has no source URL');
    setState(job.id, 'downloading', { progress: 0, error: null });
    return downloadUrl(job.source, dir, (received, total) =>
      progress(total ? P_DOWNLOAD_END * (received / total) : null),
    );
  }

  // upload: the routes layer streamed the file here before calling runJob.
  const existing = await firstFileIn(dir);
  if (!existing) throw new Error('upload ingest file is missing');
  return existing;
}

// An archive may hold a .bin/.cue pair (or a multi-track set: one .cue + many .bin).
// The .cue references its .bin sidecars, so when any .cue is present the games ARE the
// .cue files — bare .bin/.img/.mdf are sidecars, not separate jobs. With no .cue (plain
// PS2 .iso) every image file is its own game.
function selectImages(images: string[]): string[] {
  const cues = images.filter((f) => f.toLowerCase().endsWith('.cue'));
  return cues.length ? cues : images;
}

// An archive with >1 game spawns a child job per extra image. Move the image (and,
// for a .cue, the .bin sidecars it references) into its own incoming dir and run it.
async function createChildJob(parent: Job, imagePath: string): Promise<void> {
  const childId = randomUUID();
  const dir = incomingJobDir(childId);
  await fsp.mkdir(dir, { recursive: true });

  const srcDir = path.dirname(imagePath);
  const names = new Set([path.basename(imagePath)]);
  if (imagePath.toLowerCase().endsWith('.cue')) for (const b of await cueBins(imagePath)) names.add(b);
  for (const name of names) {
    const src = path.join(srcDir, name);
    if (existsSync(src)) await moveFile(src, path.join(dir, name));
  }

  const now = Date.now();
  db.insert(jobs)
    .values({
      id: childId,
      kind: 'upload', // it's a local file now
      source: `${parent.source ?? 'archive'} :: ${path.basename(imagePath)}`,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  void runJob(childId);
}

// --------------------------------------------------------------------------
// small fs helpers
// --------------------------------------------------------------------------

async function firstFileIn(dir: string): Promise<string | null> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null; // dir missing
  }
  const f = entries.find((e) => e.isFile());
  return f ? path.join(dir, f.name) : null;
}

// The FILE "..." references inside a .cue (its .bin sidecars). Best-effort; [] on error.
async function cueBins(cuePath: string): Promise<string[]> {
  try {
    const text = await fsp.readFile(cuePath, 'latin1');
    return [...text.matchAll(/FILE\s+"([^"]+)"/gi)].map((m) => m[1]);
  } catch {
    return [];
  }
}

// rename within DATA_DIR; fall back to copy+unlink if it straddles a mount.
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
}
