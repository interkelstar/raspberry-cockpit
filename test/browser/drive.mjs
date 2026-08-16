// Drives the harness with REAL browser touch input over CDP and checks the RFB
// pointer messages that come out the other side.
const PORT = Number(process.env.CDP_PORT || 9333);
const PAGE = process.env.HARNESS_URL;
if (!PAGE) { console.error("HARNESS_URL is not set — run this through run.sh"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Browser-level connection with a FLATTENED session, not a raw /devtools/page/<id>
// socket. Two reasons, both learned the hard way: /json/new?<url> quietly ignores
// the url and hands back about:blank, and a page socket does not survive the
// renderer process swap that happens when about:blank navigates to an http origin
// — after which every command hangs with no reply and no error.
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));

let id = 0;
const waiting = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
let session = null;
function cdp(method, params = {}) {
  const mid = ++id;
  const msg = { id: mid, method, params };
  if (session) msg.sessionId = session;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(method + ": no reply in 15s")), 15000);
    waiting.set(mid, (m) => { clearTimeout(timer); m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result); });
  });
}
const { targetId } = await cdp("Target.createTarget", { url: PAGE });
session = (await cdp("Target.attachToTarget", { targetId, flatten: true })).sessionId;
await sleep(1500);

async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(expression.slice(0, 70) + " -> " + JSON.stringify(r.exceptionDetails.exception).slice(0, 300));
  return r.result.value;
}

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await sleep(800);
// The plugin remembers the pointer mode in localStorage, so a previous run would
// decide what this one starts in. Clear it and reload before measuring anything.
await evaluate("try { localStorage.clear(); } catch (e) {} ; true");
await cdp("Page.reload", {});
// Poll for the canvas instead of guessing a sleep: over file:// the module graph
// loads noticeably slower, and a fixed wait that is long enough today is a flake
// tomorrow.
for (let i = 0; i < 60; i++) {
  if (await evaluate("!!document.querySelector('#screen canvas')")) break;
  await sleep(250);
}
console.log("page:", await evaluate("location.href + ' | ' + document.readyState"));

const touch = (p) => ({ x: p.x, y: p.y, radiusX: 12, radiusY: 12, force: 1, id: p.id });
async function tp(type, points, pause = 40) {
  await cdp("Input.dispatchTouchEvent", { type, touchPoints: points.map(touch) });
  await sleep(pause);
}
// A gesture is judged against the wall clock, so the events that make it up must
// arrive close together. Awaiting each CDP round-trip put 40-400ms between them
// depending on how loaded the machine was, which turned a two-finger tap into a
// half-second press and made the whole run depend on the weather. Bursting sends
// them all, then waits.
async function burst(steps) {
  const sends = steps.map(([type, points]) => cdp("Input.dispatchTouchEvent", { type, touchPoints: points.map(touch) }));
  await Promise.all(sends);
  await sleep(120);
}
const intents = () => evaluate("window.__intents");
const settle = () => sleep(650);
const reset = () => evaluate("window.__sent.length = 0; window.__touch.length = 0; window.__intents.length = 0; true");
const sent = () => evaluate("window.__sent");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const state = await evaluate(`(() => {
  const c = document.querySelector('#screen canvas');
  const r = c && c.getBoundingClientRect();
  return { err: window.__log, canvas: c ? { w: c.width, h: c.height, rect: { x: r.x, y: r.y, w: r.width, h: r.height } } : null,
           buttons: [...document.querySelectorAll('#ad-desktop-toolbar button')].map(b => b.title) };
})()`);
check("no page errors", state.err.length === 0, state.err.join("; "));
check("RFB handshake completed: framebuffer is 1920x1080",
      !!state.canvas && state.canvas.w === 1920 && state.canvas.h === 1080,
      state.canvas ? `${state.canvas.w}x${state.canvas.h}` : "no canvas");
check("the pointer-mode button is in the toolbar, showing the mode in force",
      /^Direct touch:/.test(state.buttons.find((t) => /touch|Trackpad/i.test(t)) || ""),
      state.buttons.join(" | "));

// Two properties a phone needs and a desktop never misses. Neither is visible
// in any behaviour this harness can drive — CDP injects touches below the level
// where the browser arbitrates gestures — so they are asserted directly.
const mobile = await evaluate(`(() => {
  const m = document.querySelector('meta[name="viewport"]');
  const c = document.querySelector('#screen canvas');
  return { viewport: m ? m.content : null, touchAction: c ? getComputedStyle(c).touchAction : null };
})()`);
check("the page declares a mobile viewport",
      !!mobile.viewport && /width=device-width/.test(mobile.viewport), String(mobile.viewport));
