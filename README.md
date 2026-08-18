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

Browser → `cockpit-ws` → stream channel → local VNC. Cockpit already authenticated the user through PAM, so **the VNC server runs with no authentication** — there is nothing to log into twice.

Which makes where it listens the whole of its security, and a loopback port is not enough. `127.0.0.1` closes the network, not the machine: an unauthenticated RFB port is connectable by every process of every UID on the box, and what that buys is keyboard and pointer injection into the live session plus a continuous view of it. So on Wayland the server listens on a **unix socket inside a directory this installer creates at mode 0700** — access becomes a file permission instead of an open door, and Cockpit's stream channel takes `unix` in place of `address`/`port`, so nothing is given up to gain it.

Measured while doing this, and worth knowing if you rely on the usual assumption: `/run/user/1000` on Raspberry Pi OS is **770, not 700**, and `wayvnc` creates its socket **775** — so neither the runtime directory nor the socket's own mode would have kept group members out. Owning the parent directory is what settles it.

The X11 path does the same, with `x0vncserver -rfbunixpath` (whose `-rfbunixmode` already defaults to 0600). Verified on Fedora 44 with XFCE under Xorg: socket 0600 in a 0700 directory, an RFB banner on it, and `cockpit-bridge` able to open it — and a second `x0vncserver` on the same display coexists with an existing one quite happily.

A useful side effect: the plugin contains no reference to X11, Wayland, or any particular VNC server. It opens a stream and speaks RFB; where the pixels come from is invisible to it. The installer picks the server (`wayvnc` for Wayland, `x0vncserver` for X11) by detecting the **live session**, not by reading the distribution name.

## Two ways to point

A 1920px desktop scaled into a phone means a fingertip covers a good part of a window's title bar. Tapping where you want to click — which is what noVNC does on its own — is fine for a button and hopeless for a close box or a scrollbar. So the toolbar has a second mode, the one Chrome Remote Desktop settled on:

| | |
|---|---|
| **Direct touch** (hand icon) | you tap, it clicks there |
| **Trackpad** (touchpad icon) | the screen is a touchpad; slide to push a visible pointer, tap to click wherever it is |

In trackpad mode: **tap** left-click · **two-finger tap** right-click · **three-finger tap** middle-click · **two fingers sliding** scroll. To **drag** — a window, a resize edge, a scrollbar — either tap and then touch down again in the same place and slide, or simply press and hold for a moment before sliding. Slow movement is geared down and fast movement geared up, so the pointer can be both precise and cross the screen — the same acceleration curve that lets a small physical trackpad drive a large display.

Let go while still moving and the pointer **coasts** and slows to a stop, so crossing a 1920px desktop is one flick rather than several strokes. A finger back on the glass stops it, and a drag never coasts — it would put down what it was carrying somewhere else.

A tap's click is **held back briefly** before it is sent. That is what makes tap-then-drag work at all: the click of the first tap is a real click, and on a window title bar a click followed by the drag's press *is* a double click, so the window maximised instead of moving. Nothing can retract a click already sent, so it is not sent yet — if a finger comes back and drags, the click is dropped and the remote sees only press, motion, release. Physical touchpads do exactly this, and pay the same price: an isolated click arrives a fraction of a second late. Touching the screen again settles a waiting click immediately, so the full wait falls only on a lone tap.

**Pinch zooms**, in either mode: spreading two fingers leaves "fit" and magnifies from exactly what you were looking at, pinching back below the fit scale returns to fit. While pinching, the fingers also drag the view, because otherwise a zoomed-in desktop would have no gesture that pans it — two-finger drag is a scroll wheel and belongs to whichever app has focus. The 🔍+ / 🔍− button remains the way back to a known scale: actual pixels, or the whole screen.

The pointer you see is the **real remote cursor** — an I-beam over text, resize arrows on a window edge — not a dot this plugin invented. noVNC already draws the server's cursor as an overlay rather than a CSS cursor when it detects a touch device (a touch screen has no hover for a CSS cursor to attach to), so the pointer follows the synthetic mouse moves for free.

