// Ingest helpers: stream a URL to disk, extract archives, hash files.
// The multipart upload handler lives in the routes layer; this module only owns
// the URL download, archive extraction, and the extension/hash helpers routes need.
import { createReadStream, createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileP = promisify(execFile);

// Accepted image formats (PS1 .bin/.cue/.img/.mdf, PS2 .iso) and archive containers.
const IMAGE_EXTENSIONS = ['.iso', '.bin', '.cue', '.img', '.mdf'];
const ARCHIVE_EXTENSIONS = ['.zip', '.7z', '.rar'];

/** True if `name` ends in an accepted image OR archive extension. Used by routes
 *  to reject junk before creating an upload/URL job. */
export function acceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return [...IMAGE_EXTENSIONS, ...ARCHIVE_EXTENSIONS].some((ext) => lower.endsWith(ext));
}

function isImageExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isArchive(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// ---------------------------------------------------------------------------
// SSRF guard: reject private/loopback/link-local/CGNAT(tailnet) addresses.
// ponytail: hand-rolled range checks + IPv6 parser. Ceiling: no CIDR library
// (ip-cidr/netmask). Upgrade path: swap isPrivateIp's body if ranges grow.
// ---------------------------------------------------------------------------

function isPrivateIpv4(ip: string): boolean {
  const p = ip.split('.').map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT / tailnet
  return false;
}

// Expand an IPv6 literal to 16 bytes; null if unparseable.
function ipv6ToBytes(ip: string): number[] | null {
  ip = ip.split('%')[0]; // drop any zone id
  let v4: number[] | null = null;
  if (ip.includes('.')) {
    const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip); // embedded IPv4 tail
    if (!m) return null;
    v4 = m[1].split('.').map(Number);
    if (v4.some((n) => n < 0 || n > 255)) return null;
    ip = ip.slice(0, m.index) + '0:0'; // stand-in hextets, overwritten below
  }
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : null;
  let groups: string[];
  if (tail === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  if (v4) bytes.splice(12, 4, ...v4);
  return bytes;
}

/** True if `ip` (a resolved literal) is in a range we must not connect to. */
export function isPrivateIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isPrivateIpv4(ip);
  if (fam === 6) {
    const b = ipv6ToBytes(ip);
    if (!b) return true; // unparseable -> treat as unsafe
    if (b.every((x) => x === 0)) return true; // :: unspecified
    if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
    if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
      return isPrivateIpv4(b.slice(12).join('.')); // IPv4-mapped ::ffff:a.b.c.d
    }
    if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local (incl. tailnet fd7a::)
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
    return false;
  }
  return true; // not an IP literal -> be safe
}

// Custom DNS lookup that fails any connection resolving to a private address,
// unless explicitly allowed. Applied to every request (initial + each redirect),
// closing the TOCTOU gap because the connection uses exactly what we validate.
function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, '', 0);
    if (config.ALLOW_PRIVATE_URL_HOSTS) return callback(null, address as string | LookupAddress[], family);
    const list = Array.isArray(address) ? address : [{ address: address as string }];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (bad) return callback(permanentErr(`refusing to connect: ${hostname} resolves to private address ${bad.address}`), '', 0);
    return callback(null, address as string | LookupAddress[], family);
  });
}

// ---------------------------------------------------------------------------
// URL download
// ---------------------------------------------------------------------------

type ProgressFn = (received: number, total: number | null) => void;

const USER_AGENT = 'ps2sync';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Errors marked permanent are not retried (bad scheme, private host, too large, HTTP 4xx/5xx).
function permanentErr(msg: string): NodeJS.ErrnoException {
  const e = new Error(msg) as NodeJS.ErrnoException & { permanent?: boolean };
  e.permanent = true;
  return e;
}
function isPermanent(err: unknown): boolean {
  return !!(err && typeof err === 'object' && (err as { permanent?: boolean }).permanent);
}
function backoff(retry: number): number {
  return Math.min(1000 * 2 ** (retry - 1), 8000); // 1s, 2s, 4s
}

