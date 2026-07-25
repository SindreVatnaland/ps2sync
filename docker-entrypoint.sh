#!/bin/sh
# Start as root only long enough to make the bind-mounted /data writable by the
# unprivileged `node` user (a host bind mount's ownership overrides the image's),
# then drop to `node` for the actual app. The app never runs as root.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data 2>/dev/null || true
  # setpriv ships with util-linux in the base image — no extra dependency.
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

# Already unprivileged (e.g. compose set `user:`) — just run.
exec "$@"
