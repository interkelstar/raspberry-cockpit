import RFB from "./novnc/core/rfb.js";
// The port lives in its own module so the parsing can be unit-tested: this file
// touches the DOM and noVNC on import and cannot be loaded under node.
import { readTarget, DEFAULT_PORT } from "./config.js";
// Same reason again: the gesture recognition is where the decisions are, so it
// lives apart from the DOM and is unit-tested.
import { createTrackpad, LONG_PRESS_MS, TAP_HOLD_MS } from "./trackpad.js";
// noVNC grabs the pointer on mousedown by dropping a FULL-SCREEN transparent
// div (#noVNC_mouse_capture_elem, z-index 10000) over the page, and takes it
// away again on a mouseup seen at window level. Our synthetic mouseup never
// gets there: noVNC's own canvas handler calls stopPropagation on it. So the
// div stayed, over everything, and every toolbar button below it went dead
// after the first tap — invisibly, since the div is transparent.
import { releaseCapture } from "./novnc/core/util/events.js";

let rfb;

// Pointer mode. "touch" is direct: you tap where you want to click, which is what
// noVNC does on its own. "trackpad" is relative: the screen becomes a touchpad,
// the finger pushes a visible pointer around, and clicks land wherever that
// pointer is. Direct touch is unusable for anything small — a 1920px desktop
// scaled into a phone means a fingertip covers a good fraction of a window's
// title bar — which is why Chrome Remote Desktop offers exactly this pair.
let pointerMode = "touch";
try {
  if (localStorage.getItem("ad-desktop-pointer") === "trackpad") pointerMode = "trackpad";
} catch (e) { /* private mode */ }

// Viewport mode (mobile-friendly): "fit" scales the whole FHD desktop into the view
// (default, good overview); "pan" shows actual pixels and lets the user drag the viewport
// around the fixed FHD canvas (readable on a phone). resizeSession stays false either way —
// the remote screen is a fixed 1080p by product decision. Choice persists in localStorage.
let panMode = false;
try { panMode = localStorage.getItem("ad-desktop-pan") === "1"; } catch (e) { /* private mode */ }
function applyViewportMode() {
  if (!rfb) return;
  rfb.scaleViewport = !panMode;
  rfb.clipViewport = panMode;
  // dragViewport must be OFF in trackpad mode even when panning. It is checked
  // inside noVNC's mouse handling, not its touch handling, so it would swallow
  // the synthetic press we send for a tap and turn every click into a pan.
  rfb.dragViewport = panMode && pointerMode !== "trackpad";
  if (panMode) applyZoom();
}

// Zoom, meaningful only in pan mode: fit mode is by definition "whatever scale
// shows all of it". 1.0 is actual pixels, which is what the toolbar button
// gives you; pinching moves it from there. Persisted, like the mode itself.
const MIN_ZOOM = 0.2, MAX_ZOOM = 4;
let zoom = 1;
try {
  const z = parseFloat(localStorage.getItem("ad-desktop-zoom"));
  if (z >= MIN_ZOOM && z <= MAX_ZOOM) zoom = z;
} catch (e) { /* private mode */ }

// _display is private, but Display.scale is a public property of a public class,
// and there is no route to manual scaling through RFB: scaleViewport is
// all-or-nothing autoscale.
//
// The viewport size has to be set here too, and it is the whole reason zooming
// out used to SHRINK the desktop instead of showing more of it. The viewport is
// measured in framebuffer pixels while the canvas is laid out at
// scale x viewport, so filling a container of C css pixels needs a viewport of
// C / scale. noVNC's own _updateClip passes the container size straight through,
// which is right only at scale 1 — clipping and scaling are never combined in
// stock noVNC, since scaleViewport turns clipping off. Reusing it left the
// canvas exactly `scale` times too small, i.e. a smaller picture of the same
// amount of desktop: the opposite of zooming out.
function applyZoom() {
  if (!rfb) return;
  try {
    const b = screenEl.getBoundingClientRect();
    rfb._display.scale = zoom;
    rfb._display.viewportChangeSize(b.width / zoom, b.height / zoom);
  } catch (e) { /* no scaling available — stay wherever noVNC put us */ }
}

// Panning in whole framebuffer pixels, with the fraction carried over.
// Display.viewportChangePos FLOORS its deltas and keeps no remainder, so every
// sub-pixel request was thrown away — and floor is not symmetric about zero, so
// it was thrown away in one direction only. At zoom 4 a slow push against the
// right edge asks for 0.275px and gets nothing, while the same push at the left
// edge floors to -1 and moves: the pan worked leftwards and not rightwards.
//
// It also reports whether the viewport actually MOVED, read through absX/absY,
// which return the viewport origin. The coast needs that: "the overshoot was
// non-zero" is not the same as "we went somewhere", and at the framebuffer
// boundary viewportChangePos returns having done nothing.
const panRest = { x: 0, y: 0 };
function panViewport(dxFb, dyFb) {
  if (!rfb) return false;
  try {
    const d = rfb._display;
    panRest.x += dxFb;
    panRest.y += dyFb;
    const ix = Math.trunc(panRest.x), iy = Math.trunc(panRest.y);
    if (ix === 0 && iy === 0) return false;
    panRest.x -= ix;
    panRest.y -= iy;
    const wasX = d.absX(0), wasY = d.absY(0);
    d.viewportChangePos(ix, iy);
    return d.absX(0) !== wasX || d.absY(0) !== wasY;
  } catch (e) {
    return false;
  }
}

// The scale at which the whole desktop fits. Below it, panning has nothing to
// pan to, so that is the point where pinching in should hand back to fit mode.
function fitScale() {
  try {
    const b = screenEl.getBoundingClientRect();
    return Math.min(b.width / rfb._display.width, b.height / rfb._display.height);
  } catch (e) { return MIN_ZOOM; }
}

let refreshFitButton = () => {};
function setPanMode(on) {
  if (panMode === on) return;
  panMode = on;
  try { localStorage.setItem("ad-desktop-pan", on ? "1" : "0"); } catch (e) { /* ignore */ }
  applyViewportMode();
  refreshFitButton();
  setTimeout(updateFrame, 150);
}

