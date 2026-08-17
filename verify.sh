#!/usr/bin/env bash
# Checks that this actually works, not that the files are present. Read-only.
#
# The distinction is the whole point of the script. An earlier version confirmed
# "all files installed" while the Desktop tab rendered nothing, three builds in a
# row — because it listed the same filenames the installer did, so the two drifted
# together. Everything below therefore compares against an EXTERNAL source of
# truth: the repository directory, the device tree, the live socket.

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR=/usr/share/cockpit/desktop
FILES_DIR=/usr/share/cockpit/files
CONFIG=/etc/cockpit/desktop.conf
UNIT=raspberry-cockpit-vnc.service
fail=0
skipped=0
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '   \033[31m✗\033[0m %s\n' "$*"; fail=1; }
warn() { printf '   \033[33m⚠\033[0m %s\n' "$*"; }
# A component that is not installed is not a failure and is not a pass either.
# Counting it mattered: every "not installed" was a warn, warn did not set fail,
# and a box with nothing but Cockpit on it printed "all good" — which is the exact
# failure mode this script exists to catch, wearing a different hat.
absent() { printf '   \033[33m⚠\033[0m %s\n' "$*"; skipped=$((skipped+1)); }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

hdr "Cockpit"
if ! [ -d /usr/share/cockpit ]; then
    bad "Cockpit is not installed"
else
    if curl -sk -o /dev/null --max-time 5 -w '%{http_code}' https://localhost:9090/ 2>/dev/null | grep -q 200; then
        ok "console answers on https://$(hostname -I | awk '{print $1}'):9090"
    else
        bad "port 9090 does not answer (systemctl status cockpit.socket)"
    fi
    for m in machines podman; do
        [ -d "/usr/share/cockpit/$m" ] && ok "module $m present" || warn "module $m missing"
    done
    # Login is by system password, not ssh key — on a key-only box there may be none.
    [ "$(sudo -n passwd -S "$USER" 2>/dev/null | awk '{print $2}')" = P ] \
        && ok "$USER has a password — login is possible" \
        || warn "could not confirm a password for $USER (needs sudo); without one, login is impossible"
    if command -v podman >/dev/null 2>&1; then
        systemctl --user is-active --quiet podman.socket 2>/dev/null \
            && ok "podman.socket active — Containers tab is live" \
            || bad "podman.socket inactive — Containers tab will be empty"
    fi
fi

hdr "File browser"
if [ -d "$FILES_DIR" ]; then
    ok "module present"
    if [ -f "$FILES_DIR/.raspberry-cockpit-version" ]; then
        ok "pinned tarball, version $(cat "$FILES_DIR/.raspberry-cockpit-version") — updates are manual"
    elif { command -v dpkg >/dev/null 2>&1 && dpkg -S "$FILES_DIR/manifest.json" >/dev/null 2>&1; } \
      || { command -v rpm  >/dev/null 2>&1 && rpm  -qf "$FILES_DIR/manifest.json" >/dev/null 2>&1; }; then
        ok "from a distribution package — updates are automatic"
    else
        # The ABSENCE of our stamp was being reported as a positive fact, in green.
        # An install interrupted between unpacking and stamping looks identical.
        warn "no install marker and no owning package — origin unknown"
    fi
else
    absent "not installed (./install.sh --only files)"
fi

hdr "Desktop tab"
if [ ! -d "$PLUGIN_DIR" ]; then
    absent "not installed (./install.sh --only desktop)"
