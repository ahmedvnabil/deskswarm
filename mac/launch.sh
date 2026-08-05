#!/bin/bash
# DeskSwarm — macOS launcher core.
#
# Shared by both entry points so the boot logic lives in exactly one place:
#   Start DeskSwarm.command  -> --tty   (visible Terminal, follows the log)
#   DeskSwarm.app            -> --gui   (no Terminal, opens an app window)
#
# Brings the stack up with `docker compose`, waits for /health, then opens the
# dashboard. Everything it does is idempotent: run it twice and the second run
# just reattaches to what is already up.

set -uo pipefail

MODE="${1:---tty}"

# The project root is the parent of the directory this script lives in.
# Resolved from the script's own path so moving the folder never breaks it.
SELF="${BASH_SOURCE[0]}"
DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
cd "$DIR" || exit 1

APP_NAME="DeskSwarm"
LOG_DIR="$HOME/Library/Logs/DeskSwarm"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/launch.log"

# A double-clicked .command / .app runs a non-login shell: Homebrew and
# OrbStack's docker shim are not on PATH by default.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

{
  echo ""
  echo "================ $(date '+%Y-%m-%d %H:%M:%S') ($MODE) ================"
} >>"$LOG"


# ---------------------------------------------------------------- output ----

log() { echo "$*" >>"$LOG"; }

# Progress. In tty mode it prints; in gui mode it becomes a notification, since
# the first build takes minutes and a silent Dock icon looks like a hang.
say() {
  log "$*"
  if [ "$MODE" = "--tty" ]; then
    echo "$*"
  else
    osascript -e "display notification \"$1\" with title \"$APP_NAME\"" >/dev/null 2>&1
  fi
}

# Fatal. tty waits for a keypress so the window does not vanish with the error;
# gui shows a dialog offering to open the log.
die() {
  log "FATAL: $*"
  if [ "$MODE" = "--tty" ]; then
    echo ""
    echo "❌ $*"
    echo ""
    echo "   اللوج: $LOG"
    echo ""
    read -n 1 -s -r -p "اضغط أي زر للخروج..."
    echo ""
  else
    local choice
    choice=$(osascript -e "display dialog \"$*\" with title \"$APP_NAME\" buttons {\"افتح اللوج\", \"تمام\"} default button \"تمام\" with icon stop" 2>/dev/null)
    case "$choice" in *"افتح اللوج"*) open -a Console "$LOG" 2>/dev/null || open "$LOG" ;; esac
  fi
  exit 1
}


# ------------------------------------------------------------ preflight -----

if [ "$MODE" = "--tty" ]; then
  clear 2>/dev/null || true
  echo "================================================="
  echo "  $APP_NAME"
  echo "  $DIR"
  echo "================================================="
  echo ""
fi

command -v docker >/dev/null 2>&1 || die "Docker مش متسطّب.
سطّب OrbStack (أخف وأسرع) من https://orbstack.dev
أو Docker Desktop من https://docker.com/products/docker-desktop"

# Is the daemon reachable? If not, start whichever runtime is installed and
# wait for it — a cold OrbStack takes a few seconds, Docker Desktop longer.
if ! docker info >/dev/null 2>&1; then
  RUNTIME=""
  [ -d "/Applications/OrbStack.app" ] && RUNTIME="OrbStack"
  [ -z "$RUNTIME" ] && [ -d "/Applications/Docker.app" ] && RUNTIME="Docker"
  [ -n "$RUNTIME" ] || die "Docker متسطّب بس الـ daemon مش شغّال، ومش لاقي OrbStack ولا Docker Desktop عشان أفتحهم.
شغّل الـ Docker runtime بتاعك يدويًا وجرّب تاني."

  say "⏳ بشغّل $RUNTIME..."
  open -ga "$RUNTIME" 2>>"$LOG"

  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  docker info >/dev/null 2>&1 || die "$RUNTIME مافتحش خلال دقيقتين. افتحه بنفسك وجرّب تاني."
fi

docker compose version >/dev/null 2>&1 \
  || die "docker compose مش موجود. حدّث الـ Docker runtime بتاعك."

say "✓ Docker شغّال ($(docker info --format '{{.Name}}' 2>/dev/null))"


# ----------------------------------------------------------------- port -----

# If the dashboard is already up, reuse the port it is actually published on —
# picking a "free" one would pointlessly recreate the container somewhere else.
PORT="$(docker compose port dashboard 7000 2>/dev/null | tail -1 | sed 's/.*://' | tr -d '[:space:]')"

