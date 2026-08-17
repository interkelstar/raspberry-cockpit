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

// Dispatch with an EXPLICIT event time. The plugin measures gestures from
// ev.timeStamp rather than from when its handler ran, so the harness can state
// the timing instead of inheriting whatever CDP latency happened to be — which is
// the only way a velocity check means the same thing on a fast box and a slow one.
// CDP wants seconds since the epoch; the page's clock is milliseconds since its
// own time origin.
const timeOrigin = await evaluate("performance.timeOrigin");
async function tpAt(type, points, atMs) {
  await cdp("Input.dispatchTouchEvent", {
    type, touchPoints: points.map(touch), timestamp: (timeOrigin + atMs) / 1000,
  });
}
const settle = () => sleep(650);
const reset = () => evaluate("window.__sent.length = 0; window.__touch.length = 0; window.__intents.length = 0; true");
// A left tap's click is held back by TAP_HOLD_MS in case a drag follows, so
// reading the wire immediately after a tap would read it before the click.
const TAP_HOLD_MS = 400;
// Waits for the wire to go QUIET rather than for a fixed interval. A held-back
// click arrives TAP_HOLD_MS after the touchend HANDLER ran — not after the event
// was dispatched — so any fixed wait races a slow round trip, and a longer one
// only makes the race rarer. Two identical reads in a row means nothing more is
// coming; the ceiling stops a genuinely broken run from hanging here.
// Waits for at least `min` messages and then for the wire to go QUIET, rather
// than for a fixed interval. A held-back click arrives TAP_HOLD_MS after the
// touchend HANDLER ran — not after the event was dispatched — so any fixed wait
// races a slow round trip, and a longer one only makes the race rarer.
//
// The `min` is what makes the wait honest. Quiescence alone cannot tell "nothing
// is coming" from "nothing yet", so an empty buffer looked settled and the check
// read it before the click existed. Callers that expect nothing pass 0.
async function sent(min = 1) {
  let prev = -1, quiet = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(120);
    const n = await evaluate("window.__sent.length");
    quiet = n === prev ? quiet + 1 : 0;
    prev = n;
    if (n >= min && quiet >= 2) break;
  }
  return evaluate("window.__sent");
}

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
// The touch and its first movement go together, so the gesture is committed to
// being a slide before anything else can claim it. Left to separate round trips,
// CDP latency put more than LONG_PRESS_MS between them and the slide came out as
// a long-press drag — a property of the harness, not of the plugin.
await settle();
await reset();
await burst([
  ["touchStart", [{ id: 1, ...mid }]],
  ["touchMove", [{ id: 1, x: mid.x + 15, y: mid.y }]],
]);
for (let i = 1; i <= 8; i++) await tp("touchMove", [{ id: 1, x: mid.x + 15 + i * 10, y: mid.y }]);
// Read the wire BEFORE releasing — a release at speed hands the pointer a coast,
// and the extra travel would be measured as if the finger had caused it. A SHORT
// fixed wait, not the quiesce loop: pointer moves are never held back, and leaving
// the finger down for seconds while polling would turn this into a long press.
await sleep(200);
const slide = await evaluate("window.__sent");
await tp("touchEnd", []);
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
await settle();
await reset();
// Stated times again: paced by round trip, a 70ms tap became a 400ms one whenever
// the machine was busy, which is a long press, and the check failed for a reason
// that had nothing to do with taps.
const far = { x: Math.round(rect.x + 25), y: Math.round(rect.y + rect.h - 25) };
let t1 = await evaluate("performance.now()");
await tpAt("touchStart", [{ id: 1, ...far }], t1);
await tpAt("touchEnd", [], t1 + 70);
const tap = await sent();
const down = tap.find((m) => m.mask === 1);
check("a tap presses and releases the left button",
      !!down && tap[tap.length - 1].mask === 0 && tap.length >= 2,
      JSON.stringify(tap));
