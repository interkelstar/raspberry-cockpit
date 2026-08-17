// Reading the plugin's settings. Split out of app.js precisely so the parsing
// can be tested: app.js touches the DOM and noVNC on import and cannot be loaded
// under node, while this function is pure.

export const CONFIG_PATH = "/etc/cockpit/desktop.conf";
export const DEFAULT_PORT = 5901;

// The format is deliberately primitive: key=value, "#" starts a comment. A real
// ini parser would cost more than the problem, and an extra format is an extra
// way to be wrong.
//
// Returns the fallback on ANY questionable input rather than throwing: the config
// is a convenience, and corrupting it must not leave the user without a tab. But
// "odd value" and "no file" have to behave identically, otherwise behaviour
// depends on exactly how the file is broken.
export function parsePort(text, fallback = DEFAULT_PORT) {
    if (typeof text !== "string") return fallback;
    // Anchors ^…$ with the m flag: the key must occupy a whole line. Without them
    // a commented-out "#port=9999" would match as a substring.
    const m = text.match(/^[ \t]*port[ \t]*=[ \t]*(\d{1,5})[ \t]*$/m);
    if (!m) return fallback;
    const p = Number(m[1]);
    return (p > 0 && p < 65536) ? p : fallback;
}

// A unix socket path, if the installer configured one. Preferred over a port
// when present: a socket in the user's runtime directory is reachable by that
// user alone, where a no-auth listener on 127.0.0.1 is reachable by every
// process on the machine whatever its UID. See parsePort for the format.
//
// Anything that is not an absolute path is ignored rather than passed on: this
// value ends up as the target of a Cockpit stream channel, so a relative or
// empty one should fall back to the port, not open something unintended.
export function parseSocket(text) {
    if (typeof text !== "string") return null;
    const m = text.match(/^[ \t]*socket[ \t]*=[ \t]*(\/[^\s#]+)[ \t]*$/m);
    return m ? m[1] : null;
}

// Kept apart from the parsers because this is where I/O and the dependency on
// cockpit begin. Never throws — the caller needs no .catch. Returns the socket
// path when one is configured, otherwise a port.
export async function readTarget(fallbackPort = DEFAULT_PORT) {
    let text = "";
    try {
        text = await cockpit.file(CONFIG_PATH).read();
    } catch (e) {
        // No file, or unreadable — not an error, just "use the defaults".
        return { port: fallbackPort };
    }
    const socket = parseSocket(text);
    return socket ? { socket } : { port: parsePort(text, fallbackPort) };
}
