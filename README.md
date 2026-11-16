# ps2sync

Play your own PS1 and PS2 discs on a PlayStation 2 straight over the network, with no
copying files around or fiddling with USB sticks.

You open a web page, upload a disc image, and a minute later the game shows up in
**Open PS2 Loader (OPL)** on the PS2. ps2sync identifies the game, rejects duplicates,
converts PS1 discs to the format the PS2's PS1 emulator (POPStarter) needs, and files
everything into a network share that the PS2 reads from.

```
 laptop / phone ──(home network)──> server  http://ps2sync.local   (upload games)
 PS2 running OPL ──(ethernet)─────> server  SMB share "PS2"        (plays games)
```

## How it works

ps2sync runs two containers on a small always-on Linux server:

- **ps2sync** is the web UI. For every image you add, by upload or by pasting a URL, it:
  1. **Identifies** the disc by reading `SYSTEM.CNF` to get the console (PS1/PS2) and
     serial (e.g. `SLUS-20102`), then looks the title up in a game database.
  2. **Dedupes**, so a game that's already there isn't added twice.
  3. **Converts** PS1 `.bin`/`.cue` to POPStarter `.VCD`. PS2 `.iso` files are kept as-is.
  4. **Files it**: PS2 games go to `DVD/` or `CD/`, PS1 games to `POPS/`.
- **Samba** shares that same folder on the network as `PS2`. OPL on the console connects
  to it and lists the games. The PS2 pulls them, and nothing is ever pushed to it.

Everything lives in one data folder on the server: the games, the database and the PS1
memory-card files.

## Daily use

1. Open **<http://ps2sync.local>** in a browser. If that doesn't resolve on your device,
   use the server's IP instead, e.g. `http://192.168.1.50`.
2. Go to **Add** and upload a PS2 `.iso`, or a PS1 `.bin` + `.cue`. You can also paste a
   direct download link.
3. Watch **Jobs** until the game is done. On the PS2, refresh OPL's game list (or restart
   OPL) and the game is there.

The **Library** page lists everything that's on the share. The **Setup guide** page in the
app has the PS2 steps below, with download links.

## Setting up the PS2 (one time)

**You need:**

- A PS2 with ethernet. Slim models have the port built in. Original "fat" models need
  the official Network Adapter.
- A way to run homebrew:
  - **FreeMcBoot (FMCB)**: a modded memory card that boots a homebrew menu at power-on.
  - **FreeDVDBoot**: a burned disc that runs homebrew on an unmodified console.
