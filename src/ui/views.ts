// Pure HTML-string views (mirrors wii-sync). No DOM, no framework — each function
// takes data and returns markup. Dynamic tables (jobs) render a shell that
// public/app.js fills by polling; static content is rendered here.
import { escapeHtml } from './layout.js';
import type { Game } from '../db/schema.js';

// --- small formatting helpers ------------------------------------------------

function fmtBytes(n: number | null): string {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let x = n;
  let i = 0;
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(i > 0 && x < 10 ? 1 : 0)} ${u[i]}`;
}

function fmtDate(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString();
}

// media -> the /data folder + loader it lands in.
function fmtMedia(g: Game): string {
  if (g.media === 'pops') return 'POPS (VCD)';
  if (g.media === 'cd') return 'CD';
  return 'DVD';
}

// --- Library -----------------------------------------------------------------

function libraryTable(consoleLabel: string, rows: Game[]): string {
  if (rows.length === 0) {
    return `<h3>${escapeHtml(consoleLabel)}</h3><p class="muted small">Nothing here yet.</p>`;
  }
  const body = rows
    .map((g) => {
      const title = escapeHtml(g.title || g.serial);
      const id = escapeHtml(g.id);
      const del = `<button class="btn small danger" data-action="delete" data-id="${id}" data-title="${title}">Delete</button>`;
      const search = escapeHtml(`${g.title} ${g.serial}`.toLowerCase());
      return `<tr data-row data-search="${search}">
  <td><img class="cover-sm" data-cover data-console="${escapeHtml(g.console)}" data-serial="${escapeHtml(g.serial)}" data-title="${escapeHtml(g.title)}" alt="">${title}</td>
  <td><code>${escapeHtml(g.serial)}</code></td>
  <td>${escapeHtml(fmtMedia(g))}</td>
  <td data-value="${g.sizeBytes}">${fmtBytes(g.sizeBytes)}</td>
  <td data-value="${g.createdAt}">${escapeHtml(fmtDate(g.createdAt))}</td>
  <td><div class="row-actions">${del}</div></td>
</tr>`;
    })
    .join('\n');

  return `<h3>${escapeHtml(consoleLabel)} <span class="muted small">(${rows.length})</span></h3>
<div class="table-wrap"><table class="lib-table">
<colgroup><col style="width:38%"><col style="width:18%"><col style="width:11%"><col style="width:11%"><col style="width:15%"><col style="width:7%"></colgroup>
<thead><tr>
  <th data-col="0" data-type="text">Title</th>
  <th data-col="1" data-type="text">Serial</th>
  <th data-col="2" data-type="text">Folder</th>
  <th data-col="3" data-type="num">Size</th>
  <th data-col="4" data-type="num">Added</th>
  <th></th>
</tr></thead>
<tbody>
${body}
</tbody>
</table></div>`;
}

export function libraryView(games: Game[]): string {
  const ps2 = games.filter((g) => g.console === 'ps2');
  const ps1 = games.filter((g) => g.console === 'ps1');

  const empty =
    games.length === 0
      ? `<p class="muted">No games organised yet. <a href="/add">Add one</a> to get started.</p>`
      : '';

  return `<h2 style="margin-top:2rem">Library</h2>
<div class="card">
  <label for="lib-filter">Filter by title or serial</label>
  <input id="lib-filter" type="text" placeholder="type to filter…" autocomplete="off">
</div>
${empty}
${libraryTable('PlayStation 2 (OPL — DVD / CD)', ps2)}
${libraryTable('PlayStation 1 (POPStarter — POPS)', ps1)}`;
}

// --- Add ---------------------------------------------------------------------

export function addView(): string {
  return `<h1>Add a game</h1>

