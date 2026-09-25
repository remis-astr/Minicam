#!/bin/bash
# Live-stacking bridge: pulls new minicam timelapse frames from the Pi's SD
# card into a local folder that Astro Live Stacker (ALS) scans.
#
# Runs entirely from the Mac (or any SSH client) — no changes needed on the
# Pi beyond an authorized SSH key. Capture on the Pi is fully independent of
# this script: it writes to /timelapse regardless of whether this is running,
# and rsync catches up on whatever was missed once it (re)connects.
#
# One-time setup, from this machine:
#   ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519   # skip if you already have a key
#   ssh-copy-id admin@allsky.local                      # use admin@192.168.4.1 if mDNS doesn't resolve
#
# Then, connected to the AllskyCam WiFi:
#   ./als_sync.sh
#
# Sync is gated on the Pi's own timelapse state (/timelapse/status): it only
# pulls while a timelapse is running, so starting/stopping the timelapse from
# the minicam web page is what turns this on and off.

set -uo pipefail

PI_HOST="admin@allsky.local"
SCAN_DIR="$HOME/ALS_Scan"
POLL_INTERVAL=3

mkdir -p "$SCAN_DIR"

echo "Syncing /timelapse from $PI_HOST into $SCAN_DIR (Ctrl+C to stop)"

while true; do
    status=$(curl -s --max-time 2 "http://${PI_HOST#*@}:8000/timelapse/status" 2>/dev/null || echo '{}')
    if echo "$status" | grep -q '"running": *true'; then
        rsync -az --exclude='preview.jpg' --exclude='session_info.json' \
            "${PI_HOST}:/timelapse/" "$SCAN_DIR/" 2>&1 || true
    fi
    sleep "$POLL_INTERVAL"
done
