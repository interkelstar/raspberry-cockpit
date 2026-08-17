import test from "node:test";
import assert from "node:assert/strict";
import {
    createTrackpad, gainFor,
    MIN_GAIN, MAX_GAIN, FAST_SPEED,
    TAP_MAX_MS, TAP_SLOP, DRAG_ARM_MS, DRAG_ARM_SLOP, TAP_CHAIN_SLOP, LONG_PRESS_MS,
    TAP_HOLD_MS, FLICK_MIN_SPEED, FLICK_MAX_SPEED,
} from "../desktop/trackpad.js";

const p = (id, x, y) => ({ id, x, y });
const types = (intents) => intents.map((i) => i.t);
// A flick is emitted whenever a gesture ends at speed, which is most of the ones
// that move at all. Tests about buttons say so and ignore it.
const buttons = (intents) => intents.filter((i) => i.t !== "flick");

test("gain is geared down when the finger is slow", () => {
    const g = gainFor(1, 100);
    assert.ok(g >= MIN_GAIN && g < MIN_GAIN + 0.05, `expected ~${MIN_GAIN}, got ${g}`);
    assert.ok(g < 1, "slow movement must move the pointer LESS than the finger");
});

test("gain saturates at MAX_GAIN, it does not keep climbing", () => {
    assert.equal(gainFor(FAST_SPEED * 10, 10), MAX_GAIN);
    assert.equal(gainFor(FAST_SPEED * 1000, 10), MAX_GAIN);
});

// Two touchmove events can share a millisecond. Dividing by that zero would make
// the speed infinite and fling the pointer off the screen on an ordinary slow drag.
test("a zero-length interval is the slowest case, not the fastest", () => {
    assert.equal(gainFor(50, 0), MIN_GAIN);
    assert.equal(gainFor(50, -1), MIN_GAIN);
});

// A left tap's click is HELD BACK — see TAP_HOLD_MS. It is sent when the hold
// expires, or earlier if something settles it, and never if a drag follows.
test("a short still touch is a left click, once the hold expires", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    assert.deepEqual(t.touchEnd([], 80), []);
    assert.equal(t.clickPending, true);
    assert.deepEqual(t.flush(80 + TAP_HOLD_MS - 1), []);
    assert.deepEqual(t.flush(80 + TAP_HOLD_MS), [{ t: "click", button: 0 }]);
    assert.equal(t.clickPending, false);
});

test("a touch held past the tap window is not a click", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    assert.deepEqual(t.touchEnd([], TAP_MAX_MS + 1), []);
});

test("a touch that wandered is a move, not a click", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    const moved = t.touchMove([p(1, 100 + TAP_SLOP + 5, 100)], 20);
    assert.deepEqual(types(moved), ["move"]);
    assert.ok(moved[0].dx > 0);
    assert.deepEqual(buttons(t.touchEnd([], 40)), []);
    assert.deepEqual(t.flush(40 + TAP_HOLD_MS), []);
});

test("movement within the slop still counts as a tap", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchMove([p(1, 100 + TAP_SLOP - 1, 100)], 20);
    assert.deepEqual(buttons(t.touchEnd([], 60)), []);
    assert.deepEqual(t.flush(60 + TAP_HOLD_MS), [{ t: "click", button: 0 }]);
});

test("two fingers tapped together are a right click", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchStart([p(1, 100, 100), p(2, 130, 100)], 10);
    t.touchEnd([p(1, 100, 100)], 60);
    assert.deepEqual(t.touchEnd([], 70), [{ t: "click", button: 2 }]);
});

// Right and middle taps are not held back: neither can begin a drag, so delaying
// them would buy nothing and cost latency.
test("a right click is sent at once, not held", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchStart([p(1, 100, 100), p(2, 130, 100)], 10);
    t.touchEnd([p(1, 100, 100)], 60);
    t.touchEnd([], 70);
    assert.equal(t.clickPending, false);
});