The button shows the mode you are **in**, and lights up while the trackpad is on. That is deliberately the opposite convention to the zoom button next to it: a mode control that shows what it would switch *to* reads backwards to half the people who meet it, and here the cost is not cosmetic — believing you are on the trackpad while actually in direct touch, in a zoomed view, means one-finger drags pan the viewport and nothing can be dragged at all. It only appears on touch devices: with a real mouse you already have relative pointing and a visible cursor.

## What this does NOT do

**It does not create a desktop.** The tab *shows* a graphical session; it does not make one. If you don't have one, the installer refuses loudly and tells you what to enable, rather than quietly installing a desktop environment you didn't ask for.

On Raspberry Pi OS: `raspi-config` → System Options → Boot / Auto Login → **Desktop Autologin**.

**It runs its own VNC server rather than reusing yours.** An already-configured VNC (the one behind `raspi-config`, for instance) is almost always authenticated and exposed — the opposite of what the design needs. Pointing at it would cost the "no second password" property, so the installer starts its own instance on localhost beside it. Several `wayvnc` instances coexist happily; the test board runs three.

## Why it opens quickly

The page is noVNC: 49 ES modules and 622kB of JavaScript. Two things are done about that at install time, both of them mechanisms Cockpit already has and this plugin was not using.

**It ships compressed.** Cockpit answers a request for `x.js` with `x.js.gz` if that is what is on disk, and sets `Content-Encoding: gzip` — from `src/cockpit/packages.py`, which strips a trailing `.gz` to build its file table and takes the encoding from `mimetypes.guess_type`. 622kB becomes **162kB, a 73% saving**, which over a phone connection is most of the wait. The plain file is *replaced*, not kept beside the compressed one: both present map to the same key in that table and the directory scan order decides which is served. Cockpit's own packages do the same — `/usr/share/cockpit/shell` has `shell.js.gz` and no `shell.js`.

**It asks for `cockpit.js` first.** Nothing in the tab happens until Cockpit's own `base1/cockpit.js` has loaded — it is what opens the channel — and Cockpit's shell shows a spinner until the frame's transport is up. So that script is the first thing in the `<head>`, ahead of everything else the page needs.

That second point replaced a `modulepreload` pass which named all 49 modules up front so the browser would not discover them in waves. It is *removed*, because it made the thing it was meant to fix worse: **cockpit-ws speaks HTTP/1.1**, so a browser has roughly six connections per host, and forty-nine preload links in the `<head>` are queued before the parser ever reaches the script the whole tab waits on. Reported from a network panel as `cockpit.js` loading so slowly it had to be cancelled. Compression stays — fewer bytes helps on any connection and cannot reorder anything. If Cockpit ever serves HTTP/2 this is worth revisiting; there the preloads would cost nothing.

## If pages take tens of seconds to arrive

Check `cockpit-tls` before suspecting anything here:

```sh
ps -eo pcpu,comm --sort=-pcpu | head -3
```

**Cockpit before 356 has a busy loop in it** — `cockpit-tls` spins on `poll()` with a zero timeout and burns whole cores, and everything it fronts crawls. Measured on the test board: four cores consumed with *zero* connections open, a 1.4kB page taking 30 seconds, and a font belonging to Cockpit's own shell taking the same 30 seconds beside it. That last detail is the giveaway — when an unrelated resource waits exactly as long as yours, the two are queued behind a shared resource, not a shared bug.

