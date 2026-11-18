#!/usr/bin/env bash
# APIfication — stop the servers started by ./start.sh.
#
#   ./stop.sh           graceful stop (SIGTERM, then SIGKILL after 10s)
#   ./stop.sh --ports   also stop anything still listening on API_PORT / WEB_PORT
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
RUN="$ROOT/.run"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"

BY_PORT=0
for arg in "$@"; do
  case "$arg" in
    --ports) BY_PORT=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m→\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

# All descendants of a PID (uvicorn --reload and next spawn child processes).
descendants() {
  local kids k
  kids="$(pgrep -P "$1" 2>/dev/null || true)"
  for k in $kids; do
    echo "$k"
    descendants "$k"
  done
}

stop_tree() {  # pid name
  local pid="$1" name="$2" all i
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  all="$pid $(descendants "$pid" | tr '\n' ' ')"
  say "Stopping $name (pid $pid)"
  # shellcheck disable=SC2086
  kill -TERM $all 2>/dev/null || true
  i=0
  while [ "$i" -lt 10 ]; do
    local alive=0 p
    for p in $all; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ "$alive" = 0 ] && return 0
    sleep 1; i=$((i + 1))
  done
  # shellcheck disable=SC2086
  kill -KILL $all 2>/dev/null || true
  return 0
}

stopped=0
for svc in web api; do
  f="$RUN/$svc.pid"
  name=$([ "$svc" = api ] && echo "control plane" || echo "web UI")
  if [ -f "$f" ]; then
    if stop_tree "$(cat "$f")" "$name"; then
      ok "Stopped $name"; stopped=1
    else
      echo "  $name was not running"
    fi
    rm -f "$f"
  fi
done
rm -f "$RUN/mode"

listeners() { command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }

for port in "$API_PORT" "$WEB_PORT"; do
  pids="$(listeners "$port")"
  [ -z "$pids" ] && continue
  if [ "$BY_PORT" = 1 ]; then
    for p in $pids; do stop_tree "$p" "process on port $port" && stopped=1; done
    ok "Freed port $port"
  else
    echo "  Port $port is still in use (pid $(echo $pids | tr '\n' ' ')). Run ./stop.sh --ports to stop it."
  fi
done

[ "$stopped" = 1 ] && ok "APIfication stopped" || echo "Nothing to stop."
exit 0
