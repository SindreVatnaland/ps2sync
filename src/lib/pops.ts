// PlayStation 1 support (POPStarter). PS1 games are stored as .VCD in POPS/; to
// actually boot them the PS2 also needs the Sony PS1-emulator core + the POPStarter
// launcher in POPS/. Those files are copyright (they come from your own console),
// so ps2sync NEVER downloads them — it only stores what you upload, and then copies
// the POPStarter ELF once per game so OPL's "PS1 Games" page lists each title.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsp from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Client } from 'basic-ftp';
import { popsDir } from './paths.js';
import { writeConfApps } from './apps.js';
import { getServerLanIp } from './settings.js';

const execFileP = promisify(execFile);

// The support files that belong in POPS/. All user-supplied. POPSTARTER.ELF is the
// launcher we clone per game; the rest are the emulator core.
const POPS_FILES = ['POPS.ELF', 'IOPRP252.IMG', 'POPS.PAK', 'POPS_IOX.PAK', 'POPSTARTER.ELF'];

// Canonical POPS filename for an upload (case-insensitive match), or null if it's
// not a recognized POPS file.
export function canonicalPopsName(filename: string): string | null {
  const base = path.basename(filename).toUpperCase();
  return POPS_FILES.find((f) => f === base) ?? null;
}

// Stream a recognized POPS upload straight into POPS/. Returns the canonical name,
// or null if unrecognized (caller must drain the stream itself).
export async function savePopsFile(filename: string, stream: NodeJS.ReadableStream): Promise<string | null> {
  const canon = canonicalPopsName(filename);
  if (!canon) return null;
  await fsp.mkdir(popsDir, { recursive: true });
  await pipeline(stream, createWriteStream(path.join(popsDir, canon)));
  return canon;
}

// Extract the recognized POPS files out of an uploaded .7z/.zip into POPS/ via the
// bundled 7z. Returns the canonical names placed.
export async function extractPopsArchive(archivePath: string): Promise<string[]> {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'ps2sync-pops-'));
  try {
    await execFileP('7z', ['x', '-y', `-o${work}`, archivePath], { maxBuffer: 64 * 1024 * 1024 });
    const entries = await fsp.readdir(work, { recursive: true, withFileTypes: true });
    await fsp.mkdir(popsDir, { recursive: true });
    const placed: string[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const canon = canonicalPopsName(e.name);
      if (!canon) continue;
      const from = path.join((e as { parentPath?: string }).parentPath ?? work, e.name);
      await fsp.copyFile(from, path.join(popsDir, canon));
      placed.push(canon);
    }
    return placed;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

// True once the POPStarter launcher has been uploaded (per-game ELFs can be made).
export function popsReady(): boolean {
  return existsSync(path.join(popsDir, 'POPSTARTER.ELF'));
}

// Public mirrors of the POPStarter core (Sony's PS1 emulator, mirrored by the
// homebrew community — obtain/use for a console you own). All are plain files.
const POPS_SOURCES: Array<{ name: string; url: string }> = [
  { name: 'POPS.ELF', url: 'https://github.com/AnimMouse/POPS-binaries/raw/main/POPS.ELF' },
  { name: 'IOPRP252.IMG', url: 'https://github.com/AnimMouse/POPS-binaries/raw/main/IOPRP252.IMG' },
  { name: 'POPS.PAK', url: 'https://github.com/AnimMouse/POPS-binaries/raw/main/POPS.PAK' },
  { name: 'POPS_IOX.PAK', url: 'https://github.com/AnimMouse/POPS-binaries/raw/main/POPS_IOX.PAK' },
  { name: 'POPSTARTER.ELF', url: 'https://archive.org/download/pops-iox/POPSTARTER.ELF' },
];

// Push POPStarter's SMB config onto the PS2's memory card over ethernet, via
// wLaunchELF's built-in FTP server (PS2Net). `ps2ip` is the PS2's current IP (shown
// on the PS2Net screen); we also use it as POPStarter's static IP so it matches.
// Creates mc0:/POPSTARTER/ and writes SMBCONFIG.DAT + IPCONFIG.DAT — no USB, no
// on-console typing. Requires PS2Net running and this server's LAN IP set.
export async function pushPopsConfig(ps2ip: string): Promise<{ server: string; files: string[] }> {
  const ip = ps2ip.trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) throw new Error('Enter the PS2 IP shown on the PS2Net screen, e.g. 192.168.68.74');
  const server = getServerLanIp();
  if (!server) throw new Error("Set this server's LAN IP in the Setup guide first — it goes into SMBCONFIG.DAT");

  const gateway = ip.replace(/\.\d+$/, '.1');
  // POPStarter's format: SMBCONFIG.DAT is "<server IP> <share>" (login lines omitted
  // for a guest share); IPCONFIG.DAT is "<PS2 IP> <netmask> <gateway>".
  const smbCfg = `${server} PS2\n`;
  const ipCfg = `${ip} 255.255.255.0 ${gateway}`;

  const client = new Client(45000); // PS2Net's FTP is slow — be patient
  try {
    await client.access({ host: ip, port: 21, user: 'anonymous', password: 'ps2sync', secure: false });
    await client.ensureDir('mc0:/POPSTARTER'); // creates the folder and cwd's into it
    await client.uploadFrom(Readable.from([Buffer.from(smbCfg)]), 'SMBCONFIG.DAT');
    await client.uploadFrom(Readable.from([Buffer.from(ipCfg)]), 'IPCONFIG.DAT');
  } catch (err) {
    throw new Error(`FTP to PS2 (${ip}) failed: ${err instanceof Error ? err.message : String(err)}. Is PS2Net running (wLaunchELF -> MISC -> PS2Net) at that IP?`);
  } finally {
    client.close();
  }
  return { server, files: ['SMBCONFIG.DAT', 'IPCONFIG.DAT'] };
}