else
    perm=$(stat -c %a "$PLUGIN_DIR")
    [ "$perm" = 755 ] && ok "$PLUGIN_DIR (0755)" \
                      || bad "directory is $perm — cockpit-ws serves static files as non-root, expect 403"
    # Compare against the repository DIRECTORY, not a list of names.
    missing=0
    for f in "$SRC"/desktop/*; do
        [ -f "$f" ] || continue
        b="$(basename "$f")"
        # Installed as $b or as $b.gz — Cockpit answers a request for x.js with
        # x.js.gz, so the compressed name is the installed name.
        [ -e "$PLUGIN_DIR/$b" ] || [ -e "$PLUGIN_DIR/$b.gz" ] \
            || { bad "$b is in desktop/ but not installed"; missing=1; }
    done
    [ "$missing" = 0 ] && ok "every file from desktop/ is installed ($(ls -1 "$SRC"/desktop | wc -l))"
    rfbfile=""
    for c in "$PLUGIN_DIR/novnc/core/rfb.js" "$PLUGIN_DIR/novnc/core/rfb.js.gz"; do
        [ -e "$c" ] && { rfbfile="$c"; break; }
    done
    if [ -n "$rfbfile" ]; then
        ok "noVNC client present"
        # The 0755 check above covers ONE directory. cp -r creates hundreds of
        # files under root's umask, and with umask 077 they come out unreadable to
        # the non-root user cockpit-ws serves as: 403 on every module, blank tab,
        # installer green. Stat something INSIDE the tree.
        fmode=$(stat -c %a "$rfbfile"); dmode=$(stat -c %a "$(dirname "$rfbfile")")
        case "$fmode" in *4|*5|*6|*7) fok=1 ;; *) fok=0 ;; esac
        case "$dmode" in *5|*7) dok=1 ;; *) dok=0 ;; esac
        [ "$fok" = 1 ] && [ "$dok" = 1 ] \
            && ok "noVNC tree is world-readable (file $fmode, dir $dmode)" \
            || bad "noVNC tree is not readable by others (file $fmode, dir $dmode) — cockpit-ws will 403"
    else
        bad "novnc/core/rfb.js missing"
    fi

    # Both names present is NOT a safe superset: they map to the same key in
    # Cockpit's file table and the directory scan order picks the winner.
    dupes=$(find "$PLUGIN_DIR" -name '*.gz' | sed 's/\.gz$//' | while read -r p; do [ -e "$p" ] && echo "$p"; done | wc -l)
    [ "$dupes" = 0 ] && ok "no file installed both compressed and plain" \
                     || bad "$dupes file(s) exist as both x and x.gz — which one Cockpit serves is scan order"

    # Last line of defence: a file can exist and still point at nothing. That is
    # exactly what a blank tab looked like.
    app="$PLUGIN_DIR/app.js"; reader=cat
    [ -e "$app" ] || { app="$PLUGIN_DIR/app.js.gz"; reader=zcat; }
    while read -r dep; do
        [ -e "$PLUGIN_DIR/$dep" ] || [ -e "$PLUGIN_DIR/$dep.gz" ] \
            && ok "import ./$dep resolves" || bad "app.js imports ./$dep, which is absent"
    done < <($reader "$app" 2>/dev/null | grep -oE 'from "\./[^"]+"' | sed 's|from "\./||; s|"$||')

    # The page must ask for cockpit.js BEFORE anything else it needs. Over
    # HTTP/1.1 whatever is queued ahead of it is queued ahead of the whole tab.
    if [ -f "$PLUGIN_DIR/index.html" ]; then
        order=$(grep -nE 'base1/cockpit\.js|rel="modulepreload"|type="module"' "$PLUGIN_DIR/index.html" | head -1)
        case "$order" in
            *base1/cockpit.js*) ok "index.html requests cockpit.js first" ;;
            "") bad "index.html does not load cockpit.js at all" ;;
            *) bad "something is queued ahead of cockpit.js: ${order#*:}" ;;
        esac
    fi

    if [ -r "$CONFIG" ]; then
        sock=$(grep -oE '^[ \t]*socket[ \t]*=[ \t]*/[^[:space:]#]+' "$CONFIG" | sed 's|.*=[ \t]*||' || true)
        port=$(grep -oE '^[ \t]*port[ \t]*=[ \t]*[0-9]+' "$CONFIG" | grep -oE '[0-9]+$' || true)
        if [ -n "$sock" ]; then ok "$CONFIG: socket=$sock"
        elif [ -n "$port" ]; then ok "$CONFIG: port=$port"
        else bad "$CONFIG exists but names neither a socket nor a port"
        fi
    else
        warn "no $CONFIG — the plugin will fall back to port 5901"
        port=5901
    fi

    systemctl --user is-active --quiet "$UNIT" 2>/dev/null \
        && ok "$UNIT active" \
        || bad "$UNIT inactive (journalctl --user -u $UNIT)"
    if [ -n "${sock:-}" ]; then
        # A socket, which is the stronger arrangement: loopback closes the network,
        # file permissions close the machine. A no-auth RFB port on 127.0.0.1 is
        # connectable by every process of every UID here, and what that buys is
        # keyboard and pointer injection into the live session.
        if [ -S "$sock" ]; then
            mode=$(stat -c %a "$sock" 2>/dev/null)
            owner=$(stat -c %U "$sock" 2>/dev/null)
            ok "VNC on a unix socket: $sock (owner $owner, mode $mode)"
            # The DIRECTORY is what actually settles this. Measured on Raspberry
            # Pi OS: /run/user/1000 is 770 and wayvnc creates its socket 775, so
            # relying on either would have left group members able to connect —
            # which for a no-auth RFB server is full control of the session.
            dirmode=$(stat -c %a "$(dirname "$sock")" 2>/dev/null)
            [ "$dirmode" = 700 ] && ok "its directory is 0700 — no other user can reach it" \
                                 || bad "$(dirname "$sock") is $dirmode, not 0700 — other local users can reach the socket"
            banner=$(timeout 3 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[1]); sys.stdout.write(s.recv(12).decode('latin1'))
" "$sock" 2>/dev/null)
            case "$banner" in
                RFB*) ok "speaks RFB: $(printf '%s' "$banner" | tr -d '\n')" ;;
                *)    bad "no RFB response on $sock (got: '${banner:-nothing}')" ;;
            esac
        else
            bad "$sock is configured but is not a socket — the tab has nothing to connect to"
        fi
        # And nothing should be listening on TCP for this to work at all.
        stray=$(ss -tlnH 2>/dev/null | awk '{print $4}' | grep -E '(127\.0\.0\.1|\[::1\]):59[0-9][0-9]$' | head -1 || true)
        # Ours is on a socket, so ANY VNC port here belongs to something else —
        # raspi-config's server, Raspberry Pi Connect. Reported, not judged: their
        # authentication is their business, and claiming "no unauthenticated port
        # is open" would be asserting something this script cannot know.
        [ -z "$stray" ] && ok "no VNC listening on TCP at all" \
                        || warn "TCP VNC also present on $stray — not ours (raspi-config? Pi Connect?)"
    elif [ -n "${port:-}" ]; then
        # The server must listen on localhost ONLY: it has no authentication.
        listen=$(ss -tln 2>/dev/null | awk -v p="$port" '{n=split($4,a,":"); if (a[n]==p) print $4}' | head -1)
        case "$listen" in
            127.0.0.1:*|"[::1]:"*) ok "listening on localhost only ($listen)" ;;
            "") bad "nothing is listening on port $port" ;;
            *)  bad "listening on $listen — an unauthenticated server is reachable from outside" ;;
        esac
        warn "a loopback port is reachable by EVERY local user — a unix socket would not be"
        # An RFB banner proves it is VNC there, not something else.
        banner=$(timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port && head -c 12 <&3" 2>/dev/null)
        case "$banner" in
            RFB*) ok "speaks RFB: $(printf '%s' "$banner" | tr -d '\n')" ;;
            *)    bad "no RFB response on $port (got: '${banner:-nothing}')" ;;
        esac
    fi
    # The transport, end to end, without a browser or a password: ask
    # cockpit-bridge to open the very channel the plugin opens. Everything else
    # here checks the server and the files; this checks the one link between them,
    # which is also the link with the most assumptions in it.
    target="${sock:-${port:-}}"
    if [ -n "$target" ] && [ -x "$SRC/test/bridge-channel.py" ]; then
        if out=$("$SRC/test/bridge-channel.py" "$target" 2>&1); then
            ok "Cockpit's own bridge can reach it — $out"
        else
            case "$out" in
                *"not installed"*) warn "cockpit-bridge absent — transport not checked" ;;
                *) bad "Cockpit's bridge could NOT reach it: $out" ;;
            esac
        fi
    fi
    warn "none of the above proves the tab RENDERS — open it and look"
