// Serial -> title enrichment + a metadata search. PS1/PS2 have no clean GameTDB,
// so we lean on the PCSX2 GameIndex.yaml, which maps disc serials to names. It's a
// PS2 emulator index, so every hit is treated as 'ps2'. Best-effort: network/parse
// failures are non-fatal (identify has header fallbacks; the route also searches the
// local library).
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { config } from '../config.js';
import type { Console } from '../types.js';

// PCSX2's serial->name database. A plain YAML file we scan by hand.
const GAMEINDEX_URL = 'https://raw.githubusercontent.com/PCSX2/pcsx2/master/bin/resources/GameIndex.yaml';
const YAML_PATH = path.join(config.DATA_DIR, 'pcsx2-gameindex.yaml');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const DOWNLOAD_TIMEOUT_MS = 120_000;

// ponytail: naive line-scan of the YAML; swap for a parser if titles come out wrong.
let text: string | null | undefined; // undefined = not loaded, null = unavailable

// Parsed views, built lazily from `text` and reset on refresh.
let serialMap: Map<string, string> | undefined; // undefined = not parsed yet
let index: GameHit[] | undefined; // search index, parallel to serialMap

let inFlight: Promise<void> | null = null;

export interface GameHit {
  serial: string;
  title: string;
  console?: Console; // always 'ps2' here (PCSX2 index); optional per the route's shape
}

// Download GameIndex.yaml if missing or older than 7 days. Idempotent and cheap when
// fresh (a single stat). Concurrent callers share one download. Never throws.
export function ensureDb(): Promise<void> {
  if (!inFlight) {
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function refresh(): Promise<void> {
  try {
    const st = await stat(YAML_PATH).catch(() => null);
    if (st && Date.now() - st.mtimeMs < MAX_AGE_MS) return; // still fresh

    await mkdir(config.DATA_DIR, { recursive: true });
    const res = await fetch(GAMEINDEX_URL, {
      headers: { 'user-agent': 'ps2sync' },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer()); // a few MB; fine to buffer
    // temp file in DATA_DIR so the rename is same-filesystem + atomic (no partial reads).
    const tmp = path.join(config.DATA_DIR, `.gameindex-tmp-${process.pid}`);
    await writeFile(tmp, body);
    await rename(tmp, YAML_PATH);
    text = undefined; // force reload of the fresh file
    serialMap = undefined; // and rebuild the parsed views from it
    index = undefined;
  } catch (err) {
    console.warn(`gamedb: GameIndex refresh failed, external lookup disabled (${(err as Error).message})`);
  }
}

function loadText(): string | null {
  if (text === undefined) {
    try {
      text = readFileSync(YAML_PATH, 'utf8');
    } catch {
      text = null; // not downloaded yet / unreadable
    }
  }
  return text;
}

// Line-scan the YAML into serialMap + index. A top-level "SERIAL:" line (no leading
// whitespace) opens a block; the first indented "name: Title" inside it is the title.
function parse(): void {
  serialMap = new Map();
  index = [];
  const data = loadText();
  if (!data) return;
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
          serialMap.set(serial, title);
          index.push({ serial, title, console: 'ps2' });
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
// GameIndex.yaml is present (call ensureDb() first). Capped at `limit` results.
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
  text = `# PCSX2 GameIndex
SLUS-20946:
  name: "Grand Theft Auto - San Andreas"
  region: "NTSC-U"
SLES-50916:
  name: Metal Gear Solid 2 - Sons of Liberty
not-a-serial:
  name: ignored
`;
  serialMap = undefined;
  index = undefined;
  assert.equal(lookup('SLUS-20946'), 'Grand Theft Auto - San Andreas');
  assert.equal(lookup('slus-20946'), 'Grand Theft Auto - San Andreas'); // case-insensitive
  assert.equal(lookup('SLES-50916'), 'Metal Gear Solid 2 - Sons of Liberty'); // unquoted
  assert.equal(lookup('NOPE-00000'), undefined);
  assert.equal(searchGames('san andreas').length, 1);
  assert.equal(searchGames('SLES').length, 1);
  assert.equal(searchGames('metal gear')[0]?.console, 'ps2');
  assert.equal(searchGames('nothinghere').length, 0);
  console.log('gamedb self-check ok');
}