function applyPinch(factor, cx, cy) {
  if (!rfb) return;
  const c = canvasEl();
  if (!c) return;
  let before;
  try { before = rfb._display.scale; } catch (e) { return; }

  // Pinching out while fitted enters zoom mode from exactly what you were
  // looking at, rather than jumping to 1:1 first.
  if (!panMode) {
    if (factor <= 1) return;
    zoom = before;
    setPanMode(true);
  }

  const rect = c.getBoundingClientRect();
  const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
  if (target < fitScale()) { setPanMode(false); return; }

  zoom = target;
  applyZoom();
  try { localStorage.setItem("ad-desktop-zoom", String(zoom)); } catch (e) { /* ignore */ }

  // Keep the desktop pixel that was between the fingers between the fingers.
  // Without this the view lurches toward its top-left corner on every pinch.
  try {
    const after = rfb._display.scale;
    const k = (1 / before) - (1 / after);
    panViewport((cx - rect.left) * k, (cy - rect.top) * k);
  } catch (e) { /* anchoring is a nicety, not a requirement */ }
}

// Where the local VNC server is. A unix socket when the installer could arrange
// one, a port otherwise. It lives in a variable and NOT as a connect() argument:
// on a drop, reconnect is called as setTimeout(connect, 1500) — with NO arguments
// — so a parameter would silently become undefined. That gives the worst possible
// failure: the first connection works, recovery after a drop does not.
let vncTarget = { port: DEFAULT_PORT };

// noVNC over a Cockpit stream channel to the local VNC, wrapped as a
// WebSocket-like object that RFB/Websock.attach() accepts. The Cockpit session authenticates
// it — no websockify, no extra password: reaching this tab already required a Cockpit/PAM login.
function cockpitVncSocket() {
  // A unix socket is reachable by its owner and nobody else; a no-auth listener
  // on 127.0.0.1 is reachable by every process on the machine, of any UID, and
  // full pointer, keyboard and screen access is what that gets them. The port is
  // the fallback for servers that cannot do sockets.
  const channel = cockpit.channel(vncTarget.socket
    ? { payload: "stream", unix: vncTarget.socket, binary: true }
    : { payload: "stream", address: "127.0.0.1", port: vncTarget.port, binary: true });
  const sock = {
    binaryType: "arraybuffer", readyState: 0, bufferedAmount: 0, protocol: "",
    onclose: null, onerror: null,
    send(data) { channel.send(data instanceof Uint8Array ? data : new Uint8Array(data)); },
    close() { try { channel.close(); } catch (e) { /* ignore */ } },
  };

  // What follows is a queue plus pump(), rather than forwarding events straight
  // through. There are TWO reasons, both measured on a live machine, and both
  // producing the same symptom: noVNC dies with "Unknown init state (state: )",
  // i.e. it receives bytes before it has been told the socket opened.
  //
  // 1. The "ready" event may never arrive AT ALL. On Cockpit 337 the stream
  //    channel starts delivering data without ever sending ready (proved by
  //    instrumenting: "PROBE message … readyState=0" appears, "PROBE ready"
  //    never does). So "open" is taken to be whichever comes FIRST — the ready
  //    event or the first data.
  // 2. The handlers are attached by RFB, and it does that AFTER
  //    cockpitVncSocket() has returned the object: the socket is built as a
  //    constructor argument. So an event can arrive while onopen is still null
  //    and the open signal would be lost forever. Hence onopen/onmessage are
  //    accessor properties: assigning to them drives pump() itself.
  const pending = [];
  let openDelivered = false;
  let _onopen = null, _onmessage = null;

  function pump() {
    if (!_onopen) return;                 // RFB has not subscribed yet — data queues up
    if (!openDelivered) {
      openDelivered = true;
      sock.readyState = 1;
      _onopen(new Event("open"));
    }
    while (_onmessage && pending.length) _onmessage({ data: pending.shift() });
  }

  // Delivery is ALWAYS asynchronous, and that is not an optimisation.
  // Websock.attach() assigns onmessage, then onopen, and only then
  // onclose/onerror. If the setter delivered "open" synchronously, the handlers
  // would run in the middle of attach() — RFB would begin the handshake on a
  // half-assembled socket, and the very next state arrives at the wrong moment:
  // "Unexpected server connection while connecting". A real WebSocket never
  // calls onopen synchronously from an assignment, and neither should a fake one.
  // A microtask runs after the current synchronous block, i.e. after the RFB
  // constructor has finished entirely.
  let scheduled = false;
  function schedulePump() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }

  // enumerable: true is MANDATORY, and it's not cosmetic. Websock.attach() checks
  // the socket's suitability like this:
  //     [...Object.keys(rawChannel), ...Object.getOwnPropertyNames(proto)]
  // and Object.keys() only returns ENUMERABLE properties. With defineProperty
  // enumerable defaults to false, so the getters exist, work — and are
  // invisible to the check: the RFB constructor fails with "Raw channel missing
  // property: onmessage" before the canvas is even created. From the outside
  // this looks like "blank page, console silent".
  const accessor = (getter, setter) => ({ get: getter, set: setter, enumerable: true, configurable: true });
  Object.defineProperty(sock, "onopen", accessor(() => _onopen, (fn) => { _onopen = fn; schedulePump(); }));
  Object.defineProperty(sock, "onmessage", accessor(() => _onmessage, (fn) => { _onmessage = fn; schedulePump(); }));

  channel.addEventListener("ready", schedulePump);
  channel.addEventListener("message", (_ev, payload) => {
    const u8 = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    // Copy the slice: cockpit's buffer is reused, and we may hand ours off later.
    pending.push(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    schedulePump();
  });
  channel.addEventListener("close", (_ev, options) => {
    sock.readyState = 3;
    if (sock.onclose) sock.onclose(new CloseEvent("close", { reason: (options && options.problem) || "" }));
  });
  return sock;
}

