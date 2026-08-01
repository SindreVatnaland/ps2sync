# syntax=docker/dockerfile:1
# ps2sync — multi-stage build, ARM64 target (Raspberry Pi 5). Sibling of wii-sync.
# Build on the Pi, or cross-build with `docker buildx --platform linux/arm64`.

# ---------------------------------------------------------------------------
# Stage 1: cue2pops-builder — compile cue2pops (PS1 .bin/.cue -> .VCD) from source.
# Tiny C tool; gcc/make/git is all it needs. Output binary lands at /src/cue2pops.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS cue2pops-builder
ARG CUE2POPS_REPO=https://github.com/tallero/cue2pops-linux
# ponytail: clone tip of default branch (shallow). Ceiling: not reproducible across
# rebuilds. Upgrade path: pin a --build-arg ref and `git checkout` it before `make`.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends gcc libc6-dev make git ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    git clone --depth 1 "$CUE2POPS_REPO" /src; \
    cd /src; \
    make; \
    test -x /src/cue2pops

# ---------------------------------------------------------------------------
# Stage 2: node-builder — install deps, compile TypeScript -> dist.
# python3/make/g++ are here only so better-sqlite3 can build its native addon
# if no prebuilt binary matches; none of that tooling ships in the runtime.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS node-builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# package-lock.json may not exist yet; the glob keeps the COPY optional.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build
# Drop dev dependencies; keep the compiled better-sqlite3 native binary.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 3: runtime — slim, non-root, only the artefacts + CLI tools it shells to.
# p7zip-full (archive extraction), mame-tools (chdman, for .chd expansion),
# cue2pops (PS1 conversion, from stage 1).
# ponytail: p7zip-full covers .zip/.7z; .rar needs the non-free p7zip-rar codec.
# Ceiling: .rar uploads fail to extract. Upgrade path: enable contrib repo + add p7zip-rar.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends p7zip-full mame-tools ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# cue2pops binary from stage 1 (PS1 .bin/.cue -> POPStarter .VCD).
COPY --from=cue2pops-builder /src/cue2pops /usr/local/bin/cue2pops

WORKDIR /app
COPY --from=node-builder /app/package.json ./package.json
COPY --from=node-builder /app/node_modules ./node_modules
COPY --from=node-builder /app/dist ./dist
COPY --from=node-builder /app/public ./public

# ponytail: reuse the base image's built-in unprivileged `node` user (uid 1000)
# instead of adduser'ing a fresh one. /data is the bind-mount target; creating it
# here just gives sane perms when the container runs without a mount.
RUN mkdir -p /data && chown -R node:node /app /data

# Entrypoint starts as root, chowns the (possibly root-owned) bind-mounted /data
# to node, then drops to node. Runs as root ONLY for that chown; the app is node.
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]

EXPOSE 8080

# GET /health returns {"ok":true} (src/routes/api.ts). Honour a custom PORT via env.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
