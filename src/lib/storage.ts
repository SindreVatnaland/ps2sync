// Storage accounting for the disk-usage display. Only one side here: the shared
// /data disk the PS2 pulls from over SMB (no push target like wii-sync had).
import { statfs } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { games } from '../db/schema.js';
import { DATA_DIR } from './paths.js';

interface SumRow {
  bytes: number;
  count: number;
}
function sumAll(): SumRow {
  const r = db
    .select({
      bytes: sql<number>`coalesce(sum(${games.sizeBytes}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(games)
    .get();
  return { bytes: r?.bytes ?? 0, count: r?.count ?? 0 };
}

// Total bytes of games organised on disk.
export function stagedBytes(): number {
  return sumAll().bytes;
}

// Free/total bytes of the filesystem holding /data (the shared drive).
export async function diskUsage(): Promise<{ totalBytes: number; freeBytes: number } | null> {
  try {
    const s = await statfs(DATA_DIR);
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

// Usage for the UI. `pi` is the single shared disk (name kept for parity with
// wii-sync's UI shape).
export async function storageSummary(): Promise<{
  pi: { stagedBytes: number; stagedGames: number; totalBytes: number | null; freeBytes: number | null };
}> {
  const staged = sumAll();
  const disk = await diskUsage();
  return {
    pi: {
      stagedBytes: staged.bytes,
      stagedGames: staged.count,
      totalBytes: disk?.totalBytes ?? null,
      freeBytes: disk?.freeBytes ?? null,
    },
  };
}
