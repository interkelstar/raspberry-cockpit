#!/usr/bin/env bash
# raspberry-cockpit — Cockpit on Raspberry Pi OS, with the pieces the distro
# doesn't give you: a Desktop tab, a file browser, and honest branding.
#
# What it installs:
#   cockpit + machines + podman   web console, VMs, containers
#   files                         file browser (not packaged for Debian — pinned tarball)
#   desktop                       the machine's own desktop in a Cockpit tab, over noVNC
#   branding                      "Raspberry Pi OS" + the raspberry, instead of generic Debian
#
# What it does NOT do: it does not create a desktop environment. The Desktop tab
# SHOWS a session; it does not make one. If you have no graphical session the
# desktop step refuses loudly rather than quietly installing XFCE you didn't ask
# for. On Raspberry Pi OS: raspi-config -> System Options -> Boot / Auto Login ->
# Desktop Autologin.
#
#   ./install.sh                     everything
#   ./install.sh --only desktop      one part (cockpit,files,desktop,branding)
#   ./install.sh --port 5902         VNC port for the desktop tab (default 5901)
#   ./install.sh --dry-run           print the plan, touch nothing
#   ./install.sh --uninstall         remove what this script added

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=5901; DRY=0; UNINSTALL=0
ONLY="cockpit,files,desktop,branding"

PLUGIN_DIR=/usr/share/cockpit/desktop
FILES_DIR=/usr/share/cockpit/files
CONFIG=/etc/cockpit/desktop.conf
UNIT=raspberry-cockpit-vnc.service
BRAND_SRC=/usr/local/share/raspberry-cockpit/branding
BRAND_DST=/usr/share/cockpit/branding/debian

# cockpit-files is not packaged for Debian (checked: apt-cache madison is empty),
# but its release tarball ships a PREBUILT dist/, and the module is plain JS with
# no native parts — so it installs by copying and is architecture-independent.
# Version and checksum are pinned because the tarball comes from a third-party
# host and lands in a directory the web console serves.
CF_VER=43
CF_SHA=e3a45b3df43aa6c814517d334f46cfff4ac64a4dbe6a1e3a6d57e53f06f0be6f

while [ $# -gt 0 ]; do
    case "$1" in
        --port)      PORT="${2:?--port needs a number}"; shift ;;
        --port=*)    PORT="${1#--port=}" ;;
        --only)      ONLY="${2:?--only needs a list}"; shift ;;
        --only=*)    ONLY="${1#--only=}" ;;
        --dry-run)   DRY=1 ;;
        --uninstall) UNINSTALL=1 ;;
        -h|--help)   sed -n '2,26p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '   \033[90m·\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m⚠\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '   \033[90m[dry] %s\033[0m\n' "$*"; else eval "$@"; fi; }