<div class="card">
  <div id="dropzone" class="dropzone">
    <p>Drag &amp; drop one or more disc images here, or <label class="link" for="file-input" style="display:inline">choose files</label>.</p>
    <input id="file-input" type="file" multiple
      accept=".iso,.bin,.cue,.img,.mdf,.zip,.7z,.rar" hidden>
    <p class="muted small">Accepted: PS2 <code>.iso</code>, PS1 <code>.bin/.cue</code> (also <code>.img .mdf</code>),
      and <code>.zip/.7z/.rar</code> archives.</p>
  </div>

  <form method="post" action="/url">
    <label for="target-select" style="margin-top:1rem">Console / media</label>
    <select id="target-select" name="target">
      <option value="">Auto-detect (recommended)</option>
      <option value="ps2-dvd">PS2 — DVD (place in DVD/)</option>
      <option value="ps2-cd">PS2 — CD (place in CD/)</option>
      <option value="ps1">PS1 — convert to VCD (place in POPS/)</option>
    </select>
    <p class="muted small">Auto reads the disc's serial from <code>SYSTEM.CNF</code> to pick the console and
      folder. PS1 <code>.bin/.cue</code> images are automatically converted to a POPStarter <code>.VCD</code>.</p>

    <label for="url-input" style="margin-top:1rem">… or paste a direct HTTP(S) link instead of a file</label>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      <input id="url-input" type="url" name="url" placeholder="https://example.com/game.iso"
        style="flex:1;min-width:220px" required>
      <button class="btn primary" type="submit">Download</button>
    </div>
    <p class="muted small">The console/media option above applies to both the file upload and the URL download.</p>
  </form>

  <div id="upload-status" class="hidden">
    <div id="upload-queue"></div>
    <p id="upload-text" class="muted small"></p>
  </div>
</div>`;
}

// --- Storage usage (shared /data disk) ---------------------------------------

export function storageView(): string {
  return `<div class="card" id="storage-card">
  <h2 style="margin-bottom:.5rem">Storage</h2>
  <div id="storage-body" class="muted small">Loading…</div>
</div>`;
}

// --- Search (serial catalogue + local library, metadata only) ----------------

export function searchView(): string {
  return `<h1>Search games</h1>