const clipEl = document.createElement("div");
clipEl.contentEditable = true;
clipEl.style.cssText =
  "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
document.body.appendChild(clipEl);

function pasteToVnc(text) {
  if (!rfb || !text) return;
  rfb.clipboardPasteFrom(text);
  setTimeout(() => {
    rfb.sendKey(0xffe3, "ControlLeft", true);
    rfb.sendKey(0x0076, "KeyV", true);
    rfb.sendKey(0x0076, "KeyV", false);
    rfb.sendKey(0xffe3, "ControlLeft", false);
    rfb.focus();
  }, 50);
}

// Cmd/Ctrl+V can arrive via two paths (async Clipboard API and the native paste-event
// on clipEl) — both call deliverPaste; dedup over a short window so it isn't pasted twice.
let lastPasteAt = 0;
function deliverPaste(text) {
  if (!text) return;
  const now = Date.now();
  if (now - lastPasteAt < 400) return;
  lastPasteAt = now;
  pasteToVnc(text);
}

clipEl.addEventListener("paste", (e) => {
  e.preventDefault();
  e.stopPropagation();
  deliverPaste((e.clipboardData || window.clipboardData)?.getData("text/plain"));
});

function connect() {
  rfb = new RFB(document.getElementById("screen"), cockpitVncSocket());
  // A reconnect builds a new canvas, so the remembered pointer position belongs
  // to an element that no longer exists — drop it and re-centre on first use.
  cursor.placed = false;
  panRest.x = 0; panRest.y = 0;
  applyViewportMode();
  rfb.resizeSession = false;
  rfb.qualityLevel = 8;
  rfb.compressionLevel = 2;

  rfb.addEventListener("clipboard", (e) => {
    navigator.clipboard.writeText(e.detail.text).catch(() => {});
  });

  rfb.addEventListener("disconnect", () => {
    // Everything blur does, and for the same reason: noVNC removes the canvas on
    // cleanup while our `rfb` stays truthy, so a finger still down when the
    // channel drops has its touchend swallowed and the recogniser keeps `held`.
    // On noVNC 1.6, which reads ev.buttons, that turns every later mousemove
    // into a held left button — a stuck drag that survives the reconnect.
    runIntents(trackpad.cancel());
    clearTimeout(longPressTimer);
    clearTimeout(flushTimer);
    stopGlide();
    engaged = false;
    ignoring = false;
    setTimeout(connect, 1500);
  });
}

// Cockpit hides the inactive plugin-iframe via display:none, so
// visibilitychange doesn't fire. ResizeObserver catches the 0×0 → real
// size transition; resetting and reapplying the mode forces RFB to recompute the viewport
// and redraw the canvas (otherwise it's a gray screen after returning to the tab).
const screenEl = document.getElementById("screen");

// Frame to match the native Cockpit page card: inset (24px body padding, in style.css) +
// rounded corners. The radius is clamped to the noVNC letterbox so it NEVER clips the actual
// desktop — pan/actual-size fills the canvas (letterbox 0 -> radius 0); fit with margin ->
// up to 16px. Fullscreen or a phone-width/touch viewport -> flush (no inset, no radius:
// matches native's mobile collapse and avoids eating space where the nav is a drawer).
// Measure the real native Cockpit page-card insets (per side) + radius by probing a throwaway
// .pf-v6-c-page__main-container in the shell — the block (top/bottom) and inline (left/right)
// margins use DIFFERENT, mode/breakpoint-dependent tokens, so a hardcode drifts (the top gap
// didn't line up with native). Cached; refreshed on resize.
let NATIVE = { top: 24, right: 24, bottom: 24, left: 24, radius: 16 };
function refreshNative() {
  let page = null;
  try {
    const pdoc = window.parent.document;
    page = pdoc.createElement("div"); page.className = "pf-v6-c-page";
    page.style.cssText = "position:absolute;left:-9999px;top:0;width:800px;height:800px;visibility:hidden";
    const mc = pdoc.createElement("div"); mc.className = "pf-v6-c-page__main-container";
    page.appendChild(mc); pdoc.body.appendChild(page);
    const cs = window.parent.getComputedStyle(mc);
    const num = (v, d) => { const n = parseFloat(v); return isFinite(n) ? Math.max(0, n) : d; };
    // Only the TOP uses the block-start token (it differs from the inset); the card's other
    // three sides are the page inline inset. marginBlockEnd on a bare main-container is 0/auto
    // (unreliable), so derive left/right/bottom from marginInlineStart, which resolves cleanly.
    const inset = num(cs.marginInlineStart, 24);
    NATIVE = {
      top: num(cs.marginBlockStart, 24),
      right: inset, bottom: inset, left: inset,
      radius: num(cs.borderTopLeftRadius, 16),
    };
  } catch (e) { /* keep defaults */
  } finally {
    // In a finally, because a throw between the append and the remove leaks a
    // hidden div into the SHELL's document, not ours, and it accumulates.
    try { if (page && page.parentNode) page.parentNode.removeChild(page); } catch (e2) { /* gone already */ }
  }
}
// resize fires continuously while a window is dragged or a mobile keyboard
// animates, and each call above mutates the parent document and forces a layout
// in the Cockpit shell. Coalesce to one measurement per burst.
let nativeTimer = null;
function refreshNativeSoon() {
  clearTimeout(nativeTimer);
  nativeTimer = setTimeout(refreshNative, 120);
}
// The frame is dropped only when Cockpit has moved the nav out of the left column into its
// collapsed/hamburger mode (the masthead toggle becomes visible) — NOT merely on a narrow or
// touch viewport. A phone in landscape keeps the side nav, so it should keep the frame.
function navCollapsed() {
  try {
    const pdoc = window.parent.document;
    const t = pdoc.querySelector(".pf-v6-c-masthead__toggle");
    if (t) {
      const cs = window.parent.getComputedStyle(t);
      return cs.display !== "none" && cs.visibility !== "hidden" && t.getClientRects().length > 0;
    }
  } catch (e) { /* fall through */ }
  return (window.parent && window.parent.innerWidth || window.innerWidth) < 1200; // cockpit docks sidebar >= 75rem
}
function updateFrame() {
  const flush = !!document.fullscreenElement || navCollapsed();
  document.body.classList.toggle("ad-flush", flush);
  if (flush) { document.body.style.padding = "0"; screenEl.style.borderRadius = "0"; return; }
  document.body.style.padding = `${NATIVE.top}px ${NATIVE.right}px ${NATIVE.bottom}px ${NATIVE.left}px`;
  const canvas = screenEl.querySelector("canvas");
  let r = 0;
  if (canvas) {
    const s = screenEl.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    const lbX = Math.floor((s.width - c.width) / 2), lbY = Math.floor((s.height - c.height) / 2);
    // A rounded corner clips a small triangle at the corner; those pixels are non-desktop as
    // long as EITHER axis has >= r of letterbox there (the corner falls in the black band).
    // So the safe radius is bounded by max(lbX, lbY), not min. Both 0 (canvas fills, e.g. pan)
    // -> 0. This is why the desktop rounds only when there's a letterbox on some side.
    r = Math.max(0, Math.min(NATIVE.radius, Math.max(lbX, lbY)));
  }
  screenEl.style.borderRadius = r + "px";
}

