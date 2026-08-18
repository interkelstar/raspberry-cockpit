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

# The same guard get.sh has, and for the same reason — it belonged here all along.
# get.sh refuses root because this script calls sudo itself and writes PER-USER
# systemd units, and README documents the clone-and-run path, which had no check
# at all. Under `sudo ./install.sh` HOME is /root: the unit lands in root's
# manager, linger is enabled for root, the wayvnc config is written under /root,
# and the graphical session it is supposed to capture belongs to somebody else.
# The failure is quiet — a unit that never finds a session.
if [ "$(id -u)" = 0 ]; then
    printf '\n\033[31m✗ run as your normal user, not root — this script calls sudo where it needs to,\n' >&2
    printf '   and the systemd units it writes are per-user ones that root would put in the\n' >&2
    printf '   wrong place, watching a session that is not yours.\033[0m\n' >&2
    exit 1
fi
PORT=5901; DRY=0; UNINSTALL=0
ONLY="cockpit,files,desktop,branding"

# One private scratch directory for the whole run, removed however we exit. There
# was no trap at all: an abort between unpacking a tarball and cleaning up left it
# in /tmp, and one step wrote a PREDICTABLE /tmp path that root then read back —
# a local user could pre-create it world-writable and have root splice their text
# into a page cockpit-ws serves.
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT INT TERM

PLUGIN_DIR=/usr/share/cockpit/desktop
# Written on install, checked before anything destructive. Without it the script
# could not tell its own installation from somebody else's directory that happened
# to be at the same path — and it compressed, deleted and uninstalled regardless.
MARKER=.raspberry-cockpit
# The socket lives in a directory WE create at 0700, not directly in
# XDG_RUNTIME_DIR. Measured on Raspberry Pi OS: /run/user/1000 is 770, not the 700
# it is often assumed to be, and wayvnc creates its socket 775 — so group members
# could both traverse the directory and write to the socket, which for a no-auth
# RFB server means driving the session. Owning the parent directory settles it
# whatever mode the server picks for the socket itself.
VNC_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/raspberry-cockpit"
VNC_SOCK="$VNC_DIR/vnc.sock"
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
    # $BRAND_DST too, not just the backup: removing cockpit-ws before removing its
    # add-ons is an ordinary thing to do, and then `cp -a` fails, `run` is eval
    # under `set -e`, and uninstall exits here — leaving everything below it in
    # place with nothing but a bare cp error to explain why.
    if [ -d "$BRAND_SRC/.orig" ] && [ -d "$BRAND_DST" ]; then
        run "sudo cp -a '$BRAND_SRC/.orig/.' '$BRAND_DST/'"
        ok "distro branding restored"
    fi

    # Each removal has to establish that we are the ones who put it there.
    # $FILES_DIR is exactly where the DISTRIBUTION package puts cockpit-files, and
    # this script prefers that package when it exists — so an unconditional rm -rf
    # deleted a dpkg-owned directory while the package database went on claiming it
    # was installed. The stamp file distinguishes the two cases and was already
    # being written; it simply was not consulted.
    if [ -e "$FILES_DIR/.raspberry-cockpit-version" ]; then
        run "sudo rm -rf $FILES_DIR /usr/share/metainfo/org.cockpit_project.files.metainfo.xml"
        ok "file browser removed (it was ours)"
    elif [ -d "$FILES_DIR" ]; then
        warn "$FILES_DIR left alone — no install marker, so it is the distribution's"
    fi
    if [ -e "$PLUGIN_DIR/$MARKER" ]; then
        run "sudo rm -rf $PLUGIN_DIR"
        ok "desktop plugin removed"
    elif [ -d "$PLUGIN_DIR" ]; then
        warn "$PLUGIN_DIR left alone — no install marker, so something else owns it"
    fi
    run "sudo rm -rf $CONFIG /usr/local/share/raspberry-cockpit"
    ok "done. Packages are left alone — they may predate this script"
    exit 0
