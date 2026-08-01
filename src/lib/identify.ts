// Image identification: read the disc's SYSTEM.CNF to get console + serial, then
// enrich the title via gamedb (falling back to the filename). Only a handful of
// 2 KB sectors are read — never the whole multi-GB image.
//
// SYSTEM.CNF lives in the ISO9660 root of the data track and holds a line like:
//   BOOT2 = cdrom0:\SLUS_201.02;1   (BOOT2 => PS2)
//   BOOT  = cdrom0:\SLUS_000.05;1   (BOOT  => PS1)
// The serial (SLUS_201.02) is normalised to SLUS-20102.
import { open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Console, Media, IdentifyResult } from '../types.js';

// Thrown when the image file itself can't be opened (bad path / broken .cue pair).
// Content problems (not ISO9660, no SYSTEM.CNF) don't throw — they fall back to
// override/filename heuristics and log a warning.
export class IdentifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentifyError';
  }
}

// Caller-supplied hints. Either field wins over what we sniff from the disc.
export interface IdentifyOverride {
  console?: Console;
  media?: Media;
}

// PS2 media heuristic: real CD-vs-DVD is hard to read, so bucket by image size.
// ~900 MB is above the CD ceiling (~870 MB) and well below a DVD5. Rough on purpose.
const CD_MAX_BYTES = 900 * 1024 * 1024;

/**
 * Identify a PS1/PS2 image at `filePath` (`ext` is its extension, with or without
 * a leading dot). `override` can pin the console and/or media. Never loads the
 * whole file; only reads directory + SYSTEM.CNF sectors.
 */
export async function identify(
  filePath: string,
  ext: string,
  override: IdentifyOverride = {},
): Promise<IdentifyResult> {
  const e = ext.toLowerCase().replace(/^\./, '');
  const isCue = e === 'cue';
  // .bin/.img/.mdf PS1 dumps are raw 2352-sector images too; treat them as raw so
  // detectRawLayout runs and the unknown-content fallback defaults them to PS1.
  const isRaw = isCue || e === 'bin' || e === 'img' || e === 'mdf';
  const stem = path.basename(filePath).replace(/\.[^./\\]*$/, ''); // filename sans extension

  // A .cue is text — the actual sectors live in the .bin it references.
  const imagePath = isCue ? ((await binFromCue(filePath)) ?? filePath) : filePath;

  let fh: FileHandle;
  try {
    fh = await open(imagePath, 'r');
  } catch (err) {
    throw new IdentifyError(`cannot open image ${imagePath}: ${(err as Error).message}`);
  }

  let parsed: Boot | null = null;
  let imageSize = 0;
  try {
    imageSize = (await fh.stat()).size;
    const layout = isRaw ? await detectRawLayout(fh) : { raw: 2048, offset: 0 };
    parsed = await parseSystemCnf(makeReader(fh, layout));
  } catch (err) {
    console.warn(
      `identify: SYSTEM.CNF read failed for ${imagePath} (${(err as Error).message}); using heuristics`,
    );
  } finally {
    await fh.close();
  }

  if (!parsed) {
    console.warn(`identify: no SYSTEM.CNF serial for ${filePath}; falling back to filename/override`);
  }

  const console_: Console = override.console ?? parsed?.console ?? (isRaw ? 'ps1' : 'ps2');
  // ponytail: when the disc is unreadable, use the filename stem as a pseudo-serial
  // so (serial, console) still dedups per source. Real serials always win above.
  const serial = parsed?.serial ?? stem.toUpperCase();
  const media: Media =
    override.media ?? (console_ === 'ps1' ? 'pops' : imageSize <= CD_MAX_BYTES ? 'cd' : 'dvd');
  const title = (await gamedbTitle(serial)) ?? stem; // sanitised later, at place time

  return { console: console_, serial, title, media };
}

// ---------------------------------------------------------------------------
// SYSTEM.CNF parsing
// ---------------------------------------------------------------------------

interface Boot {
  console: Console;
  serial: string;
}

// Pull the BOOT2 (PS2) / BOOT (PS1) line and normalise its serial.
function parseBootLine(text: string): Boot | null {
  let boot2: string | undefined;
  let boot1: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(BOOT2|BOOT)\s*=\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    if (m[1].toUpperCase() === 'BOOT2') boot2 = m[2];
    else boot1 = m[2];
  }
  const raw = boot2 ?? boot1;
  if (!raw) return null;
  const serial = normalizeSerial(raw);
  if (!serial) return null;
  return { console: boot2 ? 'ps2' : 'ps1', serial };
}

// "cdrom0:\SLUS_201.02;1" -> "SLUS-20102"
function normalizeSerial(bootValue: string): string {
  let s = bootValue.trim();
  const cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'), s.lastIndexOf(':'));
  if (cut !== -1) s = s.slice(cut + 1); // drop the cdrom0:\ prefix
  const semi = s.indexOf(';');
  if (semi !== -1) s = s.slice(0, semi); // drop the ;1 version
  return s.trim().toUpperCase().replace(/_/g, '-').replace(/\./g, '');
}