check("the click lands at the pointer, NOT under the finger",
      !!down && Math.abs(down.x - toRemoteX(far.x)) > 200,
      down ? `click x=${down.x}, finger was at x=${toRemoteX(far.x)}` : "no click");

// Two fingers tapped together -> right button (mask 1<<2 = 4).
await settle();
await reset();
t1 = await evaluate("performance.now()");
await tpAt("touchStart", [{ id: 1, x: mid.x - 20, y: mid.y }], t1);
await tpAt("touchStart", [{ id: 1, x: mid.x - 20, y: mid.y }, { id: 2, x: mid.x + 20, y: mid.y }], t1 + 30);
await tpAt("touchEnd", [{ id: 1, x: mid.x - 20, y: mid.y }], t1 + 120);
await tpAt("touchEnd", [], t1 + 140);
const two = await sent();
check("a two-finger tap is a right click", two.some((m) => m.mask === 4),
      JSON.stringify(two) + " touches=" + JSON.stringify(await evaluate("window.__touch")) + " intents=" + JSON.stringify(await evaluate("window.__intents")));

// Three fingers: middle click, RFB mask 2. Worth its own check because DOM's two
// button numberings disagree exactly here — `button` says 1 for middle while
// `buttons` says 4 — so a reversed mapping trades middle for right silently, and
// the right-click check above would still pass.
await settle();
await reset();
t1 = await evaluate("performance.now()");
await tpAt("touchStart", [{ id: 1, x: mid.x - 40, y: mid.y }], t1);
await tpAt("touchStart", [{ id: 1, x: mid.x - 40, y: mid.y }, { id: 2, x: mid.x, y: mid.y }], t1 + 25);
await tpAt("touchStart", [{ id: 1, x: mid.x - 40, y: mid.y }, { id: 2, x: mid.x, y: mid.y }, { id: 3, x: mid.x + 40, y: mid.y }], t1 + 50);
await tpAt("touchEnd", [{ id: 2, x: mid.x, y: mid.y }, { id: 3, x: mid.x + 40, y: mid.y }], t1 + 140);
await tpAt("touchEnd", [{ id: 3, x: mid.x + 40, y: mid.y }], t1 + 155);
await tpAt("touchEnd", [], t1 + 170);
const three = await sent();
check("a three-finger tap is a middle click", three.some((m) => m.mask === 2),
      JSON.stringify([...new Set(three.map((m) => m.mask))]));

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
// Explicit event times, so the gaps are the gaps and not whatever CDP latency
// happened to be. Paced by round trip this check passed or failed with the load
// on the machine, which is worse than not having it.
let c0 = await evaluate("performance.now()");
await tpAt("touchStart", [{ id: 1, ...mid }], c0);
await tpAt("touchEnd", [], c0 + 70);                       // a 70ms tap
await tpAt("touchStart", [{ id: 2, ...mid }], c0 + 370);   // 300ms later, inside the window
await tpAt("touchMove", [{ id: 2, x: mid.x, y: mid.y + 14 }], c0 + 520);   // after a dwell
for (let i = 2; i <= 5; i++) {
  await tpAt("touchMove", [{ id: 2, x: mid.x, y: mid.y + i * 14 }], c0 + 520 + i * 30);
}
await tpAt("touchEnd", [], c0 + 700);
const chain = await sent();
const chainMasks = chain.map((m) => m.mask);
check("tap, pause, touch and slide drags", chain.filter((m) => m.mask === 1).length >= 3,
      JSON.stringify(chainMasks));
