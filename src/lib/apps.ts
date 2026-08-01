// Optional homebrew "Apps": fetch the latest OPL / wLaunchELF ELF from GitHub
// releases and drop it in APPS/ on the share, so the PS2 can pull it over ethernet.
// ps2sync never writes to the console — on the PS2 you open wLaunchELF, browse the
// share to APPS/, and copy the ELF to the memory card yourself.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appsDir } from './paths.js';

const execFileP = promisify(execFile);

export interface AppSpec {
  key: string;
  name: string;
  repo: string; // GitHub owner/repo
  tag?: string; // specific release tag; default = the latest published release
  asset: RegExp; // which release asset to download
  innerElf?: RegExp; // if the asset is a .7z/.zip, the ELF to pull out of it
  dest: string; // filename written into APPS/
  blurb: string;
}

export const CATALOG: AppSpec[] = [
  {
    key: 'opl',
    name: 'Open PS2 Loader',
    repo: 'ps2homebrew/Open-PS2-Loader',
    asset: /^OPNPS2LD\.7z$/,
    innerElf: /^OPNPS2LD.*\.ELF$/i, // archive holds OPNPS2LD-v<ver>.ELF; save as canonical name
    dest: 'OPNPS2LD.ELF',
    blurb: 'Lists & boots your games over SMB. Update this to fix large (>2 GB) DVDs not showing.',
  },
  {
    key: 'ule',
    name: 'wLaunchELF',
    repo: 'ps2homebrew/wLaunchELF',
    tag: 'latest', // rolling prerelease that ships a bare BOOT.ELF
    asset: /^BOOT\.ELF$/,
    dest: 'wLaunchELF.ELF',
    blurb: 'PS2 file manager — copy new ELFs from the share to your memory card over ethernet.',
  },
];

// version = the release tag; fingerprint pins the exact asset (so a rolling
// "latest" tag whose ELF changed still registers as an update).
interface Manifest {
  [key: string]: { version: string; fingerprint?: string; at: number };
}
const manifestPath = path.join(appsDir, '.versions.json');

async function readManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as Manifest;
  } catch {
    return {};
  }
}

const GH_HEADERS = { 'user-agent': 'ps2sync', accept: 'application/vnd.github+json' };

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  updated_at: string;
}
interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

// GitHub is rate-limited (60/hr unauthenticated), so cache release lookups. The
// list/check UI and the auto-updater all share this — one fetch per app per TTL.
const relCache = new Map<string, { at: number; rel: Release }>();
const REL_TTL = 6 * 60 * 60 * 1000; // 6h

function releaseUrl(spec: AppSpec): string {
  return spec.tag
    ? `https://api.github.com/repos/${spec.repo}/releases/tags/${spec.tag}`
    : `https://api.github.com/repos/${spec.repo}/releases/latest`;
}

async function fetchRelease(spec: AppSpec): Promise<Release> {
  const url = releaseUrl(spec);
  const hit = relCache.get(url);
  if (hit && Date.now() - hit.at < REL_TTL) return hit.rel;
  const res = await fetch(url, { headers: GH_HEADERS });
  if (!res.ok) throw new Error(`GitHub ${res.status} fetching ${spec.repo} release`);
  const rel = (await res.json()) as Release;
  relCache.set(url, { at: Date.now(), rel });
  return rel;
}

function matchAsset(spec: AppSpec, rel: Release): ReleaseAsset {
  const asset = (rel.assets ?? []).find((a) => spec.asset.test(a.name));
  if (!asset) throw new Error(`no asset matching ${spec.asset} in ${spec.repo} ${rel.tag_name}`);
  return asset;
}

const fingerprint = (rel: Release, asset: ReleaseAsset): string => `${rel.tag_name}:${asset.updated_at}`;

export interface AppStatus {
  key: string;
  name: string;
  blurb: string;
  file: string;
  installed: boolean;
  version: string | null;
}

// Catalog + on-disk state only — no network. installApp()/checkApps() hit GitHub.
export async function listApps(): Promise<AppStatus[]> {
  const m = await readManifest();
  return CATALOG.map((a) => ({
    key: a.key,
    name: a.name,
    blurb: a.blurb,
    file: a.dest,
    installed: existsSync(path.join(appsDir, a.dest)),
    version: m[a.key]?.version ?? null,
  }));
}

