// PS1 virtual-memory-card (VMC) backup / restore / reset. POPStarter keeps a game's
// save in POPS/<disc>.<title>/SLOT0.VMC (+SLOT1.VMC) on the SMB share. A known
// POPStarter-over-SMB bug leaves a *valid* card unmountable ("no memory card") after
// an interrupted save; the fix is to delete the VMCs so POPStarter regenerates fresh
// ones, then restore the save. The save data itself is almost always intact — we just
// keep backups and offer an easy reset/restore.
import * as fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const SLOTS = ['SLOT0.VMC', 'SLOT1.VMC'] as const;
const KEEP = 5; // newest N backups kept per slot

// POPStarter names a game's folder after its VCD (sans extension) — same as fixes.ts.
const gameFolder = (stagedPath: string): string => path.join(DATA_DIR, stagedPath.replace(/\.vcd$/i, ''));
// Backups live outside the share, one dir per game per slot.
const backupDir = (stagedPath: string, slot: string): string =>
  path.join(DATA_DIR, 'vmc-backups', path.basename(gameFolder(stagedPath)), slot.replace(/\.vmc$/i, ''));

// A formatted PS1 card starts with ASCII "MC".
export function isFormatted(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x43;
}

// Block 0 is 8192 bytes of 128-byte frames; frames 1..15 are directory entries. A dir
// frame whose first byte is 0x51/0x52/0x53 marks that save block in use (0xA0 = free).
// So the card "has a save" if any of frames 1..15 is in use.
export function vmcHasSave(buf: Buffer): boolean {
  for (let i = 1; i <= 15; i++) {
    const b = buf[i * 128];
    if (b === 0x51 || b === 0x52 || b === 0x53) return true;
  }
  return false;
}

const sha10 = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex').slice(0, 10);
// Newest-last list of a slot's backup files (names start with a ms timestamp, so lexical == chronological).
async function listBackups(stagedPath: string, slot: string): Promise<string[]> {
  return (await fsp.readdir(backupDir(stagedPath, slot)).catch(() => [] as string[])).filter((f) => f.endsWith('.VMC')).sort();
}

// Back up a game's SLOT0/SLOT1 VMCs, but only when formatted and holding a save. Skips
// when a backup with the same content-hash already exists, then rotates to keep KEEP.
// Returns how many new backups were written. Never throws.
export async function backupGameVmc(stagedPath: string): Promise<number> {
  let written = 0;
  for (const slot of SLOTS) {
    try {
      const buf = await fsp.readFile(path.join(gameFolder(stagedPath), slot)).catch(() => null);
      if (!buf || !isFormatted(buf) || !vmcHasSave(buf)) continue;
      const hash = sha10(buf);
      const dir = backupDir(stagedPath, slot);
      const existing = await listBackups(stagedPath, slot);
      if (existing.some((f) => f.endsWith(`-${hash}.VMC`))) continue; // unchanged since last backup
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, `${Date.now()}-${hash}.VMC`), buf);
      written++;
      const all = (await listBackups(stagedPath, slot)).slice(); // newest-last
      for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
        await fsp.rm(path.join(dir, old), { force: true }).catch(() => {});
      }
    } catch {
      /* best-effort per slot */
    }
  }
  return written;
}

// Back up every PS1 game's VMCs. Never throws — logs and moves on. The db is imported
// lazily so this module (and its self-check) stays free of the sqlite-open side effect.
export async function backupAllVmcs(): Promise<number> {
  let total = 0;
  try {
    const { eq } = await import('drizzle-orm');
    const { db } = await import('../db/index.js');
    const { games } = await import('../db/schema.js');
    const rows = db.select().from(games).where(eq(games.console, 'ps1')).all();
    for (const g of rows) total += await backupGameVmc(g.stagedPath);
  } catch (err) {
    console.error('backupAllVmcs failed:', err instanceof Error ? err.message : err);
  }
  return total;
}

// "Fix card (no-detect)": back up first (safety), then delete the VMCs so POPStarter
// rebuilds fresh ones on next launch.
export async function resetGameVmc(stagedPath: string): Promise<void> {
  await backupGameVmc(stagedPath);
  const dir = gameFolder(stagedPath);
  // Save-safety: never delete a SLOT0 that holds a save unless a backup actually exists.
  // (backup is best-effort; if it silently failed and there's no prior copy, refuse.)
  const slot0 = await fsp.readFile(path.join(dir, 'SLOT0.VMC')).catch(() => null);
  const hasSave = !!slot0 && isFormatted(slot0) && vmcHasSave(slot0);
  if (hasSave && (await listBackups(stagedPath, 'SLOT0.VMC')).length === 0) {
    throw new Error('refusing to reset: the card has a save but no backup could be made — try again');
  }
  for (const slot of SLOTS) await fsp.rm(path.join(dir, slot), { force: true }).catch(() => {});
}

// Copy the newest SLOT0 backup back into the game folder, or null if there's none.
// 0777 the folder + 0666 the file so POPStarter (samba guest = nobody) can mount/write it.
export async function restoreGameVmc(stagedPath: string): Promise<string | null> {
  const backups = await listBackups(stagedPath, 'SLOT0.VMC');
  if (!backups.length) return null;
  const newest = backups[backups.length - 1];
  const dir = gameFolder(stagedPath);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.chmod(dir, 0o777).catch(() => {});
  const dst = path.join(dir, 'SLOT0.VMC');
  await fsp.copyFile(path.join(backupDir(stagedPath, 'SLOT0.VMC'), newest), dst);
  await fsp.chmod(dst, 0o666).catch(() => {});
  return newest;
}

// State for the Tweaks modal's "Memory card" section.
export async function vmcStatus(stagedPath: string): Promise<{ hasSave: boolean; backups: number; lastBackup: number | null }> {
  const buf = await fsp.readFile(path.join(gameFolder(stagedPath), 'SLOT0.VMC')).catch(() => null);
  const backups = await listBackups(stagedPath, 'SLOT0.VMC');
  const newest = backups[backups.length - 1];
  const ms = newest ? Number(newest.split('-')[0]) : NaN;
  return {
    hasSave: !!buf && isFormatted(buf) && vmcHasSave(buf),
    backups: backups.length,
    lastBackup: Number.isFinite(ms) ? ms : null,
  };
}

// Self-check: `tsx vmc.ts`. Pure format logic only — no filesystem.
if (import.meta.url === `file://${process.argv[1]}`) {
  const good = Buffer.alloc(131072);
  good[0] = 0x4d; // 'M'
  good[1] = 0x43; // 'C'
  good[128] = 0x51; // frame 1 in use
  assert.equal(isFormatted(good), true);
  assert.equal(vmcHasSave(good), true);
  const zero = Buffer.alloc(131072);
  assert.equal(isFormatted(zero), false);
  assert.equal(vmcHasSave(zero), false);
  console.log('vmc self-check ok');
}
