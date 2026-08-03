#!/bin/bash
# Real Pi TUI demo for screen recording.
#
# Loads Hypagraph with:  pi -e ./extensions/hypagraph.ts
# (optional skill dir for guidance: --skill ./skills)
#
# YOU:
#   1. Start QuickTime screen recording
#   2. Run this script
#   3. Stop when the timed key sequence ends
#   4. Save to docs/demo/assets/hypagraph-demo.mp4
#
# Slow model:
#   HYPA_DEMO_SLOW=1 ./docs/demo/run-real-pi-demo.command

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROMPT_FILE="$ROOT/docs/demo/DEMO_PROMPT.txt"
ASCRIPT="$ROOT/docs/demo/assets/last-real-pi-demo.applescript"
LOG="$ROOT/docs/demo/assets/last-real-pi-demo.log"
EXT="$ROOT/extensions/hypagraph.ts"
SKILLS="$ROOT/skills"

mkdir -p "$ROOT/docs/demo/assets"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Missing $PROMPT_FILE" >&2
  exit 1
fi

if [[ ! -f "$EXT" ]]; then
  echo "Missing extension: $EXT" >&2
  exit 1
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "pi is not on PATH" >&2
  exit 1
fi

# Canonical launch line for this repo (relative paths; run from ROOT).
PI_CMD="pi -e ./extensions/hypagraph.ts --skill ./skills"

{
  echo "repo=$ROOT"
  echo "pi_cmd=$PI_CMD"
  echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$LOG"

# /hypagraph demo is host-side (no model create). Hold after Run covers paced checks.
if [[ "${HYPA_DEMO_SLOW:-}" == "1" ]]; then
  WAIT_PI=12
  WAIT_CREATE=4
  WAIT_AFTER_RUN=55
  WAIT_GRAPH=12
  WAIT_STATUS=8
else
  WAIT_PI=8
  WAIT_CREATE=3
  WAIT_AFTER_RUN=35
  WAIT_GRAPH=8
  WAIT_STATUS=6
fi

cat <<EOF

==============================================
 Real Pi + Hypagraph demo
==============================================

Launch: $PI_CMD
Prompt: /hypagraph demo showcase (no model authoring)

1) Start QuickTime recording NOW
2) Automator starts in 5 seconds
3) Stop recording when key sequence finishes

Timings: create wait ${WAIT_CREATE}s, after Run ${WAIT_AFTER_RUN}s
(SLOW: HYPA_DEMO_SLOW=1 — longer holds between graph steps)

EOF
sleep 5

cat >"$ASCRIPT" <<EOF
set repoPath to "$ROOT"
set promptPath to "$PROMPT_FILE"
set waitPi to $WAIT_PI
set waitCreate to $WAIT_CREATE
set waitAfterRun to $WAIT_AFTER_RUN
set waitGraph to $WAIT_GRAPH
set waitStatus to $WAIT_STATUS

set demoPrompt to read POSIX file promptPath as «class utf8»

tell application "Terminal"
  activate
  -- Real interactive Pi with Hypagraph loaded via -e
  do script "cd " & quoted form of repoPath & " && clear && echo '=== Real Pi Hypagraph demo ===' && echo 'pi -e ./extensions/hypagraph.ts --skill ./skills' && exec pi -e ./extensions/hypagraph.ts --skill ./skills"
end tell

delay waitPi

tell application "Terminal" to activate
delay 1

tell application "System Events"
  set the clipboard to demoPrompt
  keystroke "v" using command down
  delay 1.2
  keystroke return
end tell

-- /hypagraph demo creates instantly; wait for post-create dock
delay waitCreate

tell application "Terminal" to activate
delay 0.5
tell application "System Events"
  keystroke return
end tell

-- Paced check/gate steps + interaction dock
delay waitAfterRun

tell application "Terminal" to activate
delay 0.5
tell application "System Events"
  keystroke return
end tell

delay 6

tell application "Terminal" to activate
delay 0.4
tell application "System Events"
  keystroke "/hypagraph graph"
  delay 0.25
  keystroke return
end tell

delay waitGraph

tell application "Terminal" to activate
delay 0.3
tell application "System Events"
  keystroke "q"
end tell

delay 2

tell application "Terminal" to activate
delay 0.3
tell application "System Events"
  keystroke "/hypagraph status"
  delay 0.25
  keystroke return
end tell

delay waitStatus
EOF

echo "Driving real Pi TUI (Accessibility for Terminal may be required)..."
if ! osascript "$ASCRIPT"; then
  cat <<'ERR'

Failed to drive Terminal keys.
  System Settings → Privacy & Security → Accessibility → enable Terminal

ERR
  exit 1
fi

echo "done=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG"

cat <<EOF

==============================================
 Real Pi demo key sequence finished
==============================================

1) Stop QuickTime
2) Save as: $ROOT/docs/demo/assets/hypagraph-demo.mp4

Slow model:
  HYPA_DEMO_SLOW=1 ./docs/demo/run-real-pi-demo.command

Manual:
  cd $ROOT
  pi -e ./extensions/hypagraph.ts --skill ./skills

Log: $LOG
EOF
