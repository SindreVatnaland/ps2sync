// Read-only-ish file browser over DATA_DIR for the web UI: list a directory and
// resolve upload/download targets. Every path from the client passes through
// resolveSafe(), which pins it under DATA_DIR — this is a trust boundary, so the
// containment check must never be relaxed.
import * as fsp from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const base = path.resolve(DATA_DIR);

// Resolve a client-supplied relative path to an absolute path guaranteed to sit
// inside DATA_DIR. `..`, absolute paths and leading slashes can't escape. Throws otherwise.
export function resolveSafe(rel: string): string {
  const clean = path.normalize('/' + (rel || '')).replace(/^\/+/, ''); // normalize kills `..`; strip leading /
  const target = path.resolve(base, clean);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('path outside data directory');
  }
  return target;
}

export interface DirEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}

// List a directory under DATA_DIR (dirs first, then files, name-sorted). Hides
// dotfiles (the sqlite WAL, .versions.json, etc.).
export async function listDir(rel: string): Promise<{ path: string; entries: DirEntry[] }> {
  const abs = resolveSafe(rel);
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    let size = 0;
    let mtime = 0;
    try {
      const st = await fsp.stat(path.join(abs, d.name));
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      /* unreadable entry — list it with zeros */
    }
    entries.push({ name: d.name, dir: d.isDirectory(), size, mtime });
  }
  entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
  return { path: path.relative(base, abs), entries };
}

// Self-check: `tsx src/lib/files.ts` — the containment guard must hold.
if (import.meta.url === `file://${process.argv[1]}`) {
  assert.equal(resolveSafe(''), base);
  assert.equal(resolveSafe('DVD'), path.join(base, 'DVD'));
  assert.equal(resolveSafe('/DVD/'), path.join(base, 'DVD'));
  assert.equal(resolveSafe('DVD/../CD'), path.join(base, 'CD'));
  for (const evil of ['..', '../../etc/passwd', '/etc/passwd', 'DVD/../../..', 'a/../../b']) {
    let escaped = false;
    try {
      const r = resolveSafe(evil);
      escaped = r !== base && !r.startsWith(base + path.sep);
    } catch {
      escaped = false; // threw = contained
    }
    assert.equal(escaped, false, `resolveSafe leaked for ${evil}`);
  }
  console.log('files resolveSafe self-check ok');
}
