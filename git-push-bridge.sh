#!/bin/bash
# up | down | status for the git push loopback bridge (git-push-bridge.mjs)
set -u
SELF=git-push-bridge.mjs
PORT=3721
LOG=/tmp/opencode/git-push-bridge.log

# match the proxy process only: argv[0] ends in `node` (mise shim execs the
# real binary path), argv[1] is exactly this script; a shell running
# `node --check git-push-bridge.mjs` or an editor mentioning the file never matches
pid() { pgrep -f "^(.*/)?node [^ ]*/git-push-bridge\.mjs$"; }

case "${1:-}" in
  up)
    if [ -n "$(pid)" ]; then echo "already running (pid $(pid))"; exit 0; fi
    mkdir -p "$(dirname "$LOG")"
    # PORT pinned: ambient env must not be able to move the instance the rewrite points at
    nohup env PORT=$PORT node ~/.local/bin/"$SELF" >>"$LOG" 2>&1 &
    sleep 0.3
    [ -n "$(pid)" ] && echo "up (pid $(pid)), log $LOG" || { echo "start failed, see $LOG"; exit 1; }
    ;;
  down)
    if [ -z "$(pid)" ]; then echo "not running"; exit 0; fi
    kill $(pid); echo "stopped"
    ;;
  status)
    if [ -z "$(pid)" ]; then echo "down"; exit 1; fi
    printf 'up (pid %s), port %s: %s\n' "$(pid)" "$PORT" \
      "$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:$PORT/ || echo unreachable)"
    ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
