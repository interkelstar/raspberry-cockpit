# raspberry-cockpit

[Cockpit](https://cockpit-project.org/) on Raspberry Pi OS, with the parts the distribution doesn't give you: **your actual desktop in a browser tab**, a **file browser**, VM and container management, and branding that says *Raspberry Pi OS* instead of a generic Debian wordmark.

```
./install.sh                  everything
./install.sh --only desktop   one part: cockpit, files, desktop, branding
./install.sh --port 5902      VNC port for the desktop tab (default 5901)
./install.sh --dry-run        print the plan, touch nothing
./verify.sh                   check that it actually works
./install.sh --uninstall      remove what this added
```

Then open `https://<your-pi>:9090`.

## What you get

| | |
|---|---|
| **Desktop** | the machine's own graphical session in a Cockpit tab, over noVNC |
| **File browser** | upload, download, browse — `cockpit-files`, which Debian doesn't package |
| **Virtual machines** | `cockpit-machines`: create, console, start/stop |
| **Containers** | `cockpit-podman`, wired to the rootless podman socket |
| **Branding** | "Raspberry Pi OS *trixie*" with the raspberry, surviving package upgrades |

Plus everything stock Cockpit brings: terminal, logs, metrics, services, storage, networking, accounts.

## The interesting part: no websockify, no second password

The usual way to put a desktop in a browser is websockify — a separate service, a separate port, a separate password, and all of it needing protection. This plugin borrows the transport from Cockpit instead:

```js
cockpit.channel({ payload: "stream", address: "127.0.0.1", port: vncPort, binary: true })
```

Browser → `cockpit-ws` → stream channel → local VNC. Cockpit already authenticated the user through PAM, so **the VNC server runs with no authentication, bound to localhost only** — there is no route to it from outside, and nothing to log into twice.

A useful side effect: the plugin contains no reference to X11, Wayland, or any particular VNC server. It opens a stream and speaks RFB; where the pixels come from is invisible to it. The installer picks the server (`wayvnc` for Wayland, `x0vncserver` for X11) by detecting the **live session**, not by reading the distribution name.

## What this does NOT do

**It does not create a desktop.** The tab *shows* a graphical session; it does not make one. If you don't have one, the installer refuses loudly and tells you what to enable, rather than quietly installing a desktop environment you didn't ask for.

On Raspberry Pi OS: `raspi-config` → System Options → Boot / Auto Login → **Desktop Autologin**.

**It runs its own VNC server rather than reusing yours.** An already-configured VNC (the one behind `raspi-config`, for instance) is almost always authenticated and exposed — the opposite of what the design needs. Pointing at it would cost the "no second password" property, so the installer starts its own instance on localhost beside it. Several `wayvnc` instances coexist happily; the test board runs three.

## Requirements

- Raspberry Pi OS (or another Debian-like; Fedora/RHEL paths exist but are untested)
- A graphical session — Wayland (labwc) or X11
- `sudo`, and a **system password** for your user: Cockpit logs in with PAM, not with your ssh key. On a key-only box there may be no password at all, and then the console installs but cannot be entered. The installer checks and says so.

## Verified on

Raspberry Pi 4B (8 GB), Debian 13 trixie, aarch64, labwc/Wayland, Cockpit 337, wayvnc, noVNC 1.6.0.

End-to-end: install → `verify.sh` green → port changed 5901 → 5902 → back → `--uninstall` (leaving two unrelated `wayvnc` instances untouched) → reinstall. **The desktop tab was confirmed by eye in a browser**, which is a separate bullet on purpose — see below.

## Things that cost real time

Every one of these presents the same way: the installer reports success, the checks are green, and the tab is blank. None of them is visible from the server side.

**The `ready` event may never arrive.** On Cockpit 337 the stream channel starts delivering data without ever emitting `ready`. Treating it as the open signal loses the handshake and noVNC dies with `Unknown init state (state: )`. "Open" has to be whichever comes first — `ready` or the first byte.

**`Object.defineProperty` defaults to `enumerable: false`, and `Websock.attach()` validates the socket with `Object.keys()`.** Accessor properties exist and work perfectly, yet are invisible to that check: the RFB constructor throws `Raw channel missing property: onmessage` before any canvas exists — and the console stays *silent*, because the exception is swallowed by a promise.

**Open must not be delivered synchronously from a setter.** `attach()` assigns `onmessage`, then `onopen`, then `onclose`/`onerror`. A synchronous delivery starts the handshake mid-`attach()`, on a half-assembled socket, and the next state arrives at the wrong moment: `Unexpected server connection while connecting`. A real WebSocket never fires `onopen` from an assignment; hence `queueMicrotask`.

**`wayvnc` without `--config` reads `~/.config/wayvnc/config`** — someone else's file. On the test board it began with `[wayvnc]`, and this parser has no sections: `Failed to load config. Error on line 1`.

**`wayvnc`'s control socket defaults to one shared path.** Machines easily run several instances; without an explicit `--socket` you take the socket away from a neighbour.

**`systemctl enable --now` is a no-op on a running unit.** Re-running with a different `--port` rewrote both configs and left VNC on the old one — while reporting success. Needs an explicit `restart`.

**Debian's `logo.png` is a symlink** to `/usr/share/pixmaps/debian-logo.png`. `install` over a symlink writes through it, so the naive approach silently replaces the system-wide Debian logo. Hence `rm -f` first.

**Behind a reverse proxy, Cockpit rejects the WebSocket unless the external name is listed.** The page loads, then everything live — terminal, graphs, this desktop tab — fails with *"Connection failed: there was an unexpected error while connecting to the machine"*. The journal is explicit once you look: `received request from bad Origin`. Fix in `/etc/cockpit/cockpit.conf`:

```ini
[WebService]
Origins = https://your.host wss://your.host
ProtocolHeader = X-Forwarded-Proto
```

Note the origin must match **exactly, including the port**. A box configured for `https://host` (through a tunnel on 443) will refuse a direct browser connection to `https://host:9090`, because that origin is a different string. List both if you use both entry points.

**Cockpit's branding directory belongs to the package.** `cockpit-ws` searches three hard-coded paths; `$ID-$VARIANT_ID` never matches on Debian (no `VARIANT_ID`), and `/usr/local/share` is not consulted at all. That leaves the package-owned `$ID` directory, so an upgrade restores the default — which is why a `.path` unit watches it and re-applies. Recovery measured at ~4 seconds, with no self-trigger loop.

## Tests

```
npm test        # node --test, no dependencies
```

Covers the config parsing (`desktop/config.js`), which is a separate module precisely so it can be tested — `app.js` touches the DOM and noVNC on import and won't load under node. Two of the tests are regression locks on the `^…$` anchors: without them a commented-out `#port=9999` would count as a setting. The locks were checked for their ability to fail — removing the anchors reddens exactly those two and leaves the other seven green.

## A note on verification

`verify.sh` deliberately checks *behaviour* rather than *presence*: that the port answers with an RFB banner, that every relative import in `app.js` resolves to an installed file, that the VNC server listens on localhost and nowhere else.

It still ends by telling you to go and look at the tab. An earlier version of it was green across three consecutive non-working builds, because it checked transport and files while the bug was in rendering every time. **For anything with a user interface, "the pieces are present" is not evidence.**

## Configuration

`/etc/cockpit/desktop.conf`, written by the installer:

```
port=5901
```

Read when the tab loads. Missing or corrupt → 5901: the config is a convenience, and breaking it should not cost you the tab.

## License

MIT. The Raspberry Pi logo is not vendored here — the branding uses the one already installed by the `raspberrypi-artwork` package, so it updates with the OS and stays with its owner. "Raspberry Pi" is a trademark of Raspberry Pi Ltd; this project is not affiliated with or endorsed by them.