<div class="card">
  <p class="muted small">Reference lookup of the PS2 disc-serial catalogue (PCSX2's GameIndex) and your own
    library — confirm a game's exact title and serial before you add <em>your own</em> file on the
    <a href="/add">Add</a> page. Metadata only: no game files, no download links.</p>
  <label for="search-q">Search by title or serial</label>
  <input id="search-q" type="text" placeholder="e.g. Gran Turismo, or SLUS-20946" autocomplete="off" autofocus>
  <label style="display:flex;align-items:center;gap:.5rem;margin-top:.5rem">
    <input type="checkbox" id="hide-dupes"> Hide regional duplicates (one entry per title)
  </label>
  <label style="display:flex;align-items:center;gap:.5rem;margin-top:.35rem">
    <input type="checkbox" id="hide-demos" checked> Hide demos &amp; betas
  </label>
  <p class="muted small">Type at least 2 characters.</p>
</div>
<div id="search-status" class="muted small"></div>
<div id="search-results" class="results"></div>`;
}

// --- Jobs --------------------------------------------------------------------

export function jobsView(): string {
  return `<h2>Jobs</h2>
<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap">
    <p class="muted small" style="margin:0">Active and recent ingest jobs. Auto-refreshes every 2 seconds.</p>
    <button class="btn small" data-action="clear-jobs">Clear finished</button>
  </div>
  <div class="table-wrap"><table>
  <thead><tr>
    <th></th><th>Source</th><th>Kind</th><th>Console</th><th>Serial</th><th>State</th><th>Progress</th><th>Info</th><th></th>
  </tr></thead>
  <tbody id="jobs-tbody"><tr><td colspan="9" class="muted">Loading…</td></tr></tbody>
  </table></div>
  <div id="jobs-pager" style="display:flex;align-items:center;gap:.6rem;margin-top:.5rem"></div>
</div>`;
}

// --- Login (auth) ------------------------------------------------------------

export function loginView(error?: string): string {
  const err = error ? `<p style="color:var(--danger)">${escapeHtml(error)}</p>` : '';
  return `<h1>Sign in</h1>
<div class="card">
  <form method="post" action="/login">
    ${err}
    <label for="token">Access token</label>
    <input id="token" type="password" name="token" autocomplete="current-password" autofocus>
    <p style="margin-top:1rem"><button class="btn primary" type="submit">Sign in</button></p>
  </form>
</div>`;
}

// --- PS2 setup guide ---------------------------------------------------------

export function guideView(): string {
  return `<h1>Connect your PS2 to this server</h1>
<p class="muted">Do this once to get homebrew and Open PS2 Loader (OPL) running on the console. After that,
the PS2 pulls games straight off this server over your network — you never copy files by hand. This app
already sorts every upload into the right folder (<code>DVD/</code>, <code>CD/</code>, <code>POPS/</code>).</p>

<div class="card">
  <label for="lan-ip"><strong>Your server's LAN IP</strong> — the SMB address OPL connects to (step 4)</label>
  <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-top:.4rem">
    <input id="lan-ip" type="text" placeholder="192.168.1.10" style="width:12rem">
    <button class="btn small" id="lan-ip-save">Save</button>
    <span id="lan-ip-msg" class="muted small"></span>
  </div>
  <p class="muted small">Auto-filled if you opened this page via the Pi's LAN IP. Set it once — it then
    shows in step 4 and never changes (give the Pi a DHCP reservation so it stays put).</p>
</div>

<div class="card">
  <h2>1. What you need</h2>
  <ul>
    <li>A <strong>PlayStation 2</strong> with <strong>wired Ethernet</strong>. Slim models
      <strong>SCPH-70000 and later</strong> have the network port built in. Original "fat" models need the
      official <strong>Network Adapter</strong> (the one that clips onto the expansion bay).</li>
    <li>A way to run homebrew: a <strong>FreeMcBoot (FMCB)</strong> memory card, or
      <strong>FreeDVDBoot</strong> for an otherwise-unmodified console (see step 2).</li>
    <li>The PS2 and this server on the <strong>same LAN</strong> (same router/switch). Wired is strongly
      recommended — the PS2 has no built-in Wi-Fi.</li>
    <li>Optionally a USB flash drive formatted <strong>FAT32</strong> as a fallback if SMB acts up.</li>
  </ul>
</div>

<div class="card">
  <h2>2. Get homebrew running</h2>
  <p>You need a way to launch unsigned apps. Two common routes:</p>
  <ul>
    <li><strong>FreeMcBoot (FMCB)</strong> — a modified memory card that boots into a homebrew launcher
      (wLaunchELF / OPL) at power-on. The easiest option if you can install it to a memory card (many
      people buy a pre-made FMCB card, or use another modded PS2 / the auto-installers).</li>
    <li><strong>FreeDVDBoot</strong> — for a totally unmodified console: you burn a special disc (or use a
      compatible USB), the PS2's DVD player exploit runs it, and it launches ELF homebrew. Great when you
      can't get an FMCB card.</li>
  </ul>
  <p>Either way, the goal is to reach a homebrew launcher such as <strong>wLaunchELF (uLaunchELF)</strong>,
    from which you start OPL.</p>
  <p class="muted small">Downloads:
    <a href="https://github.com/ps2homebrew/wLaunchELF" rel="noopener" target="_blank">wLaunchELF</a> ·
    <a href="https://github.com/CTurt/FreeDVDBoot" rel="noopener" target="_blank">FreeDVDBoot</a> ·
    general guides at <a href="https://www.ps2-home.com/" rel="noopener" target="_blank">ps2-home.com</a> and
    <a href="https://ps2.fun/" rel="noopener" target="_blank">ps2.fun</a>.</p>
</div>

<div class="card">
  <h2>3. Install Open PS2 Loader (and POPStarter for PS1)</h2>
  <ul>
    <li><strong>Open PS2 Loader (OPL)</strong> is the app that lists and boots your PS2 games from USB, HDD,
      or — what we use here — <strong>SMB (network)</strong>. Copy <code>OPNPS2LD.ELF</code> to your memory
      card or USB and launch it from wLaunchELF (or set it as the FMCB auto-boot app).</li>
    <li><strong>POPStarter</strong> launches PS1 games from the <code>.VCD</code> files this app writes into
      <code>POPS/</code>. It's driven by OPL's VMC/POPS support — install it alongside OPL.</li>
  </ul>
  <p class="muted small">Downloads:
    <a href="https://github.com/ps2homebrew/Open-PS2-Loader" rel="noopener" target="_blank">Open PS2 Loader</a> ·
    <a href="https://github.com/israpps/POPStarter" rel="noopener" target="_blank">POPStarter</a>.</p>
</div>

<div class="card">
  <h2>4. Point OPL at this server (SMB)</h2>
  <p>Start OPL, open its <strong>Settings → Network config</strong>, and enter:</p>
  <ul>
    <li><strong>SMB server</strong>: this server's LAN IP — <code class="smb-ip">192.168.1.10</code>
      (set it in the field at the top of this guide; it fills in here).</li>
    <li><strong>Port</strong>: <code>445</code></li>
    <li><strong>Share name</strong>: <code>PS2</code></li>
    <li><strong>Login / password</strong>: <strong>guest</strong> (leave the user/password blank or set to
      <code>GUEST</code>, per the share).</li>
    <li>Set the PS2's IP: <strong>DHCP</strong> is easiest (it grabs an address automatically); or set a
      static IP on the same subnet as the server.</li>
  </ul>
  <p>Save, then in OPL enable <strong>USB / HDD / SMB (ETH) game list</strong> as needed and
    <strong>reload</strong>. Your <strong>PS2 DVD and CD games appear automatically</strong> — they're read
    from the <code>DVD/</code> and <code>CD/</code> folders this app fills.</p>
  <p class="muted small">Tip: give both the server and the PS2 fixed addresses (DHCP reservations in your
    router) so the SMB server IP you typed never changes.</p>
</div>

<div class="card">
  <h2>5. PS1 games via POPStarter</h2>
  <ul>
    <li>PS1 games are stored as <strong><code>.VCD</code></strong> files in the <code>POPS/</code> folder.
      POPStarter reads that folder and boots them.</li>
    <li>Heads-up: <strong>PS1-over-SMB is a little less reliable than PS2</strong> on some setups. If a PS1
      title won't start from the network, copy that <code>.VCD</code> (plus its
      <code>POPStarter.ELF</code>) to a <strong>FAT32 USB drive</strong> and run it from there — the
      <strong>USB fallback</strong> is rock-solid.</li>
  </ul>
