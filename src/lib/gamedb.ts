// Serial -> title enrichment + a metadata search. PS1/PS2 have no clean GameTDB,
// so we lean on two emulator serial databases, both plain YAML we scan by hand:
//   - PCSX2 GameIndex.yaml   -> PS2 disc serials -> names
//   - DuckStation gamedb.yaml -> PS1 disc serials -> names
// Same SERIAL:/name: shape, so one scanner handles both; each hit is tagged with the
// source's console. Best-effort: network/parse failures are non-fatal (identify has
// header fallbacks; the route also searches the local library).
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { config } from '../config.js';
import type { Console } from '../types.js';

interface Source {
  url: string;
  path: string;
  console: Console;
}

// Both files are keyed the same way (top-level "SERIAL:" block, indented "name:").
const SOURCES: Source[] = [
  {
    url: 'https://raw.githubusercontent.com/PCSX2/pcsx2/master/bin/resources/GameIndex.yaml',
    path: path.join(config.DATA_DIR, 'pcsx2-gameindex.yaml'),
    console: 'ps2',
  },
  {
    url: 'https://raw.githubusercontent.com/stenzek/duckstation/master/data/resources/gamedb.yaml',
    path: path.join(config.DATA_DIR, 'duckstation-gamedb.yaml'),
    console: 'ps1',
  },
];

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const DOWNLOAD_TIMEOUT_MS = 120_000;

// Parsed views, built lazily from the source files and reset when a refresh lands.
let serialMap: Map<string, string> | undefined; // serial -> title (both consoles)
let index: GameHit[] | undefined; // search index, parallel to serialMap

let inFlight: Promise<void> | null = null;

export interface GameHit {
  serial: string;
  title: string;
  console?: Console; // set from the source db; optional per the route's shape
}

// Download any missing/stale source (older than 7 days). Idempotent and cheap when
// fresh (a stat per source). Concurrent callers share one refresh. Never throws.
export function ensureDb(): Promise<void> {
  if (!inFlight) {
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function refresh(): Promise<void> {
  await mkdir(config.DATA_DIR, { recursive: true }).catch(() => {});
  let changed = false;
  for (const src of SOURCES) {
    try {
      const st = await stat(src.path).catch(() => null);
      if (st && Date.now() - st.mtimeMs < MAX_AGE_MS) continue; // still fresh

      const res = await fetch(src.url, {
        headers: { 'user-agent': 'ps2sync' },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer()); // a few MB; fine to buffer
      // temp file in DATA_DIR so the rename is same-filesystem + atomic (no partial reads).
      const tmp = path.join(config.DATA_DIR, `.gamedb-tmp-${src.console}-${process.pid}`);
      await writeFile(tmp, body);
      await rename(tmp, src.path);
      changed = true;
    } catch (err) {
      console.warn(`gamedb: ${src.console} index refresh failed (${(err as Error).message})`);
    }
  }
  if (changed) {
    serialMap = undefined; // rebuild the parsed views from the fresh files
    index = undefined;
  }
}

// (Re)build serialMap + index by scanning every source file that's present on disk.
function parse(): void {
  serialMap = new Map();
  index = [];
  for (const src of SOURCES) {
    let data: string;
    try {
      data = readFileSync(src.path, 'utf8');
    } catch {
      continue; // not downloaded yet / unreadable — skip this source
    }
    scan(data, src.console);
  }
}

// Line-scan one YAML into serialMap + index. A top-level "SERIAL:" line (no leading
// whitespace) opens a block; the first indented "name: Title" inside it is the title.
function scan(data: string, console: Console): void {
  let serial: string | null = null;
  for (const line of data.split('\n')) {
    if (line === '') continue;
    const first = line[0];
    if (first !== ' ' && first !== '\t') {
      // top-level line: a serial key opens a block, anything else closes the current one.
      const m = first === '#' ? null : line.match(/^([A-Z]{2,}-[A-Z0-9.]+):/);
      serial = m ? m[1] : null;
    } else if (serial) {
      // indented child of an open block: grab the first name, then stop scanning it.
      const m = line.match(/^\s+name:\s*(.+?)\s*$/);
      if (m) {
        const title = unquote(m[1]);
        if (title) {
          serialMap!.set(serial, title);
          index!.push({ serial, title, console });
        }
        serial = null;
      }
    }
  }
}

// Strip a single layer of surrounding YAML quotes (and unescape \" in double-quoted).
function unquote(s: string): string {
  s = s.trim();
  if (s.length >= 2 && s[0] === '"' && s.at(-1) === '"') return s.slice(1, -1).replace(/\\"/g, '"');
  if (s.length >= 2 && s[0] === "'" && s.at(-1) === "'") return s.slice(1, -1);
  return s;
}

// Return the catalogue title for a disc serial (e.g. SLUS-20946), or undefined.
export function lookup(serial: string): string | undefined {
  if (serialMap === undefined) parse();
  return serialMap!.get(serial.trim().toUpperCase());
}

// Match query against title or serial (case-insensitive substring). Returns [] until
// a source file is present (call ensureDb() first). Capped at `limit` results.
export function searchGames(query: string, limit = 60): GameHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  if (index === undefined) parse();
  const hits: GameHit[] = [];
  for (const g of index!) {
    if (g.title.toLowerCase().includes(q) || g.serial.toLowerCase().includes(q)) {
      hits.push(g);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

// Self-check: only runs when this file is executed directly (`node gamedb.js`).
if (import.meta.url === `file://${process.argv[1]}`) {
  serialMap = new Map();
  index = [];
  // PS2 source (PCSX2 shape)
  scan(
    `# PCSX2 GameIndex
SLUS-20946:
  name: "Grand Theft Auto - San Andreas"
  region: "NTSC-U"
SLES-50916:
  name: Metal Gear Solid 2 - Sons of Liberty
not-a-serial:
  name: ignored
`,
    'ps2',
  );
  // PS1 source (DuckStation shape: name first, then nested metadata/localizedName)
  scan(
    `SLUS-00594:
  name: "Metal Gear Solid"
  localizedName: ignored
  metadata:
    genre: Action
SCUS-94163:
  name: Gran Turismo
`,
    'ps1',
  );
  assert.equal(lookup('SLUS-20946'), 'Grand Theft Auto - San Andreas');
  assert.equal(lookup('slus-20946'), 'Grand Theft Auto - San Andreas'); // case-insensitive
  assert.equal(lookup('SLES-50916'), 'Metal Gear Solid 2 - Sons of Liberty'); // unquoted
  assert.equal(lookup('NOPE-00000'), undefined);
  assert.equal(searchGames('san andreas').length, 1);
  assert.equal(searchGames('SLES').length, 1);
  // PS1 games now searchable, tagged 'ps1'
  assert.equal(lookup('SLUS-00594'), 'Metal Gear Solid');
  assert.equal(searchGames('gran turismo')[0]?.console, 'ps1');
  // one query spanning both consoles returns hits from each
  const mg = searchGames('metal gear');
  assert.ok(mg.some((h) => h.console === 'ps1') && mg.some((h) => h.console === 'ps2'));
  console.log('gamedb self-check ok');
}
