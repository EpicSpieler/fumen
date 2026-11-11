// A stand-in for tosu (lib/tosu) on its port, for "Follow osu!" in the browser preview:
//   node tools/browser-preview/fake-tosu.mjs [port]
// On another port than 24050 (when the real tosu runs), point the preview at it:
//   localStorage["fumen-preview-tosu"] = "ws://127.0.0.1:<port>/websocket/v2"
// It plays a script like a round of osu!lazer (the MD5 is the preview map's index in hex, which
// the preview shim takes back): map 9 in song select; started with DT, the menu's music running
// on for a moment before the lead-in; a pause; the results; back to song select; map 5 started
// and quit; a map that isn't in the library; map 13 failed, misses piling up before the fail;
// then over again.
//   node tools/browser-preview/fake-tosu.mjs [port] --show [fc|fail|pass]
// plays whole tries at map 13 instead, with the combo, misses, health and results the visualizer
// answers (lib/vis/feel): a full combo, a fail on low health, a pass with a break; one of them
// over and over, or all three in turn.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.argv[2]) || 24050;
const SHOW = process.argv.includes("--show") ? (process.argv[process.argv.indexOf("--show") + 1] ?? "all") : null;
/** [seconds into the script, map index or null (not in the library), state (5 song select,
 * 2 play, 7 results), rate, paused, the song's place there (ms) or null to go on, and while
 * playing: the misses so far and whether it's failed] */
const SCRIPT = [
  [0, 9, 5, 1, false, 40000],
  [5, 9, 2, 1, false, null],
  [6.5, 9, 2, 1.5, false, -1500],
  [12, 9, 2, 1.5, true, null],
  [14, 9, 2, 1.5, false, null],
  [20, 9, 7, 1, true, null],
  [23, 9, 5, 1, false, 40000],
  [26, 5, 5, 1, false, 30000],
  [29, 5, 2, 1, false, null],
  [30.5, 5, 2, 1, false, 0],
  [35, 5, 5, 1, false, 30000],
  [38, null, 2, 1, false, 0],
  [41, 13, 5, 1, false, 30000],
  [44, 13, 2, 1, false, -1500, 0],
  [50, 13, 2, 1, false, null, 2],
  [53, 13, 2, 1, false, null, 5],
  [55, 13, 2, 1, false, null, 8, true],
  [58, 13, 5, 1, false, 30000],
];
const LENGTH = 61;

function frame(text) {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, (data.length >> 8) & 255, data.length & 255]);
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