new ResizeObserver(() => {
  if (rfb && screenEl.clientWidth > 0) {
    rfb.scaleViewport = false;
    rfb.clipViewport = false;
    applyViewportMode();
  }
  requestAnimationFrame(updateFrame);
}).observe(screenEl);
// The canvas appears/resizes without changing #screen's own size, so watch for it directly.
new MutationObserver(() => {
  const canvas = screenEl.querySelector("canvas");
  if (canvas && !canvas.__adObserved) {
    canvas.__adObserved = true;
    new ResizeObserver(updateFrame).observe(canvas);
  }
  updateFrame();
}).observe(screenEl, { childList: true, subtree: true });
document.addEventListener("fullscreenchange", updateFrame);
window.addEventListener("resize", () => { refreshNativeSoon(); updateFrame(); });

// Ctrl (Win/Linux) or Cmd (macOS) both become Ctrl on the remote side.
// e.code is the physical key, independent of layout (e.key with a Cyrillic
// layout would return the Cyrillic look-alike letters instead of "c"/"v"/…). Cmd would reach the
// Linux remote as Super (no-op), so we synthesize every combo as Ctrl+<key>.
function sendRemoteCtrl(keysym, code) {
  rfb.sendKey(0xffe3, "ControlLeft", true);
  rfb.sendKey(keysym, code, true);
  rfb.sendKey(keysym, code, false);
  rfb.sendKey(0xffe3, "ControlLeft", false);
  rfb.focus();
}