- An ethernet cable from the PS2, either to your router/switch or directly into the
  server (see [Server setup](#server-setup-for-claude-code)).

**Steps:**

1. **Get homebrew running.** Use FMCB or FreeDVDBoot to reach **wLaunchELF**, a file
   manager and launcher.
2. **Install OPL.** On the ps2sync **Apps** page, click **Install all**. This puts Open PS2
   Loader, wLaunchELF and the POPStarter files on the share. Get `OPNPS2LD.ELF` onto the
   PS2 (memory card or USB) and launch it from wLaunchELF, or set it as FMCB's auto-boot.
3. **Point OPL at the server.** In OPL, open **Settings → Network config**:

   | Field | PS2 plugged into the router | PS2 cabled directly to the server |
   |---|---|---|
   | IP address type | DHCP | Static |
   | PS2 IP / mask / gateway | *(automatic)* | `10.0.0.2` / `255.255.255.0` / `10.0.0.1` |
   | SMB server IP | the server's IP (shown on the **Setup guide** page) | `10.0.0.1` |
   | Port | `445` | `445` |
   | Share | `PS2` | `PS2` |
   | User / password | `guest` / *(empty)* | same |

   Save the settings, set **Network start mode** to *Auto*, and restart OPL. Your PS2 games
   appear under **ETH**.
4. **PS1 games (POPStarter).** POPStarter needs a small config on the memory card that
   tells it where the server is. ps2sync can write it for you:
   1. On the PS2, start **wLaunchELF** and go to **MISC → PS2Net** (starts its FTP server).
   2. In ps2sync's POPStarter section, enter the PS2's IP and click **Push config to PS2**.

   After that, PS1 games launch from OPL's **Apps** list.

### When something's off

- **OPL can't connect to the SMB server.** Check the SMB server IP, and that the PS2's
  cable is in. If it still fails, ask Claude Code to check the server (see below).
- **Every PS1 game suddenly says "no memory card"**, usually right after the server
  restarted. The PS2 is holding a dead network session. **Fully power the PS2 off and on.**
  Your saves are fine.
- **A PS1 game drops back to the file manager.** POPStarter's config is missing or points
  at the wrong IP. Redo step 4.

---

## Server setup (for Claude Code)

> **For Claude Code:** set up ps2sync on the user's Linux server. What follows covers what's
> specific to this app: the two services, their config, and the traps. Handle the general
> Linux work (Docker, disks, networking, hostname) yourself. Ask the user only where it
> says **ASK**.

**Goal:**

- Local network only.
- Starts by itself at power-on with nothing to click.
- The user uploads games at **`http://ps2sync.local`**: hostname `ps2sync`, mDNS/avahi,
  UI on host port 80.
- Finish by telling the user that URL. If `.local` doesn't resolve on one of their
  devices, also give the IP.

**ASK:**

1. Does the PS2 connect through the router, or with a direct cable to the server?
2. Where should games be stored?
3. Is it OK to rename the host to `ps2sync`?

### Services

Use this compose file. Replace both `/srv/ps2` with the chosen data dir:

```yaml
services:
  # Web UI: upload, identify, convert, organize.
  ps2sync:
    image: ghcr.io/sindrevatnaland/ps2sync:latest   # multi-arch: arm64 + x86_64
    container_name: ps2sync
    restart: unless-stopped
    ports:
      - "80:8080"
    environment:
      TZ: Europe/Oslo
    volumes:
      - /srv/ps2:/data

  # SMB share "PS2" that OPL on the PS2 reads from.
  ps2-samba:
    image: dperson/samba
    container_name: ps2-samba
    restart: unless-stopped
    ports:
      - "445:445"
    environment:
      TZ: Europe/Oslo
    volumes:
      - /srv/ps2:/ps2                # same folder as ps2sync's /data
    command:
      - -s
      - PS2;/ps2;yes;no;yes          # name;path;browsable;readonly;guest
      - -g
      - server min protocol = NT1
      - -g
      - client min protocol = NT1
      - -g
      - ntlm auth = yes
```

### Traps

- **Old SMB.** OPL's SMB client is ancient. Keep SMB1/NT1 + NTLM, as in the compose file.
- **No `-p` on Samba.** It chowns the share away from ps2sync (uid 1000), and uploads then
  fail with `EACCES`. ps2sync fixes `/data` ownership itself on every start.
- **Bind 445 on all interfaces**, not a single IP like `10.0.0.1:445`. If that IP is
  missing when Samba starts (PS2 off, link down, early boot), the bind fails. Docker
  **never retries a container that failed to start**, so Samba stays dead. If the host
  already runs another SMB server on 445, stop it. If you have to keep it, pin Samba to
  the PS2-facing IP *and* make sure that IP stays up without carrier.
- **Data dir must be ext4** (or another Unix filesystem). FAT32 caps files at 4 GB, and
  exFAT/NTFS lack the permissions the container needs. On a USB drive, mount it with
  `nofail` in fstab, and make Docker wait for it (`RequiresMountsFor=` drop-in).
  Otherwise games silently land on the root disk when the drive mounts late.
- **Direct cable.** Server `eth0` = `10.0.0.1/24`, PS2 = `10.0.0.2`.
  - Don't put a gateway on `eth0`. Internet and the home network stay on Wi-Fi.
  - Keep `10.0.0.1` assigned while the PS2 is off: `ignore-carrier: true` in netplan;
    NetworkManager's `ipv4.never-default yes` and a static profile.
  - No crossover cable is needed.
- **Server LAN IP setting.** ps2sync writes this IP into POPStarter's config, so it must
  be the IP the **PS2** uses to reach the server: the router-reserved IP, or `10.0.0.1`
  for a direct cable. Never use the Wi-Fi IP for a direct cable. Set it with:
  `curl -X POST http://localhost/api/settings -H 'Content-Type: application/json' -d '{"serverLanIp":"<ip>"}'`.
- **Router setup.** Give the server a DHCP reservation so the SMB IP in OPL never changes.
- **After Samba restarts, power-cycle the PS2.** Otherwise it holds a dead session, and
  every PS1 game reports "no memory card".
- **Security.** It's a guest-writable SMB1 share with an open UI, so keep it LAN-only and
  never port-forward 80 or 445. Set `AUTH_TOKEN` to password the UI.

### Done when

- After a **reboot**, both containers are up.
- `curl -f http://localhost/health` succeeds.
- `docker port ps2-samba` lists 445.
- `http://ps2sync.local` opens from another device.
- For a direct cable: with OPL's network started, the server can ping `10.0.0.2`.

Hand the user the [PS2 table](#setting-up-the-ps2-one-time), filled in with the real IPs.

**Update:** `docker compose pull && docker compose up -d`, then power-cycle the PS2.

---

## Configuration

Environment variables for the `ps2sync` container. All of them are optional.

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `/data` | Root data dir; holds `DVD/ CD/ POPS/ incoming/ db/`. |
| `PORT` | `8080` | HTTP listen port inside the container. |
| `MAX_UPLOAD_BYTES` | `12884901888` | Max single upload (12 GiB, fits a PS2 DVD9). |
| `MAX_DOWNLOAD_BYTES` | `10737418240` | Max single URL download (10 GiB). |
| `ALLOW_PRIVATE_URL_HOSTS` | `false` | Allow URL downloads that resolve to private IPs (SSRF risk). |
| `AUTH_TOKEN` | *(unset)* | Shared secret for the UI/API; unset = open (trusted LAN). |
| `LOG_LEVEL` | `info` | `fatal\|error\|warn\|info\|debug\|trace\|silent`. |

## Development

```sh
docker compose up --build     # root docker-compose.yml: app only, ./data, port 8080
```
