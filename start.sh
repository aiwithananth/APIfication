#!/usr/bin/env bash
# APIfication — start the control plane and web UI in the background.
#
#   ./start.sh            run setup, then start in development mode (hot reload)
#   ./start.sh --prod     run setup with a production build, then start optimised servers
#   ./start.sh --skip-setup
#
# Ports: API_PORT (default 8000), WEB_PORT (default 3000). Logs: .run/logs/. Stop with ./stop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
API="$ROOT/services/control-plane"
WEB="$ROOT/apps/web"
RUN="$ROOT/.run"
LOGS="$RUN/logs"
export API_PORT="${API_PORT:-8000}"
export WEB_PORT="${WEB_PORT:-3000}"

PROD=0
SKIP_SETUP=0
for arg in "$@"; do
  case "$arg" in
    --prod) PROD=1 ;;
    --skip-setup) SKIP_SETUP=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

is_running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}
wait_http() {  # url seconds name logfile
  local i=0
  while [ "$i" -lt "$2" ]; do
    if curl -s -o /dev/null "$1" 2>/dev/null; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  echo; echo "---- last lines of $4 ----" >&2; tail -n 25 "$4" >&2 || true
  "$ROOT/stop.sh" >/dev/null 2>&1 || true
  fail "$3 did not start within $2s (see $4)"
}

mkdir -p "$LOGS"

if is_running "$RUN/api.pid" || is_running "$RUN/web.pid"; then
  fail "APIfication is already running. Use ./stop.sh first."
fi
port_busy "$API_PORT" && fail "Port $API_PORT is in use. Stop that process or set API_PORT=…"
port_busy "$WEB_PORT" && fail "Port $WEB_PORT is in use. Stop that process or set WEB_PORT=…"

if [ "$SKIP_SETUP" = 0 ]; then
  if [ "$PROD" = 1 ]; then "$ROOT/setup.sh" --prod; else "$ROOT/setup.sh"; fi
fi
[ -x "$API/.venv/bin/uvicorn" ] || fail "Backend is not installed. Run ./setup.sh"
[ -d "$WEB/node_modules" ] || fail "Frontend is not installed. Run ./setup.sh"

# ------------------------------------------------------------------ control plane
say "Starting control plane on http://localhost:$API_PORT"
UV_ARGS="app.main:app --host 127.0.0.1 --port $API_PORT"
[ "$PROD" = 0 ] && UV_ARGS="$UV_ARGS --reload"
(
  cd "$API"
  # shellcheck disable=SC2086
  exec nohup "$API/.venv/bin/uvicorn" $UV_ARGS >"$LOGS/api.log" 2>&1
) &
echo $! > "$RUN/api.pid"

# ------------------------------------------------------------------ web UI
say "Starting web UI on http://localhost:$WEB_PORT"
NEXT_BIN="$WEB/node_modules/.bin/next"
if [ "$PROD" = 1 ]; then NEXT_CMD="start"; else NEXT_CMD="dev"; fi
(
  cd "$WEB"
  export APF_API_URL="http://127.0.0.1:$API_PORT" NEXT_TELEMETRY_DISABLED=1
  exec nohup "$NEXT_BIN" "$NEXT_CMD" -p "$WEB_PORT" >"$LOGS/web.log" 2>&1
) &
echo $! > "$RUN/web.pid"
echo "$([ "$PROD" = 1 ] && echo production || echo development)" > "$RUN/mode"

wait_http "http://127.0.0.1:$API_PORT/health" 90 "Control plane" "$LOGS/api.log"
ok "Control plane is up"
wait_http "http://127.0.0.1:$WEB_PORT/" 180 "Web UI" "$LOGS/web.log"
ok "Web UI is up"

cat <<EOF

  APIfication is running ($(cat "$RUN/mode") mode)

    Web UI          http://localhost:$WEB_PORT
    API docs        http://localhost:$API_PORT/docs
    Logs            .run/logs/api.log, .run/logs/web.log
    Demo tokens     services/control-plane/.data/dev-tokens.json

  Stop with ./stop.sh
EOF
