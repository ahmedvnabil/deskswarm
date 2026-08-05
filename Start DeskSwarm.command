#!/bin/bash
# Double-click launcher for DeskSwarm (macOS) — visible Terminal.
# Use this one when you want to watch the log or debug a failed start.
# For the no-Terminal version, open DeskSwarm.app instead.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/mac/launch.sh" --tty
