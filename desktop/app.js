import RFB from "./novnc/core/rfb.js";
// The port lives in its own module so the parsing can be unit-tested: this file
// touches the DOM and noVNC on import and cannot be loaded under node.
import { readPort, DEFAULT_PORT } from "./config.js";

let rfb;

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
  rfb.dragViewport = panMode;
}

// Port of the local VNC server. It lives in a variable and NOT as a connect()
// argument: on a drop, reconnect is called as setTimeout(connect, 1500) — with NO
// arguments — so a port parameter would silently become undefined. That gives the
// worst possible failure: the first connection works, recovery after a drop does not.
let vncPort = DEFAULT_PORT;

// noVNC over a Cockpit stream channel to the local VNC (127.0.0.1:<vncPort>), wrapped as a
// WebSocket-like object that RFB/Websock.attach() accepts. The Cockpit session authenticates
// it — no websockify, no extra password: reaching this tab already required a Cockpit/PAM login.
function cockpitVncSocket() {
  const channel = cockpit.channel({ payload: "stream", address: "127.0.0.1", port: vncPort, binary: true });
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
  applyViewportMode();
  rfb.resizeSession = false;
  rfb.qualityLevel = 8;
  rfb.compressionLevel = 2;

  rfb.addEventListener("clipboard", (e) => {
    navigator.clipboard.writeText(e.detail.text).catch(() => {});
  });

  rfb.addEventListener("disconnect", () => {
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
  try {
    const pdoc = window.parent.document;
    const page = pdoc.createElement("div"); page.className = "pf-v6-c-page";
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
    pdoc.body.removeChild(page);
  } catch (e) { /* keep defaults */ }
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
window.addEventListener("resize", () => { refreshNative(); updateFrame(); });

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

// Mobile toolbar (bottom-right, semi-transparent): Fit⇄1:1 mode, fullscreen, on-screen
// keyboard. All within the pinned FHD (resizeSession=false). Doesn't get in the way on desktop.
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
  };

  const fitBtn = mkBtn(ICON.zoomIn, "", () => { panMode = !panMode; applyViewportMode(); refreshFit(); setTimeout(updateFrame, 150); });
  function refreshFit() {
    // fit mode -> offer "actual/pan" (expand); pan mode -> offer "fit whole" (compress).
    fitBtn.innerHTML = panMode ? ICON.zoomOut : ICON.zoomIn;
    fitBtn.title = panMode ? "Fit whole screen" : "Actual size — drag to pan";
    try { localStorage.setItem("ad-desktop-pan", panMode ? "1" : "0"); } catch (e) { /* ignore */ }
  }
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

  const bar = document.createElement("div");
  bar.id = "ad-desktop-toolbar";
  bar.style.cssText =
    "position:fixed;right:10px;bottom:10px;z-index:50;display:flex;gap:6px;opacity:.35;transition:opacity .2s";
  const wake = () => { bar.style.opacity = "1"; };
  const dim = () => { bar.style.opacity = ".35"; };
  bar.addEventListener("pointerenter", wake);
  bar.addEventListener("pointerleave", dim);
  bar.addEventListener("pointerdown", wake);
  bar.append(fitBtn, fsBtn);
  if (isTouch) bar.append(kbBtn);
  document.body.appendChild(bar);
})();

// Config first, then connect. readPort() never throws — on any
// problem with the file it returns the default port, so .catch isn't needed here
// and its absence won't swallow an error.
readPort(vncPort).then((p) => { vncPort = p; connect(); });
refreshNative();
updateFrame(); // initial insets/flush; the canvas radius follows once it renders