test("three fingers tapped together are a middle click", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchStart([p(1, 100, 100), p(2, 130, 100)], 5);
    t.touchStart([p(1, 100, 100), p(2, 130, 100), p(3, 160, 100)], 10);
    t.touchEnd([p(1, 100, 100), p(2, 130, 100)], 50);
    t.touchEnd([p(1, 100, 100)], 55);
    assert.deepEqual(t.touchEnd([], 60), [{ t: "click", button: 1 }]);
});

test("tap, then touch again and slide: the button is held for the whole drag", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchEnd([], 50);                                    // tap
    // Armed, NOT pressed — landing must not commit to a button yet.
    assert.deepEqual(t.touchStart([p(2, 100, 100)], 100), []);
    // The press arrives with the first movement, and BEFORE it.
    assert.deepEqual(types(t.touchMove([p(2, 160, 100)], 150)), ["down", "move"]);
    assert.deepEqual(types(t.touchMove([p(2, 200, 100)], 180)), ["move"]);
    assert.deepEqual(t.touchEnd([], 200), [{ t: "up", button: 0 }]);
});

// Reported from a phone as "right click just doesn't work in this mode". People
// tap in quick succession, so a tap followed by a two-finger tap is ordinary —
// and pressing on landing turned the intended right click into a left one.
test("a tap followed straight away by a two-finger tap is still a right click", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchEnd([], 50);                                    // tap
    t.touchStart([p(2, 100, 100)], 100);                   // inside the arm window
    t.touchStart([p(2, 100, 100), p(3, 140, 100)], 120);
    t.touchEnd([p(3, 140, 100)], 200);
    // The first tap's click is settled here — it was a tap after all — and the
    // right click follows it, in that order.
    assert.deepEqual(t.touchEnd([], 210), [{ t: "click", button: 0 }, { t: "click", button: 2 }]);
});

// Measured on a phone: 18px of slide during the first tap lost the click AND the
// drag meant to follow, leaving no gesture at all. A thumb tapping twice quickly
// slides that far routinely, which is why "is this a click" and "was that the
// first of two taps" get different slops.
test("a tap too sloppy to click still arms the drag", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    const wobbled = t.touchMove([p(1, 100 + TAP_SLOP + 8, 100)], 30);
    assert.deepEqual(types(wobbled), ["move"]);           // too far to be a click
    assert.deepEqual(buttons(t.touchEnd([], 60)), []);    // so no click is sent
    t.touchStart([p(2, 100 + TAP_SLOP + 8, 100)], 200);   // ...but the chain is open
    assert.deepEqual(types(t.touchMove([p(2, 200, 100)], 250)), ["down", "move"]);
});

// The distance is measured from where the gesture STARTED, which is what keeps a
// repositioning stroke out of the chain: a stroke travels, a sloppy tap wanders
// and comes back.
test("a stroke that travelled does not arm a drag, however brief", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchMove([p(1, 100 + TAP_CHAIN_SLOP + 20, 100)], 40);
    t.touchEnd([], 60);
    t.touchStart([p(2, 100 + TAP_CHAIN_SLOP + 20, 100)], 150);
    assert.deepEqual(types(t.touchMove([p(2, 300, 100)], 200)), ["move"]);
});

test("a plain double tap is two clicks, with no stray press between them", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    assert.deepEqual(t.touchEnd([], 50), []);                 // held back
    t.touchStart([p(2, 100, 100)], 120);                      // chains, still held
    // The second tap settles the first: two clicks, close together, which is what
    // the remote needs to see a double click.
    assert.deepEqual(t.touchEnd([], 170), [{ t: "click", button: 0 }]);
    assert.deepEqual(t.flush(170 + TAP_HOLD_MS), [{ t: "click", button: 0 }]);
});

