# raspberry-cockpit

[Cockpit](https://cockpit-project.org/) on Raspberry Pi OS, with the parts the distribution doesn't give you: **your actual desktop in a browser tab**, a **file browser**, VM and container management, and branding that says *Raspberry Pi OS* instead of a generic Debian wordmark.

```sh
curl -fsSL https://raw.githubusercontent.com/interkelstar/raspberry-cockpit/master/get.sh | bash
```

Then open `https://<your-pi>:9090`.

<details>
<summary>Prefer to read it first? (you should)</summary>

```sh
git clone https://github.com/interkelstar/raspberry-cockpit
cd raspberry-cockpit
./install.sh --dry-run        # print the plan, touch nothing
./install.sh
```

`get.sh` clones the repository to `~/.local/share/raspberry-cockpit` and runs `install.sh` from there — the installer is not a single file (it needs `desktop/` and `branding/`), and keeping the clone means `verify.sh` and `--uninstall` stay available afterwards.
</details>

```
./install.sh                  everything
./install.sh --only desktop   one part: cockpit, files, desktop, branding
./install.sh --port 5902      VNC port for the desktop tab (default 5901)
./install.sh --dry-run        print the plan, touch nothing
./verify.sh                   check that it actually works
./install.sh --uninstall      remove what this added
```

Arguments pass through the one-liner too:

```sh
curl -fsSL https://raw.githubusercontent.com/interkelstar/raspberry-cockpit/master/get.sh | bash -s -- --only desktop
```

## What you get

| | |
|---|---|
| **Desktop** | the machine's own graphical session in a Cockpit tab, over noVNC |
| **Trackpad mode** | on a phone, the screen becomes a touchpad with a visible pointer |
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

## Two ways to point

A 1920px desktop scaled into a phone means a fingertip covers a good part of a window's title bar. Tapping where you want to click — which is what noVNC does on its own — is fine for a button and hopeless for a close box or a scrollbar. So the toolbar has a second mode, the one Chrome Remote Desktop settled on:

| | |
|---|---|
| **Direct touch** (hand icon) | you tap, it clicks there |
| **Trackpad** (touchpad icon) | the screen is a touchpad; slide to push a visible pointer, tap to click wherever it is |

In trackpad mode: **tap** left-click · **two-finger tap** right-click · **three-finger tap** middle-click · **two fingers sliding** scroll. To **drag** — a window, a resize edge, a scrollbar — either tap and then touch down again in the same place and slide, or simply press and hold for a moment before sliding. Slow movement is geared down and fast movement geared up, so the pointer can be both precise and cross the screen — the same acceleration curve that lets a small physical trackpad drive a large display.

**Pinch zooms**, in either mode: spreading two fingers leaves "fit" and magnifies from exactly what you were looking at, pinching back below the fit scale returns to fit. While pinching, the fingers also drag the view, because otherwise a zoomed-in desktop would have no gesture that pans it — two-finger drag is a scroll wheel and belongs to whichever app has focus. The 🔍+ / 🔍− button remains the way back to a known scale: actual pixels, or the whole screen.

The pointer you see is the **real remote cursor** — an I-beam over text, resize arrows on a window edge — not a dot this plugin invented. noVNC already draws the server's cursor as an overlay rather than a CSS cursor when it detects a touch device (a touch screen has no hover for a CSS cursor to attach to), so the pointer follows the synthetic mouse moves for free.

The button shows the mode you are **in**, and lights up while the trackpad is on. That is deliberately the opposite convention to the zoom button next to it: a mode control that shows what it would switch *to* reads backwards to half the people who meet it, and here the cost is not cosmetic — believing you are on the trackpad while actually in direct touch, in a zoomed view, means one-finger drags pan the viewport and nothing can be dragged at all. It only appears on touch devices: with a real mouse you already have relative pointing and a visible cursor.

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

Trackpad mode is covered by `npm run test:browser` down to the RFB bytes on the wire, on an emulated phone viewport with real touch input. That is strong evidence and it is still not the same as a thumb on actual glass — the feel of the acceleration curve, in particular, is a judgement no assertion makes.

## Things that cost real time

Every one of these presents the same way: the installer reports success, the checks are green, and the tab is blank. None of them is visible from the server side.

**The `ready` event may never arrive.** On Cockpit 337 the stream channel starts delivering data without ever emitting `ready`. Treating it as the open signal loses the handshake and noVNC dies with `Unknown init state (state: )`. "Open" has to be whichever comes first — `ready` or the first byte.

**`Object.defineProperty` defaults to `enumerable: false`, and `Websock.attach()` validates the socket with `Object.keys()`.** Accessor properties exist and work perfectly, yet are invisible to that check: the RFB constructor throws `Raw channel missing property: onmessage` before any canvas exists — and the console stays *silent*, because the exception is swallowed by a promise.

**Open must not be delivered synchronously from a setter.** `attach()` assigns `onmessage`, then `onopen`, then `onclose`/`onerror`. A synchronous delivery starts the handshake mid-`attach()`, on a half-assembled socket, and the next state arrives at the wrong moment: `Unexpected server connection while connecting`. A real WebSocket never fires `onopen` from an assignment; hence `queueMicrotask`.

**DOM numbers the mouse buttons twice, and differently.** `MouseEvent.button` counts 0 left / 1 middle / 2 right; the `buttons` bitmask is 1 left / 2 right / 4 middle — middle and right swap places. Deriving one from the other with `1 << button` looks obviously right and silently turns every right click into a middle click. Worse, *which field is read* depends on the noVNC version: 1.5 reads `button` plus the event type, 1.6 rewrote mouse handling around `buttons` (`RFB._convertButtonMask`). A synthetic event has to fill in both, correctly. Nothing on the browser side reports this — the click is delivered, just as the wrong button.

**The viewport is in framebuffer pixels; the canvas is laid out at `scale × viewport`.** So filling a container of *C* CSS pixels needs a viewport of *C / scale*, and noVNC's own `_updateClip` passes the container size straight through — correct only at scale 1, which is all stock noVNC ever needs, because `scaleViewport` turns clipping off and the two are never combined. Reuse it while zoomed and the canvas comes out exactly `scale` times too small: **zooming out shrank the picture instead of showing more desktop.** Measured, it was 412 → 412 desktop pixels visible while the drawing went 309px → 155px in the same 412px container.

**A page that never says `width=device-width` is a page the phone still arbitrates gestures for**, with double-tap zoom and the tap delay that comes with it — and `touch-action: none` lives in noVNC's `app/styles/base.css`, part of its bundled UI, not of `core/rfb.js`. Import only the core, as this plugin does, and the canvas silently keeps the browser's default gesture handling. Neither is visible to a desktop browser, and neither is reachable by a test harness: CDP injects touches below the level where the browser decides who owns a gesture. They are now asserted as properties rather than behaviour.

**The harness page must be built from the shipped page, not written alongside it.** It was a copy, the copy had gained a viewport meta the real page lacked, and a phone-only failure therefore could not reproduce. `run.sh` now takes `desktop/index.html` and substitutes one script tag.

**Touch hit-testing uses the finger's radius, so a touch whose centre is outside an element is still delivered with that element as its target.** A tap on the letterbox beside a fitted desktop targets the canvas. Deciding not to act on it is not enough: `preventDefault` alone stops the browser synthesising a mouse click, while noVNC's own `GestureHandler`, attached to that canvas, still turns the touch into a click at the finger. Swallowing means `stopPropagation` too.

**noVNC grabs the pointer with a full-screen transparent div, and only a `mouseup` seen at window level lets it go.** `setCapture` drops `#noVNC_mouse_capture_elem` (z-index 10000) over the whole page on every mousedown. A synthetic mouseup dispatched at the canvas never reaches window: noVNC's own handler calls `stopPropagation` on it. So after the first tap the div stays, invisible, over everything — and every toolbar button under it is dead, with no error and nothing to see. The fix is to call the exported `releaseCapture()` after each synthetic release. The lesson generalises: **synthesising input means inheriting the side effects the real thing would have undone.**

Related, and the reason the scoping test is geometric: deciding "is this touch mine?" from `ev.target` is wrong whenever a transparent overlay exists, because the target is the overlay and the user is touching what they see. Comparing coordinates against rectangles cannot be fooled that way.

**Pressing the button when the finger lands is not the same as arming a drag.** A tap that arms the next touch, and presses immediately on it, turns an ordinary tap-then-two-finger-tap into a *left* click — reported from a phone as "right click just doesn't work". Arming must wait for actual movement before it commits to a button.

**Gesture timing has to be tested with the timing it will actually see.** The double-tap-drag was covered by a test that fired its touch events back to back, and it passed while the gesture was failing about half the time in a hand. A real one has a gap after the tap and a further pause before the finger moves; measured against those, a 300ms arm window — counted from the tap's *release*, which is shorter than the press-to-press double-tap timeouts usually quoted — missed most attempts. The window is now 500ms, with the discrimination carried by a distance condition instead: the second touch has to land where the first one was, so reaching elsewhere to reposition the pointer stays a reposition.

**A tap window measured from the first finger is not a tap window.** A two-finger tap needs time for the second finger to land, be noticed, and lift; a quarter of a second is not enough and the right click simply never arrives. The threshold is now the long-press timeout, which is also the only value that cannot conflict with it.

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
npm test                # node --test, no dependencies, ~0.2s
npm run test:browser    # real touch input through real chromium, ~30s
```

`npm test` covers the two modules that hold decisions rather than DOM calls, and are separate files precisely so they can be tested: `desktop/config.js` (parsing) and `desktop/trackpad.js` (what counts as a tap, when a touch becomes a drag, how far the pointer travels per finger-pixel). `app.js` touches the DOM and noVNC on import and won't load under node.

40 tests. Several are regression locks, and each was checked for its **ability to fail** — the fix removed, the suite run, exactly the expected test red. Two of them did not fail, which is how it came out that treating a hand-off between fingers as movement drops half of all right clicks: whichever finger leaves first is a coin toss.

`npm run test:browser` is the other half, because "the event was dispatched" is not evidence. It loads the real `app.js` against the real noVNC, speaks just enough RFB to bring the client up with a 1920×1080 framebuffer, feeds it **real browser touch events** over the DevTools Protocol, and decodes the pointer messages the client sends back — coordinates and button mask. 22 checks. It found a right click arriving as a middle click, a two-finger tap being silently dropped, a stray pointer grab that killed the toolbar, and zooming out shrinking the picture instead of showing more desktop. Note what it could *not* pin down: the exact arm window, because CDP round-trip latency swamps a 200ms difference. Timing constants are locked by the unit tests, which have an exact clock.

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
