// Absolute paths derived from DATA_DIR. The DVD/ CD/ POPS/ dirs are what the
// sibling Samba container shares so the PS2 (OPL/POPStarter) can pull games.
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const DATA_DIR = config.DATA_DIR;

export const dvdDir = path.join(DATA_DIR, 'DVD'); // PS2 DVD images
export const cdDir = path.join(DATA_DIR, 'CD'); // PS2 CD images
export const popsDir = path.join(DATA_DIR, 'POPS'); // PS1 .VCD files (POPStarter)
export const artDir = path.join(DATA_DIR, 'ART'); // OPL box art: <BOOT_ID>_COV.png
export const appsDir = path.join(DATA_DIR, 'APPS'); // homebrew ELFs (OPL, wLaunchELF)
export const incomingDir = path.join(DATA_DIR, 'incoming'); // scratch, one subdir per job
export const dbDir = path.join(DATA_DIR, 'db'); // sqlite lives here

// mkdir -p every base directory. Idempotent; call once on boot.
export function ensureDirs(): void {
  for (const d of [dvdDir, cdDir, popsDir, artDir, appsDir, incomingDir, dbDir]) {
    mkdirSync(d, { recursive: true });
  }
  // POPStarter (running over SMB as the samba guest = nobody) must be able to CREATE
  // its VMC (virtual PS1 memory card) in POPS/ or PS1 saves fail with "no memory card".
  // The share is otherwise guest-read-only, so make POPS/ world-writable.
  // ponytail: 0777 on POPS only. Ceiling: any LAN client can write there — fine for a
  // trusted homelab behind Tailscale. Upgrade path: samba `force user` if that changes.
  try {
    chmodSync(popsDir, 0o777);
  } catch {
    /* best-effort — non-fatal if the fs rejects it */
  }
}

export function incomingJobDir(id: string): string {
  return path.join(incomingDir, id);
}