fi

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
    # sudo -n, and skipped entirely in a dry run: --dry-run promises to touch
    # nothing and this was prompting for a password, updating the sudo timestamp
    # and writing an auth-log line.
    if [ "$DRY" = 1 ]; then
        skip "password check needs sudo — skipped in a dry run"
    elif [ "$(sudo -n passwd -S "$USER" 2>/dev/null | awk '{print $2}')" != P ]; then
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
    # `apt show` exists; dnf and dnf5 call it `info`. With PKG=dnf this condition
    # was always false, so Fedora — which does package cockpit-files — silently
    # took the pinned third-party tarball and its manual-update path.
    case "$PKG" in dnf) PKGQUERY="info" ;; *) PKGQUERY="show" ;; esac
    if $PKG $PKGQUERY cockpit-files >/dev/null 2>&1 && \
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
        TMPD="$WORKDIR/cf"
        mkdir -p "$TMPD"
        URL="https://github.com/cockpit-project/cockpit-files/releases/download/$CF_VER/cockpit-files-$CF_VER.tar.xz"
        if curl -fsSL -o "$TMPD/cf.tar.xz" "$URL"; then
            if [ "$(sha256sum "$TMPD/cf.tar.xz" | cut -d' ' -f1)" = "$CF_SHA" ]; then
                tar xJf "$TMPD/cf.tar.xz" -C "$TMPD"
                sudo install -d -m 0755 "$FILES_DIR"
                # --no-preserve=mode: the tarball's own modes have no business in a
                # root-owned directory the web console serves. a+rX adds read, and
                # go-w takes away anything the archive thought should be writable.
                sudo cp -r --no-preserve=mode "$TMPD"/cockpit-files*/dist/. "$FILES_DIR/"
                sudo chmod -R a+rX,go-w "$FILES_DIR"
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
            #
            # --unix-socket is the security-relevant one. address=127.0.0.1 closes
            # the network and NOT the machine: a no-auth RFB listener on loopback
            # is connectable by every process of every UID on the box, and what it
            # gets is pointer and keyboard injection plus a live view of the
            # session. A socket inside XDG_RUNTIME_DIR (0700, owner only) makes
            # that a filesystem permission instead of an open door, and Cockpit's
            # stream channel takes "unix" in place of address/port, so nothing is
            # given up to gain it.
            EXEC="wayvnc --config=$WVCONF --unix-socket --socket=%t/raspberry-cockpit-wayvncctl --max-fps=30"
            ;;
        x11)
            BIN=x0vncserver
            case "$PKG" in
                apt) VPKG=tigervnc-standalone-server ;;
                dnf) VPKG=tigervnc-server ;;
            esac
            # A unix socket here too, for the same reason as on Wayland: a no-auth
            # RFB listener on 127.0.0.1 is reachable by every process of every UID
            # on the box. x0vncserver takes -rfbunixpath, and -rfbunixmode is
            # already 0600 by default; the socket still goes in a 0700 directory,
            # because a mode is a property of the file and a directory is a
            # property of everything in it.
            #
            # -SecurityTypes=None stays: authentication is Cockpit's job, and it
            # has already happened by the time anything can reach this.
            EXEC="x0vncserver -display :0 -rfbunixpath $VNC_SOCK -rfbunixmode 0600 -SecurityTypes=None -SendPrimary=0"
            ;;
    esac
    command -v "$BIN" >/dev/null 2>&1 && skip "$BIN already installed" || run "sudo $PKG install -y $VPKG"

    if [ "$SESSION_TYPE" = wayland ]; then
        run "mkdir -p '$(dirname "$WVCONF")'"
        run "install -d -m 0700 '$VNC_DIR'"
        if [ "$DRY" = 1 ]; then
            printf '   \033[90m[dry] write %s\033[0m\n' "$WVCONF"
        else
            cat > "$WVCONF" <<WVEOF
