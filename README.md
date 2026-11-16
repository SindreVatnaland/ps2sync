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
  cable is in. If it still fails, see the server troubleshooting below.
- **Every PS1 game suddenly says "no memory card"**, usually right after the server
  restarted. The PS2 is holding a dead network session. **Fully power the PS2 off and on.**
  Your saves are fine.
- **A PS1 game drops back to the file manager.** POPStarter's config is missing or points
  at the wrong IP. Redo step 4.

---

## Server setup (for Claude Code)

> **For Claude Code:** you're setting up ps2sync on the user's Linux server, either on
> the box itself or over SSH. Do the steps in order, and run each **Verify** before moving
> on. Ask the user only where it says **ASK**. Everything else has a default, so use it.
> When you're done, tell the user their upload URL ([step 7](#7-hand-over)).
>
> **Goal:** a local-only box with no Tailscale, reverse proxy or internet exposure. It
> starts by itself when powered on, and the user uploads games at `http://ps2sync.local`.

### 0. Requirements and decisions

- **64-bit ARM (`arm64`) Linux.** The published image
  `ghcr.io/sindrevatnaland/ps2sync:latest` is arm64-only, so `uname -m` must print
  `aarch64`. On `x86_64`, use the build-from-source variant in step 5.
- A Debian/Ubuntu-style OS: apt, systemd, and either NetworkManager or netplan.

**ASK:** how does the PS2 connect?

| Option | Pick when | Effect on the server |
|---|---|---|
| **A. Through the router** *(simplest)* | The PS2 can be cabled to the router or a switch | No network changes. The server only needs a DHCP reservation |
| **B. Direct cable PS2 ↔ server** | The PS2 is far from the router. The server sits next to it on Wi-Fi | `eth0` gets a static `10.0.0.1`. Home network and internet stay on Wi-Fi |

**ASK:** where should the games live?

- **External USB drive (recommended).** Images are 0.5–8 GB each. The drive must be
  **ext4**: FAT32 caps files at 4 GB, and exFAT/NTFS have no Unix permissions, which the
  container needs. Mount point `/mnt/ps2drive`, data dir `/mnt/ps2drive/ps2`.
- **The internal disk**, for a handful of games. Data dir `/srv/ps2`.

From here on, `DATA` means the chosen data dir.

**ASK:** is it OK to rename the machine's hostname to `ps2sync`? That gives the
`http://ps2sync.local` address. If not, keep the current hostname, and the URL becomes
`http://<hostname>.local`.