// And the tap's own click must NOT be on the wire in front of the drag. Sent, it
// pairs with the drag's press into a double click, and a double click on a title
// bar maximises the window instead of moving it — which is how the bug presented.
//
// Bursted on purpose. The suppression window is a real duration, and CDP
// round-trip latency alone can exceed it, so a paced version of this check tests
// the harness's speed rather than the plugin's behaviour. The paced check above
// covers the timing; this one covers the suppression.
await settle();
await reset();
await burst([
  ["touchStart", [{ id: 1, ...mid }]],
  ["touchEnd", []],
  ["touchStart", [{ id: 2, ...mid }]],
  ["touchMove", [{ id: 2, x: mid.x, y: mid.y + 20 }]],
  ["touchMove", [{ id: 2, x: mid.x, y: mid.y + 45 }]],
  ["touchMove", [{ id: 2, x: mid.x, y: mid.y + 70 }]],
  ["touchEnd", []],
]);
const quick = (await sent()).map((m) => m.mask);
const firstPress = quick.indexOf(1);
check("the tap that began the drag sent no click of its own",
      firstPress >= 0 && quick.slice(firstPress).filter((m) => m === 0).length === 1,
      JSON.stringify(quick));

// Reaching somewhere else after a tap is repositioning, not a drag. This is the
// cost of a window wide enough to hit, and what the distance condition buys back.
await settle();
await reset();
// Same treatment: stated times, so what is being tested is the DISTANCE rule and
// not the harness's reflexes. Well inside the time window, well outside the space
// one.
c0 = await evaluate("performance.now()");
await tpAt("touchStart", [{ id: 1, ...mid }], c0);
await tpAt("touchEnd", [], c0 + 70);
await tpAt("touchStart", [{ id: 2, x: mid.x + 120, y: mid.y }], c0 + 320);
for (let i = 1; i <= 5; i++) {
  await tpAt("touchMove", [{ id: 2, x: mid.x + 120, y: mid.y + i * 14 }], c0 + 320 + i * 30);
}
await tpAt("touchEnd", [], c0 + 500);
const far2 = await sent();
// Exactly one press: the tap's own. A drag would add a second, held across the
// moves that follow.
check("touching down elsewhere after a tap moves the pointer, it does not drag",
      far2.filter((m) => m.mask === 1).length === 1,
      JSON.stringify(far2.map((m) => m.mask)));

// Inertia: released at speed, the pointer keeps travelling and slows down. Read
// after the release, so anything further is the coast and not the finger.
await settle();
await reset();
// The direction is chosen from where the POINTER is, not where the finger starts:
// this is relative pointing, so the finger's position says nothing about how much
// room the pointer has, and a flick into a nearby edge has nothing to show.
// Where the pointer is, read from the cursor overlay rather than from the wire:
// the message buffer was just cleared, and defaulting to "the middle" sent the
// flick straight into the edge the pointer was already resting against.
const whereX = await evaluate(`(() => {
  const c = [...document.body.children].find(e => e.tagName === 'CANVAS' && e.style.position === 'fixed');
  return c ? parseFloat(c.style.left) || 0 : -1;
})()`);
const dir = whereX < (rect.x + rect.w / 2) ? 1 : -1;
// The touch and its first move are paced, so the gesture is a slide rather than a
// long press. The last two moves and the release are bursted, which puts a tiny
// interval under the final velocity sample and so releases fast on any machine.
//
// Paced throughout, this depended on how quickly the harness could talk to the
// browser: on the Pi the round trips are slower, the release read as gentle, and
// no flick was produced at all. What speed counts as a flick is a threshold, and
// thresholds belong to the unit tests, which have an exact clock. This check is
// here to prove the coast moves the pointer and then stops — so it makes the
// flick unambiguous and leaves the boundary alone. The velocity cap is what keeps
// an unrealistically fast release from being unrealistic in its effect too.
const from = Math.round(mid.x - dir * 60);
const t0 = await evaluate("performance.now()");
// A short, unmistakably fast release: most of the travel in the last few
// milliseconds, so even if the browser coalesces two touchmoves into one the
// remaining sample is still far above the flick threshold — and the total finger
// travel stays small, so the pointer does not reach the edge before letting go
// and leaves the coast somewhere to go.
await tpAt("touchStart", [{ id: 1, x: from, y: mid.y }], t0);
await tpAt("touchMove", [{ id: 1, x: from + dir * 10, y: mid.y }], t0 + 16);
await tpAt("touchMove", [{ id: 1, x: from + dir * 22, y: mid.y }], t0 + 32);
await tpAt("touchMove", [{ id: 1, x: from + dir * 60, y: mid.y }], t0 + 40);
await tpAt("touchEnd", [], t0 + 46);
// Counted rather than measured. Acceleration plus a coast can cross the whole
// 1920px framebuffer, and a clamped pointer keeps reporting the same coordinate —
// so position proves nothing at the edges while the flow of updates proves both
// halves of what matters: that it keeps going, and that it stops.
// Position AND count. Count alone is too weak a signal: noVNC batches pointer
// moves on a timer of its own, so a few updates trickle out after the release
// whether anything is coasting or not. Position says the pointer actually
// travelled; count settling says it stopped.
const probe = `(() => { const n = window.__sent.length; return { n, x: n ? window.__sent[n - 1].x : -1 }; })()`;
// The coast decays over roughly 550ms from the capped velocity, so "still going"
// is read early and "stopped" comfortably after that, not at the boundary.
const atRelease = await evaluate(probe);
await sleep(300);
const coasting = await evaluate(probe);
await sleep(1200);
const settled = await evaluate(probe);
check("released at speed, the pointer coasts on",
      Math.abs(coasting.x - atRelease.x) >= 20 && coasting.n > atRelease.n,
      `x ${atRelease.x} -> ${coasting.x} over ${coasting.n - atRelease.n} updates after the finger left`);
