import test from "node:test";
import assert from "node:assert/strict";
import {
    createTrackpad, gainFor,
    MIN_GAIN, MAX_GAIN, FAST_SPEED,
    TAP_MAX_MS, TAP_SLOP, DRAG_ARM_MS, LONG_PRESS_MS,
} from "../desktop/trackpad.js";

const p = (id, x, y) => ({ id, x, y });
const types = (intents) => intents.map((i) => i.t);

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

test("a short still touch is a left click", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    assert.deepEqual(t.touchEnd([], 80), [{ t: "click", button: 0 }]);
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
    assert.deepEqual(t.touchEnd([], 40), []);
});

test("movement within the slop still counts as a tap", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchMove([p(1, 100 + TAP_SLOP - 1, 100)], 20);
    assert.deepEqual(t.touchEnd([], 60), [{ t: "click", button: 0 }]);
});

test("two fingers tapped together are a right click", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchStart([p(1, 100, 100), p(2, 130, 100)], 10);
    t.touchEnd([p(1, 100, 100)], 60);
    assert.deepEqual(t.touchEnd([], 70), [{ t: "click", button: 2 }]);
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
    assert.deepEqual(t.touchStart([p(2, 100, 100)], 100), [{ t: "down", button: 0 }]);
    assert.deepEqual(types(t.touchMove([p(2, 160, 100)], 150)), ["move"]);
    assert.deepEqual(t.touchEnd([], 200), [{ t: "up", button: 0 }]);
});

test("touching again too late is an ordinary touch, not a drag", () => {
    const t = createTrackpad();
    t.touchStart([p(1, 100, 100)], 0);
    t.touchEnd([], 50);
    assert.deepEqual(t.touchStart([p(2, 100, 100)], 50 + DRAG_ARM_MS + 1), []);
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
    assert.deepEqual(t.touchEnd([], 50), []);
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
