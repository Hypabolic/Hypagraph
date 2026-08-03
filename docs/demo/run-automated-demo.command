#!/bin/bash
# Automated README demo for screen recording.
#
# YOU:
#   1. Start QuickTime screen recording
#   2. Run this script (double-click or ./docs/demo/run-automated-demo.command)
#   3. Stop recording when it finishes
#   4. Save to docs/demo/assets/hypagraph-demo.mp4
#
# Slow model/machine:
#   HYPA_DEMO_SLOW=1 ./docs/demo/run-automated-demo.command

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROMPT_FILE="$ROOT/docs/demo/DEMO_PROMPT.txt"
LOG="$ROOT/docs/demo/assets/last-auto-demo.log"
ASCRIPT="$ROOT/docs/demo/assets/last-auto-demo.applescript"

mkdir -p "$ROOT/docs/demo/assets"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Missing $PROMPT_FILE" >&2
  exit 1
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "pi is not on PATH. Open a normal Terminal and run: which pi" >&2
  exit 1
fi

if ! command -v osascript >/dev/null 2>&1; then
  echo "This automator only works on macOS (needs osascript)." >&2
  exit 1
fi

# Timings (seconds). Demo create is host-side; after-Run wait covers paced checks.
if [[ "${HYPA_DEMO_SLOW:-}" == "1" ]]; then
  WAIT_PI=12
  WAIT_CREATE=4
  WAIT_AFTER_RUN=55
  WAIT_GRAPH=10
  WAIT_STATUS=8
else
  WAIT_PI=8
  WAIT_CREATE=3
  WAIT_AFTER_RUN=35
  WAIT_GRAPH=8
  WAIT_STATUS=6
fi

{
  echo "repo=$ROOT"
  echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "WAIT_CREATE=$WAIT_CREATE WAIT_AFTER_RUN=$WAIT_AFTER_RUN"
} >"$LOG"

cat <<EOF

==============================================
 Hypagraph automated demo
==============================================

1) Start QuickTime screen recording NOW
   QuickTime Player → File → New Screen Recording
   Record the Terminal window (or full screen)

2) This script will drive Pi for you (~2–3 minutes)

3) When it finishes: stop recording and save to
   docs/demo/assets/hypagraph-demo.mp4

Starting in 5 seconds (switch to Terminal if needed)...
EOF
sleep 5

# Build AppleScript that reads the prompt from disk (avoids shell escaping bugs).
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
  do script "cd " & quoted form of repoPath & " && clear && echo '=== Hypagraph README demo ===' && echo 'Pi starting…' && exec pi"
end tell

delay waitPi

tell application "Terminal" to activate
delay 1

tell application "System Events"
  set the clipboard to demoPrompt
  keystroke "v" using command down
  delay 1
  keystroke return
end tell

-- /hypagraph demo creates instantly; wait for post-create dock
delay waitCreate

tell application "Terminal" to activate
delay 0.4
tell application "System Events"
  -- Run (preselected on post-create dock)
  keystroke return
end tell

-- Wait for paced checks/gates + interaction dock
delay waitAfterRun

tell application "Terminal" to activate
delay 0.4
tell application "System Events"
  -- Approve (preselected / first option)
  keystroke return
end tell

delay 6

tell application "Terminal" to activate
delay 0.4
tell application "System Events"
  keystroke "/hypagraph graph"
  delay 0.2
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
  delay 0.2
  keystroke return
end tell

delay waitStatus
EOF

echo "Driving Terminal + Pi (Accessibility permission may be required)..."
if ! osascript "$ASCRIPT"; then
  cat <<'ERR'

Automator failed. Common fixes:
  System Settings → Privacy & Security → Accessibility → enable Terminal
  If macOS asks to control System Events, click Allow
  Ensure Pi works: open Terminal, run: pi

Then try again.
ERR
  echo "failed=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG"
  exit 1
fi

echo "done=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG"

cat <<EOF

==============================================
 Demo key sequence finished
==============================================

1) Stop QuickTime (menu bar Stop square)
2) File → Save or Export As → 1080p
3) Save as:
   $ROOT/docs/demo/assets/hypagraph-demo.mp4

If Run/Approve fired too early (dock not ready yet):
  HYPA_DEMO_SLOW=1 ./docs/demo/run-automated-demo.command

Log: $LOG
EOF
