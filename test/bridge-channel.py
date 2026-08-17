#!/usr/bin/env python3
"""Prove that Cockpit itself can reach the VNC server, over the exact path the tab uses.

    test/bridge-channel.py /run/user/1000/raspberry-cockpit/vnc.sock
    test/bridge-channel.py 5901

Everything else about the desktop tab can be checked from the outside: the server
runs, it speaks RFB, the files are installed and readable. The transport could not
be, and it is the part with the most assumptions in it — the plugin does not open
the socket itself, it asks cockpit-bridge to, with

    cockpit.channel({ payload: "stream", unix: <path>, binary: true })

so the question that matters is whether the BRIDGE can open it, as the logged-in
user, with whatever permissions that user has. Opening the tab in a browser is the
usual way to find out and it needs a password; this needs nothing, because
cockpit-bridge speaks its protocol on stdio to whoever runs it.

Exit 0 means the bridge opened the target and the first bytes back were an RFB
banner. Anything else prints why.
"""

import json
import subprocess
import sys
import time

TIMEOUT = 8


def frame(payload: bytes) -> bytes:
    """Cockpit framing: the decimal payload length, a newline, then the payload."""
    return str(len(payload)).encode() + b"\n" + payload


def control(obj: dict) -> bytes:
    """A control frame carries an EMPTY channel id, so the payload starts with \\n."""
    return frame(b"\n" + json.dumps(obj).encode())


def open_options(target: str) -> dict:
    opts = {"command": "open", "channel": "probe", "payload": "stream", "binary": "raw"}
    # Same choice the plugin makes: a path is a socket, anything else is a port on
    # localhost. Keeping both here means this check follows the plugin rather than
    # asserting one particular configuration.
    if target.startswith("/"):
        opts["unix"] = target
    else:
        opts["address"] = "127.0.0.1"
        opts["port"] = int(target)
    return opts


def read_frames(proc, deadline):
    """Yield (channel, payload) pairs until the deadline or EOF."""
    buf = b""
    while time.time() < deadline:
        # One byte at a time only while reading the length prefix; the body is read
        # in one go below. Cockpit does not pad or align, so there is nothing to
        # scan for and a buffered read could swallow the start of the next frame.
        chunk = proc.stdout.read(1)
        if not chunk:
            return
        buf += chunk
        if b"\n" not in buf:
            continue
        length, buf = buf.split(b"\n", 1)
        try:
            length = int(length)
        except ValueError:
            continue
        while len(buf) < length:
            more = proc.stdout.read(length - len(buf))
            if not more:
                return
            buf += more
        payload, buf = buf[:length], buf[length:]
        if payload.startswith(b"\n"):
            yield None, json.loads(payload[1:] or b"{}")
        else:
            cid, _, data = payload.partition(b"\n")
            yield cid.decode(), data


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip().splitlines()[0])
        print("usage: bridge-channel.py <unix-socket-path|port>", file=sys.stderr)
        return 2
    target = sys.argv[1]

    try:
        proc = subprocess.Popen(
            ["cockpit-bridge"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        print("cockpit-bridge is not installed — nothing to prove here", file=sys.stderr)
        return 2

    proc.stdin.write(control({"command": "init", "version": 1, "host": "localhost"}))
    proc.stdin.write(control(open_options(target)))
    proc.stdin.flush()

    deadline = time.time() + TIMEOUT
    try:
        for channel, payload in read_frames(proc, deadline):
            if channel is None:
                # A refusal arrives as a close with a "problem", which is the
                # answer we came for just as much as a banner is.
                if payload.get("command") == "close" and payload.get("channel") == "probe":
                    print(f"bridge refused {target}: {payload.get('problem', 'closed, no reason given')}")
                    return 1
                continue
            if channel == "probe" and payload:
                first = payload[:12].decode("latin1").strip()
                if first.startswith("RFB"):
                    print(f"bridge opened {target} and read {first!r}")
                    return 0
                print(f"bridge opened {target} but the first bytes are not RFB: {first!r}")
                return 1
    finally:
        proc.kill()
        proc.wait()

    err = proc.stderr.read().decode("latin1", "replace").strip()
    print(f"no answer from the bridge within {TIMEOUT}s" + (f"; stderr: {err[:300]}" if err else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
