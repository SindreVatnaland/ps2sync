// Absolute paths derived from DATA_DIR. The DVD/ CD/ POPS/ dirs are what the
// sibling Samba container shares so the PS2 (OPL/POPStarter) can pull games.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const DATA_DIR = config.DATA_DIR;

export const dvdDir = path.join(DATA_DIR, 'DVD'); // PS2 DVD images
export const cdDir = path.join(DATA_DIR, 'CD'); // PS2 CD images
export const popsDir = path.join(DATA_DIR, 'POPS'); // PS1 .VCD files (POPStarter)
export const incomingDir = path.join(DATA_DIR, 'incoming'); // scratch, one subdir per job
export const dbDir = path.join(DATA_DIR, 'db'); // sqlite lives here

// mkdir -p every base directory. Idempotent; call once on boot.
export function ensureDirs(): void {
  for (const d of [dvdDir, cdDir, popsDir, incomingDir, dbDir]) {
    mkdirSync(d, { recursive: true });
  }
}

export function incomingJobDir(id: string): string {
  return path.join(incomingDir, id);
}
