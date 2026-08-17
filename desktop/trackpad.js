// Relative-pointing ("trackpad") gesture recognition for touch screens.
//
// It lives in its own module for the same reason config.js does: app.js touches
// the DOM and noVNC on import and cannot be loaded under node, and this is the
// part with actual decisions in it — what counts as a tap, when a touch becomes
// a drag, how far the pointer travels per finger-pixel. All of that is testable
// only if it never mentions an event, an element or a clock.
//
// So: the recogniser takes plain {id, x, y} points plus a timestamp and returns
// a list of intents. It has no idea that noVNC exists.
//
//   {t: "move",   dx, dy}      move the pointer by this much (already accelerated)
//   {t: "down",   button}      press and hold
//   {t: "up",     button}      release
//   {t: "click",  button}      press and release at the current position
//   {t: "scroll", dx, dy}      finger travel, in finger pixels, sign as on a touch screen
//   {t: "zoom",   factor, cx, cy}   pinch: scale by factor about the point between the fingers
//   {t: "pan",    dx, dy}      pinch: the fingers also dragged the image this far
//
// Button numbers follow the DOM: 0 left, 1 middle, 2 right.

// A press longer than this, or one that wandered further than the slop, is not a
// tap — it was a drag, and the click must not be delivered on release.
//
// It sits above LONG_PRESS_MS deliberately, and generously. A press that lasts
// that long has ALREADY become a drag (tick pressed the button and the release
// goes down the other branch), so this value only ever decides the case where
// no timer ran — and a short window there buys nothing while costing real taps: the clock starts at the FIRST finger, and a two-finger tap needs
// time for the second finger to land, for both to be noticed, and for both to
// lift. Measured against a browser dispatching real touch events, a two-finger
// tap comfortably exceeds a quarter of a second, and the right click it should
// have produced simply never arrived.
export const TAP_MAX_MS = 500;
export const TAP_SLOP = 12;

// Touching down again this soon after a tap ARMS the tap-tap-drag every trackpad
// has. Armed is not pressed: the button goes down when the finger actually
// starts moving, not when it lands.
//
// Pressing on landing is the obvious implementation and it is wrong twice over.
// People tap in quick succession, so a tap followed by a two-finger tap is
// ordinary — and pressing immediately turns that intended RIGHT click into a
// left one, which reads as "right click just doesn't work in this mode". It
// also puts a stray press-release around every plain double tap.
//
// The window is measured from the first tap's RELEASE to the second PRESS,
// which is a shorter span than the double-tap timeouts usually quoted — those
// run press-to-press and include the whole first tap. 300ms measured this way
// dropped roughly half of real attempts on a phone: the gesture "worked" in
// tests and did not work in a hand. Widened, and the space condition below
// carries the discrimination instead.
export const DRAG_ARM_MS = 500;

// ...and the second touch has to land near the first. Time alone is a poor
// discriminator between "tap, then drag from here" and "tap, then reach
// somewhere else to slide", and a widened window makes that worse; requiring
// the finger to come back down where it left cuts the false drags without
// narrowing the window again.
export const DRAG_ARM_SLOP = 60;

// How far a gesture may travel and still count as the FIRST HALF of a double
// tap. This is deliberately much looser than TAP_SLOP, and separating the two is
// the difference between the gesture working in a hand and not.
//
// The two questions are not the same question. "Is this a click?" needs a tight
// slop, or a deliberate slide would click. "Was that the first of two taps?"
// needs a loose one, because a thumb tapping twice in a hurry slides — measured,
// 18px of slide in the first tap was enough to lose the click AND the drag that
// was meant to follow it, leaving no gesture at all. Android draws the same
// distinction, and far more sharply: 8dp of touch slop against 100dp of
// double-tap slop.
//
// It stays a distance from the gesture's START, not a total path length, which
// is what keeps a repositioning stroke out: a stroke travels and so ends far
// from where it began, while a sloppy tap wanders and comes back.
export const TAP_CHAIN_SLOP = 40;

// How much the gap between two fingers must change before the gesture is a
// pinch rather than a two-finger scroll. Whichever moved further — the gap or
// the midpoint — wins, and the decision is made ONCE per gesture: re-deciding
// every frame makes a slightly diagonal pinch flicker between zooming and
// scrolling.
export const PINCH_SLOP = 8;

// Holding still this long presses the button without a preceding tap. This is
// the OTHER way to drag, and the one that always works: put a finger down,
// wait, move. It costs nothing to make it quick — a long press that ends
// without moving is a press and a release at one spot, which is a click, so
// shortening it cannot turn an intended click into anything else.
export const LONG_PRESS_MS = 400;