/** A try at map 13 for --show: what tosu says `s` seconds into it; null once it's over. */
function tryAt(kind, s) {
  const MAP_MD5 = `${"0".repeat(26)}${(13).toString(16).padStart(6, "0")}`;
  const LAST = kind === "fail" ? 60000 : 34000;
  const PER_S = 30;
  const msg = (state, live, play = {}, extra = {}) => ({
    state: { number: state, name: "" },
    game: { paused: !!play.paused },
    beatmap: {
      checksum: MAP_MD5,
      isBreak: false,
      time: { live: Math.round(live), firstObject: 0, lastObject: LAST, mp3Length: 205000 },
      stats: { maxCombo: Math.round((LAST / 1000) * PER_S) },
      artist: "Fake",
      title: "Preview map 13",
      version: "Test",
    },
    play: {
      mode: { number: 3 },
      failed: !!play.failed,
      accuracy: play.accuracy ?? 100,
      combo: { current: play.combo ?? 0, max: play.max ?? 0 },
      hits: { 300: play.hits ?? 0, 0: play.misses ?? 0 },
      healthBar: { normal: play.health ?? 100, smooth: play.health ?? 100 },
      rank: { current: play.rank ?? "SS" },
      pp: { current: play.pp ?? 0 },
      mods: { number: 0, name: "", array: [], rate: 1 },
    },
    ...extra,
  });
  // song select with the menu's music, then loading: the music still running, then back at the
  // beginning and still for a while, paused flickering (as lazer does), then the lead-in
  if (s < 2) return msg(5, 30000 + s * 1000);
  if (s < 3) return msg(2, 30000 + s * 1000);
  if (s < 5) return msg(2, -1500, { paused: Math.floor(s * 4) % 2 === 0 });
  const live = -1500 + (s - 5) * 1000;
  // misses (song s) and the health along the way
  const missAt = { fc: [], pass: [8.2], fail: [6, 11, 12.6, 14.2, 15.4] }[kind];
  const failAt = kind === "fail" ? 17 : Infinity;
  const t = Math.min(live, failAt * 1000) / 1000;
  const notes = Math.max(0, Math.floor(t * PER_S));
  const misses = missAt.filter((m) => m <= t).length;
  const lastMiss = Math.max(0, ...missAt.filter((m) => m <= t));
  const combo = Math.max(0, notes - Math.floor(lastMiss * PER_S));
  let max = 0;
  for (let i = 0, from = 0; i <= missAt.length; i++) {
    const to = i < missAt.length && missAt[i] <= t ? missAt[i] : t;
    max = Math.max(max, Math.floor((to - from) * PER_S));
    if (i < missAt.length && missAt[i] <= t) from = missAt[i];
    else break;
  }
  const health = kind === "fail" ? (t < 9 ? 100 : Math.max(0, 100 - ((t - 9) / 8) * 100)) : Math.min(100, 97 - 3 * Math.sin(t));
  const accuracy = Math.max(0, 99.4 - misses * 0.9 - t * 0.02);
  const rank = accuracy >= 99.5 ? "SS" : accuracy >= 95 ? "S" : accuracy >= 90 ? "A" : "B";
  const play = { combo, max, misses, hits: notes + misses, health, accuracy, rank, pp: Math.round(notes * 0.11) };
  if (live / 1000 >= failAt) {
    // the fail screen: paused, the time creeping on, then back to song select
    if (s - 3 - 1.5 - failAt > 4) return null;
    return msg(2, failAt * 1000 + (live - failAt * 1000) * 0.2, { ...play, failed: true, paused: true });
  }
  if (live < LAST + 1500) return msg(2, live, play);
  // the results, then back to song select
  if (live > LAST + 1500 + 5000) return null;
  return msg(7, live, play, { resultsScreen: { scoreId: 9001, rank, accuracy, score: 812345, maxCombo: max, pp: { current: play.pp } } });
}

const ROUNDS = SHOW === "all" ? ["fc", "fail", "pass"] : SHOW ? [SHOW] : [];
let round = 0;
let roundAt = Date.now();

let start = Date.now();
let live = 40000;
let lastStep = -1;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  if (SHOW) {
    let m = tryAt(ROUNDS[round % ROUNDS.length], (now - roundAt) / 1000);
    if (!m) {
      round++;
      roundAt = now;
      console.log(`try: ${ROUNDS[round % ROUNDS.length]}`);
      m = tryAt(ROUNDS[round % ROUNDS.length], 0);
    }
    for (const c of clients) c.write(frame(JSON.stringify(m)));
    return;
  }
  let s = (now - start) / 1000;
  if (s >= LENGTH) {
    start = now;
    s = 0;
  }
  const step = SCRIPT.findLastIndex(([at]) => s >= at);
  const [, map, state, rate, paused, from, misses = 0, failed = false] = SCRIPT[step];
  if (step !== lastStep) {
    if (from !== null) live = from;
    console.log(`${s.toFixed(1)}s  map ${map ?? "(not in library)"}  state ${state}  ${rate}×${paused ? "  paused" : ""}`);
    lastStep = step;
  }
  if (!paused) live += (now - last) * rate;
  last = now;
  const msg = JSON.stringify({
    state: { number: state, name: "" },
    beatmap: {
      checksum: map === null ? "0123456789abcdef0123456789abcdef" : `${"0".repeat(26)}${map.toString(16).padStart(6, "0")}`,
      time: { live: Math.round(live), firstObject: 0, lastObject: 0, mp3Length: 0 },
      artist: "Fake",
      title: map === null ? "Not here" : `Preview map ${map}`,
      version: "Test",
    },
    play: {
      mods: { number: 0, name: rate === 1.5 ? "DT" : "", array: rate === 1.5 ? [{ acronym: "DT" }] : [], rate },
      failed,
      accuracy: misses ? 100 - misses * 0.6 : 100,
      hits: state === 2 ? { 300: Math.max(0, Math.floor(live / 150)), 0: misses } : {},
    },
  });
  for (const c of clients) c.write(frame(msg));
}, 100);

server.listen(PORT, "127.0.0.1", () => console.log(`fake tosu on ws://127.0.0.1:${PORT}/websocket/v2`));