check("and the coast stops on its own", settled.n === coasting.n && settled.x === coasting.x,
      `x ${coasting.x} -> ${settled.x} over the next 1200ms`);

// A fitted desktop is letterboxed inside its container. A tap on the bars is
// neither the trackpad's nor the toolbar's — and letting it through means the
// browser synthesises a mouse click from it, landing on noVNC at the finger,
// which is the very behaviour this mode replaces.
await settle();
await reset();
const bar0 = { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y - 8) };
// Reported by review: wrapped in a bare `if`, this check DISAPPEARED when the
// precondition did not hold — the run still printed "N/N passed" with one fewer
// check and no sign of it. Now the precondition is itself a check.
check("there is letterbox above the fitted desktop to tap on", bar0.y > 4,
      `canvas top at ${Math.round(rect.y)}`);
if (bar0.y > 4) {
  await tp("touchStart", [{ id: 1, ...bar0 }], 70);
  await tp("touchEnd", [], 250);
  const strays = await sent(0);
  check("a tap on the letterbox does nothing at all", strays.length === 0, JSON.stringify(strays));
}

// Two fingers sliding -> wheel. noVNC turns wheel into buttons 4/5 (mask 8/16).
await settle();
await reset();
// Stated times. Paced by round trip, the gap between the first finger and the
// second could exceed LONG_PRESS_MS, the long press fired on the single finger,
// and the scroll then arrived with a button held — [1,17,0] instead of [16,0].
t1 = await evaluate("performance.now()");
await tpAt("touchStart", [{ id: 1, x: mid.x - 20, y: mid.y }], t1);
await tpAt("touchStart", [{ id: 1, x: mid.x - 20, y: mid.y }, { id: 2, x: mid.x + 20, y: mid.y }], t1 + 30);
for (let i = 1; i <= 10; i++) {
  await tpAt("touchMove", [{ id: 1, x: mid.x - 20, y: mid.y - i * 12 }, { id: 2, x: mid.x + 20, y: mid.y - i * 12 }], t1 + 30 + i * 25);
}
await tpAt("touchEnd", [{ id: 1, x: mid.x - 20, y: mid.y - 120 }], t1 + 300);
await tpAt("touchEnd", [], t1 + 320);
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