check("the canvas claims every touch (touch-action: none)",
      mobile.touchAction === "none", String(mobile.touchAction));

const rect = state.canvas.rect;
const scale = 1920 / rect.w;
const mid = { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
const toRemoteX = (clientX) => Math.round((clientX - rect.x) * scale);

// ------------------------------------------------------- direct touch (default)
await reset();
const spot = { x: Math.round(rect.x + rect.w * 0.25), y: Math.round(rect.y + rect.h * 0.25) };
await tp("touchStart", [{ id: 1, ...spot }]);
await tp("touchEnd", []);
await sleep(300);
const direct = await sent();
const dDown = direct.find((m) => m.mask === 1);
check("direct mode taps where the finger is",
      !!dDown && Math.abs(dDown.x - toRemoteX(spot.x)) < 60,
      dDown ? `click x=${dDown.x}, finger at x=${toRemoteX(spot.x)}` : JSON.stringify(direct));

// ------------------------------------------------------------------- switch
const switched = await evaluate(`(() => {
  const b = document.getElementById("ad-pointer-btn");
  if (!b) return "no button";
  b.click();
  return b.title + " || pressed=" + b.getAttribute("aria-pressed");
})()`);
check("the button switches mode, and says which mode is now in force",
      /^Trackpad:/.test(switched) && /pressed=true/.test(switched), switched);
await sleep(200);

// A slow slide: the pointer must move, and by LESS than 1:1 mapping would give.
await settle();
await reset();
await tp("touchStart", [{ id: 1, ...mid }]);
for (let i = 1; i <= 8; i++) await tp("touchMove", [{ id: 1, x: mid.x + i * 10, y: mid.y }]);
await tp("touchEnd", []);
const slide = await sent();
const moves = slide.filter((m) => m.mask === 0);
const travelled = moves.length ? moves[moves.length - 1].x - moves[0].x : 0;
const oneToOne = Math.round(80 * scale);
check("a slide moves the remote pointer", moves.length > 2 && travelled > 0,
      `${moves.length} pointer messages, +${travelled} remote px`);
check("slow movement is geared down for precision",
      travelled > 0 && travelled < oneToOne,
      `${travelled} remote px for 80 finger px (1:1 would be ${oneToOne})`);
check("a slide alone presses no button", slide.every((m) => m.mask === 0),
      JSON.stringify(slide.filter((m) => m.mask)) + " intents=" + JSON.stringify(await intents()));

// A tap clicks where the POINTER is, not under the finger.
await reset();
const far = { x: Math.round(rect.x + 25), y: Math.round(rect.y + rect.h - 25) };
await tp("touchStart", [{ id: 1, ...far }]);
await tp("touchEnd", []);
const tap = await sent();
const down = tap.find((m) => m.mask === 1);
check("a tap presses and releases the left button",
      !!down && tap[tap.length - 1].mask === 0 && tap.length >= 2, JSON.stringify(tap));
check("the click lands at the pointer, NOT under the finger",
      !!down && Math.abs(down.x - toRemoteX(far.x)) > 200,
      down ? `click x=${down.x}, finger was at x=${toRemoteX(far.x)}` : "no click");

// Two fingers tapped together -> right button (mask 1<<2 = 4).
await settle();
await reset();
await burst([
  ["touchStart", [{ id: 1, x: mid.x - 20, y: mid.y }]],
  ["touchStart", [{ id: 1, x: mid.x - 20, y: mid.y }, { id: 2, x: mid.x + 20, y: mid.y }]],
  ["touchEnd", [{ id: 1, x: mid.x - 20, y: mid.y }]],
  ["touchEnd", []],
]);
const two = await sent();
check("a two-finger tap is a right click", two.some((m) => m.mask === 4),
      JSON.stringify(two) + " touches=" + JSON.stringify(await evaluate("window.__touch")) + " intents=" + JSON.stringify(await evaluate("window.__intents")));

// Hold still, then move: the button stays down for the whole drag.
await settle();
await reset();
await tp("touchStart", [{ id: 1, ...mid }]);
await sleep(500);   // LONG_PRESS_MS is 400 — this must clear it, not dwarf it
for (let i = 1; i <= 5; i++) await tp("touchMove", [{ id: 1, x: mid.x + i * 12, y: mid.y }]);
await tp("touchEnd", []);
const held = await sent();
check("a long press starts a drag and holds the button through it",
      held.filter((m) => m.mask === 1).length >= 3 && held[held.length - 1].mask === 0,
      `${held.filter((m) => m.mask === 1).length} moves with the button down, ends mask=${held[held.length - 1] && held[held.length - 1].mask}`);

// Tap, then touch again and slide -> the same drag, without the wait.
//
// The pauses here are the point. Fired back to back this passed while the
// gesture was failing about half the time in a hand: a real double-tap-drag has
// a gap between the tap and the second touch, and a further pause before the
// finger starts moving. Anything that judges timing has to be tested with the
// timing it will actually see.
await settle();
await reset();
await tp("touchStart", [{ id: 1, ...mid }], 70);
await tp("touchEnd", [], 300);                      // human gap after the tap
await tp("touchStart", [{ id: 2, ...mid }], 150);   // and a dwell before moving
for (let i = 1; i <= 5; i++) await tp("touchMove", [{ id: 2, x: mid.x, y: mid.y + i * 12 }]);
await tp("touchEnd", []);
const chain = await sent();
check("tap, pause, touch and slide drags", chain.filter((m) => m.mask === 1).length >= 3,
      JSON.stringify(chain.map((m) => m.mask)));

// Reaching somewhere else after a tap is repositioning, not a drag. This is the
// cost of a window wide enough to hit, and what the distance condition buys back.
await settle();
await reset();
await tp("touchStart", [{ id: 1, ...mid }], 70);
await tp("touchEnd", [], 250);
await tp("touchStart", [{ id: 2, x: mid.x + 120, y: mid.y }], 120);
for (let i = 1; i <= 5; i++) await tp("touchMove", [{ id: 2, x: mid.x + 120, y: mid.y + i * 12 }]);
await tp("touchEnd", []);
const far2 = await sent();
// Exactly one press: the tap's own. A drag would add a second, held across the
// moves that follow.
check("touching down elsewhere after a tap moves the pointer, it does not drag",
      far2.filter((m) => m.mask === 1).length === 1,
      JSON.stringify(far2.map((m) => m.mask)));

// A fitted desktop is letterboxed inside its container. A tap on the bars is
// neither the trackpad's nor the toolbar's — and letting it through means the
// browser synthesises a mouse click from it, landing on noVNC at the finger,
// which is the very behaviour this mode replaces.
await settle();
await reset();
const bar0 = { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y - 8) };
if (bar0.y > 4) {
  await tp("touchStart", [{ id: 1, ...bar0 }], 70);
  await tp("touchEnd", [], 250);
  const strays = await sent();
  check("a tap on the letterbox does nothing at all", strays.length === 0, JSON.stringify(strays));
}