// We swallow Cmd/Win (Meta) entirely so noVNC doesn't send Super_L to the Linux remote:
// a held-down Super turns our synthesized Ctrl+<key> into Super+Ctrl+<key>,
// which Chromium rejects for exact shortcuts (Ctrl+A/C/X). Cmd as Super
// on the remote is useless anyway.
//
// We swallow keyup ONLY for keys whose keydown we ACTUALLY intercepted (the set below
// is populated in keydown). The previous unconditional swallow by code (KeyV/C/X/A) broke
// normal text entry: keydown of an ordinary "a" went through to noVNC (press), but keyup was
// suppressed in the capture phase before it reached the canvas listener — the release was
// never sent, remote-X considered the key held down, and
// autorepeat kicked in, typing the letter endlessly.
const suppressedUp = new Set();
document.addEventListener("keyup", (e) => {
  if (!rfb) return;
  if (e.code === "MetaLeft" || e.code === "MetaRight") {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (suppressedUp.delete(e.code)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);
// If a keyup got lost (blur/fullscreen/tab switch), the stale code would eat ONE
// subsequent ordinary keyup of the same key — clear the set on focus loss.
window.addEventListener("blur", () => suppressedUp.clear());

document.addEventListener("keydown", (e) => {
  if (!rfb) return;
  if (e.code === "MetaLeft" || e.code === "MetaRight") {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (!(e.ctrlKey || e.metaKey)) return;
  // Shift and Alt must fall THROUGH to noVNC untouched. This block rewrites a
  // combination into a bare Ctrl+<key>, and it used to do so on e.code alone —
  // so Ctrl+Shift+C, which is how every Linux terminal copies, arrived at the
  // remote as Ctrl+C and sent SIGINT to whatever was running. The same downgrade
  // hit Ctrl+Shift+A/X and every Ctrl+Alt variant. Intercepting only the plain
  // combination is both correct and the smaller claim.
  if (e.shiftKey || e.altKey) return;
  if (e.code === "KeyV" || e.code === "KeyC" || e.code === "KeyX" || e.code === "KeyA") {
    suppressedUp.add(e.code);
  }
  switch (e.code) {
    case "KeyV": // paste: async Clipboard API (Chrome/Safari, HTTPS) + fallback native paste-event on clipEl
      // We do NOT call preventDefault — otherwise OS-paste won't reach clipEl on the fallback path.
      e.stopPropagation();
      if (navigator.clipboard?.readText) {
        navigator.clipboard.readText().then(deliverPaste).catch(() => {});
      }
      clipEl.textContent = "";
      clipEl.focus();
      setTimeout(() => { if (document.activeElement === clipEl) rfb.focus(); }, 500);
      break;
    case "KeyC": // copy: remote → local clipboard (clipboard-listener mirrors it back)
      e.preventDefault(); e.stopPropagation();
      sendRemoteCtrl(0x0063, "KeyC");
      break;
    case "KeyX": // cut
      e.preventDefault(); e.stopPropagation();
      sendRemoteCtrl(0x0078, "KeyX");
      break;
    case "KeyA": // select-all
      e.preventDefault(); e.stopPropagation();
      sendRemoteCtrl(0x0061, "KeyA");
      break;
  }
}, true);

// The gutter around #screen (12px in style.css) must blend with the shell's background.
// It can't be made transparent — the plugin-iframe doesn't composite over the shell
// (renders white), and a hardcoded hex would drift from the PatternFly theme. The iframe is
// same-origin with the shell, so we read the shell page's --color-body-background token
// directly: PatternFly v6 (Cockpit 364) paints the background via color-scheme/canvas,
// NOT background-color on ancestors, so walking up for the "first opaque ancestor" finds
// nothing — the token holds the theme color instead
// (#151515 dark / #f2f2f2 light). The walk-up is kept as a fallback. Theme changes
// are caught by a MutationObserver on the <html> class.
function syncGutterBg() {
  try {
    const pdoc = window.parent.document;
    let bg = window.parent.getComputedStyle(pdoc.documentElement)
      .getPropertyValue("--color-body-background").trim();
    if (!bg) bg = window.parent.getComputedStyle(pdoc.body)
      .getPropertyValue("--color-body-background").trim();
    if (bg) { document.body.style.backgroundColor = bg; return; }
    let el = window.frameElement;
    while (el) {
      const c = window.parent.getComputedStyle(el).backgroundColor;
      if (c && c !== "transparent" && c !== "rgba(0, 0, 0, 0)") {
        document.body.style.backgroundColor = c;
        return;
      }
      el = el.parentElement;
    }
  } catch (e) { /* cosmetic — stay on the CSS fallback */ }
}
syncGutterBg();
try {
  new MutationObserver(syncGutterBg)
    .observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ["class"] });
} catch (e) { /* ignore */ }

// ---------------------------------------------------------------------------
// Trackpad pointer mode.
//
// The pointer is driven by dispatching ordinary MouseEvents at noVNC's canvas
// rather than by calling into RFB. That is deliberate: the mouse path is the
// public, decade-stable surface (mousedown/mouseup/mousemove/wheel with
// clientX/clientY), it already does the client -> element -> remote coordinate
// conversion, and it costs nothing — noVNC never checks isTrusted.
//
// The visible pointer comes free. noVNC's Cursor draws the REAL remote cursor
// image — I-beam over text, resize arrows over an edge — and on a touch device
// it draws it as a positioned overlay instead of a CSS cursor (`useFallback =
// !supportsCursorURIs || isTouchDevice`), precisely because a touch screen has
// no hover to attach a CSS cursor to. That overlay follows mousemove on the
// canvas, so our synthetic moves carry it along with no extra code and no
// second cursor of our own invention.
const trackpad = createTrackpad();
let longPressTimer = null;
let flushTimer = null;

// How fast the coast decays: velocity is multiplied by e^(-dt/GLIDE_TAU) each
// frame, so the pointer travels roughly v*TAU further after the finger leaves.
// Long enough to be worth flicking, short enough that it never feels loose.
const GLIDE_TAU = 110;
let glide = null;

// A generation counter, not just a null. stopGlide() cannot unqueue a frame that
// requestAnimationFrame has already accepted, so a flick completed inside one
// frame interval — touchstart stops the coast, touchend starts a new one, all
// before the pending callback runs — left the OLD loop alive to find a truthy
// glide and schedule itself again. Two loops then share one glide: double speed,
// double decay, twice the pointer events on the wire.
let glideGen = 0;
function stopGlide() { glide = null; glideGen++; }

// The flick, i.e. pointer inertia. A small trackpad crossing a 1920px desktop
// needs it as much as acceleration does: the two solve the same problem from
// different ends, and without inertia every long move is several strokes.
function startGlide(vx, vy) {
  glideGen++;
  glide = { vx, vy, at: null, gen: glideGen };
  requestAnimationFrame(stepGlide);
}
function stepGlide(now) {
  if (!glide || glide.gen !== glideGen) return;
  // The first frame only establishes the clock. Its interval is zero, so it moves
  // the pointer nowhere — and "went nowhere" is the signal that stops the coast,
  // so acting on this frame killed every flick on the frame it began.
  if (glide.at === null) {
    glide.at = now;
    requestAnimationFrame(stepGlide);
    return;
  }
  // Frames are capped: coming back from a background tab hands us one enormous
  // dt, which would teleport the pointer across the screen in a single step.
  const dt = Math.min(50, now - glide.at);
  glide.at = now;
  // Stop the moment the pointer stops going anywhere. Against an edge it is
  // pinned, and a decaying velocity can stay above the threshold for a long
  // while — frames burned and a pointer event on the wire for each of them,
  // every one of them reporting the same coordinate.
  const went = moveCursor(glide.vx * dt, glide.vy * dt, null);
  const decay = Math.exp(-dt / GLIDE_TAU);
  glide.vx *= decay;
  glide.vy *= decay;
  if (!went || Math.hypot(glide.vx, glide.vy) < 0.02) { glide = null; return; }
  requestAnimationFrame(stepGlide);
}

// Where the pointer is, in CLIENT pixels, kept fractional. Fractional matters:
// in fit mode the canvas is scaled, so a whole client pixel is several remote
// pixels, and rounding here would make the pointer step across the desktop in
// visible jumps at exactly the moment precision is wanted.
const cursor = { x: 0, y: 0, placed: false };

function canvasEl() { return screenEl.querySelector("canvas"); }

// DOM numbers the buttons TWICE, and differently. `button` counts them
// 0 left / 1 middle / 2 right, while the `buttons` bitmask is
// 1 left / 2 right / 4 middle — middle and right swap places. Deriving one from
// the other with 1 << button silently trades a right click for a middle click.
// It matters which one is filled in: noVNC 1.5 reads `button` and the event
// type, 1.6 rewrote mouse handling to read `buttons` (RFB._convertButtonMask).
// The Pi ships 1.6, other boxes ship 1.5, so both are filled in correctly rather
// than picking whichever the local copy happens to consult.
const BUTTONS_BIT = [1, 4, 2];

function dispatchMouse(type, button, held) {
  const c = canvasEl();
  if (!c) return;
  c.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, view: window,
    clientX: cursor.x, clientY: cursor.y,
    button: button || 0,
    buttons: held === null || held === undefined ? 0 : (BUTTONS_BIT[held] || 0),
  }));
}

