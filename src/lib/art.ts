// Best-effort OPL box art. When a game is placed, drop a front cover in
// ART/<BOOT_ID>_COV.png — Open PS2 Loader shows it for the game on the console
// (PS1/POPStarter art works the same way, keyed by the boot id). Covers come from
// libretro's thumbnail CDN. Its filenames carry region/language/version tags and
// use "_" for "&" (e.g. "Ratchet _ Clank (Europe) (En,Fr,De,Es,It) (v1.00)"), which
// we can't guess — so we fetch the system's boxart index once and match our title
// against the real names. The whole thing is optional and never throws.
import { writeFile, readFile, readdir, mkdir, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { artDir } from './paths.js';
import type { Console } from '../types.js';

const TIMEOUT_MS = 12_000;

const exists = (p: string): Promise<boolean> => access(p).then(() => true).catch(() => false);

// OPL's minimal PNG decoder shows a generic cover for libretro's full-size art:
// it ships ~512px PNGs carrying ICC/gamma profile chunks OPL can't parse. Re-encode
// each cover through GraphicsMagick — `-strip` drops the profiles, `-resize` shrinks
// to an OPL-friendly width. Falls back to the original buffer if gm is missing or
// fails, so a cover is never lost to a resize error.
const COVER_WIDTH = 256;
function resizeCover(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve) => {
    const gm = spawn('gm', ['convert', 'png:-', '-strip', '-resize', `${COVER_WIDTH}x`, 'png:-']);
    const out: Buffer[] = [];
    gm.stdout.on('data', (d: Buffer) => out.push(d));
    gm.on('error', () => resolve(buf)); // gm not installed -> keep original
    gm.on('close', (code) => resolve(code === 0 && out.length ? Buffer.concat(out) : buf));
    gm.stdin.on('error', () => {}); // ignore EPIPE if gm dies before we finish writing
    gm.stdin.end(buf);
  });
}

// Re-process every cover already in ART/ through resizeCover (strip + shrink) — for
// fixing full-size covers written before resizing existed. Returns how many changed.
export async function resizeExistingCovers(): Promise<number> {
  let n = 0;
  for (const f of await readdir(artDir).catch(() => [] as string[])) {
    if (!f.endsWith('_COV.png')) continue;
    const p = path.join(artDir, f);
    try {
      const buf = await readFile(p);
      const small = await resizeCover(buf);
      if (small.length !== buf.length) {
        await writeFile(p, small);
        n++;
      }
    } catch {
      /* skip unreadable */
    }
  }
  return n;
}

// Disc serial (SLUS-20102) -> OPL boot id (SLUS_201.02) — how OPL names its art
// files. Standard ids are 4 letters + 5 digits split 3.2; anything else falls back
// to a dash->underscore swap.
export function oplId(serial: string): string {
  const m = serial.toUpperCase().match(/^([A-Z]{4})-?(\d{5})$/);
  return m ? `${m[1]}_${m[2].slice(0, 3)}.${m[2].slice(3)}` : serial.toUpperCase().replace(/-/g, '_');
}

// Region tag (as libretro writes it) from the serial prefix.
function regionOf(serial: string): string {
  const pre = serial.split('-')[0].toUpperCase();
  if (/^(SLES|SCES|SLED|SCED|SLEH)/.test(pre)) return 'Europe';
  if (/^(SLPS|SLPM|SCPS|SCAJ|SLKA|SCKA|PCPX|SLAJ)/.test(pre)) return 'Japan';
  return 'USA';
}

const sysName = (console: Console): string => (console === 'ps1' ? 'Sony - PlayStation' : 'Sony - PlayStation 2');
const repoName = (console: Console): string => (console === 'ps1' ? 'Sony_-_PlayStation' : 'Sony_-_PlayStation_2');

// Cached list of Named_Boxarts filenames (sans .png) per system — the index we match against.
const indexCache = new Map<Console, { at: number; names: string[] }>();
const INDEX_TTL = 24 * 60 * 60 * 1000;