// ---------------------------------------------------------------------------
// Minimal ISO9660 walker (enough to find one file in the root directory)
// ---------------------------------------------------------------------------

interface SectorReader {
  // Return the 2048-byte logical data of ISO9660 sector `lba` (short at EOF).
  read(lba: number): Promise<Buffer>;
}

interface RawLayout {
  raw: number; // bytes per physical sector (2048 cooked, 2352 raw)
  offset: number; // offset of the 2048-byte user data within a physical sector
}

function makeReader(fh: FileHandle, layout: RawLayout): SectorReader {
  return {
    async read(lba: number): Promise<Buffer> {
      const buf = Buffer.alloc(2048);
      const { bytesRead } = await fh.read(buf, 0, 2048, lba * layout.raw + layout.offset);
      return bytesRead < 2048 ? buf.subarray(0, bytesRead) : buf;
    },
  };
}

// Sniff whether a raw image is Mode 1 (data @16) or Mode 2 (data @24) from the
// 12-byte CD sync + mode byte. ponytail: no sync => assume raw Mode 2 (per spec
// note that .bin/.cue user data sits at offset 24).
async function detectRawLayout(fh: FileHandle): Promise<RawLayout> {
  const head = Buffer.alloc(16);
  await fh.read(head, 0, 16, 0);
  const sync = Buffer.from([0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0]);
  if (head.subarray(0, 12).equals(sync)) {
    return { raw: 2352, offset: head[15] === 1 ? 16 : 24 };
  }
  return { raw: 2352, offset: 24 };
}

async function parseSystemCnf(reader: SectorReader): Promise<Boot | null> {
  // Volume Descriptor Set starts at sector 16; scan for the Primary VD (type 1).
  let pvd: Buffer | null = null;
  for (let s = 16; s < 32; s++) {
    const sec = await reader.read(s);
    if (sec.length < 190 || sec.toString('latin1', 1, 6) !== 'CD001') break; // not ISO9660 / past set
    if (sec[0] === 255) break; // terminator
    if (sec[0] === 1) {
      pvd = sec;
      break;
    }
  }
  if (!pvd) return null;

  // Root directory record lives at PVD offset 156; extent LBA @+2, size @+10 (LE).
  const rootLba = pvd.readUInt32LE(158);
  const rootSize = pvd.readUInt32LE(166);
  const cnf = (await readDir(reader, rootLba, rootSize)).find(
    (r) => !r.isDir && r.name.toUpperCase() === 'SYSTEM.CNF',
  );
  if (!cnf) return null;

  const data = await readFileData(reader, cnf.lba, cnf.size);
  return parseBootLine(data.toString('latin1'));
}

interface DirEntry {
  name: string;
  lba: number;
  size: number;
  isDir: boolean;
}

// Walk the directory records in the extent at `lba` (spanning `dataLen` bytes).
async function readDir(reader: SectorReader, lba: number, dataLen: number): Promise<DirEntry[]> {
  const out: DirEntry[] = [];
  const sectors = Math.max(1, Math.ceil(dataLen / 2048));
  for (let s = 0; s < sectors; s++) {
    const sec = await reader.read(lba + s);
    let off = 0;
    while (off + 33 <= sec.length) {
      const len = sec[off];
      if (len === 0) break; // rest of the sector is padding
      if (off + len > sec.length) break;
      const idLen = sec[off + 32];
      if (off + 33 + idLen > sec.length) break;
      let name = sec.toString('latin1', off + 33, off + 33 + idLen);
      const semi = name.indexOf(';');
      if (semi !== -1) name = name.slice(0, semi); // strip ;1 version
      out.push({
        name,
        lba: sec.readUInt32LE(off + 2),
        size: sec.readUInt32LE(off + 10),
        isDir: (sec[off + 25] & 0x02) !== 0,
      });
      off += len;
    }
  }
  return out;
}

// Read a file's extent (`size` bytes starting at `lba`) as one Buffer.
async function readFileData(reader: SectorReader, lba: number, size: number): Promise<Buffer> {
  const sectors = Math.max(1, Math.ceil(size / 2048));
  const chunks: Buffer[] = [];
  for (let s = 0; s < sectors; s++) chunks.push(await reader.read(lba + s));
  return Buffer.concat(chunks).subarray(0, size);
}

// ---------------------------------------------------------------------------
// Raw (.bin, 2352-byte sectors) -> cooked 2048-byte ISO
// ---------------------------------------------------------------------------

