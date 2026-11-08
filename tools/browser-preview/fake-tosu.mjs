// A stand-in for tosu (lib/tosu) on its port, for "Follow osu!" in the browser preview:
//   node tools/browser-preview/fake-tosu.mjs
// It plays a script: preview map 5 from 0:30 at 1×, a pause, DT, then map 9 (the preview shim
// takes "preview:<index>" as the MD5), then a map that isn't in the library, then over again.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = 24050;
/** [seconds into the script, map index or null (not in the library), state, rate, paused] */
const SCRIPT = [
  [0, 5, 2, 1, false],
  [8, 5, 2, 1, true],
  [11, 5, 2, 1.5, false],
  [18, 9, 5, 1, false],
  [26, null, 2, 1, false],
  [30, null, 0, 1, false],
];
const LENGTH = 32;

function frame(text) {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([head, data]);
}

const clients = new Set();
const server = createServer((_, res) => res.end("fake tosu"));
server.on("upgrade", (req, socket) => {
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
  // a close frame from the page: let it go
  socket.on("data", (d) => (d[0] & 15) === 8 && socket.end());
});

let start = Date.now();
let live = 30000;
let lastStep = -1;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  let s = (now - start) / 1000;
  if (s >= LENGTH) {
    start = now;
    s = 0;
    live = 30000;
  }
  const step = SCRIPT.findLastIndex(([at]) => s >= at);
  const [, map, state, rate, paused] = SCRIPT[step];
  if (step !== lastStep) {
    if (step > 0 && SCRIPT[step - 1][1] !== map) live = 20000;
    console.log(`${s.toFixed(1)}s  map ${map ?? "(not in library)"}  state ${state}  ${rate}×${paused ? "  paused" : ""}`);
    lastStep = step;
  }
  if (!paused) live += (now - last) * rate;
  last = now;
  const msg = JSON.stringify({
    state: { number: state, name: "" },
    beatmap: {
      checksum: map === null ? "0123456789abcdef0123456789abcdef" : `preview:${map}`,
      time: { live: Math.round(live), firstObject: 0, lastObject: 0, mp3Length: 0 },
      artist: "Fake",
      title: map === null ? "Not here" : `Preview map ${map}`,
      version: "Test",
    },
    play: { mods: { number: 0, name: rate === 1.5 ? "DT" : "", array: rate === 1.5 ? [{ acronym: "DT" }] : [], rate } },
  });
  for (const c of clients) c.write(frame(msg));
}, 100);

server.listen(PORT, "127.0.0.1", () => console.log(`fake tosu on ws://127.0.0.1:${PORT}/websocket/v2`));