</div>

<div class="card">
  <h2>6. You don't arrange any files</h2>
  <p>That's the whole point of this app. Every upload or URL you add is identified, converted if it's a PS1
    disc, and dropped into the correct folder:</p>
  <ul>
    <li>PS2 DVD images → <code>DVD/</code></li>
    <li>PS2 CD images → <code>CD/</code></li>
    <li>PS1 games (converted to <code>.VCD</code>) → <code>POPS/</code></li>
  </ul>
  <p>The sibling Samba container shares those folders as the <code>PS2</code> network share, so the console
    sees new games as soon as a job finishes — just reload the game list in OPL.</p>
</div>

<div class="card">
  <h2>Reference links</h2>
  <ul>
    <li>Open PS2 Loader — <a href="https://github.com/ps2homebrew/Open-PS2-Loader" rel="noopener" target="_blank">github.com/ps2homebrew/Open-PS2-Loader</a></li>
    <li>wLaunchELF (homebrew launcher) — <a href="https://github.com/ps2homebrew/wLaunchELF" rel="noopener" target="_blank">github.com/ps2homebrew/wLaunchELF</a></li>
    <li>POPStarter (PS1) — <a href="https://github.com/israpps/POPStarter" rel="noopener" target="_blank">github.com/israpps/POPStarter</a></li>
    <li>FreeDVDBoot (unmodded consoles) — <a href="https://github.com/CTurt/FreeDVDBoot" rel="noopener" target="_blank">github.com/CTurt/FreeDVDBoot</a></li>
    <li>PS2 homebrew guides — <a href="https://www.ps2-home.com/" rel="noopener" target="_blank">ps2-home.com</a> · <a href="https://ps2.fun/" rel="noopener" target="_blank">ps2.fun</a></li>
  </ul>
  <p class="muted small">These are homebrew tools and guides only. This app never provides game files.</p>
</div>`;
}