// Put the pointer somewhere sane the first time the mode is used, and whenever
// the canvas has been replaced by a reconnect.
function placeCursor() {
  const c = canvasEl();
  if (!c) return false;
  const r = c.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (!cursor.placed) {
    cursor.x = r.left + r.width / 2;
    cursor.y = r.top + r.height / 2;
    cursor.placed = true;
    dispatchMouse("mousemove");
  }
  return true;
}

// Returns whether the pointer actually went anywhere — the coast needs to know.
function moveCursor(dx, dy, held) {
  const c = canvasEl();
  if (!c) return false;
  const r = c.getBoundingClientRect();
  // Half a pixel of inset: exactly on the edge, elementFromPoint can return the
  // element behind the canvas and noVNC's Cursor would blink out at the border.
  const minX = r.left + 0.5, maxX = r.right - 0.5;
  const minY = r.top + 0.5, maxY = r.bottom - 0.5;

  const wasX = cursor.x, wasY = cursor.y;
  let x = cursor.x + dx, y = cursor.y + dy;
  const overX = x > maxX ? x - maxX : (x < minX ? x - minX : 0);
  const overY = y > maxY ? y - maxY : (y < minY ? y - minY : 0);
  cursor.x = Math.min(maxX, Math.max(minX, x));
  cursor.y = Math.min(maxY, Math.max(minY, y));

  // Pushing against the edge while the viewport is clipped scrolls the desktop
  // under the pointer, the way a real screen edge does. Without this, actual-size
  // mode plus trackpad could only ever reach the visible third of a 1080p desktop.
  // _display is private API; if a future noVNC drops it the pointer simply stops
  // at the edge, which is a limitation rather than a breakage — hence the guard
  // instead of a hard dependency.
  let panned = false;
  if ((overX || overY) && rfb && rfb.clipViewport) {
    // panViewport takes FRAMEBUFFER pixels; the overshoot is in client pixels.
    // They differ by the scale as soon as zoom is not 1.
    let sc = 1;
    try { sc = rfb._display.scale || 1; } catch (e) { /* keep 1 */ }
    panned = panViewport(overX / sc, overY / sc);
  }

  dispatchMouse("mousemove", 0, held);
  // "Went nowhere" has to include the edge-pan case: pinned against the edge but
  // scrolling the desktop underneath is still going somewhere. It has to mean the
  // viewport MOVED, though — not merely that we asked it to.
  return cursor.x !== wasX || cursor.y !== wasY || panned;
}

function runIntents(list) {
  for (const it of list) {
    switch (it.t) {
      case "move":
        moveCursor(it.dx, it.dy, trackpad.holding);
        break;
      case "down":
        dispatchMouse("mousedown", it.button, it.button);
        break;
      case "up":
        // The button is already released by the time this runs, so `buttons`
        // is 0 — that is what tells noVNC 1.6 the button went up.
        dispatchMouse("mouseup", it.button, null);
        releaseCapture();
        break;
      case "click":
        dispatchMouse("mousedown", it.button, it.button);
        dispatchMouse("mouseup", it.button, null);
        releaseCapture();
        break;
      case "zoom":
        applyPinch(it.factor, it.cx, it.cy);
        break;
      case "flick":
        startGlide(it.vx, it.vy);
        break;
      case "pan":
        // Fingers moving right show what is further LEFT, so the viewport origin
        // decreases. In framebuffer pixels, hence the division by the scale.
        if (rfb && rfb.clipViewport) {
          let sc = 1;
          try { sc = rfb._display.scale || 1; } catch (e) { /* keep 1 */ }
          panViewport(-it.dx / sc, -it.dy / sc);
        }
        break;
      case "scroll": {
        const c = canvasEl();
        if (!c) break;
        // Sign follows the touch-screen convention, and noVNC's own two-finger
        // gesture: fingers move down -> content follows -> that is a scroll UP.
        c.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, view: window,
          clientX: cursor.x, clientY: cursor.y,
          deltaX: -it.dx, deltaY: -it.dy, deltaMode: 0,
        }));
        break;
      }
    }
  }
}

// Gesture timing is measured from WHEN THE INPUT HAPPENED, not from when we got
// round to handling it. ev.timeStamp is stamped by the browser as the touch
// arrives; Date.now() inside the handler adds however long the main thread was
// busy — and on a phone doing real work that is exactly the moment a queue
// builds up. A tap can then read as a long press, or a slide as a flick, purely
// because a frame ran late. performance.now() shares its time origin with
// ev.timeStamp, so the timer-driven ticks below sit on the same clock.
const eventTime = (ev) => (typeof ev.timeStamp === "number" && ev.timeStamp > 0 ? ev.timeStamp : performance.now());

function armLongPress() {
  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => runIntents(trackpad.tick(performance.now())), LONG_PRESS_MS + 20);
}
// A tap's click is held back in case a drag follows. If none does, nothing else
// would ever send it — hence a timer, not a hope.
function armFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => runIntents(trackpad.flush(performance.now())), TAP_HOLD_MS + 20);
}

function points(ev) {
  return Array.from(ev.touches, (t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));
}

// Bound on `document`, in the capture phase, for two independent reasons.
// Capture: noVNC's GestureHandler listens on the canvas itself, and a capture
// listener on an ancestor runs first, so stopPropagation here is what keeps the
// two modes from both firing. Document rather than #screen: noVNC's setCapture
// drops a full-screen proxy element into document.body for the duration of a
// button press, and a listener anchored inside #screen would stop seeing the
// finger the moment a drag started.
// Whether the gesture in progress belongs to us. Decided once, at the first
// finger down, and by GEOMETRY rather than by ev.target: a transparent overlay
// (noVNC's own pointer capture is one) changes the target without changing what
// the user is touching, and a target test then hands the toolbar's taps to the
// trackpad — where preventDefault quietly cancels the click. Geometry cannot be
// fooled that way. It is also why the decision is not re-made on touchmove: a
// drag that wanders off the canvas must keep working.
let engaged = false;
// ...and a gesture that is ours to SWALLOW without acting on. A touch on the
// letterbox beside a fitted desktop belongs to neither the trackpad nor the
// toolbar, and simply ignoring it lets the browser synthesise a mouse click from
// it — landing on noVNC at the finger's position, which is exactly the
// tap-where-you-touch behaviour this mode exists to replace.
let ignoring = false;

