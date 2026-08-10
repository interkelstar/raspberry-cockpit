// npm test
//
// This exercises the config PARSING, not "the file exists". On a live machine a
// bug here looks like "black tab, everything green": the port silently fell back
// to the default, VNC is running, and the plugin knocks on the wrong door.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePort, DEFAULT_PORT } from "../desktop/config.js";

test("reads the port from what the installer actually writes", () => {
    const written = "# VNC port for the Cockpit Desktop tab. Read when the tab loads.\nport=5902\n";
    assert.equal(parsePort(written), 5902);
});

test("tolerates spaces and tabs around the equals sign", () => {
    assert.equal(parsePort("  port =  5903  "), 5903);
    assert.equal(parsePort("\tport\t=\t5904\t"), 5904);
});

test("finds the key among other lines", () => {
    assert.equal(parsePort("# a comment\nfoo=bar\nport=5905\nbaz=1\n"), 5905);
});

// Regression lock: without the ^…$ anchors a substring search would find a
// commented-out port, handing the user a value they had explicitly disabled.
test("does NOT take a commented-out port", () => {
    assert.equal(parsePort("#port=9999\n"), DEFAULT_PORT);
    assert.equal(parsePort("# port = 9999\n"), DEFAULT_PORT);
});

// Regression lock: a suffix must not be accepted silently — "port=5901x" is a
// typo, not "5901".
test("does NOT accept junk around the value", () => {
    assert.equal(parsePort("port=5901x\n"), DEFAULT_PORT);
    assert.equal(parsePort("myport=5902\n"), DEFAULT_PORT);
    assert.equal(parsePort("port=abc\n"), DEFAULT_PORT);
});

test("rejects an out-of-range port", () => {
    assert.equal(parsePort("port=0\n"), DEFAULT_PORT);
    assert.equal(parsePort("port=70000\n"), DEFAULT_PORT);
});

// A corrupted config must not cost the user the tab, only return them to the
// default. So "no file" and "garbage in file" have to behave identically.
test("any questionable input yields the default, never an exception", () => {
    for (const bad of ["", "\n\n", undefined, null, 42, {}, []]) {
        assert.equal(parsePort(bad), DEFAULT_PORT);
    }
});

test("an explicit fallback overrides the default", () => {
    assert.equal(parsePort("garbage", 5999), 5999);
});

// Pinned so a re-run of the installer with a different port behaves the same
// whether it appended or replaced.
test("with two keys the first wins — pinned deliberately", () => {
    assert.equal(parsePort("port=5901\nport=5902\n"), 5901);
});