// Pointer acceleration. A fixed 1:1 mapping is unusable on a phone: the canvas
// is a 1920px desktop scaled into ~390px of screen, so one finger pixel is
// already five desktop pixels, and nothing small can be hit. Slow movement is
// therefore geared DOWN (precision), fast movement geared up (reach) — which is
// what every pointer acceleration curve does, and why a trackpad a tenth the
// size of the screen still works.
export const MIN_GAIN = 0.55;
export const MAX_GAIN = 2.2;
export const FAST_SPEED = 1.6; // finger px per ms at which MAX_GAIN is reached

export function gainFor(distance, dtMs) {
    // dt can be 0 when two touchmove events share a timestamp; treating that as
    // infinite speed would fling the pointer across the screen, so a zero-length
    // interval is simply the slowest case rather than the fastest.
    if (!(dtMs > 0)) return MIN_GAIN;
    const speed = distance / dtMs;
    const k = Math.min(1, speed / FAST_SPEED);
    return MIN_GAIN + (MAX_GAIN - MIN_GAIN) * k;
}

function centroid(points) {
    let x = 0, y = 0;
    for (const p of points) { x += p.x; y += p.y; }
    return { x: x / points.length, y: y / points.length };
}

function find(points, id) {
    for (const p of points) if (p.id === id) return p;
    return null;
}

