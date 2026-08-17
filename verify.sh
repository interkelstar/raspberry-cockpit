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
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '   \033[31m✗\033[0m %s\n' "$*"; fail=1; }
warn() { printf '   \033[33m⚠\033[0m %s\n' "$*"; }
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
    [ -f "$FILES_DIR/.raspberry-cockpit-version" ] \
        && ok "installed from a pinned tarball, version $(cat "$FILES_DIR/.raspberry-cockpit-version") — updates are manual" \
        || ok "installed from a distribution package — updates are automatic"
else
    warn "not installed (./install.sh --only files)"
fi

hdr "Desktop tab"
if [ ! -d "$PLUGIN_DIR" ]; then
    warn "not installed (./install.sh --only desktop)"
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
    [ -e "$PLUGIN_DIR/novnc/core/rfb.js" ] || [ -e "$PLUGIN_DIR/novnc/core/rfb.js.gz" ] \
        && ok "noVNC client present" || bad "novnc/core/rfb.js missing"

    # Both names present is NOT a safe superset: they map to the same key in
    # Cockpit's file table and the directory scan order picks the winner.
    dupes=$(sudo find "$PLUGIN_DIR" -name '*.gz' | sed 's/\.gz$//' | while read -r p; do [ -e "$p" ] && echo "$p"; done | wc -l)
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

    # Every module the page will pull must be named up front, or the browser
    # discovers them in waves and pays a round trip for each wave.
    pre=$(grep -c 'rel="modulepreload"' "$PLUGIN_DIR/index.html" 2>/dev/null || echo 0)
    [ "$pre" -gt 20 ] && ok "index.html preloads the module graph ($pre modules)" \
                      || bad "index.html preloads only $pre modules — the graph is not being named up front"

    if [ -r "$CONFIG" ]; then
        port=$(grep -oE '^[ \t]*port[ \t]*=[ \t]*[0-9]+' "$CONFIG" | grep -oE '[0-9]+$')
        [ -n "$port" ] && ok "$CONFIG: port=$port" || bad "$CONFIG exists but no port can be read from it"
    else
        warn "no $CONFIG — the plugin will fall back to port 5901"
        port=5901
    fi

    systemctl --user is-active --quiet "$UNIT" 2>/dev/null \
        && ok "$UNIT active" \
        || bad "$UNIT inactive (journalctl --user -u $UNIT)"
    if [ -n "${port:-}" ]; then
        # The server must listen on localhost ONLY: it has no authentication.
        listen=$(ss -tln 2>/dev/null | awk -v p="$port" '{n=split($4,a,":"); if (a[n]==p) print $4}' | head -1)
        case "$listen" in
            127.0.0.1:*|"[::1]:"*) ok "listening on localhost only ($listen)" ;;
            "") bad "nothing is listening on port $port" ;;
            *)  bad "listening on $listen — an unauthenticated server is reachable from outside" ;;
        esac
        # An RFB banner proves it is VNC there, not something else.
        banner=$(timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port && head -c 12 <&3" 2>/dev/null)
        case "$banner" in
            RFB*) ok "speaks RFB: $(printf '%s' "$banner" | tr -d '\n')" ;;
            *)    bad "no RFB response on $port (got: '${banner:-nothing}')" ;;
        esac
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
[ "$fail" = 0 ] && { printf '   \033[32mall good — now open the console and look at it\033[0m\n'; exit 0; }
printf '   \033[31msome checks failed (see ✗ above)\033[0m\n'; exit 1