// The whole reason the click waits. A click already sent pairs with the drag's
// press into a double click, and on a window title bar that maximises the window
// instead of moving it — which is exactly how the bug presented.
test("a tap that turns into a drag never sends its click at all", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    assert.deepEqual(t.touchEnd([], 50), []);
    t.touchStart([p(2, 100, 100)], 120);
    assert.deepEqual(types(t.touchMove([p(2, 160, 100)], 170)), ["down", "move"]);
    assert.equal(t.clickPending, false, "the click must be gone, not merely late");
    assert.deepEqual(t.flush(170 + TAP_HOLD_MS * 3), []);
    assert.deepEqual(buttons(t.touchEnd([], 300)), [{ t: "up", button: 0 }]);
});

// Time alone cannot tell "tap, then drag from here" from "tap, then reach
// somewhere else and slide". Without the distance condition, widening the window
// to something a hand can actually hit turns ordinary repositioning into drags.
test("touching again far away is an ordinary touch, not a drag", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchEnd([], 50);
    t.touchStart([p(2, 100 + DRAG_ARM_SLOP + 5, 100)], 100);
    assert.deepEqual(types(t.touchMove([p(2, 200, 100)], 150)), ["move"]);
});

test("touching again nearby, well inside the window, does drag", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchEnd([], 50);
    t.touchStart([p(2, 100 + DRAG_ARM_SLOP - 5, 100)], 50 + DRAG_ARM_MS - 1);
    assert.deepEqual(types(t.touchMove([p(2, 200, 100)], 50 + DRAG_ARM_MS + 40)), ["down", "move"]);
});

test("touching again too late is an ordinary touch, not a drag", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchEnd([], 50);
    // Out of the window, so the waiting click is settled right here.
    assert.deepEqual(t.touchStart([p(2, 100, 100)], 50 + DRAG_ARM_MS + 1),
                     [{ t: "click", button: 0 }]);
});

// A right click that armed a drag would press the LEFT button on the next touch,
// because that is the only button a drag can hold — a silent substitution of one
// click for another.
test("only a one-finger tap arms a drag", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchStart([p(1, 100, 100), p(2, 130, 100)], 10);
    t.touchEnd([p(1, 100, 100)], 50);
    t.touchEnd([], 60);                                    // right click
    assert.deepEqual(t.touchStart([p(3, 100, 100)], 80), []);
});

test("holding still presses the button, and releasing lets it go", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    assert.deepEqual(t.tick(LONG_PRESS_MS - 1), []);
    assert.deepEqual(t.tick(LONG_PRESS_MS), [{ t: "down", button: 0 }]);
    assert.equal(t.holding, 0);
    assert.deepEqual(t.touchEnd([], LONG_PRESS_MS + 300), [{ t: "up", button: 0 }]);
});

test("a touch that already moved never becomes a long press", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchMove([p(1, 200, 100)], 20);
    assert.deepEqual(t.tick(LONG_PRESS_MS + 50), []);
});

test("two fingers sliding together scroll", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchStart([p(1, 100, 100), p(2, 140, 100)], 10);
    const out = t.touchMove([p(1, 100, 130), p(2, 140, 130)], 30);
    assert.deepEqual(types(out), ["scroll"]);
    assert.equal(out[0].dy, 30);
    assert.equal(out[0].dx, 0);
});

test("scroll is reported as travel since the last move, not since the start", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchStart([p(1, 100, 100), p(2, 140, 100)], 10);
    t.touchMove([p(1, 100, 120), p(2, 140, 120)], 20);
    const second = t.touchMove([p(1, 100, 135), p(2, 140, 135)], 30);
    assert.equal(second[0].dy, 15);
});

// --- flick -----------------------------------------------------------------

test("letting go at speed asks the pointer to coast", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    for (let i = 1; i <= 4; i++) t.touchMove([p(1, 100 + i * 40, 100)], i * 16);
    const out = t.touchEnd([], 4 * 16 + 10);
    const flick = out.find((i) => i.t === "flick");
    assert.ok(flick, JSON.stringify(out));
    assert.ok(flick.vx >= FLICK_MIN_SPEED, `vx ${flick.vx}`);
    assert.equal(Math.round(flick.vy), 0);
});

