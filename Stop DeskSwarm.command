#!/bin/bash
# Stops the DeskSwarm dashboard. Desktop machines, their home volumes and all
# backups are left untouched — this is `docker compose down`, not `down -v`.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

clear 2>/dev/null || true
echo "بوقّف DeskSwarm..."
echo ""

if ! docker info >/dev/null 2>&1; then
  echo "✓ الـ Docker daemon أصلًا مش شغّال — مفيش حاجة توقّف."
else
  docker compose down
  echo ""
  echo "✓ اتوقّف. الماكينات وملفاتها زي ما هي."
fi

echo ""
read -n 1 -s -r -p "اضغط أي زر للخروج..."
echo ""
