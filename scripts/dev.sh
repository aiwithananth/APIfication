#!/usr/bin/env bash
# Kept for compatibility — use ./start.sh and ./stop.sh at the repository root.
exec "$(cd "$(dirname "$0")/.." && pwd)/start.sh" "$@"