function parseContentLength(v: string | string[] | undefined): number | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Content-Disposition filename, else URL basename; always reduced to a safe basename.
function pickFilename(cd: string | string[] | undefined, url: string): string {
  const header = Array.isArray(cd) ? cd[0] : cd;
  let name = '';
  if (header) {
    const star = /filename\*=(?:[^']*'[^']*')?([^;]+)/i.exec(header); // RFC 5987 filename*
    if (star) {
      const raw = star[1].trim().replace(/^"|"$/g, '');
      try { name = decodeURIComponent(raw); } catch { name = raw; }
    } else {
      const plain = /filename="?([^";]+)"?/i.exec(header);
      if (plain) name = plain[1].trim();
    }
  }
  if (!name) {
    const basename = new URL(url).pathname.split('/').pop() ?? '';
    try { name = decodeURIComponent(basename); } catch { name = basename; }
  }
  // Reduce to a basename (no traversal) and drop control chars, without relying
  // on hex-escape regexes.
  name = Array.from(path.basename(name), (c) => (c.charCodeAt(0) < 0x20 ? '' : c)).join('').trim();
  if (!name || name === '.' || name === '..') name = 'download';
  return name;
}

// Single GET following redirects manually so every hop is scheme-checked and
// resolved through guardedLookup. Returns the final response (2xx/3xx-less).
function httpGet(startUrl: string, headers: Record<string, string>): Promise<{ res: http.IncomingMessage; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const go = (u: string) => {
      let parsed: URL;
      try { parsed = new URL(u); } catch { return reject(permanentErr(`invalid URL: ${u}`)); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reject(permanentErr(`unsupported URL scheme: ${parsed.protocol}`));
      }
      // guardedLookup only runs for hostnames: Node's socket layer skips
      // options.lookup entirely when the host is an IP literal (isIP truthy) and
      // connects straight to it. So literal-IP hosts must be checked here too, on
      // both the initial URL and every redirect hop. URL.hostname wraps IPv6 in
      // brackets ("[::1]"), which isIP/isPrivateIp need stripped.
      const hn = parsed.hostname.replace(/^\[|\]$/g, '');
      if (isIP(hn) && !config.ALLOW_PRIVATE_URL_HOSTS && isPrivateIp(hn)) {
        return reject(permanentErr(`refusing to connect: private address ${hn}`));
      }
      const mod = parsed.protocol === 'https:' ? https : http;
      // ponytail: `lookup` typing across dns/net overloads is painful; one cast.
      const opts: http.RequestOptions = { headers, lookup: guardedLookup as unknown as http.RequestOptions['lookup'] };
      const req = mod.get(u, opts, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain
          if (++redirects > 10) return reject(permanentErr('too many redirects'));
          return go(new URL(res.headers.location, u).toString());
        }
        resolve({ res, finalUrl: u });
      });
      req.on('error', reject);
    };
    go(startUrl);
  });
}

// Pipe one response segment to `dest`, enforcing the size cap and throttling
// progress to once per second. Resolves with the new cumulative byte count.
function streamToFile(
  res: http.IncomingMessage,
  dest: string,
  startBytes: number,
  total: number | null,
  onProgress?: ProgressFn,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let received = startBytes;
    let lastEmit = 0;
    let settled = false;
    const out = createWriteStream(dest, { flags: startBytes > 0 ? 'a' : 'w' });
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      res.destroy();
      out.destroy();
      reject(err);
    };
    out.on('error', fail);
    res.on('error', fail);
    res.on('close', () => {
      if (!settled && !res.complete) fail(new Error('connection closed before download completed'));
    });
    res.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > config.MAX_DOWNLOAD_BYTES) {
        return fail(permanentErr(`download exceeded MAX_DOWNLOAD_BYTES (${config.MAX_DOWNLOAD_BYTES})`));
      }
      const ok = out.write(chunk);
      const now = Date.now();
      if (onProgress && now - lastEmit >= 1000) {
        lastEmit = now;
        onProgress(received, total);
      }
      if (!ok) {
        res.pause();
        out.once('drain', () => res.resume());
      }
    });
    res.on('end', () => {
      if (settled) return;
      out.end(() => {
        if (settled) return;
        settled = true;
        if (onProgress) onProgress(received, total);
        resolve(received);
      });
    });
  });
}