want() { case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# --- Uninstall --------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
    say "Removing"
    run "systemctl --user disable --now $UNIT 2>/dev/null || true"
    run "rm -f ~/.config/systemd/user/$UNIT ~/.config/raspberry-cockpit/wayvnc.conf"
    run "systemctl --user daemon-reload"
    run "sudo systemctl disable --now raspberry-cockpit-branding.path 2>/dev/null || true"
    run "sudo rm -f /etc/systemd/system/raspberry-cockpit-branding.{path,service} /usr/local/bin/raspberry-cockpit-branding"
    run "sudo systemctl daemon-reload"
    # Put the distro's own branding back rather than leaving a gap.
    if [ -d "$BRAND_SRC/.orig" ]; then
        run "sudo cp -a '$BRAND_SRC/.orig/.' '$BRAND_DST/'"
        ok "distro branding restored"
    fi
    run "sudo rm -rf $PLUGIN_DIR $FILES_DIR $CONFIG /usr/local/share/raspberry-cockpit"
    ok "removed. Packages are left alone — they may predate this script"
    exit 0
fi

# Every module reachable from app.js, as paths relative to the plugin directory.
# Derived by following the imports rather than listed by hand, for the same reason
# the file copy is: a hand-written list is a list that goes stale silently.
module_graph() {
    local dir="$1" queue="app.js" seen="" cur spec res
    while [ -n "$queue" ]; do
        cur="${queue%%$'\n'*}"
        case "$queue" in *$'\n'*) queue="${queue#*$'\n'}" ;; *) queue="" ;; esac
        case $'\n'"$seen"$'\n' in *$'\n'"$cur"$'\n'*) continue ;; esac
        seen="${seen:+$seen$'\n'}$cur"
        # A module already installed is a COMPRESSED module: reading only the plain
        # name made this walk stop at the first noVNC file on every run after the
        # first, and the preload list silently shrank from 49 entries to 5.
        if [ -f "$dir/$cur" ]; then read_cur() { cat "$dir/$cur"; }
        elif [ -f "$dir/$cur.gz" ]; then read_cur() { zcat "$dir/$cur.gz"; }
        else continue
        fi
        for spec in $(read_cur | grep -oE '(from|import)[[:space:]]*"\.[^"]+"' | sed 's/.*"\(.*\)"/\1/' | sort -u); do
            res="$(cd "$dir/$(dirname "$cur")" 2>/dev/null && realpath -m --relative-to="$dir" "$spec")" || continue
            queue="${queue:+$queue$'\n'}$res"
        done
    done
    printf '%s\n' "$seen"
}

# --- Preconditions ----------------------------------------------------------
say "Checks"

case "$PORT" in ''|*[!0-9]*) die "port must be a number, got: $PORT" ;; esac
[ "$PORT" -gt 0 ] && [ "$PORT" -lt 65536 ] || die "port out of range: $PORT"

. /etc/os-release 2>/dev/null || die "no /etc/os-release"
case "${ID:-}${ID_LIKE:-}" in
    *debian*|*raspbian*) PKG=apt ;;
    *fedora*|*rhel*)     PKG=dnf ;;
    *) die "unknown distribution (${ID:-?}) — Debian-likes and Fedora/RHEL are supported" ;;
esac
ok "system: ${PRETTY_NAME:-$ID} (packages: $PKG)"

MODEL="$( { tr -d '\0' < /proc/device-tree/model; } 2>/dev/null || echo '')"
case "$MODEL" in
    *"Raspberry Pi"*) ok "board: $MODEL" ;;
    *) warn "not a Raspberry Pi (${MODEL:-unknown}) — everything works except the branding logo" ;;
esac

# --- Cockpit itself ---------------------------------------------------------
if want cockpit; then
    say "Cockpit"
    run "sudo $PKG install -y cockpit cockpit-machines cockpit-podman"
    # A socket, not a service: cockpit-ws starts on first request instead of
    # sitting in RAM, which matters on a board where RAM is the point.
    run "sudo systemctl enable --now cockpit.socket"
    # cockpit-podman talks to the rootless podman API, which does not listen by
    # default. Without this the Containers tab is empty while containers run.
    if command -v podman >/dev/null 2>&1; then
        run "systemctl --user enable --now podman.socket"
        ok "podman.socket enabled — the Containers tab will see rootless podman"
    fi
    # Login is by SYSTEM PASSWORD, not by ssh key. On a key-only box there may be
    # no password at all, and then the console installs but cannot be entered.
    if [ "$(sudo passwd -S "$USER" 2>/dev/null | awk '{print $2}')" != P ]; then
        warn "$USER has no password — you will not be able to log in. Set one: sudo passwd $USER"
    else
        ok "$USER has a password — login is possible"
    fi
    ok "console: https://$(hostname -I | awk '{print $1}'):9090"
    warn "the certificate is self-signed; your browser will complain, which is expected"
fi

