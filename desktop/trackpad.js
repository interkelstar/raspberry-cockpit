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
//
// Button numbers follow the DOM: 0 left, 1 middle, 2 right.

// A press longer than this, or one that wandered further than the slop, is not a
// tap — it was a drag, and the click must not be delivered on release.
//
// It mirrors LONG_PRESS_MS deliberately, and generously. A press that outlives
// the window has ALREADY become a drag by then (tick pressed the button and the
// release goes down the other branch), so a short window buys nothing and costs
// real taps: the clock starts at the FIRST finger, and a two-finger tap needs
// time for the second finger to land, for both to be noticed, and for both to
// lift. Measured against a browser dispatching real touch events, a two-finger
// tap comfortably exceeds a quarter of a second, and the right click it should
// have produced simply never arrived.
export const TAP_MAX_MS = 500;
export const TAP_SLOP = 12;

// Touching down again this soon after a tap holds the button instead of just
// moving: the tap-tap-drag every trackpad has. It also makes an ordinary
// double-tap work for free — tap one delivers a click, tap two presses and
// releases, and the remote side sees two clicks close enough together to be a
// double-click by its own rules rather than ours.
export const DRAG_ARM_MS = 300;

// Holding still this long presses the button without a preceding tap. This is
// the discoverable way to drag: put a finger down on a window title bar, wait,
// move. Longer than TAP_MAX_MS by a wide margin so the two never race.
export const LONG_PRESS_MS = 500;

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
    let lastTapAt = null;    // end of the previous tap, for DRAG_ARM_MS

    function reset() {
        primaryId = null; last = null; start = null;
        moved = false; maxFingers = 0; scrollFrom = null;
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

                if (held === null && lastTapAt !== null && (now - lastTapAt) <= DRAG_ARM_MS) {
                    held = 0;
                    out.push({ t: "down", button: 0 });
                }
                lastTapAt = null;
            }

            if (points.length >= 2) scrollFrom = centroid(points);
            return out;
        },

        touchMove(points, now) {
            const out = [];
            if (primaryId === null) return out;

            if (points.length >= 2) {
                // Two fingers scroll; the pointer stays where it is. The baseline
                // is re-set on every move so a finger joining or leaving mid-scroll
                // shifts the centroid without that shift being read as travel.
                const c = centroid(points);
                if (scrollFrom) {
                    const dx = c.x - scrollFrom.x, dy = c.y - scrollFrom.y;
                    if (dx || dy) out.push({ t: "scroll", dx, dy });
                }
                scrollFrom = c;
                moved = true;
                return out;
            }

            const p = find(points, primaryId);
            if (!p) return out;

            const dx = p.x - last.x, dy = p.y - last.y;
            const dist = Math.hypot(dx, dy);
            const gain = gainFor(dist, now - last.at);
            last = { x: p.x, y: p.y, at: now };

            if (!moved && Math.hypot(p.x - start.x, p.y - start.y) > TAP_SLOP) moved = true;
            if (dx || dy) out.push({ t: "move", dx: dx * gain, dy: dy * gain });
            return out;
        },

        // `points` is what is STILL down, so the gesture ends at length 0.
        touchEnd(points, now) {
            const out = [];
            if (primaryId === null) return out;

            if (points.length > 0) {
                if (points.length >= 2) scrollFrom = centroid(points);
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

            if (held !== null) {
                out.push({ t: "up", button: held });
                // A held button that was never dragged is the second half of a
                // tap-tap-drag that turned out to be an ordinary double tap.
                // Keep the chain open so a third tap still arms a drag.
                lastTapAt = (!moved && (now - start.at) <= TAP_MAX_MS) ? now : null;
                held = null;
            } else if (!moved && (now - start.at) <= TAP_MAX_MS) {
                const button = tapButton();
                out.push({ t: "click", button });
                // Only a one-finger tap can arm a drag. Chaining a drag onto a
                // right-click would press the LEFT button, which is not what the
                // finger asked for.
                lastTapAt = button === 0 ? now : null;
            } else {
                lastTapAt = null;
            }

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
            return [{ t: "down", button: 0 }];
        },

        // touchcancel, losing the window, switching mode: whatever is held must
        // be released, or the remote side keeps a button down forever.
        cancel() {
            const out = [];
            if (held !== null) { out.push({ t: "up", button: held }); held = null; }
            lastTapAt = null;
            reset();
            return out;
        },

        get active() { return primaryId !== null; },
        get holding() { return held; },
    };
}
