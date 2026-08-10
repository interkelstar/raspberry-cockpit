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

// Kept apart from parsePort because this is where I/O and the dependency on
// cockpit begin. Never throws — the caller needs no .catch.
export async function readPort(fallback = DEFAULT_PORT) {
    try {
        const text = await cockpit.file(CONFIG_PATH).read();
        return parsePort(text, fallback);
    } catch (e) {
        // No file, or unreadable — not an error, just "use the default port".
        return fallback;
    }
}
