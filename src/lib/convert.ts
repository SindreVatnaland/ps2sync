// Convert a PS1 disc image (.bin/.cue) into a POPStarter .VCD via cue2pops.
// The .VCD lands wherever `outVcdPath` points; the placing step moves it into POPS/.
//
// ponytail: shell out to cue2pops rather than reimplement the POPS .VCD packer.
// Ceiling: we depend on the prebuilt cue2pops in the image and don't parse the
// container ourselves. Upgrade path: bundle/link a native VCD writer if it ever moves.

import { spawn } from 'node:child_process';
import { access, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Baked into the image; not on PATH by convention.
const CUE2POPS = '/usr/local/bin/cue2pops';

export interface ConvertOptions {
  vmode?: boolean; // pass the `vmode` video-timing patch to cue2pops
  onProgress?: (fraction: number) => void; // 0..1, best-effort (see runCue2pops)
}

/**
 * Run cue2pops on `cuePath`, writing a .VCD to `outVcdPath`.
 * CLI: `cue2pops <input.cue> [vmode] <output.VCD>`.
 * Resolves only when cue2pops signals success via its exit code; otherwise unlinks
 * the partial .VCD and throws with cue2pops's own output.
 *
 * NOTE: cue2pops's exit code is inverted from Unix convention — main() returns 1 on
 * SUCCESS and 0 on FAILURE. The output file is NOT truth: cue2pops writes its ~1 MB
 * VCD header before it even reads the .bin, so a failure mid-read/mid-write leaves a
 * non-empty, corrupt VCD on disk. We gate on the exit code (reliable) and keep the
 * size>0 check only as a secondary sanity guard.
 */
export async function convertPs1(cuePath: string, outVcdPath: string, opts: ConvertOptions = {}): Promise<void> {
  const args = [cuePath, ...(opts.vmode ? ['vmode'] : []), outVcdPath];
  const { code, output } = await runCue2pops(args, opts.onProgress);
  const size = await stat(outVcdPath).then((s) => s.size).catch(() => 0);
  if (code === 1 && size > 0) return;
  await rm(outVcdPath, { force: true }); // drop the header-only/partial VCD
  throw new Error(`cue2pops failed (exit ${code ?? '?'}): ${output.trim() || 'no output'}`);
}

// Spawn cue2pops, accumulate its combined output, and scan for a progress percent.
// Never rejects on a non-zero exit (convertPs1 judges by the exit code); only a
// spawn failure (e.g. cue2pops missing) rejects.
function runCue2pops(
  args: string[],
  onProgress?: (fraction: number) => void,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(CUE2POPS, args);
    let output = '';

    // ponytail: progress keys off the last "NN%" token cue2pops prints. Ceiling: if
    // the build's wording differs the job still finishes — only the bar stalls.
    const scan = (b: Buffer): void => {
      const s = b.toString();
      output += s;
      if (onProgress) {
        const m = s.match(/(\d{1,3})%/g);
        if (m) onProgress(Math.min(100, parseInt(m[m.length - 1], 10)) / 100);
      }
    };

    p.stdout.on('data', scan);
    p.stderr.on('data', scan);
    p.on('error', reject); // ENOENT etc.
    p.on('close', (code) => resolve({ code, output }));
  });
}

/**
 * cue2pops needs a .cue. If `inputPath` already is one, return it. For a bare .bin
 * or .iso, reuse a sibling <stem>.cue if present, else write a minimal single-track
 * cue next to the image and return its path.
 */
export async function ensureCue(inputPath: string): Promise<string> {
  if (path.extname(inputPath).toLowerCase() === '.cue') return inputPath;

  const cuePath = path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.cue`);
  if (await exists(cuePath)) return cuePath;

  const name = path.basename(inputPath);
  const cue = `FILE "${name}" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`;
  await writeFile(cuePath, cue);
  return cuePath;
}

function exists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}