Upstream [#22274](https://github.com/cockpit-project/cockpit/issues/22274), fixed by *"tls: Fix non-blocking poll() loop"*, first released in **356**. Debian trixie ships 337; **trixie-backports has 365**. `verify.sh` says which side of that line you are on.

A long-lived console like this one is one of the reported triggers, so the plugin makes it likelier to be hit — it does not cause it.

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

**A click cannot be unsent, so a click that might turn out to be the start of a drag must not be sent yet.** Widening the arming window made tap-then-drag *arm* reliably and it still did not work: the remote was getting the tap's click and then the drag's press, which on a title bar is a double click, and the window maximised before any drag began. Delaying the click is the only fix available, and it is what libinput does for the same gesture.

**A first animation frame has a zero-length interval.** The coast stops itself when the pointer stops going anywhere, which is the right rule and made the flick die on the very frame it started: the first frame only establishes the clock, so it moves nothing, so it looked exactly like arriving at an edge. The first frame has to be skipped rather than acted on.

**One spiky velocity sample is enough to launch the pointer into orbit.** Two touch events sharing a millisecond, a coalesced batch — anything that reports a velocity an order of magnitude beyond what a hand did. Uncapped, the coast ran for seconds and put a pointer event on the wire for every frame of it. Also: read the *previous* timestamp for the interval, not the one you have just overwritten — that bug made every velocity read as if a millisecond had passed, and a slow deliberate slide ended in a flick.

**"Is this a click?" and "was that the first of two taps?" are different questions and need different slops.** Sharing one is what actually broke the double-tap drag on a phone: measured, **18px of slide during the first tap lost the click *and* the drag meant to follow it**, leaving no gesture at all — and a thumb tapping twice in a hurry slides that far routinely. The click test stays tight, or a deliberate slide would click; the chain test is three times looser. Android draws the same distinction far more sharply: 8dp of touch slop against 100dp of double-tap slop. The chain distance is measured from where the gesture *started*, which is what keeps a repositioning stroke out — a stroke travels and ends far from its origin, while a sloppy tap wanders and comes back.

**Gesture timing has to be tested with the timing it will actually see.** The double-tap-drag was covered by a test that fired its touch events back to back, and it passed while the gesture was failing about half the time in a hand. A real one has a gap after the tap and a further pause before the finger moves; measured against those, a 300ms arm window — counted from the tap's *release*, which is shorter than the press-to-press double-tap timeouts usually quoted — missed most attempts. The window is now 500ms, with the discrimination carried by a distance condition instead: the second touch has to land where the first one was, so reaching elsewhere to reposition the pointer stays a reposition.

**A tap window measured from the first finger is not a tap window.** A two-finger tap needs time for the second finger to land, be noticed, and lift; a quarter of a second is not enough and the right click simply never arrives. The threshold is now the long-press timeout, which is also the only value that cannot conflict with it.

**`wayvnc` without `--config` reads `~/.config/wayvnc/config`** — someone else's file. On the test board it began with `[wayvnc]`, and this parser has no sections: `Failed to load config. Error on line 1`.

**`wayvnc`'s control socket defaults to one shared path.** Machines easily run several instances; without an explicit `--socket` you take the socket away from a neighbour.

**`systemctl enable --now` is a no-op on a running unit.** Re-running with a different `--port` rewrote both configs and left VNC on the old one — while reporting success. Needs an explicit `restart`.

**`wayvnc` does not unlink a stale socket, and refuses to bind over one.** So the first install worked and every one after it did not: `Failed to listen on socket or bind to its address`, a restart loop, and a tab with nothing to connect to. `ExecStartPre` removes the socket before starting. Found by installing twice — which is the common case, not the rare one.

**`StartLimitIntervalSec` and `StartLimitBurst` live in `[Unit]`, not `[Service]`.** Put in the wrong section they are ignored in silence, which is how a unit that could never start got to restart nineteen times.

**A multi-finger tap had no slop at all.** `moved = true` on any two-finger `touchmove` looked harmless next to the pinch/scroll threshold three lines below it, and meant a single event of finger drift dropped the right click entirely — while a one-finger tap enjoyed twelve pixels of tolerance. Two fingers rarely rest perfectly still for the 60–250ms a tap takes. Found by review, reproduced by a test that inserts one `touchmove` into a two-finger tap; no test in either suite had done that.

**Intercepting `Ctrl+<key>` without looking at Shift and Alt rewrites them.** `Ctrl+Shift+C` — how every Linux terminal copies — was arriving at the remote as a bare `Ctrl+C`, i.e. SIGINT to whatever was running. Modifiers now fall through untouched.

**`stopGlide()` cannot unqueue a frame `requestAnimationFrame` has already accepted.** A flick completed inside one frame interval left the previous loop alive to find the *new* glide object and schedule itself again: two loops, one state, double speed and twice the traffic. A generation counter, not a null check.

**`Display.viewportChangePos` floors its deltas and keeps no remainder**, and `Math.floor` is not symmetric about zero. At zoom 4 a slow push against the right edge asks for 0.275 framebuffer pixels and gets nothing, while the same push at the left edge floors to −1 and moves — the edge pan worked in one direction only. The fraction is carried now, and "did it move" is read back from the viewport origin rather than inferred from having asked.

**Preloading is a reordering, and on HTTP/1.1 reordering is zero-sum.** Naming 49 modules up front does not widen the six connections a browser will open; it only decides who goes first — and putting them in the `<head>` put all of them ahead of `base1/cockpit.js`, which the entire tab waits on. The optimisation was measured as a 73% reduction in bytes and shipped alongside a change that made the critical path last. Compression and preloading looked like one improvement and were two, with opposite signs.

**Timers must be scheduled from the event's time, not the handler's.** The gesture recogniser measures elapsed time from `ev.timeStamp`, so a long-press timer that waits its full interval from the moment the handler ran waits too long by however late the handler was — which, on a busy main thread, is exactly when it is late. Subtracting the delay already incurred makes the two clocks agree, and it is also what stopped a test harness that backdates its events from seeing spurious long presses.

**Deleting the old output before regenerating it is not always the tidy choice.** The compression pass began by clearing every `.gz`, which reads as obviously correct and destroys the installation: noVNC is copied only when absent, so on the second run its sources are *already* compressed, and "delete all `.gz`, then compress every `.js`" removes sixty files and finds nothing to replace them with. Measured: 80 noVNC modules became 20, and the tab would have been blank. Stale output may only be deleted where staleness can actually be established.

**A generator that reads its own output has to understand its own output.** The same second run collapsed the preload list from 49 entries to 5, because the walk that follows imports could read `x.js` but not `x.js.gz` and so stopped at the first already-installed module. It failed quietly, in the direction of doing less.

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

`test/bridge-channel.py <socket|port>` proves the transport itself, and `verify.sh` runs it: it asks **cockpit-bridge** to open the very channel the plugin opens and checks that an RFB banner comes back. Everything else can be checked from outside — the server runs, it speaks RFB, the files are installed and readable — but the link between them is where the assumptions live, and until this existed the only way to test it was to open the tab and type a password. cockpit-bridge speaks its protocol on stdio to whoever runs it, so this needs neither.

`npm test` covers the two modules that hold decisions rather than DOM calls, and are separate files precisely so they can be tested: `desktop/config.js` (parsing) and `desktop/trackpad.js` (what counts as a tap, when a touch becomes a drag, how far the pointer travels per finger-pixel). `app.js` touches the DOM and noVNC on import and won't load under node.

58 tests. Several are regression locks, and each was checked for its **ability to fail** — the fix removed, the suite run, exactly the expected test red. Two of them did not fail, which is how it came out that treating a hand-off between fingers as movement drops half of all right clicks: whichever finger leaves first is a coin toss.

`npm run test:browser` is the other half, because "the event was dispatched" is not evidence. It loads the real `app.js` against the real noVNC, speaks just enough RFB to bring the client up with a 1920×1080 framebuffer, feeds it **real browser touch events** over the DevTools Protocol, and decodes the pointer messages the client sends back — coordinates and button mask. 30 checks. It found a right click arriving as a middle click, a two-finger tap being silently dropped, a stray pointer grab that killed the toolbar, and zooming out shrinking the picture instead of showing more desktop. Note what it could *not* pin down: the exact arm window, because CDP round-trip latency swamps a 200ms difference. Timing constants are locked by the unit tests, which have an exact clock.

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