if [ -z "$PORT" ]; then
  is_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
  PORT="${DASHBOARD_PORT:-7861}"
  WANTED="$PORT"
  while ! is_free "$PORT"; do PORT=$((PORT + 1)); done
  [ "$PORT" != "$WANTED" ] && say "⚠️  بورت $WANTED مشغول — هستخدم $PORT بدله."
fi

# compose reads this for the published port; a shell variable wins over .env.
export DASHBOARD_PORT="$PORT"
URL="http://127.0.0.1:$PORT"   # 127.0.0.1, not localhost: macOS tries ::1 first


# ------------------------------------------------------------------ up ------

# Decide whether to build. Passing --build unconditionally is wrong here:
# buildkit stamps a fresh attestation into the manifest on every run, so even a
# fully cached build yields a new image digest, and compose then RECREATES the
# container — a needless restart on every single launch. So build only when
# there is no image yet, or when dashboard sources are newer than the image.
# "Is the image stale?" is answered against a stamp file we touch after every
# successful build, not against the image's own timestamp: docker reports that
# in local time with an offset (+04:00), and parsing it as UTC put the image
# hours in the future, so sources never looked newer and it never rebuilt.
# `find -newer` compares two files on the same clock and has nothing to parse.
NEED_BUILD=0
STAMP="$DIR/.deskswarm-build-stamp"

if ! docker image inspect deskswarm-dashboard >/dev/null 2>&1; then
  NEED_BUILD=1
  say "📦 أول تشغيل — ببني الصورة، ممكن تاخد دقيقتين..."
elif [ ! -f "$STAMP" ] || [ -n "$(find dashboard -type f -newer "$STAMP" 2>/dev/null | head -1)" ]; then
  NEED_BUILD=1
  say "🔁 الكود اتغيّر — بعيد بناء الصورة..."
fi

say "🚀 بشغّل $APP_NAME على $URL"

BUILD_FLAG=""
[ "$NEED_BUILD" -eq 1 ] && BUILD_FLAG="--build"

if [ "$MODE" = "--tty" ]; then
  docker compose up -d $BUILD_FLAG 2>&1 | tee -a "$LOG"
  STATUS=${PIPESTATUS[0]}
else
  docker compose up -d $BUILD_FLAG >>"$LOG" 2>&1
  STATUS=$?
fi
[ "$STATUS" -eq 0 ] || die "فشل تشغيل الحاويات. شوف اللوج:
$LOG"

# Only stamp after compose actually succeeded, so a failed build is retried
# on the next launch instead of being remembered as done.
[ "$NEED_BUILD" -eq 1 ] && touch "$STAMP"


# --------------------------------------------------------------- health -----

say "⏳ بستنى الداشبورد يرد..."

# An explicit loop, not `curl --retry`: while the container is still booting,
# Docker's port proxy accepts the connection and then resets it, which curl
# reports as error 56 — and 56 is NOT one of the errors --retry retries, so a
# single early probe would abort the whole launch. The dashboard can also need
# a restart cycle on its first boot after a schema migration, which this rides
# out too. 90 x 2s ceiling.
READY=0
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null --max-time 4 "$URL/health" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 2
done

[ "$READY" -eq 1 ] || die "الحاويات اشتغلت بس الداشبورد مردّش على $URL خلال 3 دقايق.
جرّب: docker compose logs dashboard"

say "✓ $APP_NAME جاهز على $URL"


# ------------------------------------------------------------- open UI ------

open_ui() {
  if [ "$MODE" = "--gui" ] && [ -d "/Applications/Google Chrome.app" ]; then
    # App mode: own window, no tabs or address bar — reads as an application
    # rather than a browser tab. Separate profile so it does not inherit or
    # disturb the user's normal Chrome session.
    open -na "Google Chrome" --args \
      --app="$URL" \
      --user-data-dir="$HOME/Library/Application Support/DeskSwarm/chrome" \
      --no-first-run --no-default-browser-check 2>>"$LOG" && return 0
  fi
  open "$URL"
}
open_ui


# ---------------------------------------------------------------- after -----

if [ "$MODE" = "--tty" ]; then
  echo ""
  echo "-------------------------------------------------"
  echo "  الداشبورد شغّال على $URL"
  echo ""
  echo "  الحاويات شغّالة في الخلفية — قفل الشباك ده"
  echo "  أو Ctrl+C بيوقّف عرض اللوج بس، مش الأبلكيشن."
  echo "  عشان توقّفه فعلًا: \"Stop DeskSwarm.command\""
  echo "-------------------------------------------------"
  echo ""
  docker compose logs -f dashboard
fi