// One spiky sample — two events sharing a millisecond, a coalesced batch — must
// not launch the pointer. Uncapped, the coast ran for seconds and put a pointer
// event on the wire for every frame of it.
test("a freak velocity is capped, not obeyed", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchMove([p(1, 400, 100)], 1);
    t.touchMove([p(1, 900, 100)], 2);
    const flick = t.touchEnd([], 3).find((i) => i.t === "flick");
    assert.ok(flick, "expected a flick");
    assert.ok(Math.hypot(flick.vx, flick.vy) <= FLICK_MAX_SPEED + 1e-9,
              `speed ${Math.hypot(flick.vx, flick.vy)} above the cap ${FLICK_MAX_SPEED}`);
});

test("letting go slowly does not", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    for (let i = 1; i <= 4; i++) t.touchMove([p(1, 100 + i * 4, 100)], i * 60);
    assert.deepEqual(types(t.touchEnd([], 260)).filter((x) => x === "flick"), []);
});

// A drag that kept coasting after the finger left would drop what it was
// carrying somewhere else entirely.
test("a drag never coasts", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.tick(LONG_PRESS_MS);
    for (let i = 1; i <= 4; i++) t.touchMove([p(1, 100 + i * 40, 100)], LONG_PRESS_MS + i * 16);
    const out = t.touchEnd([], LONG_PRESS_MS + 80);
    assert.deepEqual(types(out), ["up"]);
});

// --- pinch -----------------------------------------------------------------

function twoDown(t, a, b, at = 10) {
    t.touchStart([a], 0);
    t.touchStart([a, b], at);
    return t;
}

test("two fingers spreading apart zoom in", () => {
    const t = twoDown(createTrackpad(), p(1, 100, 100), p(2, 200, 100));
    const out = t.touchMove([p(1, 60, 100), p(2, 240, 100)], 30);
    assert.deepEqual(types(out), ["zoom"]);
    assert.ok(out[0].factor > 1, `factor ${out[0].factor}`);
    assert.equal(out[0].cx, 150);            // the midpoint, held still
});

test("two fingers closing zoom out", () => {
    const t = twoDown(createTrackpad(), p(1, 100, 100), p(2, 200, 100));
    const out = t.touchMove([p(1, 140, 100), p(2, 160, 100)], 30);
    assert.deepEqual(types(out), ["zoom"]);
    assert.ok(out[0].factor < 1, `factor ${out[0].factor}`);
});

test("zoom is reported per move, not cumulatively", () => {
    const t = twoDown(createTrackpad(), p(1, 100, 100), p(2, 200, 100));
    t.touchMove([p(1, 50, 100), p(2, 250, 100)], 30);      // gap 100 -> 200
    const second = t.touchMove([p(1, 0, 100), p(2, 300, 100)], 60); // 200 -> 300
    assert.ok(Math.abs(second[0].factor - 1.5) < 1e-9, `factor ${second[0].factor}`);
});

// A pinch is never perfectly symmetric and a scroll is never perfectly parallel.
// Whichever changed more decides, ONCE — re-deciding per frame makes a slightly
// diagonal pinch flicker between zooming and scrolling.
test("fingers moving together scroll, and keep scrolling as the gap wobbles", () => {
    const t = twoDown(createTrackpad(), p(1, 100, 100), p(2, 200, 100));
    assert.deepEqual(types(t.touchMove([p(1, 100, 140), p(2, 200, 140)], 30)), ["scroll"]);
    assert.deepEqual(types(t.touchMove([p(1, 95, 180), p(2, 210, 180)], 60)), ["scroll"]);
});

