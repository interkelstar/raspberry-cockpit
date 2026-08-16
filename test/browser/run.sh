#!/usr/bin/env bash
# Touch-input test for the desktop tab, driven through a real browser.
#
# `npm test` covers the gesture recogniser as pure logic. This covers what the
# unit tests cannot: that a finger on glass produces the RIGHT BYTES on the wire.
# It runs the real app.js against the real noVNC, feeds it real touch events over
# the Chrome DevTools Protocol, and decodes the RFB pointer messages that come
# out — coordinates and button mask both.
#
# It caught two things that every "the event was dispatched" test would have
# called green: a right click arriving as a middle click (DOM numbers buttons
# differently in `button` and `buttons`), and a two-finger tap being dropped
# because the tap window was measured from the first finger.
#
# Not part of `npm test`: it needs chromium and takes ~30s.
#
#   ./test/browser/run.sh                 # uses the installed plugin's noVNC
#   NOVNC=/path/to/novnc ./test/browser/run.sh

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NOVNC="${NOVNC:-/usr/share/cockpit/desktop/novnc}"
CDP_PORT="${CDP_PORT:-9333}"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

CHROME=""
for c in chromium-browser chromium google-chrome chrome; do
    command -v "$c" >/dev/null 2>&1 && { CHROME="$c"; break; }
done
[ -n "$CHROME" ] || die "no chromium/chrome on PATH"
command -v node >/dev/null 2>&1 || die "node is required"
[ -d "$NOVNC/core" ] || die "no noVNC at $NOVNC — install the plugin first, or set NOVNC=..."

WORK="$(mktemp -d)"
PROFILE="$(mktemp -d)"
CHROME_PID=""
cleanup() {
    [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
    rm -rf "$WORK" "$PROFILE"
}
trap cleanup EXIT

say "Staging the page"
cp "$SRC"/desktop/*.js "$SRC"/desktop/style.css "$WORK"/
cp "$SRC"/test/browser/harness.html "$WORK"/index.html
ln -s "$NOVNC" "$WORK/novnc"
# One diagnostic shim, applied to the COPY only: it records the recogniser's
# decisions so a failure says "it decided click:2" rather than just "no bytes".
# The shipped app.js stays free of test hooks.
sed -i 's|^function runIntents(list) {|function runIntents(list) {\n  if (window.__intents \&\& list.length) window.__intents.push(...list.map(i => i.t + (i.button !== undefined ? ":" + i.button : "")));|' "$WORK/app.js"
grep -q "__intents" "$WORK/app.js" || die "could not install the diagnostic shim — has runIntents been renamed?"

say "Starting chromium"
# --allow-file-access-from-files and --disable-web-security: the page is an ES
# module graph loaded over file://, which is cross-origin to itself otherwise.
# A local http server would be the obvious alternative and is NOT usable here:
# recent Chrome blocks loopback subresource loads (Local Network Access), so the
# page silently never loads and every later CDP command hangs with no error.
"$CHROME" --headless=new --remote-debugging-port="$CDP_PORT" --no-sandbox --disable-gpu \
    --allow-file-access-from-files --disable-web-security --no-first-run \
    --user-data-dir="$PROFILE" about:blank >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!

for _ in $(seq 40); do
    curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
    sleep 0.5
done
curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || die "chromium did not open a debug port; see $WORK/chrome.log"

say "Driving touch input"
CDP_PORT="$CDP_PORT" HARNESS_URL="file://$WORK/index.html" node "$SRC/test/browser/drive.mjs"
