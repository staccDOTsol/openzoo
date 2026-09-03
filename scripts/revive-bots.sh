#!/bin/bash
# Minutely cron: keep Grok Bot + the openzoo hijack alive, and keep every bot
# on a wakeup timer. Install:  * * * * * /Users/stacc/openzoo-shim/scripts/revive-bots.sh
# Restarting kills the in-flight turn, so it only restarts when something is
# actually dead: hijack not on :8443, or Grok Bot.app not running.
set -u
SHIM="$(cd "$(dirname "$0")/.." && pwd)"
export HOME="${HOME:-/Users/$(whoami)}"
NVM_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="${NVM_BIN:+$NVM_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
NODE="${NVM_BIN:+$NVM_BIN/}node"
LOG="$HOME/.openzoo/revive.log"
mkdir -p "$HOME/.openzoo"
EVERY="${OZ_REVIVE_EVERY:-5m}"

hijack_up() { nc -z 127.0.0.1 8443 >/dev/null 2>&1; }
app_up() { pgrep -x "Grok Bot" >/dev/null 2>&1; }

if ! hijack_up || ! app_up; then
  echo "$(date '+%F %T') dead: hijack=$(hijack_up && echo up || echo down) app=$(app_up && echo up || echo down) -> restart" >> "$LOG"
  pkill -f "bin/openzoo.js bot" 2>/dev/null
  sleep 2
  nohup "$NODE" "$SHIM/bin/openzoo.js" bot --no-quit >> "$HOME/.openzoo/bot.log" 2>&1 &
  exit 0
fi

# alive: make sure every bot has a wakeup timer
out="$(curl -sk -m 20 -X POST https://127.0.0.1:8443/api/ozRevive -H 'content-type: application/json' -d "{\"every\":\"$EVERY\"}" 2>&1)"
case "$out" in
  *'"armed":[]'*) ;;                       # nothing to do, stay quiet
  *) echo "$(date '+%F %T') revive $out" >> "$LOG" ;;
esac