function spread(points) {
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

export function createTrackpad() {
    // primaryId is the finger the pointer follows. It is pinned at the first
    // touchstart and never re-picked: following "points[0]" instead would make
    // the pointer jump the moment a second finger lands or leaves, because the
    // browser does not promise any particular order in TouchList.
    let primaryId = null;
    let last = null;         // last position of the primary finger
    let start = null;        // where and when the gesture began
    let moved = false;       // travelled beyond TAP_SLOP -> no longer a tap
    let maxFingers = 0;      // how many were down at once: picks the button
    let scrollFrom = null;   // centroid baseline while two fingers are down
    let held = null;         // button currently held, or null
    let armed = false;       // a tap-tap-drag is pending: press once it moves
    let lastTap = null;      // {at, x, y} of the previous tap, for the arm window
    let twoMode = null;      // once two fingers are down: null | "scroll" | "pinch"
    let twoFrom = null;      // spread + centroid when the second finger landed
    let prevSpread = 0;

    function reset() {
        primaryId = null; last = null; start = null;
        moved = false; maxFingers = 0; scrollFrom = null;
        armed = false; twoMode = null; twoFrom = null;
    }

    // maxFingers rather than the current count, because fingers rarely land or
    // lift together: a two-finger tap is usually 1 then 2 down, then 1 then 0
    // up, and by the time the last one leaves the count is back to one.
    function tapButton() {
        if (maxFingers >= 3) return 1;
        if (maxFingers === 2) return 2;
        return 0;
    }

    return {
        touchStart(points, now) {
            const out = [];
            maxFingers = Math.max(maxFingers, points.length);

            if (primaryId === null) {
                const p = points[0];
                primaryId = p.id;
                last = { x: p.x, y: p.y, at: now };
                start = { x: p.x, y: p.y, at: now };
                moved = false;

                if (held === null && lastTap !== null &&
                    (now - lastTap.at) <= DRAG_ARM_MS &&
                    Math.hypot(p.x - lastTap.x, p.y - lastTap.y) <= DRAG_ARM_SLOP) {
                    armed = true;
                }
                lastTap = null;
            }

            if (points.length >= 2) {
                // A second finger means this was never a tap-tap-drag.
                armed = false;
                scrollFrom = centroid(points);
                prevSpread = spread(points);
                twoFrom = { spread: prevSpread, c: scrollFrom };
                twoMode = null;
            }
            return out;
        },

        touchMove(points, now) {
            const out = [];
            if (primaryId === null) return out;

            if (points.length >= 2) {
                // Two fingers either scroll or pinch; the pointer stays where it
                // is either way. The baselines are re-set on every move so a
                // finger joining or leaving mid-gesture shifts the centroid
                // without that shift being read as travel.
                const c = centroid(points);
                const d = spread(points);
                moved = true;

                if (twoMode === null && twoFrom) {
                    const dGap = Math.abs(d - twoFrom.spread);
                    const dMid = Math.hypot(c.x - twoFrom.c.x, c.y - twoFrom.c.y);
                    if (dGap > PINCH_SLOP && dGap > dMid) twoMode = "pinch";
                    else if (dMid > TAP_SLOP) twoMode = "scroll";
                }

                if (twoMode === "pinch") {
                    if (prevSpread > 0 && d > 0 && d !== prevSpread) {
                        out.push({ t: "zoom", factor: d / prevSpread, cx: c.x, cy: c.y });
                    }
                    // Once the fingers are on the image they move it, the way
                    // they do on any map. Without this, a zoomed-in view has no
                    // gesture that pans it at all: two-finger drag is a scroll
                    // wheel and belongs to whatever app has focus.
                    if (scrollFrom) {
                        const dx = c.x - scrollFrom.x, dy = c.y - scrollFrom.y;
                        if (dx || dy) out.push({ t: "pan", dx, dy });
                    }
                } else if (twoMode === "scroll" && scrollFrom) {
                    const dx = c.x - scrollFrom.x, dy = c.y - scrollFrom.y;
                    if (dx || dy) out.push({ t: "scroll", dx, dy });
                }

                scrollFrom = c;
                prevSpread = d;
                return out;
            }

            const p = find(points, primaryId);
            if (!p) return out;

            const dx = p.x - last.x, dy = p.y - last.y;
            const dist = Math.hypot(dx, dy);
            const gain = gainFor(dist, now - last.at);
            last = { x: p.x, y: p.y, at: now };

            if (!moved && Math.hypot(p.x - start.x, p.y - start.y) > TAP_SLOP) moved = true;

            // The press of a tap-tap-drag happens HERE, on the first real
            // movement — see DRAG_ARM_MS. It must precede the move, or the drag
            // starts one step behind the finger.
            if (armed && held === null && (dx || dy)) {
                armed = false;
                held = 0;
                out.push({ t: "down", button: 0 });
            }

            if (dx || dy) out.push({ t: "move", dx: dx * gain, dy: dy * gain });
            return out;
        },

        // `points` is what is STILL down, so the gesture ends at length 0.
        touchEnd(points, now) {
            const out = [];
            if (primaryId === null) return out;

            if (points.length > 0) {
                if (points.length >= 2) {
                    scrollFrom = centroid(points);
                    prevSpread = spread(points);
                }
                // The primary finger left while others remain: hand the pointer
                // to one that is still down rather than freezing it. `moved` is
                // deliberately left alone. Marking the hand-off as movement looks
                // defensive and is a bug: a two-finger tap lifts one finger before
                // the other, and which one goes first is a coin toss, so half of
                // all right clicks would silently not happen.
                if (!find(points, primaryId)) {
                    primaryId = points[0].id;
                    last = { x: points[0].x, y: points[0].y, at: now };
                }
                return out;
            }

            // Can this gesture be the first half of a double tap? One finger
            // only — chaining a drag onto a right-click would press the LEFT
            // button, which is not what the finger asked for — quick, and it has
            // to have ended near where it began. Note this is decided
            // independently of whether a click was delivered: a tap too sloppy
            // to click is still a tap as far as the next touch is concerned.
            const chainable = maxFingers === 1 &&
                (now - start.at) <= TAP_MAX_MS &&
                Math.hypot(last.x - start.x, last.y - start.y) <= TAP_CHAIN_SLOP;

            if (held !== null) {
                out.push({ t: "up", button: held });
                held = null;
            } else if (!moved && (now - start.at) <= TAP_MAX_MS) {
                out.push({ t: "click", button: tapButton() });
            }
            lastTap = chainable ? { at: now, x: last.x, y: last.y } : null;

            reset();
            return out;
        },

        // Called from a timer: this is the only intent that is produced by the
        // passage of time rather than by a finger doing something.
        tick(now) {
            if (primaryId === null || held !== null || moved) return [];
            if ((now - start.at) < LONG_PRESS_MS) return [];
            if (maxFingers > 1) return [];
            held = 0;
            armed = false;
            return [{ t: "down", button: 0 }];
        },

        // touchcancel, losing the window, switching mode: whatever is held must
        // be released, or the remote side keeps a button down forever.
        cancel() {
            const out = [];
            if (held !== null) { out.push({ t: "up", button: held }); held = null; }
            lastTap = null;
            reset();
            return out;
        },

        // For the caller's benefit only — the recogniser never reads it.
        get twoFingerMode() { return twoMode; },

        get active() { return primaryId !== null; },
        get holding() { return held; },
    };
}