# --- File browser -----------------------------------------------------------
if want files; then
    say "File browser"
    if $PKG show cockpit-files >/dev/null 2>&1 && \
       [ "$($PKG list cockpit-files 2>/dev/null | grep -c cockpit-files)" -gt 0 ] 2>/dev/null; then
        # If a distribution ever packages it, prefer the package: security
        # updates then arrive through the package manager instead of this pin.
        run "sudo $PKG install -y cockpit-files"
        ok "cockpit-files from the distribution"
    elif [ -f "$FILES_DIR/.raspberry-cockpit-version" ] && \
         [ "$(cat "$FILES_DIR/.raspberry-cockpit-version" 2>/dev/null)" = "$CF_VER" ]; then
        skip "file browser $CF_VER already installed"
    elif [ "$DRY" = 1 ]; then
        printf '   \033[90m[dry] download and unpack cockpit-files %s\033[0m\n' "$CF_VER"
    else
        TMPD="$(mktemp -d)"
        URL="https://github.com/cockpit-project/cockpit-files/releases/download/$CF_VER/cockpit-files-$CF_VER.tar.xz"
        if curl -fsSL -o "$TMPD/cf.tar.xz" "$URL"; then
            if [ "$(sha256sum "$TMPD/cf.tar.xz" | cut -d' ' -f1)" = "$CF_SHA" ]; then
                tar xJf "$TMPD/cf.tar.xz" -C "$TMPD"
                sudo install -d -m 0755 "$FILES_DIR"
                sudo cp -r "$TMPD"/cockpit-files*/dist/. "$FILES_DIR/"
                sudo chmod -R a+rX "$FILES_DIR"
                # metainfo is what the Applications tab builds its list from.
                sudo install -m 0644 "$TMPD"/cockpit-files*/org.cockpit_project.files.metainfo.xml \
                    /usr/share/metainfo/ 2>/dev/null || true
                printf '%s\n' "$CF_VER" | sudo tee "$FILES_DIR/.raspberry-cockpit-version" >/dev/null
                ok "file browser $CF_VER installed (appears under Tools as «File browser»)"
                warn "installed from a pinned tarball, so updates are manual — verify.sh prints the version"
            else
                warn "checksum mismatch — NOT installing"
            fi
        else
            warn "could not download cockpit-files (no network?) — skipping"
        fi
        rm -rf "$TMPD"
    fi
fi