/**
 * Stream an HTTP(S) URL into `jobDir` and return the saved file path.
 * - Rejects non-http(s) schemes and private/loopback/link-local/CGNAT hosts
 *   (initial connect and every redirect) unless config.ALLOW_PRIVATE_URL_HOSTS.
 * - Honours Content-Disposition, else URL basename.
 * - Enforces config.MAX_DOWNLOAD_BYTES up front (Content-Length) and mid-stream.
 * - On a dropped connection, resumes from the current byte count with a Range
 *   header: up to 3 retries with exponential backoff.
 * - Throttles onProgress to at most once per second.
 */
export async function downloadUrl(url: string, jobDir: string, onProgress?: ProgressFn): Promise<string> {
  await fsp.mkdir(jobDir, { recursive: true });
  let received = 0;
  let total: number | null = null;
  let dest: string | null = null;
  const maxRetries = 3;
  let retries = 0;

  for (;;) {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT, 'accept-encoding': 'identity' };
    if (received > 0) headers.range = `bytes=${received}-`; // resume

    let res: http.IncomingMessage;
    let finalUrl: string;
    try {
      ({ res, finalUrl } = await httpGet(url, headers));
    } catch (err) {
      if (isPermanent(err) || retries >= maxRetries) throw err;
      retries++;
      await sleep(backoff(retries));
      continue;
    }

    try {
      const status = res.statusCode ?? 0;
      if (received > 0) {
        // ponytail: if the server ignores our Range (no 206) we can't resume; fail
        // rather than silently restart. Ceiling: no from-scratch restart on 200.
        if (status !== 206) {
          res.resume();
          throw permanentErr(`resume failed: expected HTTP 206, got ${status}`);
        }
      } else {
        if (status < 200 || status >= 300) {
          res.resume();
          throw permanentErr(`download failed: HTTP ${status}`);
        }
        total = parseContentLength(res.headers['content-length']);
        if (total !== null && total > config.MAX_DOWNLOAD_BYTES) {
          res.resume();
          throw permanentErr(`file is ${total} bytes, exceeds MAX_DOWNLOAD_BYTES (${config.MAX_DOWNLOAD_BYTES})`);
        }
        dest = path.join(jobDir, pickFilename(res.headers['content-disposition'], finalUrl));
      }
      received = await streamToFile(res, dest as string, received, total, onProgress);
      return dest as string;
    } catch (err) {
      if (isPermanent(err) || retries >= maxRetries) throw err;
      retries++;
      await sleep(backoff(retries));
      // Resume from bytes actually flushed to disk, not streamToFile's internal
      // counter (which increments before write() and can exceed on-disk bytes after
      // out.destroy() drops buffered data — a Range from it would leave a gap).
      if (dest) received = (await fsp.stat(dest).catch(() => ({ size: 0 }))).size;
    }
  }
}

// ---------------------------------------------------------------------------
// Archive extraction + hashing
// ---------------------------------------------------------------------------

/**
 * If `filePath` is a .zip/.7z/.rar, extract it into `destDir` via 7z and return
 * the contained image files (accepted extensions only). Otherwise return
 * [filePath] unchanged.
 * ponytail: shells out to 7z (p7zip-full) rather than bundling an archive lib.
 * Ceiling: RAR5 needs the non-free codec in the image; upgrade path is a JS
 * unarchiver if we ever drop the 7z dependency.
 */
export async function extractArchive(filePath: string, destDir: string): Promise<string[]> {
  if (!isArchive(filePath)) return [filePath];
  await fsp.mkdir(destDir, { recursive: true });
  try {
    await execFileP('7z', ['x', '-y', `-o${destDir}`, filePath], { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const e = err as { code?: number; stderr?: string; message?: string };
    throw new Error(`7z extract failed (${e.code ?? '?'}): ${e.stderr || e.message}`);
  }
  const entries = await fsp.readdir(destDir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && isImageExtension(e.name))
    .map((e) => path.join((e as { parentPath?: string }).parentPath ?? destDir, e.name));
}

/** Streaming SHA-256 of a file (for dedupe / identify). Never buffers the file. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const s = createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (chunk) => hash.update(chunk));
    s.on('end', () => resolve(hash.digest('hex')));
  });
}