// Two fingers sliding -> wheel. noVNC turns wheel into buttons 4/5 (mask 8/16).
await settle();
await reset();
await tp("touchStart", [{ id: 1, x: mid.x - 20, y: mid.y }]);
await tp("touchStart", [{ id: 1, x: mid.x - 20, y: mid.y }, { id: 2, x: mid.x + 20, y: mid.y }]);
for (let i = 1; i <= 10; i++) {
  await tp("touchMove", [{ id: 1, x: mid.x - 20, y: mid.y - i * 12 }, { id: 2, x: mid.x + 20, y: mid.y - i * 12 }]);
}
await tp("touchEnd", [{ id: 1, x: mid.x - 20, y: mid.y - 120 }]);
await tp("touchEnd", []);
const scroll = await sent();
check("two fingers scroll (noVNC wheel buttons 4/5)",
      scroll.some((m) => m.mask === 8 || m.mask === 16),
      JSON.stringify([...new Set(scroll.map((m) => m.mask))]));

// The toolbar must survive using the trackpad. noVNC grabs the pointer on
// mousedown with a full-screen transparent div; if that grab is never released
// the div sits over everything and every button under it is silently dead.
await settle();
const toolbar = await evaluate(`(() => {
  window.__btnClicks = 0;
  window.__btn = [...document.querySelectorAll('#ad-desktop-toolbar button')].find(b => /Fullscreen/.test(b.title));
  window.__btn.addEventListener("click", () => window.__btnClicks++);
  const b = window.__btn.getBoundingClientRect();
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
})()`);
await burst([["touchStart", [{ id: 1, ...toolbar }]], ["touchEnd", []]]);
await sleep(300);
const overlay = await evaluate(`(() => { const p = document.getElementById("noVNC_mouse_capture_elem"); return p ? getComputedStyle(p).display : "absent"; })()`);
check("the toolbar still works after using the trackpad",
      (await evaluate("window.__btnClicks")) === 1,
      `clicks=${await evaluate("window.__btnClicks")}, noVNC capture overlay=${overlay}`);