# --- Desktop tab ------------------------------------------------------------
if want desktop; then
    say "Desktop tab"
    [ -d /usr/share/cockpit ] || die "Cockpit is not installed — nothing to add the tab to"

    # Session type is detected BY FACT, not by distribution name: the same distro
    # ships both, and on Raspberry Pi OS it is a raspi-config toggle. loginctl
    # knows about live sessions; environment variables are empty over ssh.
    SESSION_TYPE=""
    for sid in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
        t="$(loginctl show-session "$sid" -p Type --value 2>/dev/null)"
        case "$t" in wayland|x11) SESSION_TYPE="$t"; break ;; esac
    done
    # Fallback: some compositors report Type=unspecified while the session is
    # perfectly alive. Then look for the Wayland socket and a live Xorg.
    if [ -z "$SESSION_TYPE" ]; then
        if ls /run/user/"$(id -u)"/wayland-* >/dev/null 2>&1; then SESSION_TYPE=wayland
        elif pgrep -x Xorg >/dev/null 2>&1;                     then SESSION_TYPE=x11
        fi
    fi
    [ -n "$SESSION_TYPE" ] || die "no graphical session found.
   This tab SHOWS a desktop; it does not create one. Enable a session first
   (Raspberry Pi OS: raspi-config -> System Options -> Boot / Auto Login ->
   Desktop Autologin) and run again."
    ok "graphical session: $SESSION_TYPE"

    # Why our OWN VNC server rather than one already running. The plugin reaches
    # VNC through a Cockpit stream channel, not websockify, and expects a server
    # with NO authentication bound to localhost: the user already passed PAM, so
    # there is no second password to ask for and nowhere to ask it. An existing
    # VNC server is almost always the opposite — authenticated and exposed (that
    # is exactly how raspi-config's VNC is set up). Pointing at it would break
    # the property that makes this pleasant, so we run our own instance beside it.
    case "$SESSION_TYPE" in
        wayland)
            BIN=wayvnc; VPKG=wayvnc
            WVCONF="$HOME/.config/raspberry-cockpit/wayvnc.conf"
            # --config is REQUIRED, and not only for enable_auth=false. Without it
            # wayvnc reads ~/.config/wayvnc/config — someone else's file that we do
            # not control. On the test board that file began with "[wayvnc]", and
            # this parser has no sections: "Failed to load config. Error on line 1".
            #
            # --socket is required too: the control socket defaults to one shared
            # path while a machine easily runs several wayvnc instances (the test
            # board already had two — the system VNC and Raspberry Pi Connect).
            EXEC="wayvnc --config=$WVCONF --socket=%t/raspberry-cockpit-wayvncctl --max-fps=30"
            ;;
        x11)
            BIN=x0vncserver
            case "$PKG" in
                apt) VPKG=tigervnc-standalone-server ;;
                dnf) VPKG=tigervnc-server ;;
            esac
            # -localhost and SecurityTypes=None belong together: a server without
            # authentication must not be reachable from outside, and it does not
            # need to be, because the only way in is through Cockpit.
            EXEC="x0vncserver -display :0 -rfbport $PORT -SecurityTypes=None -localhost -SendPrimary=0"
            ;;
    esac
    command -v "$BIN" >/dev/null 2>&1 && skip "$BIN already installed" || run "sudo $PKG install -y $VPKG"

    if [ "$SESSION_TYPE" = wayland ]; then
        run "mkdir -p '$(dirname "$WVCONF")'"
        if [ "$DRY" = 1 ]; then
            printf '   \033[90m[dry] write %s\033[0m\n' "$WVCONF"
        else
            cat > "$WVCONF" <<WVEOF
# Written by raspberry-cockpit. No need to edit by hand.
# wayvnc's format is flat key=value with NO sections: a line like "[wayvnc]"
# breaks parsing entirely.
address=127.0.0.1
port=$PORT
# No authentication, deliberately: the only route in is Cockpit's stream channel,
# which already passed PAM. Security rests on address=127.0.0.1 — these two lines
# must never be separated.
enable_auth=false
WVEOF
        fi
        ok "wayvnc config: $WVCONF (localhost only, no auth)"
    fi

    if ss -tln 2>/dev/null | grep -qE "[.:]$PORT\b" && \
       ! systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
        die "port $PORT is already taken — pick another: --port $((PORT+1))"
    fi

    # A user unit, not a system one: the VNC server must see its own user's
    # session, and a system service cannot reach into it.
    run "mkdir -p ~/.config/systemd/user"
    if [ "$DRY" = 1 ]; then
        printf '   \033[90m[dry] write ~/.config/systemd/user/%s\033[0m\n' "$UNIT"
    else
        cat > "$HOME/.config/systemd/user/$UNIT" <<UNITEOF
[Unit]
Description=VNC for the Cockpit Desktop tab ($SESSION_TYPE, localhost only)
After=graphical-session.target
PartOf=graphical-session.target

