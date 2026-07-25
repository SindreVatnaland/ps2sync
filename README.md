# ps2sync

Self-hosted service that takes a PS1 or PS2 disc image, converts it to the format
the console actually reads, and files it into a shared folder that a PlayStation 2
running **Open PS2 Loader (OPL)** loads over the network. You give it an image (by
browser upload or a direct URL); it identifies the game, rejects duplicates,
converts PS1 discs to POPStarter `.VCD`, and lays everything out under `DVD/`,
`CD/`, and `POPS/`. A **sibling Samba container** shares those folders, and the PS2
**pulls** games from them over SMB — ps2sync never pushes or transfers anything
itself. One Node 22 + Fastify process serves both the server-rendered HTML UI and
the JSON API; state lives in SQLite. No game search, no catalogue, no sources — it
only organizes the files you hand it.

Sibling of [wii-sync](../WiiTransfer); same shape, minus all the FTP/push machinery.

## The image → OPL flow

1. **Add** — drop a file in the browser or paste a direct HTTP(S) URL. A job starts
   immediately.
2. **Identify** — the disc's `SYSTEM.CNF` is parsed for console (PS1/PS2) and serial
   (e.g. `SLUS-20102`); the title is enriched from a small game DB, falling back to
   the filename. Only a few sectors are read, never the whole multi-GB image. PS2
   images are bucketed CD-vs-DVD by size.
3. **Dedupe** — if that serial + console is already staged, the job is flagged a
   duplicate instead of overwriting.
4. **Convert** *(PS1 only)* — `.bin`/`.cue` is run through **cue2pops** to produce a
   POPStarter `.VCD`. PS2 `.iso` images are placed as-is.
5. **Organize** — files land in the OPL / POPStarter layout:
   PS2 → `DVD/<SERIAL>.<Title>.iso` or `CD/<SERIAL>.<Title>.iso`,
   PS1 → `POPS/<Title>.VCD`.
6. **Serve** — the sibling Samba container shares `DVD/ CD/ POPS/`; OPL on the PS2
   reads and boots them over SMB. Nothing is pushed — the console pulls on demand.

## Quick local run

```sh
cp .env.example .env      # defaults are fine; edit only to override
docker compose up
```

Open <http://localhost:8080>. Go to **Add**, upload an image or paste a URL, and
watch **Jobs**. Every setting has a sane default, so there is nothing you *must*
configure to try it out.

## Configuration

All environment variables, defaults, and meaning:

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `/data` | Root data dir (bind-mount target); holds `DVD/ CD/ POPS/ incoming/ db/`. |
| `PORT` | `8080` | HTTP listen port. |
| `MAX_UPLOAD_BYTES` | `12884901888` | Hard cap on a single uploaded file (default 12 GiB — fits a PS2 DVD9). |
| `MAX_DOWNLOAD_BYTES` | `10737418240` | Hard cap on a single URL download (default 10 GiB). |
| `ALLOW_PRIVATE_URL_HOSTS` | `false` | Allow URL downloads that resolve/redirect to private IPs (SSRF risk). |
| `AUTH_TOKEN` | *(unset)* | Shared secret; if set, required as bearer token or login cookie. Unset = open (trusted LAN). |
| `LOG_LEVEL` | `info` | Fastify log level: `fatal\|error\|warn\|info\|debug\|trace\|silent`. |

## Prepare your PS2

The app's **Setup guide** page (`/guide`) walks the whole thing with download
links: get homebrew running (FreeMcBoot or FreeDVDBoot → wLaunchELF), install
**Open PS2 Loader** and **POPStarter**, then point OPL at the Samba share
(**Settings → Network config**: this box's LAN IP, port `445`, share `PS2`, guest
login). Once that's set, your `DVD/`/`CD/` games and `POPS/` PS1 titles show up in
OPL automatically — no copying files by hand.

## Deploy to the homelab

Runs as a **single container** (`ghcr.io/sindrevatnaland/ps2sync:latest`, Fastify
serves UI at `/` and API at `/api` on 8080), bind-mounting the data dir so the
sibling Samba container can share `DVD/ CD/ POPS/`. It rides its own **Tailscale
sidecar** (`tailscale-ps2sync`, Funnel → Zoraxy) on the shared `web` network,
giving it `ps2sync.<tailnet>.ts.net`; **Zoraxy** routes that host by a single
base-origin rule to `ps2sync:8080` (no `/api` virtual directory — the app owns
`/api`). **CI** builds an arm64 image, pushes to GHCR, then POSTs the deploy
webhook (`docker compose pull && up -d`).

The **Samba** sibling shares the same `/data` sub-folders read-only-ish to the LAN
as share `PS2` (port `445`, guest); that's the share OPL connects to. Put both on
the LAN the PS2 is wired to.

Full stack (ps2sync + Samba + Tailscale sidecar + `web` network):
[`deploy/dockge-compose.yaml`](./deploy/dockge-compose.yaml). Drop it at
`/opt/stacks/ps2sync/compose.yaml`, set `TS_AUTHKEY` in the stack `.env`, deploy in
Dockge, then turn on the sidecar's Funnel:

```sh
docker exec tailscale-ps2sync tailscale funnel --bg http://zoraxy:80
```
</content>
</invoke>