// One-click PS1: fetch the whole POPStarter core into POPS/ and generate launchers.
export async function installPops(): Promise<{ placed: string[]; launchers: number }> {
  await fsp.mkdir(popsDir, { recursive: true });
  const placed: string[] = [];
  for (const s of POPS_SOURCES) {
    const res = await fetch(s.url, { headers: { 'user-agent': 'ps2sync' } });
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${s.name}`);
    await fsp.writeFile(path.join(popsDir, s.name), Buffer.from(await res.arrayBuffer()));
    placed.push(s.name);
  }
  const launchers = await reconcilePs1Launchers();
  return { placed, launchers };
}

// Which POPS support files are present, and how many PS1 games/launchers exist.
export async function popsStatus(): Promise<{
  present: string[];
  missing: string[];
  ready: boolean;
  vcds: number;
  launchers: number;
}> {
  const names = await fsp.readdir(popsDir).catch(() => [] as string[]);
  const upper = new Set(names.map((n) => n.toUpperCase()));
  return {
    present: POPS_FILES.filter((f) => upper.has(f)),
    missing: POPS_FILES.filter((f) => !upper.has(f)),
    ready: upper.has('POPSTARTER.ELF'),
    vcds: names.filter((n) => n.toLowerCase().endsWith('.vcd')).length,
    launchers: names.filter((n) => n.startsWith('SB.') && n.toUpperCase().endsWith('.ELF')).length,
  };
}

// For every <game>.VCD in POPS/, ensure its POPStarter launcher XX.<game>.ELF exists
// (a byte copy of POPSTARTER.ELF) so OPL's PS1 Games page lists it. No-op until
// POPSTARTER.ELF is uploaded. Idempotent — skips launchers that already exist, and
// prunes launchers whose VCD is gone. Returns how many it created.
export async function reconcilePs1Launchers(): Promise<number> {
  const starter = path.join(popsDir, 'POPSTARTER.ELF');
  if (!existsSync(starter)) return 0;
  const names = await fsp.readdir(popsDir).catch(() => [] as string[]);
  const vcds = names.filter((n) => n.toLowerCase().endsWith('.vcd'));
  // POPStarter reads its own filename prefix to choose the device: SB.=SMB (smb0:),
  // XX.=USB (mass:), no prefix=HDD. Our games stream over SMB, so launchers MUST be
  // SB.<name>.ELF — an XX. launcher tells POPStarter to load the VCD from USB and fails.
  const wanted = new Set(vcds.map((n) => `SB.${n.slice(0, -4)}.ELF`));

  // prune orphaned launchers, including stale XX. (USB-mode) ones from before this fix
  for (const n of names) {
    if ((n.startsWith('SB.') || n.startsWith('XX.')) && n.toUpperCase().endsWith('.ELF') && !wanted.has(n)) {
      await fsp.rm(path.join(popsDir, n), { force: true }).catch(() => {});
    }
  }

  let made = 0;
  for (const stubName of wanted) {
    const stub = path.join(popsDir, stubName);
    if (existsSync(stub)) continue;
    await fsp.copyFile(starter, stub);
    made++;
  }
  if (made) console.log(`reconcilePs1Launchers: created ${made} PS1 launcher ELF(s)`);
  await writeConfApps(); // surface the PS1 launchers on OPL's Apps page (conf_apps.cfg)
  return made;
}