export interface AppCheck extends AppStatus {
  latestVersion: string | null;
  updateAvailable: boolean;
  major: boolean; // latest is a major-version bump over what's installed
  error?: string; // GitHub lookup failed (rate limit / offline) — treated as "no update"
}

// Enrich each app with the latest available version (cached). Never throws for a
// single app — a failed lookup just reports no update with an `error` note.
export async function checkApps(): Promise<AppCheck[]> {
  const m = await readManifest();
  const out: AppCheck[] = [];
  for (const a of CATALOG) {
    const installed = existsSync(path.join(appsDir, a.dest));
    const cur = m[a.key];
    const base: AppStatus = { key: a.key, name: a.name, blurb: a.blurb, file: a.dest, installed, version: cur?.version ?? null };
    try {
      const rel = await fetchRelease(a);
      const fp = fingerprint(rel, matchAsset(a, rel));
      const updateAvailable = installed && (cur?.fingerprint ? cur.fingerprint !== fp : cur?.version !== rel.tag_name);
      out.push({ ...base, latestVersion: rel.tag_name, updateAvailable, major: isMajorBump(cur?.version, rel.tag_name) });
    } catch (err) {
      out.push({ ...base, latestVersion: null, updateAvailable: false, major: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

// True only when both tags parse as vMAJOR.* and the major increased. Rolling or
// non-semver tags (e.g. "latest") never count as major — they stay auto-eligible.
function isMajorBump(from: string | null | undefined, to: string): boolean {
  const major = (t?: string | null): number | null => {
    const m = /v?(\d+)\./.exec(t ?? '');
    return m ? Number(m[1]) : null;
  };
  const a = major(from);
  const b = major(to);
  return a !== null && b !== null && b > a;
}

// Download the newest release ELF for `key` into APPS/. Returns its status row.
export async function installApp(key: string): Promise<AppStatus> {
  const spec = CATALOG.find((a) => a.key === key);
  if (!spec) throw new Error(`unknown app: ${key}`);

  const rel = await fetchRelease(spec);
  const asset = matchAsset(spec, rel);
  const dl = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'ps2sync' } });
  if (!dl.ok) throw new Error(`download failed (${dl.status}) for ${asset.name}`);
  const buf = Buffer.from(await dl.arrayBuffer());

  const elf = spec.innerElf ? await extractFromArchive(buf, asset.name, spec.innerElf) : buf;
  await fsp.mkdir(appsDir, { recursive: true });
  await fsp.writeFile(path.join(appsDir, spec.dest), elf);

  const m = await readManifest();
  m[spec.key] = { version: rel.tag_name, fingerprint: fingerprint(rel, asset), at: Date.now() };
  await fsp.writeFile(manifestPath, JSON.stringify(m, null, 2));

  return { key: spec.key, name: spec.name, blurb: spec.blurb, file: spec.dest, installed: true, version: rel.tag_name };
}

// Auto-update installed apps to the latest *non-major* release. Called on a timer
// when the toggle is on; skips major bumps (notify-only) and never throws.
export async function autoUpdateApps(): Promise<void> {
  let checks: AppCheck[];
  try {
    checks = await checkApps();
  } catch (err) {
    console.warn(`apps: auto-update check failed: ${(err as Error).message}`);
    return;
  }
  for (const c of checks) {
    if (!(c.installed && c.updateAvailable && !c.major)) continue;
    try {
      const a = await installApp(c.key);
      console.log(`apps: auto-updated ${c.key} -> ${a.version}`);
    } catch (err) {
      console.warn(`apps: auto-update ${c.key} failed: ${(err as Error).message}`);
    }
  }
}

// Pull the one ELF out of a downloaded .7z/.zip via the bundled 7z CLI.
async function extractFromArchive(buf: Buffer, name: string, inner: RegExp): Promise<Buffer> {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'ps2sync-app-'));
  try {
    const arc = path.join(work, name);
    await fsp.writeFile(arc, buf);
    await execFileP('7z', ['x', '-y', `-o${work}`, arc], { maxBuffer: 16 * 1024 * 1024 });
    const entries = await fsp.readdir(work, { recursive: true, withFileTypes: true });
    const hit = entries.find((e) => e.isFile() && inner.test(e.name));
    if (!hit) throw new Error(`archive ${name} has no file matching ${inner}`);
    return await fsp.readFile(path.join((hit as { parentPath?: string }).parentPath ?? work, hit.name));
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}