// A .bin/.cue rip stores 2352-byte physical sectors; a bootable PS2 .iso needs the
// bare 2048-byte user data of each. If `src` is such a raw image, write the cooked
// ISO to `out` and return true. If it's already a 2048-byte ISO (or unrecognised),
// leave `out` untouched and return false — the caller keeps the original. Uses the
// same layout detection identify already relies on, so a disc it could read it can cook.
export async function cookRawImage(src: string, out: string): Promise<boolean> {
  const fh = await open(src, 'r');
  try {
    // Already cooked? ISO9660 puts "CD001" at sector 16 => byte 16*2048+1.
    const probe = Buffer.alloc(5);
    await fh.read(probe, 0, 5, 16 * 2048 + 1);
    if (probe.toString('latin1') === 'CD001') return false;

    const layout = await detectRawLayout(fh);
    // Only cook if the raw layout actually lands on the ISO9660 magic; otherwise we
    // don't understand the image and must not mangle it.
    const check = Buffer.alloc(5);
    await fh.read(check, 0, 5, 16 * layout.raw + layout.offset + 1);
    if (check.toString('latin1') !== 'CD001') return false;

    const { size } = await fh.stat();
    const sectors = Math.floor(size / layout.raw);
    const outFh = await open(out, 'w');
    try {
      const CHUNK = 512; // sectors per read (~1.2 MB), keeps the syscall count down
      const inBuf = Buffer.alloc(CHUNK * layout.raw);
      const outBuf = Buffer.alloc(CHUNK * 2048);
      for (let done = 0; done < sectors; ) {
        const n = Math.min(CHUNK, sectors - done);
        await fh.read(inBuf, 0, n * layout.raw, done * layout.raw);
        for (let i = 0; i < n; i++) {
          const from = i * layout.raw + layout.offset;
          inBuf.copy(outBuf, i * 2048, from, from + 2048);
        }
        await outFh.write(outBuf, 0, n * 2048);
        done += n;
      }
    } finally {
      await outFh.close();
    }
    return true;
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// .cue -> .bin resolution
// ---------------------------------------------------------------------------

// First FILE reference in a .cue, resolved against the cue's directory. null on error.
async function binFromCue(cuePath: string): Promise<string | null> {
  try {
    const text = await readFile(cuePath, 'latin1');
    const m = /FILE\s+"([^"]+)"/i.exec(text) ?? /FILE\s+(\S+)/i.exec(text);
    return m ? path.join(path.dirname(cuePath), m[1]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Title enrichment (optional gamedb sibling)
// ---------------------------------------------------------------------------

// ponytail: gamedb.ts is an optional sibling module (may be added in a later
// phase). Load it dynamically so identify compiles/runs standalone; a missing
// module or serial just falls back to the filename. The `string` typing keeps
// tsc from hard-resolving a file that may not exist yet.
async function gamedbTitle(serial: string): Promise<string | undefined> {
  const spec: string = './gamedb.js';
  try {
    const mod = (await import(spec)) as { lookup?: (s: string) => string | undefined };
    return mod.lookup?.(serial);
  } catch {
    return undefined;
  }
}

// Self-check: `node identify.js` (or `tsx src/lib/identify.ts`). Synthesises a raw
// Mode 2 image and verifies cookRawImage extracts the 2048-byte user data.
if (import.meta.url === `file://${process.argv[1]}`) {
  const os = await import('node:os');
  const { writeFile, unlink } = await import('node:fs/promises');
  const RAW = 2352;
  const OFF = 24; // Mode 2 user-data offset
  const N = 20;
  const raw = Buffer.alloc(N * RAW);
  const sync = Buffer.from([0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0]);
  for (let s = 0; s < N; s++) {
    sync.copy(raw, s * RAW);
    raw[s * RAW + 15] = 2; // mode 2 => detectRawLayout picks offset 24
    raw.writeUInt32LE(s, s * RAW + OFF); // marker = sector number
    if (s === 16) raw.write('CD001', s * RAW + OFF + 1, 'latin1');
  }
  const src = path.join(os.tmpdir(), 'ps2sync-cook-src.bin');
  const dst = path.join(os.tmpdir(), 'ps2sync-cook-out.iso');
  await writeFile(src, raw);
  assert.equal(await cookRawImage(src, dst), true);
  const cooked = await readFile(dst);
  assert.equal(cooked.length, N * 2048);
  assert.equal(cooked.readUInt32LE(5 * 2048), 5); // a plain sector's user data preserved
  assert.equal(cooked.toString('latin1', 16 * 2048 + 1, 16 * 2048 + 6), 'CD001'); // magic in place
  // An already-cooked 2048 image must be left alone.
  const iso = Buffer.alloc(N * 2048);
  iso.write('CD001', 16 * 2048 + 1, 'latin1');
  await writeFile(src, iso);
  assert.equal(await cookRawImage(src, dst), false);
  await unlink(src);
  await unlink(dst);
  console.log('identify cook self-check ok');
}