// Pinch. In fit mode the desktop is scaled down to fit; spreading two fingers
// must magnify it. The scale is read off the DOM — rendered width vs
// framebuffer width — rather than out of noVNC's internals.
const scaleProbe = `(() => { const c = document.querySelector('#screen canvas'); return c ? c.getBoundingClientRect().width / c.width : 0; })()`;
await settle();
const scale0 = await evaluate(scaleProbe);
await burst([
  ["touchStart", [{ id: 1, x: mid.x - 40, y: mid.y }]],
  ["touchStart", [{ id: 1, x: mid.x - 40, y: mid.y }, { id: 2, x: mid.x + 40, y: mid.y }]],
  ["touchMove", [{ id: 1, x: mid.x - 90, y: mid.y }, { id: 2, x: mid.x + 90, y: mid.y }]],
  ["touchMove", [{ id: 1, x: mid.x - 140, y: mid.y }, { id: 2, x: mid.x + 140, y: mid.y }]],
  ["touchEnd", [{ id: 2, x: mid.x + 140, y: mid.y }]],
  ["touchEnd", []],
]);
await sleep(400);
const scale1 = await evaluate(scaleProbe);
check("pinching out zooms in", scale1 > scale0 * 1.15, `scale ${scale0.toFixed(3)} -> ${scale1.toFixed(3)}`);

// Zooming must change how MUCH desktop is visible, never how big the picture
// of it is. The viewport is in framebuffer pixels and the canvas is laid out at
// scale x viewport, so a viewport set to the container size leaves the canvas
// exactly `scale` times too small — a shrinking window onto the same content,
// which is the opposite of zooming.
const fill = () => evaluate(`(() => {
  const c = document.querySelector('#screen canvas');
  const s = document.getElementById('screen');
  return { drawn: Math.round(c.getBoundingClientRect().width), container: Math.round(s.getBoundingClientRect().width), viewport: c.width };
})()`);
const zoomedIn = await fill();
check("zoomed in, the desktop still fills the window",
      Math.abs(zoomedIn.drawn - zoomedIn.container) <= 2,
      `drawn ${zoomedIn.drawn}px in a ${zoomedIn.container}px container`);

await settle();
await burst([
  ["touchStart", [{ id: 1, x: mid.x - 140, y: mid.y }]],
  ["touchStart", [{ id: 1, x: mid.x - 140, y: mid.y }, { id: 2, x: mid.x + 140, y: mid.y }]],
  ["touchMove", [{ id: 1, x: mid.x - 100, y: mid.y }, { id: 2, x: mid.x + 100, y: mid.y }]],
  ["touchMove", [{ id: 1, x: mid.x - 70, y: mid.y }, { id: 2, x: mid.x + 70, y: mid.y }]],
  ["touchEnd", [{ id: 2, x: mid.x + 70, y: mid.y }]],
  ["touchEnd", []],
]);
await sleep(400);
const zoomedOut = await fill();
check("zooming back out shows MORE desktop, at the same size on screen",
      zoomedOut.viewport > zoomedIn.viewport && Math.abs(zoomedOut.drawn - zoomedOut.container) <= 2,
      `${zoomedIn.viewport} -> ${zoomedOut.viewport} desktop px, drawn ${zoomedOut.drawn}px in ${zoomedOut.container}px`);

check("the toolbar is in the order keyboard, pointer, zoom, fullscreen",
      /^Keyboard,(Trackpad|Direct),(Fit|Actual),Fullscreen$/.test(
        await evaluate(`[...document.querySelectorAll('#ad-desktop-toolbar button')].map(b => b.title.split(/[ —:]/)[0]).join(",")`)),
      await evaluate(`[...document.querySelectorAll('#ad-desktop-toolbar button')].map(b => b.title).join(" | ")`));

// The visible pointer: noVNC's own cursor overlay must be there and following.
const cur = await evaluate(`(() => {
  const cs = [...document.body.children].filter(e => e.tagName === 'CANVAS' && e.style.position === 'fixed');
  if (!cs.length) return null;
  const s = cs[0].style;
  return { count: cs.length, left: s.left, top: s.top, visibility: s.visibility || 'visible' };
})()`);
check("the remote cursor image is drawn as an overlay, and is visible",
      !!cur && cur.visibility !== "hidden", JSON.stringify(cur));

const errs = await evaluate("window.__log");
check("still no page errors after all of it", errs.length === 0, errs.join("; "));

console.log("\n" + results.filter((r) => r.ok).length + "/" + results.length + " checks passed");
const sid = session; session = null; await cdp("Target.closeTarget", { targetId }).catch(() => {}); void sid;
process.exit(results.every((r) => r.ok) ? 0 : 1);
