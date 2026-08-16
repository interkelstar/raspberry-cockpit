// Stands in for Cockpit's base1/cockpit.js. It speaks just enough RFB 3.8 to get
// noVNC into the "connected" state with a 1920x1080 framebuffer, and records
// every pointer message the client sends back. That recording is the evidence:
// gestures go in as real browser touch events, RFB PointerEvent bytes come out,
// and we can read the coordinates and the button mask.
//
// run.sh substitutes this file for the cockpit.js tag in the SHIPPED
// desktop/index.html — the page is not a copy. It used to be, and the copy had
// picked up a viewport meta the real page lacked, so the harness was quietly
// testing a more mobile-friendly page than the one users get.

// A stand-in for Cockpit's stream channel that speaks just enough RFB 3.8 to
// get noVNC into the "connected" state with a 1920x1080 framebuffer, and then
// records every pointer message the client sends back. That recording is the
// evidence: gestures go in as real browser touch events, RFB PointerEvent
// bytes come out, and we can read the coordinates and the button mask.
window.__sent = [];      // decoded PointerEvent messages
window.__log = [];

function u8(...b) { return new Uint8Array(b); }
function concat(arrs) {
  const n = arrs.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(n);
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const WIDTH = 1920, HEIGHT = 1080;

window.cockpit = {
  file: () => ({ read: () => Promise.resolve("port=5901\n") }),
  channel() {
    const ls = {};
    const emit = (t, payload) => (ls[t] || []).forEach((f) => f(null, payload));
    let stage = "version";
    const chan = {
      addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); },
      close() {},
      send(data) {
        const b = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (stage === "version") {                       // client's "RFB 003.008\n"
          stage = "security";
          emit("message", u8(1, 1));                     // one security type: None
          return;
        }
        if (stage === "security") {                      // client picked a type
          stage = "init";
          emit("message", u8(0, 0, 0, 0));               // SecurityResult: OK
          return;
        }
        if (stage === "init") {                          // ClientInit
          stage = "running";
          const name = new TextEncoder().encode("harness");
          const hdr = new Uint8Array(24);
          const dv = new DataView(hdr.buffer);
          dv.setUint16(0, WIDTH); dv.setUint16(2, HEIGHT);
          hdr[4] = 32; hdr[5] = 24; hdr[6] = 0; hdr[7] = 1;     // bpp, depth, BE, truecolour
          dv.setUint16(8, 255); dv.setUint16(10, 255); dv.setUint16(12, 255);
          hdr[14] = 16; hdr[15] = 8; hdr[16] = 0;                // shifts
          dv.setUint32(20, name.length);
          emit("message", concat([hdr, name]));
          return;
        }
        // Running: decode what the client sends. Type 5 is PointerEvent.
        let i = 0;
        while (i < b.length) {
          const type = b[i];
          if (type === 5 && i + 6 <= b.length) {
            const dv = new DataView(b.buffer, b.byteOffset + i);
            window.__sent.push({ mask: b[i + 1], x: dv.getUint16(2), y: dv.getUint16(4) });
            i += 6;
          } else if (type === 3 && i + 10 <= b.length) { i += 10;   // FramebufferUpdateRequest
          } else if (type === 0 && i + 20 <= b.length) { i += 20;   // SetPixelFormat
          } else if (type === 2 && i + 4 <= b.length) {             // SetEncodings
            const dv = new DataView(b.buffer, b.byteOffset + i);
            i += 4 + 4 * dv.getUint16(2);
          } else if (type === 4 && i + 8 <= b.length) { i += 8;     // KeyEvent
          } else { break; }
        }
      },
    };
    // Deliberately never emit "ready" — the plugin must treat the first byte as
    // the open signal, which is the whole point of the socket shim.
    setTimeout(() => emit("message", new TextEncoder().encode("RFB 003.008\n")), 0);
    return chan;
  },
};
window.__touch = []; window.__intents = [];
for (const t of ["touchstart","touchmove","touchend","touchcancel"])
  document.addEventListener(t, (e) => window.__touch.push(t + ":" + e.touches.length + "[" + [...e.touches].map(x=>x.identifier).join(",") + "]"), true);
window.onerror = (m, s, l) => { window.__log.push("ERROR " + m + " @" + l); };
