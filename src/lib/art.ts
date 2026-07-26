// Best-effort OPL box art. When a game is placed, drop a front cover in
// ART/<BOOT_ID>_COV.png — Open PS2 Loader shows it for the game on the console
// (PS1/POPStarter art works the same way, keyed by the PS1 boot id). The cover comes
// from libretro's thumbnail CDN (No-Intro name, region derived from the serial). The
// whole thing is optional and never throws — art must never affect whether a game lands.
// ponytail: saves the CDN PNG as-is. OPL prefers 140x200 and scales larger art; if it
// renders slowly on the PS2, resize here (adds an image dependency).
import { writeFile, mkdir, rm, access } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { artDir } from './paths.js';
import type { Console } from '../types.js';

const TIMEOUT_MS = 12_000;

const exists = (p: string): Promise<boolean> => access(p).then(() => true).catch(() => false);

// Disc serial (SLUS-20102) -> OPL boot id (SLUS_201.02) — how OPL names its art files
// (matched against the game's internal boot id, not the disc filename). Standard ids
// are 4 letters + 5 digits split 3.2; anything else falls back to a dash->underscore
// swap. ponytail: covers the usual case; an odd serial just won't get art.
export function oplId(serial: string): string {
  const m = serial.toUpperCase().match(/^([A-Z]{4})-?(\d{5})$/);
  return m ? `${m[1]}_${m[2].slice(0, 3)}.${m[2].slice(3)}` : serial.toUpperCase().replace(/-/g, '_');
}

// Candidate libretro thumbnail URLs, tried in order. Our catalogue titles already use
// No-Intro's " - " subtitle form; region comes from the serial prefix, with the other
// regions as fallbacks (PS1 also tries a "(Disc 1)" variant for multi-disc games).
function candidates(title: string, serial: string, console: Console): string[] {
  const sys = console === 'ps1' ? 'Sony - PlayStation' : 'Sony - PlayStation 2';
  const base = `https://thumbnails.libretro.com/${encodeURIComponent(sys)}/Named_Boxarts/`;
  const pre = serial.split('-')[0].toUpperCase();
  const region = /^(SLES|SCES|SLED|SCED|SLEH)/.test(pre)
    ? 'Europe'
    : /^(SLPS|SLPM|SCPS|SCAJ|SLKA|SCKA|PCPX|SLAJ)/.test(pre)
      ? 'Japan'
      : 'USA';
  const regions = [...new Set([region, 'USA', 'Europe', 'Japan'])];
  const names: string[] = [];
  for (const r of regions) {
    names.push(`${title} (${r})`);
    if (console === 'ps1') names.push(`${title} (${r}) (Disc 1)`);
  }
  return names.slice(0, 6).map((n) => base + encodeURIComponent(n) + '.png');
}

// Fetch a cover for (serial, title) and write ART/<BOOT_ID>_COV.png. Skips if present.
// Never throws — call it fire-and-forget from placement.
export async function ensureCoverArt(serial: string, title: string, console: Console): Promise<void> {
  try {
    const dest = path.join(artDir, `${oplId(serial)}_COV.png`);
    if (await exists(dest)) return; // already have art for this game
    for (const url of candidates(title, serial, console)) {
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': 'ps2sync' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) continue; // 404 for this name/region — try the next candidate
        const buf = Buffer.from(await res.arrayBuffer());
        await mkdir(artDir, { recursive: true });
        await writeFile(dest, buf);
        return;
      } catch {
        /* network hiccup on this candidate — try the next */
      }
    }
  } catch {
    /* art is optional */
  }
}

// Remove a game's cover when it's deleted so ART/ doesn't accumulate orphans.
export async function removeCoverArt(serial: string): Promise<void> {
  await rm(path.join(artDir, `${oplId(serial)}_COV.png`), { force: true }).catch(() => {});
}

// Self-check: `node art.js`.
if (import.meta.url === `file://${process.argv[1]}`) {
  assert.equal(oplId('SLUS-20102'), 'SLUS_201.02');
  assert.equal(oplId('SCUS-94163'), 'SCUS_941.63');
  assert.equal(oplId('SLES-50916'), 'SLES_509.16');
  assert.equal(oplId('slus-20102'), 'SLUS_201.02'); // case-insensitive
  const c = candidates('Metal Gear Solid', 'SLUS-00594', 'ps1');
  assert.ok(decodeURIComponent(c[0]).includes('/Sony - PlayStation/Named_Boxarts/'));
  assert.ok(decodeURIComponent(c[0]).endsWith('Metal Gear Solid (USA).png'));
  assert.ok(c.some((u) => decodeURIComponent(u).includes('(Disc 1)'))); // ps1 disc fallback
  const c2 = candidates('God of War', 'SLES-53509', 'ps2');
  assert.ok(decodeURIComponent(c2[0]).endsWith('God of War (Europe).png')); // region from SLES
  console.log('art self-check ok');
}