# Written by raspberry-cockpit. No need to edit by hand.
# wayvnc's format is flat key=value with NO sections: a line like "[wayvnc]"
# breaks parsing entirely.
# With --unix-socket, "address" is the socket PATH. It sits in XDG_RUNTIME_DIR,
# which is mode 0700, so the socket is reachable by this user and nobody else.
address=$VNC_SOCK
# No authentication, deliberately: the only route in is Cockpit's stream channel,
# which already passed PAM. Security rests on the socket's permissions — these
# two lines must never be separated.
enable_auth=false
WVEOF
        fi
        ok "wayvnc config: $WVCONF (unix socket, owner only, no auth)"
    fi

    # No port-collision check any more: both session types listen on a socket we
    # own, and a path we create cannot be taken by somebody else the way a port
    # can. --port is kept for the plugin's fallback and for anyone pointing it at
    # a server of their own.

    # A user unit, not a system one: the VNC server must see its own user's
    # session, and a system service cannot reach into it.
    run "mkdir -p ~/.config/systemd/user"
    if [ "$DRY" = 1 ]; then
        printf '   \033[90m[dry] write ~/.config/systemd/user/%s\033[0m\n' "$UNIT"
    else
        cat > "$HOME/.config/systemd/user/$UNIT" <<UNITEOF
[Unit]
Description=VNC for the Cockpit Desktop tab ($SESSION_TYPE, no auth, owner-only socket)
After=graphical-session.target
PartOf=graphical-session.target
# In [Unit], where systemd actually reads them — in [Service] they are silently
# ignored, which is how a failing unit got to restart nineteen times. Bounded, or
# a box that boots without a graphical session respawns this every three seconds
# for as long as it is powered on.
StartLimitIntervalSec=120
StartLimitBurst=8

