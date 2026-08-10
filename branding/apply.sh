#!/usr/bin/env bash
# Applies the Cockpit branding on top of the package-owned directory.
#
# Why not simply "put it beside and leave the package alone": cockpit-ws searches
# three hard-coded paths, and the only one Debian actually reaches is
# /usr/share/cockpit/branding/$ID — which belongs to the cockpit-ws package.
# (The reasoning, including the two approaches that were tried and failed, is in
# branding.css.)
#
# Hence this shape: the source of truth lives under /usr/local, where the package
# manager never goes, and this script copies it into the package directory. An
# upgrade of cockpit-ws restores the distro default — the .path unit notices and
# calls us again.
#
# Idempotent: compares content and stays silent when everything is already in
# place. That is also what breaks the self-trigger loop (our write -> .path
# fires -> us again).

set -euo pipefail

SRC="${1:-/usr/local/share/raspberry-cockpit/branding}"
DST=/usr/share/cockpit/branding/debian
LOGO_SRC=/usr/share/raspberrypi-artwork/raspberry-pi-logo.png

[ -d "$SRC" ] || { echo "no source at $SRC"; exit 1; }
[ -d /usr/share/cockpit/branding ] || { echo "Cockpit not installed — nothing to brand"; exit 0; }
[ -f "$LOGO_SRC" ] || { echo "no $LOGO_SRC (package raspberrypi-artwork) — skipping"; exit 0; }

changed=0

# Back up the distro's files ONCE, before the first overwrite.
if [ ! -d "$SRC/.orig" ]; then
    mkdir -p "$SRC/.orig"
    # -a keeps symlinks as symlinks: Debian's logo.png is a link to
    # /usr/share/pixmaps/debian-logo.png, and dereferencing it here would lose
    # the knowledge that a link was ever there.
    cp -a "$DST/." "$SRC/.orig/" 2>/dev/null || true
fi

install -d -m 0755 "$DST"

put() {  # put <source-file> <name-in-directory>
    local src="$1" dst="$DST/$2"
    # cmp FOLLOWS the symlink, so comparing against an untouched Debian logo.png
    # compares us with debian-logo.png — which is correct and intended.
    if [ -e "$dst" ] && cmp -s "$src" "$dst"; then return; fi
    # The rm is MANDATORY. Without it, install opens the SYMLINK for writing and
    # therefore overwrites /usr/share/pixmaps/debian-logo.png — a system-wide file
    # that has nothing to do with Cockpit.
    rm -f "$dst"
    install -m 0644 "$src" "$dst"
    changed=1
}

put "$SRC/branding.css" branding.css
put "$LOGO_SRC"         logo.png
put "$LOGO_SRC"         favicon.ico

if [ "$changed" = 1 ]; then
    echo "Cockpit branding applied (Raspberry Pi OS)"
else
    echo "branding already in place — nothing to do"
fi
