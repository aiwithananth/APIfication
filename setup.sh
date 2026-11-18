#!/usr/bin/env bash
# APIfication — install / update dependencies.
#
#   ./setup.sh            install backend + frontend dependencies (skips anything already up to date)
#   ./setup.sh --prod     also build the web UI for production (used by ./start.sh --prod)
#   ./setup.sh --force    reinstall everything
#
# Works on macOS (bash 3.2) and Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
API="$ROOT/services/control-plane"
WEB="$ROOT/apps/web"
RUN="$ROOT/.run"
API_PORT="${API_PORT:-8000}"

PROD=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --prod) PROD=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

checksum() { cat "$@" 2>/dev/null | cksum | awk '{print $1}'; }

mkdir -p "$RUN"

# ------------------------------------------------------------------ Python
find_python() {
  for c in "${PYTHON:-}" python3.13 python3.12 python3.11 python3.10 python3; do
    [ -z "$c" ] && continue
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      echo "$c"; return 0
    fi
  done
  return 1
}
PY="$(find_python)" || fail "Python 3.10+ is required (macOS: brew install python@3.12). Set PYTHON=/path/to/python to choose one."

VENV="$API/.venv"
if [ -x "$VENV/bin/python" ] && ! "$VENV/bin/python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  say "Existing virtualenv uses an old Python; recreating it"
  rm -rf "$VENV"
fi
if [ ! -x "$VENV/bin/python" ] || [ "$FORCE" = 1 ]; then
  say "Creating Python virtualenv with $("$PY" --version)"
  rm -rf "$VENV"
  "$PY" -m venv "$VENV"
fi

REQ_SUM="$(checksum "$API/requirements.txt" "$API/requirements-dev.txt")"
if [ "$FORCE" = 1 ] || [ "$(cat "$RUN/.pip-stamp" 2>/dev/null || true)" != "$REQ_SUM" ]; then
  say "Installing backend dependencies"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
  "$VENV/bin/python" -m pip install --quiet -r "$API/requirements-dev.txt"
  echo "$REQ_SUM" > "$RUN/.pip-stamp"
fi
ok "Backend ready ($("$VENV/bin/python" --version))"

if [ ! -f "$API/.env" ] && [ -f "$API/.env.example" ]; then
  cp "$API/.env.example" "$API/.env"
  ok "Created services/control-plane/.env from .env.example"
fi

# ------------------------------------------------------------------ Node
command -v node >/dev/null 2>&1 || fail "Node.js 20+ is required (macOS: brew install node)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20+ is required (found $(node -v))."
command -v npm >/dev/null 2>&1 || fail "npm is required."

PKG_SUM="$(checksum "$WEB/package.json" "$WEB/package-lock.json")"
if [ "$FORCE" = 1 ] || [ ! -d "$WEB/node_modules" ] || [ "$(cat "$RUN/.npm-stamp" 2>/dev/null || true)" != "$PKG_SUM" ]; then
  say "Installing frontend dependencies"
  (cd "$WEB" && npm install --no-audit --no-fund --loglevel=error)
  PKG_SUM="$(checksum "$WEB/package.json" "$WEB/package-lock.json")"
  echo "$PKG_SUM" > "$RUN/.npm-stamp"
fi
ok "Frontend ready (Node $(node -v))"

# ------------------------------------------------------------------ Production build
if [ "$PROD" = 1 ]; then
  SRC_SUM="$( (find "$WEB/app" "$WEB/components" "$WEB/lib" -type f -exec cksum {} + ; echo "$API_PORT") | cksum | awk '{print $1}')"
  if [ "$FORCE" = 1 ] || [ ! -f "$WEB/.next/BUILD_ID" ] || [ "$(cat "$RUN/.build-stamp" 2>/dev/null || true)" != "$SRC_SUM" ]; then
    say "Building web UI for production"
    (cd "$WEB" && APF_API_URL="http://127.0.0.1:$API_PORT" NEXT_TELEMETRY_DISABLED=1 npm run build --silent)
    echo "$SRC_SUM" > "$RUN/.build-stamp"
  fi
  ok "Production build ready"
fi

ok "Setup complete"
