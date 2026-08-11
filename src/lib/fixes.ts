// POPStarter per-game fixes, applied over the share. Two kinds, both just drop files
// into a game's POPS/<disc>.<title>/ folder (the same folder as its VMC):
//   - CPU overclock: a generic TROJAN_2.BIN (by %), smooths PS1 stutter/slowdown.
//   - Curated game fix: hand-picked CHEATS.TXT/TROJAN/PATCH for a specific boot id
//     (e.g. FFVII's black battle-screen fix).
// The files are hugopocked's, embedded in fixes-data.ts. All PS1-only.
import * as fsp from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { OC_LEVELS, OC_BLOBS, GAME_FIX_BLOBS } from './fixes-data.js';

export { OC_LEVELS };

// POPStarter only reads these per-game files; used to validate manual fix uploads so
// users can't drop junk into a game folder. Names are matched upper-cased.
const FIX_FILE = /^(CHEATS\.TXT|PATCH_[0-9]\.BIN|TROJAN_[0-9]\.BIN|VMCDIR\.TXT|DISCS\.TXT)$/;
export function isValidFixFile(name: string): boolean {
  return FIX_FILE.test(name.toUpperCase());
}

// POPStarter names a game's folder after its VCD (sans extension).
const gameFolder = (stagedPath: string): string => path.join(DATA_DIR, stagedPath.replace(/\.vcd$/i, ''));
const blob = (b64: string): Buffer => Buffer.from(b64, 'base64');

// sha1(blob) -> level, so we can read a game's current overclock back off disk.
const levelByHash = new Map<string, number>();
for (const [lvl, b64] of Object.entries(OC_BLOBS)) {
  levelByHash.set(createHash('sha1').update(blob(b64)).digest('hex'), Number(lvl));
}

// Current overclock % for a game: 0 = off, -1 = an unrecognised TROJAN_2.BIN we didn't place.
// Sync (used from the HTML render); the files are tiny and there are only a handful of games.
export function getOverclock(stagedPath: string): number {
  const f = path.join(gameFolder(stagedPath), 'TROJAN_2.BIN');
  if (!existsSync(f)) return 0;
  try {
    return levelByHash.get(createHash('sha1').update(readFileSync(f)).digest('hex')) ?? -1;
  } catch {
    return -1;
  }
}

// Set (level in OC_LEVELS) or clear (0) a game's CPU overclock. 0777 so POPStarter (samba
// guest) keeps writing its VMC in the same folder.
export async function setOverclock(stagedPath: string, level: number): Promise<void> {
  const dir = gameFolder(stagedPath);
  const dst = path.join(dir, 'TROJAN_2.BIN');
  if (level === 0) {
    await fsp.rm(dst, { force: true }).catch(() => {});
    return;
  }
  const b64 = OC_BLOBS[level];
  if (!b64) throw new Error(`unknown overclock level: ${level}`);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.chmod(dir, 0o777).catch(() => {});
  await fsp.writeFile(dst, blob(b64));
}

// Label of the curated fix bundled for this boot id, or null if none.
export function gameFixLabel(oplId: string): string | null {
  return GAME_FIX_BLOBS[oplId]?.label ?? null;
}

// Drop the curated per-game fix files into the game's folder. Throws if none bundled.
export async function applyGameFix(stagedPath: string, oplId: string): Promise<string[]> {
  const fix = GAME_FIX_BLOBS[oplId];
  if (!fix) throw new Error(`no bundled fix for ${oplId}`);
  const dir = gameFolder(stagedPath);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.chmod(dir, 0o777).catch(() => {});
  const written: string[] = [];
  for (const [name, b64] of Object.entries(fix.files)) {
    await fsp.writeFile(path.join(dir, name), blob(b64));
    written.push(name);
  }
  return written;
}

// Self-check: `tsx fixes.ts`. Pure logic + embedded data only — no filesystem.
if (import.meta.url === `file://${process.argv[1]}`) {
  assert.equal(isValidFixFile('CHEATS.TXT'), true);
  assert.equal(isValidFixFile('cheats.txt'), true); // matched case-insensitively
  assert.equal(isValidFixFile('TROJAN_0.BIN'), true);
  assert.equal(isValidFixFile('PATCH_4.BIN'), true);
  assert.equal(isValidFixFile('README.md'), false);
  assert.equal(isValidFixFile('SLOT0.VMC'), false); // a VMC is not a manual fix file
  assert.equal(new Set(Object.values(OC_BLOBS)).size, OC_LEVELS.length); // every level a distinct blob
  assert.ok(gameFixLabel('SCUS_941.63')); // FFVII curated fix present
  assert.equal(gameFixLabel('XXXX_000.00'), null);
  console.log('fixes self-check ok');
}