function within(el, x, y) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function handleTouch(ev) {
  if (pointerMode !== "trackpad" || !rfb) return;

  // A finger on the glass stops the coast, wherever it lands and whoever ends up
  // owning the gesture — including a touch that is only being swallowed.
  if (ev.type === "touchstart") stopGlide();

  if (ev.type === "touchstart" && !engaged && !ignoring) {
    const p = ev.touches[0];
    if (!p) return;
    // The toolbar is ordinary UI and keeps its taps, including the synthetic
    // click the browser makes from them.
    if (within(document.getElementById("ad-desktop-toolbar"), p.clientX, p.clientY)) return;
    const c = canvasEl();
    if (c && within(c, p.clientX, p.clientY)) engaged = true;
    else ignoring = true;
  }
  if (ignoring) {
    // stopPropagation as well as preventDefault. preventDefault only stops the
    // BROWSER synthesising a mouse click; noVNC's own GestureHandler is attached
    // to the canvas and would still turn the touch into a click at the finger —
    // and the browser's touch hit-testing uses the finger's radius, so a tap
    // just outside the canvas is still delivered with the canvas as its target.
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.touches.length === 0) ignoring = false;
    return;
  }
  if (!engaged) return;
  if (ev.touches.length === 0) engaged = false;
  if (!placeCursor()) {
    // No canvas — a reconnect took it out from under a gesture in progress.
    // Returning quietly would leave the recogniser mid-gesture, holding a button
    // nobody will ever release.
    runIntents(trackpad.cancel());
    engaged = false;
    ignoring = false;
    return;
  }

  ev.preventDefault();
  ev.stopPropagation();

  const now = eventTime(ev);
  const pts = points(ev);
  if (ev.type === "touchstart") {
    runIntents(trackpad.touchStart(pts, now));
    armLongPress();
  } else if (ev.type === "touchmove") {
    runIntents(trackpad.touchMove(pts, now));
  } else if (ev.type === "touchend") {
    runIntents(trackpad.touchEnd(pts, now));
    if (!trackpad.active) clearTimeout(longPressTimer);
    armFlush();
  } else {
    runIntents(trackpad.cancel());
    clearTimeout(longPressTimer);
    stopGlide();
  }
}
// passive:false is required — a passive listener may not preventDefault, and
// without preventDefault the browser scrolls/zooms the page under the desktop.
for (const t of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
  document.addEventListener(t, handleTouch, { capture: true, passive: false });
}
// A button held when the window goes away would stay held on the remote side.
window.addEventListener("blur", () => { runIntents(trackpad.cancel()); clearTimeout(longPressTimer); stopGlide(); engaged = false; ignoring = false; });

function setPointerMode(mode) {
  if (mode === pointerMode) return;
  runIntents(trackpad.cancel());
  clearTimeout(longPressTimer);
  stopGlide();
  engaged = false;
  ignoring = false;
  pointerMode = mode;
  cursor.placed = false;
  panRest.x = 0; panRest.y = 0;
  applyViewportMode(); // dragViewport depends on the pointer mode
  if (pointerMode === "trackpad") placeCursor();
  try { localStorage.setItem("ad-desktop-pointer", pointerMode); } catch (e) { /* ignore */ }
}

