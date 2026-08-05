#!/bin/bash
# Assembles DeskSwarm.app in the project root from the templates in this
# directory. The bundle is a build artifact (it hardcodes this machine's path),
# so it is gitignored — rerun this after cloning or moving the project.
#
#   ./mac/build-app.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$DIR/DeskSwarm.app"

# An app launched from Finder gets no TCC grant for Desktop/Documents/Downloads.
# It can stat this project but not READ it, so the launcher dies on its very
# first file access: `open` returns 0, no window appears, nothing is logged.
# Nothing inside the bundle can work around that, so refuse to build one that
# is guaranteed to fail rather than ship a silent no-op.
case "$DIR/" in
  "$HOME/Downloads/"*|"$HOME/Desktop/"*|"$HOME/Documents/"*|"$HOME/Movies/"*|"$HOME/Pictures/"*)
    echo "✋ المشروع في فولدر محمي بـ macOS (Downloads / Desktop / Documents)."
    echo "   الأبلكيشن هيتفتح ومايشتغلش — ممنوع يقرا الملفات من هناك."
    echo ""
    echo "   انقله لمكان غير محمي وشغّل السكريبت تاني:"
    echo "     mv \"$DIR\" ~/Developer/ && ~/Developer/$(basename "$DIR")/mac/build-app.sh"
    echo ""
    echo "   (\"Start DeskSwarm.command\" شغّال في الحالتين — بيرث صلاحيات Terminal.)"
    exit 1
    ;;
esac

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$DIR/mac/Info.plist"      "$APP/Contents/Info.plist"
cp "$DIR/mac/DeskSwarm.icns"  "$APP/Contents/Resources/DeskSwarm.icns"

# Bake this checkout's absolute path into the entry point so the bundle still
# finds the project after being dragged to /Applications.
sed "s|__PROJECT_DIR__|$DIR|" "$DIR/mac/app-entry.sh" > "$APP/Contents/MacOS/DeskSwarm"

chmod +x "$APP/Contents/MacOS/DeskSwarm" "$DIR/mac/launch.sh"
chmod +x "$DIR/Start DeskSwarm.command" "$DIR/Stop DeskSwarm.command"

# Nothing here was downloaded, but strip the flag anyway: a project that
# arrived as a zip carries it, and Gatekeeper then blocks the first launch.
xattr -dr com.apple.quarantine "$APP" "$DIR/Start DeskSwarm.command" \
      "$DIR/Stop DeskSwarm.command" 2>/dev/null || true

# Ad-hoc signature (`--sign -` is local, not a developer certificate). Not
# strictly required — an unsigned bundle does launch here — but it gives the
# app a stable identity across rebuilds, which keeps macOS from re-asking for
# any permission it has already been granted.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 \
  || echo "⚠️  codesign فشل — كمّل عادي، بس استخدم Start DeskSwarm.command لو الأبلكيشن ما فتحش."

# Nudge Finder to pick up the icon instead of showing a stale/generic one.
touch "$APP"

echo "✓ $APP"
