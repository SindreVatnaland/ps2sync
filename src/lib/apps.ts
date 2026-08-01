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
    innerElf: /^OPNPS2LD\.ELF$/,
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

interface Manifest {
  [key: string]: { version: string; at: number };
}
const manifestPath = path.join(appsDir, '.versions.json');

async function readManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as Manifest;
  } catch {
    return {};
  }
}

export interface AppStatus {
  key: string;
  name: string;
  blurb: string;
  file: string;
  installed: boolean;
  version: string | null;
}

// Catalog + on-disk state only — no network. installApp() is what hits GitHub.
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

const GH_HEADERS = { 'user-agent': 'ps2sync', accept: 'application/vnd.github+json' };

interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

// Download the newest release ELF for `key` into APPS/. Returns its status row.
export async function installApp(key: string): Promise<AppStatus> {
  const spec = CATALOG.find((a) => a.key === key);
  if (!spec) throw new Error(`unknown app: ${key}`);

  const relUrl = spec.tag
    ? `https://api.github.com/repos/${spec.repo}/releases/tags/${spec.tag}`
    : `https://api.github.com/repos/${spec.repo}/releases/latest`;
  const relRes = await fetch(relUrl, { headers: GH_HEADERS });
  if (!relRes.ok) throw new Error(`GitHub ${relRes.status} fetching ${spec.repo} release`);
  const rel = (await relRes.json()) as Release;
  const asset = (rel.assets ?? []).find((a) => spec.asset.test(a.name));
  if (!asset) throw new Error(`no asset matching ${spec.asset} in ${spec.repo} ${rel.tag_name}`);

  const dl = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'ps2sync' } });
  if (!dl.ok) throw new Error(`download failed (${dl.status}) for ${asset.name}`);
  const buf = Buffer.from(await dl.arrayBuffer());

  const elf = spec.innerElf ? await extractFromArchive(buf, asset.name, spec.innerElf) : buf;
  await fsp.mkdir(appsDir, { recursive: true });
  await fsp.writeFile(path.join(appsDir, spec.dest), elf);

  const m = await readManifest();
  m[spec.key] = { version: rel.tag_name, at: Date.now() };
  await fsp.writeFile(manifestPath, JSON.stringify(m, null, 2));

  return { key: spec.key, name: spec.name, blurb: spec.blurb, file: spec.dest, installed: true, version: rel.tag_name };
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
