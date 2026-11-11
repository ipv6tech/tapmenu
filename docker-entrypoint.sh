#!/bin/sh
# Starts as root only long enough to fix ownership of the data directories
# (volumes created by older, root-running versions are root-owned), then drops
# to the unprivileged "node" user. If the container is already started as a
# non-root user (e.g. `user:` in compose), it just runs the command.
set -e

if [ "$(id -u)" = "0" ]; then
  DB_DIR="$(dirname "${DB_PATH:-/data/taproom.db}")"
  for dir in "$DB_DIR" "${UPLOADS_DIR:-$DB_DIR/uploads}"; do
    mkdir -p "$dir"
    find "$dir" ! -user node -exec chown node:node {} +
  done
  exec su-exec node "$@"
fi

exec "$@"
