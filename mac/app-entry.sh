#!/bin/bash
# DeskSwarm.app — GUI entry point. No Terminal window; progress arrives as
# notifications and failures as a dialog.
#
# PROJECT_DIR is baked in at build time so the bundle keeps working if it is
# dragged to /Applications. If that path is gone (folder renamed or moved), it
# falls back to resolving the project relative to the bundle, which is correct
# while the .app still sits in the repo root.
set -uo pipefail

PROJECT_DIR="__PROJECT_DIR__"

if [ ! -x "$PROJECT_DIR/mac/launch.sh" ]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  PROJECT_DIR="$HERE"
fi

if [ ! -x "$PROJECT_DIR/mac/launch.sh" ]; then
  osascript -e 'display dialog "مش لاقي فولدر مشروع DeskSwarm.\n\nرجّع الـ .app جنب المشروع أو اعمله من تاني بالسكريبت." with title "DeskSwarm" buttons {"تمام"} default button "تمام" with icon stop' >/dev/null 2>&1
  exit 1
fi

exec "$PROJECT_DIR/mac/launch.sh" --gui