// Mobile toolbar (bottom-right, semi-transparent): pointer mode, Fit⇄1:1 mode, fullscreen,
// on-screen keyboard. All within the pinned FHD (resizeSession=false). Doesn't get in the way
// on desktop.
(function mobileToolbar() {
  // A hidden input raises the phone's soft keyboard and forwards typing to VNC. noVNC has no
  // soft keyboard of its own; beforeinput gives inserted text/Backspace/Enter more reliably than
  // keydown (mobile keyboards often send keyCode=229).
  const kbInput = document.createElement("textarea");
  kbInput.setAttribute("autocapitalize", "off");
  kbInput.setAttribute("autocorrect", "off");
  kbInput.setAttribute("autocomplete", "off");
  kbInput.setAttribute("spellcheck", "false");
  kbInput.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
  document.body.appendChild(kbInput);
  kbInput.addEventListener("beforeinput", (e) => {
    if (!rfb) return;
    if (e.inputType === "insertText" && e.data) {
      for (const ch of e.data) {
        const cp = ch.codePointAt(0);
        rfb.sendKey(cp < 0x100 ? cp : 0x01000000 + cp, null);
      }
    } else if (e.inputType === "insertLineBreak") {
      rfb.sendKey(0xff0d, "Enter");
    } else if (e.inputType === "deleteContentBackward") {
      rfb.sendKey(0xff08, "Backspace");
    } else if (e.data) {
      // Everything else that carries text: insertCompositionText from Android's
      // predictive keyboard, insertReplacementText, insertFromPaste. Swallowing
      // these — preventDefault with nothing sent — made those keyboards look
      // broken rather than merely imperfect.
      for (const ch of e.data) {
        const cp = ch.codePointAt(0);
        rfb.sendKey(cp < 0x100 ? cp : 0x01000000 + cp, null);
      }
    } else {
      // Nothing to send and nothing gained by blocking it locally.
      return;
    }
    e.preventDefault();
    kbInput.value = "";
  });

  function mkBtn(label, title, onclick) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.style.cssText =
      "width:38px;height:38px;border-radius:8px;border:1px solid rgba(255,255,255,.2);" +
      "background:rgba(30,30,30,.85);color:#fff;cursor:pointer;" +
      "display:flex;align-items:center;justify-content:center;padding:0;-webkit-tap-highlight-color:transparent";
    b.addEventListener("click", onclick);
    return b;
  }

  // Inline SVG (fixed 20px) — obscure unicode glyphs (⤢/⛶/⌨) render tiny/inconsistently on
  // mobile; SVG is size-stable everywhere. Round line-caps turn zero-length paths into dots.
  const svg = (p) => '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const ICON = {
    zoomIn: svg('<circle cx="10" cy="10" r="7"/><path d="M21 21l-5.2-5.2M10 7v6M7 10h6"/>'),  // fit -> actual size / pan
    zoomOut: svg('<circle cx="10" cy="10" r="7"/><path d="M21 21l-5.2-5.2M7 10h6"/>'),          // pan -> fit whole
    fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h0M10 10h0M14 10h0M18 10h0M8 14h8"/>'),
    // A touchpad with a pointer on it: the screen is a pad, the arrow is what moves.
    // The arrow is drawn at full size inside a scaled group, with stroke-width
    // scaled back up by the same factor so it doesn't turn into a hairline.
    trackpad: svg('<rect x="2" y="4.5" width="20" height="15" rx="2.5"/>' +
      '<g transform="translate(8.4 7.6) scale(0.30)" stroke-width="6.5">' +
      '<path d="M1 1l16 6.4-6.8 1.8-1.8 6.8z"/></g>'),
    // A hand about to tap, with the point it lands on: what you touch is what you hit.
    directTouch: svg('<circle cx="8" cy="1.9" r=".8"/>' +
      '<path d="M10 9.5V4.6a2 2 0 0 0-4 0V14"/><path d="M14 10.2V9.4a2 2 0 0 0-4 0v.8"/>' +
      '<path d="M18 11v-1a2 2 0 0 0-4 0v1"/>' +
      '<path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>'),
  };

  const fitBtn = mkBtn(ICON.zoomIn, "", () => {
    // The button says "actual size", so it gives actual size: any zoom a pinch
    // left behind is reset. Pinching keeps its own scale; the button is the way
    // back to a known one.
    if (!panMode) zoom = 1;
    setPanMode(!panMode);
  });
  function refreshFit() {
    // fit mode -> offer "actual/pan" (expand); pan mode -> offer "fit whole" (compress).
    fitBtn.innerHTML = panMode ? ICON.zoomOut : ICON.zoomIn;
    fitBtn.title = panMode ? "Fit whole screen" : "Actual size — pinch to zoom, drag to pan";
  }
  refreshFitButton = refreshFit;
  refreshFit();

  const fsBtn = mkBtn(ICON.fullscreen, "Fullscreen", () => {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    } catch (e) { /* fullscreen blocked by iframe permissions policy */ }
  });

  // Soft-keyboard button only on touch devices — on desktop the physical keyboard works and
  // the button would just be clutter.
  const isTouch = (navigator.maxTouchPoints || 0) > 0 ||
                  (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  const kbBtn = mkBtn(ICON.keyboard, "Keyboard", () => { kbInput.focus(); });

  // Pointer mode, touch only: with a real mouse the direct path is already
  // relative pointing with a visible cursor, so the toggle would be noise.
  //
  // Unlike the fit button, this one shows the mode you are IN, and highlights
  // itself while the trackpad is on. A mode button that shows what it will
  // switch TO reads exactly backwards to half the people who see it, and the
  // cost here is not cosmetic: believing you are in trackpad mode while in
  // direct touch, in a zoomed view, means one-finger drags pan the viewport and
  // nothing can be dragged at all.
  const ptrBtn = mkBtn(ICON.trackpad, "", () => {
    setPointerMode(pointerMode === "trackpad" ? "touch" : "trackpad");
    refreshPtr();
  });
  ptrBtn.id = "ad-pointer-btn";
  function refreshPtr() {
    const on = pointerMode === "trackpad";
    ptrBtn.innerHTML = on ? ICON.trackpad : ICON.directTouch;
    const title = on
      ? "Trackpad: slide to move the pointer, tap to click — tap here for direct touch"
      : "Direct touch: tap where you want to click — tap here for the trackpad";
    ptrBtn.title = title;
    ptrBtn.setAttribute("aria-label", title);
    ptrBtn.setAttribute("aria-pressed", on ? "true" : "false");
    ptrBtn.style.background = on ? "rgba(70,130,255,.85)" : "rgba(30,30,30,.85)";
    ptrBtn.style.borderColor = on ? "rgba(140,180,255,.9)" : "rgba(255,255,255,.2)";
  }
  refreshPtr();

  const bar = document.createElement("div");
  bar.id = "ad-desktop-toolbar";
  bar.style.cssText =
    "position:fixed;right:10px;bottom:10px;z-index:50;display:flex;gap:6px;opacity:.35;transition:opacity .2s";
  const wake = () => { bar.style.opacity = "1"; };
  const dim = () => { bar.style.opacity = ".35"; };
  bar.addEventListener("pointerenter", wake);
  bar.addEventListener("pointerleave", dim);
  bar.addEventListener("pointerdown", wake);
  // Order: keyboard, pointer mode, zoom, fullscreen — the two touch-only buttons
  // first, so the pair that also exists on a desktop keeps the same position at
  // the end of the bar rather than shifting with the viewport.
  if (isTouch) bar.append(kbBtn, ptrBtn);
  bar.append(fitBtn, fsBtn);
  document.body.appendChild(bar);
})();

// Config first, then connect. readTarget() never throws — on any problem with
// the file it returns the default port, so .catch isn't needed here and its
// absence won't swallow an error.
// readTarget() never throws, but connect() runs INSIDE the then and constructs an
// RFB and a channel. Without a catch a throw there becomes an unhandled
// rejection: blank tab, and nothing in window.onerror to say why.
readTarget(vncTarget.port)
  .then((t) => { vncTarget = t; connect(); })
  .catch((e) => { console.error("desktop: could not start", e); });
refreshNative();
updateFrame(); // initial insets/flush; the canvas radius follows once it renders