[Service]
# The sh wrapper exists for one fallback line. Modern compositors export
# WAYLAND_DISPLAY into the systemd user environment (labwc does), minimal setups
# do not — and then wayvnc cannot find the session. Cheaper to supply it than to
# debug "works for you, not for me" later.
ExecStart=/bin/sh -c '[ -n "\$WAYLAND_DISPLAY" ] || [ "$SESSION_TYPE" != wayland ] || export WAYLAND_DISPLAY="\$(basename "\$(ls "\$XDG_RUNTIME_DIR"/wayland-[0-9] 2>/dev/null | head -1)")"; exec $EXEC'
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNITEOF
    fi
    run "systemctl --user daemon-reload"
    run "systemctl --user enable $UNIT"
    # restart, NOT `enable --now`: on an already-running unit "--now" does
    # nothing, so re-running with a different --port would rewrite both configs
    # and leave VNC on the old port — while reporting success.
    run "systemctl --user restart $UNIT"
    run "sudo loginctl enable-linger $USER"
    ok "$UNIT up: 127.0.0.1:$PORT, no auth, not listening outside"

    # EXPLICIT 0755 on the package directory. cockpit-ws serves static resources
    # as a NON-root user, so a directory created under a strict umask (077 in a
    # sudo/systemd context) would be 0700 and the browser would 403 on every file.
    run "sudo install -d -m 0755 $PLUGIN_DIR"
    if [ ! -d /usr/share/novnc ]; then run "sudo $PKG install -y novnc"; fi
    [ "$DRY" = 1 ] || [ -d /usr/share/novnc ] || die "no /usr/share/novnc — install the novnc package"
    # The noVNC client comes from the distribution rather than being vendored, so
    # its security updates arrive through the package manager. Copied only when
    # absent: re-copying on every run blinks the live desktop.
    if [ ! -d "$PLUGIN_DIR/novnc" ]; then
        run "sudo cp -r /usr/share/novnc $PLUGIN_DIR/novnc"
        ok "noVNC client copied from /usr/share/novnc"
    else
        skip "noVNC client already present"
    fi
    # The file list is taken FROM THE DIRECTORY, never hand-written. That mistake
    # has been made here: a new module was added to desktop/ while the installer
    # still copied four files by name, so a module shipped importing a file that
    # was not there. The failure is silent — not an error, just a blank page.
    for f in "$SRC"/desktop/*; do
        [ -f "$f" ] || continue
        run "sudo install -m 0644 '$f' '$PLUGIN_DIR/$(basename "$f")'"
    done
    run "sudo chmod 0755 $PLUGIN_DIR"
    ok "plugin installed in $PLUGIN_DIR ($(ls -1 "$SRC"/desktop | wc -l) files)"

    # noVNC is ~54 ES modules and half a megabyte of JavaScript, and the browser
    # discovers them in waves: index.html finds app.js, app.js finds rfb.js,
    # rfb.js finds twenty more, and so on. Every wave costs a round trip before
    # the next one can even start. Naming the whole graph up front collapses that
    # into one wave of parallel fetches.
    #
    # This is injected into the INSTALLED copy rather than kept in the repository
    # because the list is whatever noVNC happens to ship on this machine. It is a
    # transport hint with no effect on behaviour, which is why the test harness
    # can go on building its page from the repository's index.html.
    if [ "$DRY" = 1 ]; then
        printf '   \033[90m[dry] inject modulepreload links into %s/index.html\033[0m\n' "$PLUGIN_DIR"
    else
        graph="$(module_graph "$PLUGIN_DIR")"
        links="$(printf '%s\n' "$graph" | sed 's|.*|  <link rel="modulepreload" href="&">|')"
        printf '%s\n' "$links" > /tmp/rc-preload.$$
        sudo python3 - "$PLUGIN_DIR/index.html" /tmp/rc-preload.$$ <<'PYEOF'
import sys, re
page, links = sys.argv[1], sys.argv[2]
html = open(page).read()
html = re.sub(r'\n?\s*<link rel="modulepreload"[^>]*>', '', html)
html = html.replace("</head>", open(links).read() + "</head>", 1)
open(page, "w").write(html)
PYEOF
        rm -f /tmp/rc-preload.$$
        ok "$(printf '%s\n' "$graph" | wc -l) modules preloaded from index.html"
    fi

    # Cockpit serves a package file named `x.js.gz` in answer to a request for
    # `x.js`, with Content-Encoding: gzip. From src/cockpit/packages.py:
    #
    #     basename = re.sub(r'.gz$', '', name)      # strip trailing '.gz'
    #     self.files[basename] = name
    #     content_type, content_encoding = mimetypes.guess_type(filename)
    #
    # and mimetypes.guess_type('app.js.gz') is ('text/javascript', 'gzip'). Ours
    # shipped nothing compressed, so half a megabyte of noVNC went over the wire
    # raw — on a phone, through a tunnel, that is the difference between the tab
    # appearing and the tab eventually appearing.
    #
    # The plain file is REPLACED, not kept beside it. Both present map to the same
    # key in that dict and the scan order decides which one wins, so keeping both
    # is not a safe superset — it is a coin toss. Cockpit's own packages ship the
    # .gz alone for the same reason: /usr/share/cockpit/shell has shell.js.gz and
    # no shell.js.
    #
    # index.html and manifest.json stay plain: Cockpit reads the manifest itself,
    # and its own packages keep both uncompressed.
    if [ "$DRY" = 1 ]; then
        printf '   \033[90m[dry] compress js/css in %s for cockpit-ws\033[0m\n' "$PLUGIN_DIR"
    else
        # Compress what is still plain, and DO NOT clear the .gz files first.
        # Clearing them looks like the tidy way to avoid stale output and is in
        # fact destructive: noVNC is copied only when absent, so on the second run
        # its sources are already compressed — deleting every .gz and then
        # compressing "every .js" removes sixty files and finds nothing to replace
        # them with. Measured, before this line was written the way it is now: 80
        # noVNC modules became 20.
        before=$(sudo du -sk "$PLUGIN_DIR" | cut -f1)
        sudo find "$PLUGIN_DIR" \( -name '*.js' -o -name '*.css' \) -exec gzip -9 -f {} +
        # Stale output is still worth removing, but only where we can tell it IS
        # stale: our own files, whose source list is right here.
        for g in "$PLUGIN_DIR"/*.gz; do
            [ -e "$g" ] || continue
            b="$(basename "${g%.gz}")"
            [ -e "$SRC/desktop/$b" ] || run "sudo rm -f '$g'"
        done
        after=$(sudo du -sk "$PLUGIN_DIR" | cut -f1)
        ok "compressed for cockpit-ws ($(sudo find "$PLUGIN_DIR" -name '*.gz' | wc -l) files, ${before}kB -> ${after}kB)"
    fi

    run "sudo install -d -m 0755 /etc/cockpit"
    if [ "$DRY" = 1 ]; then
        printf '   \033[90m[dry] write %s (port=%s)\033[0m\n' "$CONFIG" "$PORT"
    else
        printf '# VNC port for the Cockpit Desktop tab. Read when the tab loads.\nport=%s\n' "$PORT" \
            | sudo tee "$CONFIG" >/dev/null
    fi
    ok "$CONFIG: port=$PORT"
fi

# --- Branding ---------------------------------------------------------------
if want branding; then
    say "Branding"
    if [ ! -f /usr/share/raspberrypi-artwork/raspberry-pi-logo.png ]; then
        warn "no raspberrypi-artwork — skipping (install: sudo $PKG install -y raspberrypi-artwork)"
    else
        # The source of truth lives under /usr/local, where the package manager
        # never goes, because the branding directory itself belongs to cockpit-ws
        # and a package upgrade restores the distro default.
        run "sudo install -d -m 0755 '$BRAND_SRC'"
        run "sudo install -m 0644 '$SRC/branding/branding.css' '$BRAND_SRC/branding.css'"
        run "sudo install -m 0755 '$SRC/branding/apply.sh' /usr/local/bin/raspberry-cockpit-branding"
        run "sudo install -m 0644 '$SRC'/branding/raspberry-cockpit-branding.{path,service} /etc/systemd/system/"
        run "sudo systemctl daemon-reload"
        run "sudo /usr/local/bin/raspberry-cockpit-branding"
        run "sudo systemctl enable --now raspberry-cockpit-branding.path"
        ok "branding applied; watcher enabled (a cockpit-ws upgrade restores the default — we re-apply)"
    fi
fi

say "Done"
echo "   Verify: $SRC/verify.sh"
echo "   Then open the console and reload — «Desktop» appears under Apps."