[Service]
# The sh wrapper exists for one fallback line. Modern compositors export
# WAYLAND_DISPLAY into the systemd user environment (labwc does), minimal setups
# do not — and then wayvnc cannot find the session. Cheaper to supply it than to
# debug "works for you, not for me" later.
# The socket's directory, owner-only, recreated on every start because
# XDG_RUNTIME_DIR is wiped when the last session ends — and the socket FILE
# removed, because wayvnc does not unlink a stale one and refuses to bind over it:
# "Failed to listen on socket or bind to its address". Every restart after the
# first failed, the restart loop ran until the start limit stopped it, and the tab
# had nothing to connect to. Found by installing twice; the second install is the
# common case, not the rare one.
ExecStartPre=/bin/sh -c 'install -d -m 0700 "%t/raspberry-cockpit" && rm -f "%t/raspberry-cockpit/vnc.sock"'
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
    # Say it started because it started. The old line asserted the address and
    # port unconditionally, so a server that failed to bind and went into the
    # restart loop still printed a tick — the same "reports success, tab is blank"
    # this file keeps running into.
    if [ "$DRY" = 1 ]; then
        ok "$UNIT would be started"
    elif systemctl --user is-active --quiet "$UNIT"; then
        ok "$UNIT up on $VNC_SOCK (owner only, no auth)"
    else
        die "$UNIT did not start — systemctl --user status $UNIT, journalctl --user -u $UNIT"
    fi

    # EXPLICIT 0755 on the package directory. cockpit-ws serves static resources
    # as a NON-root user, so a directory created under a strict umask (077 in a
    # sudo/systemd context) would be 0700 and the browser would 403 on every file.
    # Refuse a directory that exists and is not ours. `install -d` succeeds on an
    # existing one, and everything after this point rewrites its contents: the
    # compression pass gzips every .js it finds (gzip REMOVES the original) and
    # then deletes every top-level .gz whose name is not in our desktop/. Pointed
    # at a stranger's Cockpit module that is not an installation, it is a deletion.
    if [ -d "$PLUGIN_DIR" ] && [ ! -e "$PLUGIN_DIR/$MARKER" ] && [ "$DRY" != 1 ]; then
        # An installation from before the marker existed still has to be
        # upgradable, so adopt a directory that is recognisably this plugin: our
        # own app.js, under either name, beside our manifest.
        if { [ -e "$PLUGIN_DIR/app.js" ] || [ -e "$PLUGIN_DIR/app.js.gz" ]; } \
           && [ -e "$PLUGIN_DIR/manifest.json" ] \
           && grep -q '"desktop"' "$PLUGIN_DIR/manifest.json" 2>/dev/null; then
            skip "adopting the existing install (predates the ownership marker)"
        else
            die "$PLUGIN_DIR already exists and was not installed by this script.
   Move it aside if you want it replaced — refusing to rewrite files that are not ours."
        fi
    fi
    run "sudo install -d -m 0755 $PLUGIN_DIR"
    if [ "$DRY" != 1 ]; then
        printf 'Installed by raspberry-cockpit. Removing this file makes uninstall refuse to touch this directory.\n' \
            | sudo tee "$PLUGIN_DIR/$MARKER" >/dev/null
        sudo chmod 0644 "$PLUGIN_DIR/$MARKER"
    fi
    if [ ! -d /usr/share/novnc ]; then run "sudo $PKG install -y novnc"; fi
    [ "$DRY" = 1 ] || [ -d /usr/share/novnc ] || die "no /usr/share/novnc — install the novnc package"
    # The noVNC client comes from the distribution rather than being vendored, so
    # its security updates arrive through the package manager. Copied only when
    # absent: re-copying on every run blinks the live desktop.
    if [ ! -d "$PLUGIN_DIR/novnc" ]; then
        run "sudo cp -r /usr/share/novnc $PLUGIN_DIR/novnc"
        # The 0755 above covers ONE directory. cp -r creates several hundred files
        # and a dozen directories under root's umask, and the comment above about
        # 403s applies to every one of them: with umask 077 in effect — pam_umask,
        # or an install driven from a unit or cloud-init — the whole module graph
        # comes out 0700/0600 and cockpit-ws, which serves as a non-root user,
        # refuses the lot. Blank tab, installer green. The file-browser path
        # already did this; this one did not.
        run "sudo chmod -R a+rX,go-w '$PLUGIN_DIR/novnc'"
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
    ok "plugin installed in $PLUGIN_DIR ($(find "$SRC"/desktop -maxdepth 1 -type f | wc -l) files)"

    # There was a modulepreload pass here, naming all 49 modules in index.html so
    # the browser would not discover them in waves. It is REMOVED, because it made
    # the thing it was meant to fix worse.
    #
    # cockpit-ws speaks HTTP/1.1, so a browser has roughly six connections per
    # host. Forty-nine preload links in the <head> are queued before the parser
    # ever reaches ../base1/cockpit.js in the body — and nothing in the tab happens
    # until that script has loaded, because it is what opens the channel. Over a
    # tunnel the result was cockpit.js waiting behind the module graph for long
    # enough to look hung; it was reported as exactly that, from a network panel.
    #
    # Compression stays: fewer bytes helps on any connection and cannot reorder
    # anything. The waves cost a few round trips, which is a price worth paying to
    # keep the critical path first. If Cockpit ever serves HTTP/2, this is worth
    # revisiting — there the preloads would cost nothing.
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
        before=$(du -sk "$PLUGIN_DIR" | cut -f1)
        sudo find "$PLUGIN_DIR" \( -name '*.js' -o -name '*.css' \) -exec gzip -9 -f {} +
        # Stale output is still worth removing, but only where we can tell it IS
        # stale: our own files, whose source list is right here.
        for g in "$PLUGIN_DIR"/*.gz; do
            [ -e "$g" ] || continue
            b="$(basename "${g%.gz}")"
            [ -e "$SRC/desktop/$b" ] || run "sudo rm -f '$g'"
        done
        after=$(du -sk "$PLUGIN_DIR" | cut -f1)
        ok "compressed for cockpit-ws ($(find "$PLUGIN_DIR" -name '*.gz' | wc -l) files, ${before}kB -> ${after}kB)"
    fi

    run "sudo install -d -m 0755 /etc/cockpit"
    if [ "$DRY" = 1 ]; then
        printf '   \033[90m[dry] write %s (socket=%s)\033[0m\n' "$CONFIG" "$VNC_SOCK"
    else
        printf '# Where the Cockpit Desktop tab finds VNC. Read when the tab loads.\n# A unix socket: reachable by its owner, not by every local process.\nsocket=%s\n' \
            "$VNC_SOCK" | sudo tee "$CONFIG" >/dev/null
    fi
    ok "$CONFIG: socket=$VNC_SOCK"
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
