// Move finished images into the OPL / POPStarter layout and record the games row.
//   PS2 .iso   -> /data/DVD or /data/CD as "<SERIAL>.<Title>.iso" (OPL naming)
//   PS1 .VCD   -> /data/POPS as "<Title>.VCD"          (POPStarter menu name)
// The sibling Samba container shares these dirs; the PS2 pulls from them over SMB.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { games, type Game } from '../db/schema.js';
import type { Console } from '../types.js';
import { sanitizeTitle } from './sanitize.js';
import { DATA_DIR, dvdDir, cdDir, popsDir } from './paths.js';
import { ensureCoverArt, removeCoverArt } from './art.js';

export interface PlacePs2Input {
  serial: string;
  console: 'ps2';
  title: string;
  media: 'dvd' | 'cd';
  isoPath: string;
  sizeBytes: number;
}

export interface PlacePs1Input {
  serial: string;
  title: string;
  vcdPath: string;
  sizeBytes: number;
}

// Existing games row for this (serial, console), or null. UNIQUE(serial, console) dedupe key.
export function checkDuplicate(serial: string, console: Console): Game | null {
  return (
    db
      .select()
      .from(games)
      .where(and(eq(games.serial, serial), eq(games.console, console)))
      .get() ?? null
  );
}

// Move src -> dest, idempotently. A prior (crashed) run may already have moved it.
async function moveFile(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) {
    if (existsSync(dest)) return; // already placed; don't double-move
    throw new Error(`place: file not found: ${src}`);
  }
  try {
    await fs.rename(src, dest); // overwrites dest on posix
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // cross-device (e.g. incoming tmpfs -> data volume): rename can't span mounts.
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}

// Place a PS2 image into DVD/ or CD/ as "<SERIAL>.<Title>.iso" and insert the row.
export async function placePs2(input: PlacePs2Input): Promise<Game> {
  const { serial, title, media, isoPath, sizeBytes } = input;
  const safeSerial = sanitizeTitle(serial) || 'UNKNOWN'; // strip any FAT-forbidden chars
  const safeTitle = sanitizeTitle(title) || safeSerial; // fall back to the serial if it empties
  const filename = `${safeSerial}.${safeTitle}.iso`; // e.g. SLUS-20102.Game Name.iso
  const destDir = media === 'cd' ? cdDir : dvdDir;
  const bucket = media === 'cd' ? 'CD' : 'DVD';

  await fs.mkdir(destDir, { recursive: true });
  await moveFile(isoPath, path.join(destDir, filename));

  const rows = db
    .insert(games)
    .values({
      id: randomUUID(),
      serial,
      console: 'ps2',
      title,
      media,
      sizeBytes,
      stagedPath: path.join(bucket, filename), // relative to DATA_DIR, e.g. "DVD/SLUS-20102.Game.iso"
      createdAt: Date.now(),
    })
    .returning()
    .all();
  void ensureCoverArt(serial, title, 'ps2'); // fire-and-forget: art must never gate placement
  return rows[0];
}

// Place a converted PS1 image into POPS/ as "<SERIAL>.<Title>.VCD" and insert the
// row. The serial prefix keeps two distinct games whose titles sanitise to the
// same string from overwriting each other (POPStarter reads the real serial from
// inside the .VCD regardless of filename).
export async function placePs1(input: PlacePs1Input): Promise<Game> {
  const { serial, title, vcdPath, sizeBytes } = input;
  const safeSerial = sanitizeTitle(serial) || 'UNKNOWN';
  const safeTitle = sanitizeTitle(title) || safeSerial;
  const filename = `${safeSerial}.${safeTitle}.VCD`;

  await fs.mkdir(popsDir, { recursive: true });
  await moveFile(vcdPath, path.join(popsDir, filename));

  const rows = db
    .insert(games)
    .values({
      id: randomUUID(),
      serial,
      console: 'ps1',
      title,
      media: 'pops',
      sizeBytes,
      stagedPath: path.join('POPS', filename), // relative to DATA_DIR
      createdAt: Date.now(),
    })
    .returning()
    .all();
  void ensureCoverArt(serial, title, 'ps1'); // fire-and-forget: art must never gate placement
  return rows[0];
}

// Remove a game's file and its row. rm -f is idempotent — safe if the file is already gone.
export async function deleteGame(game: Game): Promise<void> {
  await fs.rm(path.join(DATA_DIR, game.stagedPath), { recursive: true, force: true });
  await removeCoverArt(game.serial); // drop its ART/<BOOT_ID>_COV.png too
  db.delete(games).where(eq(games.id, game.id)).run();
}