### 1. Docker (starts at boot)

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"        # re-login afterwards, or use sudo
sudo systemctl enable --now docker
```

**Verify:**

- `systemctl is-enabled docker` prints `enabled`.
- `sudo ss -ltnp | grep -E ':(80|445)\b'` prints nothing.
  - If `smbd` holds 445, run `sudo systemctl disable --now smbd nmbd`.
  - If something else holds 80, use `"8080:8080"` in step 5. The URL then gets `:8080`.

### 2. Hostname and `.local` address

```sh
sudo hostnamectl set-hostname ps2sync         # only if the user said yes
sudo sed -i "s/^127\.0\.1\.1.*/127.0.1.1\tps2sync/" /etc/hosts
sudo apt-get install -y avahi-daemon          # mDNS: answers for ps2sync.local
sudo systemctl enable --now avahi-daemon
```

**Verify:** from another computer on the network, `ping ps2sync.local` answers. Windows
10+, macOS, iOS and Linux resolve `.local` names. Some older Android phones don't, so
they need the IP.

### 3. Storage

**USB drive.**

> ⚠ `mkfs` **erases the drive**. Confirm the device with the user (`lsblk`) first.

```sh
lsblk                                         # find it, e.g. /dev/sda1
sudo mkfs.ext4 -L ps2drive /dev/sdX1          # ⚠ ERASES IT
sudo mkdir -p /mnt/ps2drive
echo 'LABEL=ps2drive /mnt/ps2drive ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a
sudo mkdir -p /mnt/ps2drive/ps2
```

Docker must start only after the drive is mounted. Otherwise games silently land on the
internal disk:

```sh
sudo mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nRequiresMountsFor=/mnt/ps2drive\n' | sudo tee /etc/systemd/system/docker.service.d/wait-for-ps2drive.conf
sudo systemctl daemon-reload
```

**Verify:** `df /mnt/ps2drive/ps2` shows the USB device, not the root disk.

**Internal disk.** Run `sudo mkdir -p /srv/ps2`.

In both cases you don't need to chown anything. The container fixes ownership of `DATA`
on every start.

### 4. Network

**Option A, through the router.** Add a **DHCP reservation** for the server in the
router's admin page so its IP never changes. `hostname -I` shows the current IP. That IP
is the **SMB server IP**, so note it for step 6.

**Option B, direct cable.** The setup is:

- Wi-Fi stays on the home network.
- `eth0` becomes a private two-device link: server `10.0.0.1`, PS2 `10.0.0.2`.
- **No gateway on `eth0`.** The default route must stay on Wi-Fi.
- No crossover cable needed.

> Do this while connected **over Wi-Fi**. An SSH session over ethernet will drop.

Find out which network stack is in use: `systemctl is-active NetworkManager`.

**NetworkManager:**

```sh
nmcli -t -f NAME,DEVICE con show                 # existing eth0 profile?
sudo nmcli con delete "Wired connection 1"       # only if it exists and is on eth0
sudo nmcli con add type ethernet ifname eth0 con-name ps2link \
  ipv4.method manual ipv4.addresses 10.0.0.1/24 ipv4.never-default yes \
  ipv6.method disabled connection.autoconnect yes
sudo nmcli con up ps2link    # "no carrier" error is fine while the PS2 is off
```

**netplan:** create `/etc/netplan/60-ps2link.yaml`, then run
`sudo chmod 600 /etc/netplan/60-ps2link.yaml && sudo netplan apply`:

```yaml
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: false
      addresses: [10.0.0.1/24]
      optional: true        # don't hold up boot waiting for the PS2
      ignore-carrier: true  # keep 10.0.0.1 even while the PS2 is off
```

**Verify:** `ip route | grep default` still points at `wlan0`. With the PS2 on and
cabled, `ip -4 addr show eth0` shows `10.0.0.1/24`.

### 5. Deploy

Write `/opt/ps2sync/compose.yaml`, with **both** `/srv/ps2` paths replaced by `DATA`:

```yaml
# ps2sync, local-only: web UI on port 80 + Samba share "PS2" for OPL on 445.
services:
  ps2sync:
    image: ghcr.io/sindrevatnaland/ps2sync:latest
    container_name: ps2sync
    restart: unless-stopped          # back up after every reboot
    ports:
      - "80:8080"                    # http://ps2sync.local
    environment:
      TZ: Europe/Oslo
    volumes:
      - /srv/ps2:/data               # <- DATA

  # The share the PS2 reads from. OPL's SMB client is ancient: force SMB1/NT1 + NTLM.
  # -s "name;path;browsable;readonly;guest" -> writable guest share "PS2".
  # Don't add -p: it chowns the folder away from ps2sync and breaks uploads.
  # 445 is bound on ALL interfaces on purpose. Binding one IP (e.g. 10.0.0.1:445) fails
  # whenever that IP is missing (PS2 off, link down), and Docker never retries a
  # container that failed to start, so Samba would stay dead until someone restarts it.
  ps2-samba:
    image: dperson/samba
    container_name: ps2-samba
    restart: unless-stopped
    ports:
      - "445:445"
    environment:
      TZ: Europe/Oslo
    volumes:
      - /srv/ps2:/ps2                # <- DATA (same folder)
    command:
      - -s
      - PS2;/ps2;yes;no;yes
      - -g
      - server min protocol = NT1
      - -g
      - client min protocol = NT1
      - -g
      - ntlm auth = yes