fi

hdr "Session"
st=""
for sid in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
    t="$(loginctl show-session "$sid" -p Type --value 2>/dev/null)"
    case "$t" in wayland|x11) st="$t"; break ;; esac
done
[ -z "$st" ] && { ls /run/user/"$(id -u)"/wayland-* >/dev/null 2>&1 && st=wayland; }
[ -z "$st" ] && { pgrep -x Xorg >/dev/null 2>&1 && st=x11; }
[ -n "$st" ] && ok "graphical session: $st" || bad "no graphical session — there is nothing to show"

hdr "Branding"
BR=/usr/share/cockpit/branding/debian/branding.css
if [ ! -r "$BR" ]; then
    warn "no $BR"
elif grep -q "Raspberry Pi OS" "$BR"; then
    ok "branding applied"
    # The watcher is the load-bearing part: the directory belongs to cockpit-ws,
    # so a package upgrade silently restores the distro default.
    systemctl is-active --quiet raspberry-cockpit-branding.path 2>/dev/null \
        && ok "watcher active — a package upgrade will be undone automatically" \
        || bad "watcher inactive — the next cockpit-ws upgrade wipes the branding"
    [ -f /usr/share/cockpit/branding/debian/logo.png ] && ok "logo in place" || bad "logo missing"
else
    warn "branding not applied (./install.sh --only branding)"
fi

hdr "Result"
if [ "$fail" != 0 ]; then
    printf '   \033[31msome checks failed (see ✗ above)\033[0m\n'; exit 1
elif [ "$skipped" != 0 ]; then
    printf '   \033[33m%s component(s) not installed — nothing failed, but nothing was proved about them\033[0m\n' "$skipped"
    exit 2
fi
printf '   \033[32mall good — now open the console and look at it\033[0m\n'; exit 0