test("a gesture that started as a pinch stays a pinch, however far it then travels", () => {
    const t = twoDown(createTrackpad(), p(1, 100, 100), p(2, 200, 100));
    assert.deepEqual(types(t.touchMove([p(1, 50, 100), p(2, 250, 100)], 30)), ["zoom"]);
    // Measured from the start the midpoint has now moved much further than the
    // gap did. Deciding again here would flip a pinch mid-gesture into a scroll
    // — the fingers must keep dragging the image, not start scrolling an app.
    const drift = t.touchMove([p(1, 50, 400), p(2, 250, 400)], 60);
    assert.deepEqual(types(drift), ["pan"]);
    assert.equal(drift[0].dy, 300);
});

// A zoomed-in view has no other gesture that moves it: two-finger drag is a
// scroll wheel and belongs to whatever app has focus.
test("fingers that pinch and travel at once both zoom and pan", () => {
    const t = twoDown(createTrackpad(), p(1, 100, 100), p(2, 200, 100));
    const out = t.touchMove([p(1, 80, 140), p(2, 260, 140)], 30);
    assert.deepEqual(types(out), ["zoom", "pan"]);
    assert.ok(out[0].factor > 1);
    assert.equal(out[1].dy, 40);
});

// A second finger cancels a pending tap-tap-drag. Without that the press is
// still owed, and it lands on whichever finger is left after the other lifts —
// a button going down in the middle of a two-finger gesture.
test("a second finger cancels a pending tap-tap-drag", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchEnd([], 50);                                    // tap: arms
    t.touchStart([p(2, 100, 100)], 100);
    t.touchStart([p(2, 100, 100), p(3, 200, 100)], 120);   // disarms
    t.touchEnd([p(3, 200, 100)], 160);                     // the tracked finger leaves
    assert.deepEqual(types(t.touchMove([p(3, 260, 100)], 200)), ["move"]);
});

test("a pinch is not a tap and produces no click", () => {
    const t = twoDown(createTrackpad(), p(1, 100, 100), p(2, 200, 100));
    t.touchMove([p(1, 50, 100), p(2, 250, 100)], 30);
    t.touchEnd([p(2, 250, 100)], 60);
    assert.deepEqual(t.touchEnd([], 70), []);
});

test("cancel releases a held button", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.tick(LONG_PRESS_MS);
    assert.deepEqual(t.cancel(), [{ t: "up", button: 0 }]);
    assert.equal(t.holding, null);
    assert.equal(t.active, false);
});

test("cancel on an idle recogniser does nothing", () => {
    assert.deepEqual(createTrackpad().cancel(), []);
});

// Fingers almost never leave together. If lifting the tracked one ended the
// gesture, a two-finger scroll would emit a stray click as the second finger
// came up, and the pointer would freeze until every finger was off the glass.
test("lifting the tracked finger hands over to one still down", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchStart([p(1, 100, 100), p(2, 140, 100)], 10);
    assert.deepEqual(t.touchEnd([p(2, 140, 100)], 20), []);
    assert.equal(t.active, true);
    assert.deepEqual(types(t.touchMove([p(2, 180, 100)], 40)), ["move"]);
    assert.deepEqual(buttons(t.touchEnd([], 50)), []);
});

// Which of two fingers leaves first is a coin toss, so a right click must not
// depend on it. Treating the hand-off as movement loses half of them.
test("a two-finger tap is a right click even when the tracked finger lifts first", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchStart([p(1, 100, 100), p(2, 140, 100)], 10);
    t.touchEnd([p(2, 140, 100)], 50);
    assert.deepEqual(t.touchEnd([], 60), [{ t: "click", button: 2 }]);
});

// The pointer follows one pinned finger. Reading "the first touch in the list"
// instead means that a move listing only an untracked finger — a stray event, a
// touchend that never arrived — teleports the pointer by the distance between
// two fingers instead of doing nothing.
test("a move that does not list the tracked finger moves nothing", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    assert.deepEqual(t.touchMove([p(9, 400, 400)], 20), []);
});