```

```sh
sudo mkdir -p /opt/ps2sync    # then write compose.yaml above into it
cd /opt/ps2sync && sudo docker compose up -d
```

If the pull fails with `denied`, or the machine is `x86_64`, build from source instead:

1. Run `sudo git clone https://github.com/SindreVatnaland/ps2sync.git /opt/ps2sync/src`.
2. In `compose.yaml`, replace the `image:` line with `build: ./src`.
3. Run `sudo docker compose up -d --build`. The first build takes 5–15 minutes.

Then tell ps2sync which IP the **PS2** uses to reach it. The IP goes into POPStarter's
config, so use the reserved LAN IP for option A, or `10.0.0.1` for option B. For
option B, never use the Wi-Fi IP:

```sh
curl -fsS -X POST http://localhost/api/settings \
  -H 'Content-Type: application/json' -d '{"serverLanIp":"<SMB server IP>"}'
```

**Verify:**

```sh
sudo docker compose -f /opt/ps2sync/compose.yaml ps   # both Up
curl -fsS http://localhost/health && echo OK
sudo docker port ps2-samba                            # 445/tcp -> 0.0.0.0:445
ls DATA                                               # db/ etc. created
```

Then **reboot** and run the same checks to prove it all comes back on its own.

> **Security:** this is a guest-writable SMB1 share with an open web UI. That's fine
> inside a home network. **Never** port-forward 80 or 445 on the router. To password the
> UI, add `AUTH_TOKEN: <secret>` under ps2sync's `environment`.

### 6. PS2 settings

Give the user the [PS2 table](#setting-up-the-ps2-one-time) filled in with the real SMB
server IP. For option B, also verify the link: with OPL's network started on the PS2,
`ping -c3 10.0.0.2` from the server should answer.

### 7. Hand over

Tell the user, plainly:

- **Upload games at `http://ps2sync.local`**, or at `http://<reserved IP>` if `.local`
  doesn't work on a device. Suggest bookmarking it on their phone and laptop.
- It starts by itself whenever the server is powered on. Nothing needs to be opened.

### Updating

```sh
cd /opt/ps2sync && sudo docker compose pull && sudo docker compose up -d
```

For a source build, the update is `sudo git -C src pull && sudo docker compose up -d --build`.
Afterwards, power-cycle the PS2 so it reconnects.

### Server troubleshooting

- **OPL "cannot connect to SMB server":**
  1. `docker ps`: is `ps2-samba` up?
  2. `docker port ps2-samba`: is 445 listed?
  3. Does `ping <PS2 IP>` answer?
  4. Option B: does `eth0` have `10.0.0.1`?
- **A container shows as stopped/inactive after a restart:** check
  `docker inspect <name> --format '{{.State.Error}}'`. Docker does **not** retry a
  container whose start failed, for example because a port bind failed. Fix the cause,
  then run `docker compose up -d`.
- **"Push config to PS2" times out (option B):** the container reaches `10.0.0.2` through
  the host's routing. Check `ping 10.0.0.2` and that PS2Net is running. Otherwise, write
  the two files by hand in wLaunchELF under `mc0:/POPSTARTER/`:
  - `SMBCONFIG.DAT` containing `10.0.0.1 PS2`
  - `IPCONFIG.DAT` containing `10.0.0.2 255.255.255.0 10.0.0.1`
- **Uploads fail with EACCES:** the data dir is on exFAT/NTFS, or someone added `-p` to
  the Samba command.
- **Games vanished after a reboot:** the USB drive wasn't mounted when Docker started.
  Check `df DATA` and the `RequiresMountsFor` drop-in.
- **Logs:** `docker logs ps2sync --tail 100` and `docker logs ps2-samba --tail 100`.

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

A variant with a Tailscale sidecar lives in
[`deploy/dockge-compose.yaml`](./deploy/dockge-compose.yaml). CI builds the arm64 image
and pushes it to GHCR on every push to `main`.
