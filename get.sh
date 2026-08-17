#!/usr/bin/env bash
# One-line bootstrap:
#
#   curl -fsSL https://raw.githubusercontent.com/interkelstar/raspberry-cockpit/master/get.sh | bash
#
# Arguments pass through to install.sh:
#
#   curl -fsSL .../get.sh | bash -s -- --only desktop --port 5902
#
# This exists because install.sh is not a single file — it needs desktop/,
# branding/ and their contents — so piping install.sh itself into bash would
# fetch a script whose payload is missing. This clones the repository to a
# permanent place first, which also leaves verify.sh and --uninstall available
# afterwards.

set -euo pipefail

# Everything below lives in a function that is only CALLED at the very end. Under
# `curl | bash` a dropped connection executes whatever prefix arrived; wrapped
# like this, a truncated transfer is a syntax error instead of half an install.
main() {

    DEST="${RASPBERRY_COCKPIT_DIR:-$HOME/.local/share/raspberry-cockpit}"
    REPO="${RASPBERRY_COCKPIT_REPO:-https://github.com/interkelstar/raspberry-cockpit.git}"

    say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
    ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
    die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

    [ "$(id -u)" != 0 ] || die "run as your normal user, not root — the installer calls sudo itself
       and creates per-user systemd units that root would put in the wrong place."

    command -v git >/dev/null 2>&1 || die "git is required: sudo apt install -y git"

    say "Fetching raspberry-cockpit"
    if [ -d "$DEST/.git" ]; then
        git -C "$DEST" pull --ff-only --quiet || die "could not update $DEST — move it aside and retry"
        ok "updated $DEST"
    else
        mkdir -p "$(dirname "$DEST")"
        git clone --depth 1 --quiet "$REPO" "$DEST" || die "could not clone $REPO"
        ok "cloned into $DEST"
    fi

    # The whole reason this block exists: under `curl | bash` the script's stdin IS
    # the pipe. Anything downstream that reads stdin — most importantly sudo's
    # password prompt, and apt's occasional questions — would either read the
    # remainder of this script as input or fail outright with no explanation.
    # Re-attaching the terminal fixes it. When there is no terminal (CI, a
    # provisioning run), stdin is closed instead so a prompt fails loudly and at
    # once rather than hanging forever waiting for input that cannot arrive.
    say "Running the installer"
    if [ -e /dev/tty ] && { : >/dev/tty; } 2>/dev/null; then
        exec "$DEST/install.sh" "$@" < /dev/tty
    else
        printf '   \033[33m⚠\033[0m no terminal available — if sudo needs a password this will fail fast.\n'
        printf '       Pre-authorise with `sudo -v` first, or run %s/install.sh directly.\n' "$DEST"
        exec "$DEST/install.sh" "$@" < /dev/null
    fi
}

main "$@"
