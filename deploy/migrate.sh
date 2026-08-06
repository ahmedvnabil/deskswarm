#!/usr/bin/env bash
#
# Move a deskswarm install to another host, machines and all.
#
#   on the old host:   ./deploy/migrate.sh export /root/deskswarm-migration.tar.gz
#   copy it over:      scp old:/root/deskswarm-migration.tar.gz new:/root/
#   on the new host:   ./deploy/migrate.sh import /root/deskswarm-migration.tar.gz
#
# What travels: the database (machines, tasks, audit, shares, schedules,
# snapshots, users), every machine's home directory, the stored backups, and
# .env. What does not: the images, which the new host builds or pulls, and the
# containers, which are recreated around the restored home volumes.
#
# A machine is its home directory plus a row. Everything else about it —
# container, ports, bridge — is rebuilt from that row on arrival, which is why
# this is a few gigabytes rather than a disk image.

set -euo pipefail

MODE="${1:-}"
ARCHIVE="${2:-}"
DIR="${DESKSWARM_DIR:-/opt/deskswarm}"
COMPOSE="docker compose -f ${DIR}/docker-compose.yml"
DATA_VOLUME="deskswarm_deskswarm_data"

# Not hardcoded: DASHBOARD_PORT is a setting, and the first install this ran
# against published 7000 rather than the default.
dashboard_url() {
  local published
  published="$($COMPOSE port dashboard 7000 2>/dev/null | tail -1 | sed 's/.*://')"
  echo "http://127.0.0.1:${published:-7861}"
}

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

[ -n "$MODE" ] && [ -n "$ARCHIVE" ] || die "usage: $0 export|import <archive.tar.gz>"

# Volume in, volume out. Done in a throwaway alpine so neither side needs tar
# on the host, and -p so the desktop user still owns its own files afterwards.
vol_out() {
  docker run --rm -v "$1":/src:ro -v "$2":/out alpine \
    tar czf "/out/$1.tar.gz" -C /src . 2>/dev/null
}
vol_in() {
  docker volume create "$1" >/dev/null
  docker run --rm -v "$1":/dst -v "$2":/in alpine \
    tar xzpf "/in/$1.tar.gz" -C /dst
}

# ------------------------------------------------------------------ export

if [ "$MODE" = "export" ]; then
  [ -d "$DIR" ] || die "no deskswarm at $DIR"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  log "database"
  # VACUUM INTO is the consistent way to copy a live SQLite file. Copying it
  # while a writer holds the WAL gives you something that looks complete and
  # is not.
  $COMPOSE exec -T dashboard bun -e '
    const { Database } = require("bun:sqlite");
    new Database("/app/data/fleet.db").exec(`VACUUM INTO "/app/data/migrate.db"`);
  '
  docker cp deskswarm-dashboard-1:/app/data/migrate.db "$WORK/fleet.db"
  $COMPOSE exec -T dashboard rm -f /app/data/migrate.db
  echo "    $(du -h "$WORK/fleet.db" | cut -f1)"

  log "machine homes"
  mkdir -p "$WORK/volumes"
  for vol in $(docker volume ls --format '{{.Name}}' | grep '^deskswarm-dyn-home-' || true); do
    printf '    %-42s ' "$vol"
    vol_out "$vol" "$WORK/volumes"
    du -h "$WORK/volumes/$vol.tar.gz" | cut -f1
  done

  log "backups and settings"
  # The data volume carries the stored backups; the database inside it is the
  # live one, and the consistent copy above replaces it on the way in.
  vol_out "$DATA_VOLUME" "$WORK/volumes"
  echo "    $(du -h "$WORK/volumes/$DATA_VOLUME.tar.gz" | cut -f1) (backups)"
  [ -f "$DIR/.env" ] && cp "$DIR/.env" "$WORK/env" && echo "    .env"

  docker ps --filter 'label=deskswarm.role=desktop' --format '{{.Names}}' > "$WORK/machines.txt"

  log "packing"
  tar czf "$ARCHIVE" -C "$WORK" .
  echo "    $ARCHIVE  ($(du -h "$ARCHIVE" | cut -f1))"
  echo
  echo "    copy it over, then on the new host:"
  echo "      $0 import $(basename "$ARCHIVE")"

