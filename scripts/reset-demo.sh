#!/usr/bin/env bash
# Delete local registry, vault and demo database. The demo is re-seeded on next start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$ROOT/services/control-plane/.data"
echo "Local data removed. Restart scripts/dev.sh to re-seed the demo."