async function boxartIndex(console: Console): Promise<string[]> {
  const hit = indexCache.get(console);
  if (hit && Date.now() - hit.at < INDEX_TTL) return hit.names;
  const url = `https://api.github.com/repos/libretro-thumbnails/${repoName(console)}/git/trees/master?recursive=1`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'ps2sync', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`libretro index ${res.status}`);
  const data = (await res.json()) as { tree: { path: string }[] };
  const names = data.tree
    .map((t) => t.path)
    .filter((p) => p.startsWith('Named_Boxarts/') && p.endsWith('.png'))
    .map((p) => p.slice('Named_Boxarts/'.length, -4));
  indexCache.set(console, { at: Date.now(), names });
  return names;
}

// Normalise a title/filename for matching: drop (region)/(lang)/(version) groups,
// treat & and _ as spaces, keep only alphanumerics.
export function normTitle(s: string): string {
  return s
    .replace(/\([^)]*\)/g, '')
    .replace(/[&_]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// The exact libretro boxart filename (sans .png) for (title, serial), or null.
async function findBoxart(title: string, serial: string, console: Console): Promise<string | null> {
  let names: string[];
  try {
    names = await boxartIndex(console);
  } catch {
    return null;
  }
  const want = normTitle(title);
  if (!want) return null;
  let matches = names.filter((n) => normTitle(n) === want);
  if (!matches.length) {
    // No exact hit — regional titles often add/drop a subtitle (US "Going Commando"
    // vs EU "Locked and Loaded" vs libretro's bare "Ratchet _ Clank 2"). Fall back to
    // a libretro base title our longer title starts with, taking the most specific
    // (longest) one so "…2" wins over "…" for "Ratchet & Clank 2 - …".
    const based = names.filter((n) => {
      const nn = normTitle(n);
      return nn.length >= 6 && want.startsWith(nn + ' ');
    });
    if (based.length) {
      const maxLen = Math.max(...based.map((n) => normTitle(n).length));
      matches = based.filter((n) => normTitle(n).length === maxLen);
    }
  }
  if (!matches.length) return null;
  const rl = regionOf(serial).toLowerCase();
  // prefer our region, then USA, then whatever came first
  return matches.find((n) => n.toLowerCase().includes(`(${rl}`)) ?? matches.find((n) => n.toLowerCase().includes('(usa')) ?? matches[0];
}

// Fetch a cover for (serial, title) and write ART/<BOOT_ID>_COV.png. Skips if present.
// Never throws — call it fire-and-forget from placement.
export async function ensureCoverArt(serial: string, title: string, console: Console): Promise<void> {
  try {
    const dest = path.join(artDir, `${oplId(serial)}_COV.png`);
    if (await exists(dest)) return; // already have art
    const name = await findBoxart(title, serial, console);
    if (!name) return; // no matching cover in the index
    const url = `https://thumbnails.libretro.com/${encodeURIComponent(sysName(console))}/Named_Boxarts/${encodeURIComponent(name)}.png`;
    const res = await fetch(url, { headers: { 'user-agent': 'ps2sync' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(artDir, { recursive: true });
    await writeFile(dest, await resizeCover(buf));
  } catch {
    /* art is optional */
  }
}

// Remove a game's cover when it's deleted so ART/ doesn't accumulate orphans.
export async function removeCoverArt(serial: string): Promise<void> {
  await rm(path.join(artDir, `${oplId(serial)}_COV.png`), { force: true }).catch(() => {});
}

// Self-check: `node art.js` (or tsx). Pure logic only — no network.
if (import.meta.url === `file://${process.argv[1]}`) {
  assert.equal(oplId('SLUS-20102'), 'SLUS_201.02');
  assert.equal(oplId('SCES-50916'), 'SCES_509.16');
  assert.equal(oplId('slus-20102'), 'SLUS_201.02');
  assert.equal(regionOf('SCES-50916'), 'Europe');
  assert.equal(regionOf('SLUS-20224'), 'USA');
  assert.equal(regionOf('SLPS-12345'), 'Japan');
  // Our titles and libretro's tagged filenames must normalise to the same thing.
  assert.equal(normTitle('Ratchet & Clank'), 'ratchet clank');
  assert.equal(normTitle('Ratchet _ Clank (Europe) (En,Fr,De,Es,It) (v1.00)'), 'ratchet clank');
  assert.equal(normTitle('Pac-Man World 2'), normTitle('Pac-Man World 2 (USA) (v1.00)'));
  assert.equal(normTitle('Crash Bandicoot 3 - Warped'), normTitle('Crash Bandicoot 3 - Warped (Europe) (En,Fr,De,Es,It)'));
  console.log('art self-check ok');
}