# ------------------------------------------------------------------ import

elif [ "$MODE" = "import" ]; then
  [ -f "$ARCHIVE" ] || die "no such archive: $ARCHIVE"
  [ -d "$DIR" ] || die "run deploy/hetzner-setup.sh first — no deskswarm at $DIR"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  log "unpacking"
  tar xzf "$ARCHIVE" -C "$WORK"

  log "stopping the dashboard"
  $COMPOSE down

  log "machine homes"
  for path in "$WORK"/volumes/deskswarm-dyn-home-*.tar.gz; do
    [ -e "$path" ] || continue
    name="$(basename "$path" .tar.gz)"
    printf '    %-42s ' "$name"
    vol_in "$name" "$WORK/volumes"
    echo "restored"
  done

  log "backups"
  docker volume rm "$DATA_VOLUME" >/dev/null 2>&1 || true
  vol_in "$DATA_VOLUME" "$WORK/volumes"

  log "database"
  # Written after the data volume is back, so it replaces the live database
  # that travelled inside it rather than being overwritten by it.
  docker run --rm -v "$DATA_VOLUME":/d -v "$WORK":/in alpine \
    sh -c 'cp /in/fleet.db /d/fleet.db && rm -f /d/fleet.db-wal /d/fleet.db-shm'
  echo "    replaced with the consistent copy"

  if [ -f "$WORK/env" ]; then
    log "settings"
    # Keep this host's answers to "where am I" — the address and the port are
    # about the new server, everything else came with the install.
    for key in DASHBOARD_PORT DESKSWARM_PUBLIC_HOST; do
      grep "^${key}=" "$DIR/.env" 2>/dev/null || true
    done > "$WORK/local-keys"
    grep -vE '^(DASHBOARD_PORT|DESKSWARM_PUBLIC_HOST)=' "$WORK/env" > "$DIR/.env.new"
    cat "$WORK/local-keys" >> "$DIR/.env.new"
    mv "$DIR/.env" "$DIR/.env.before-migration" 2>/dev/null || true
    mv "$DIR/.env.new" "$DIR/.env"
    chmod 600 "$DIR/.env"
    echo "    merged; the old one is at .env.before-migration"
  fi

  log "starting"
  $COMPOSE up -d --build
  for _ in $(seq 1 60); do
    sleep 2
    curl -fsS -o /dev/null --max-time 3 "$(dashboard_url)/health" 2>/dev/null && break
  done

  log "rebuilding the machines"
  # The rows arrived with the database and their home volumes are back, but no
  # containers exist yet. `restart` is destroy-and-create with keep_home, which
  # is exactly that: new containers around the restored homes.
  TOKEN="$(grep '^DASHBOARD_TOKEN=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
  BASE="$(dashboard_url)"
  IDS="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/computers" |
         grep -oE '"id":[0-9]+' | cut -d: -f2 || true)"
  for id in $IDS; do
    printf '    machine %-4s ' "$id"
    if curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
         "$BASE/api/v1/computers/$id/restart" >/dev/null 2>&1; then
      echo "rebuilt"
    else
      echo "FAILED — rebuild it from the dashboard"
    fi
  done

  log "done"
  $COMPOSE ps --format '    {{.Name}}  {{.Status}}'
  docker ps --filter 'label=deskswarm.role=desktop' --format '{{.Names}}' | sed 's/^/    /'
  echo
  echo "    Sign in with the same username and password as the old host —"
  echo "    the users table travelled with the database."

else
  die "usage: $0 export|import <archive.tar.gz>"
fi
