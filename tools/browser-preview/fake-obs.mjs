// A stand-in for OBS's websocket server (obs-websocket 5) for trying Fumen's scenes and clips in
// the browser preview without OBS (views/obs-control.ts):
//   node tools/browser-preview/fake-obs.mjs [port] [--password <pw>] [--no-replay]
// It has five scenes (Song select, Gameplay, Results, Just chatting, BRB), switches between them
// when asked and says so, runs a replay buffer (off with --no-replay until Fumen starts it) and
// answers "save" with a made-up file a moment later. Every request is printed.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const PORT = Number(process.argv[2]) || 4455;
const PASSWORD = process.argv.includes("--password") ? process.argv[process.argv.indexOf("--password") + 1] : null;
let replay = !process.argv.includes("--no-replay");
let recording = false;
const SCENES = ["Song select", "Gameplay", "Results", "Just chatting", "BRB"];
let current = "Just chatting";
let saved = 0;

const sha = (s) => createHash("sha256").update(s).digest("base64");

function frame(text, opcode = 1) {
  const data = Buffer.from(text);
  const head =
    data.length < 126
      ? Buffer.from([0x80 | opcode, data.length])
      : data.length < 65536
        ? Buffer.from([0x80 | opcode, 126, (data.length >> 8) & 255, data.length & 255])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127, 0, 0, 0, 0]), Buffer.from([(data.length >>> 24) & 255, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255])]);
  return Buffer.concat([head, data]);
}

/** The client's frames out of what came in so far (they're masked); what's left over. */
function frames(buf) {
  const out = [];
  let i = 0;
  while (buf.length - i >= 2) {
    const op = buf[i] & 15;
    let len = buf[i + 1] & 127;
    let at = i + 2;
    if (len === 126) {
      if (buf.length < at + 2) break;
      len = buf.readUInt16BE(at);
      at += 2;
    } else if (len === 127) {
      if (buf.length < at + 8) break;
      len = Number(buf.readBigUInt64BE(at));
      at += 8;
    }
    const masked = (buf[i + 1] & 128) !== 0;
    const key = masked ? buf.subarray(at, at + 4) : null;
    if (masked) at += 4;
    if (buf.length < at + len) break;
    const data = Buffer.from(buf.subarray(at, at + len));
    if (key) for (let j = 0; j < data.length; j++) data[j] ^= key[j & 3];
    out.push({ op, data });
    i = at + len;
  }
  return { out, rest: buf.subarray(i) };
}

const clients = new Set();
const send = (socket, msg) => socket.write(frame(JSON.stringify(msg)));
const event = (type, data) => {
  for (const c of clients) if (c.identified) send(c.socket, { op: 5, d: { eventType: type, eventIntent: 0, eventData: data } });
};

function answer(type, data) {
  switch (type) {
    case "GetVersion":
      return { obsVersion: "31.0.0", obsWebSocketVersion: "5.5.0", rpcVersion: 1 };
    case "GetSceneList":
      return { currentProgramSceneName: current, currentPreviewSceneName: null, scenes: SCENES.map((sceneName, i) => ({ sceneName, sceneIndex: SCENES.length - 1 - i })) };
    case "SetCurrentProgramScene":
      if (!SCENES.includes(data.sceneName)) throw [600, "No such scene"];
      current = data.sceneName;
      setTimeout(() => event("CurrentProgramSceneChanged", { sceneName: current }), 20);
      return {};
    case "GetReplayBufferStatus":
      return { outputActive: replay };
    case "StartReplayBuffer":
      replay = true;
      setTimeout(() => event("ReplayBufferStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" }), 50);
      return {};
    case "SaveReplayBuffer":
      if (!replay) throw [501, "Replay buffer is not active"];
      saved++;
      setTimeout(() => event("ReplayBufferSaved", { savedReplayPath: `C:/Videos/Replay 2026-11-11 21-05-${String(saved).padStart(2, "0")}.mkv` }), 400);
      return {};
    case "GetRecordStatus":
      return { outputActive: recording };
    case "CreateRecordChapter":
      return {};
    default:
      throw [204, `Unknown request ${type}`];
  }
}

const server = createServer((_, res) => res.end("fake obs"));
server.on("upgrade", (req, socket) => {
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const c = { socket, identified: false, salt: randomBytes(32).toString("base64"), challenge: randomBytes(32).toString("base64") };
  clients.add(c);
  let pending = Buffer.alloc(0);
  send(socket, { op: 0, d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1, ...(PASSWORD ? { authentication: { challenge: c.challenge, salt: c.salt } } : {}) } });
  socket.on("data", (chunk) => {
    const { out, rest } = frames(Buffer.concat([pending, chunk]));
    pending = Buffer.from(rest);
    for (const f of out) {
      if (f.op === 8) {
        socket.end(frame(Buffer.from([3, 232]).toString("latin1"), 8));
        continue;
      }
      if (f.op !== 1) continue;
      const msg = JSON.parse(f.data.toString());
      if (msg.op === 1) {
        if (PASSWORD && msg.d.authentication !== sha(sha(PASSWORD + c.salt) + c.challenge)) {
          console.log("identify: wrong password");
          const reason = Buffer.from("Authentication failed.");
          socket.end(Buffer.concat([Buffer.from([0x88, reason.length + 2, 0x0f, 0xa9]), reason]));
          continue;
        }
        c.identified = true;
        console.log(`identified (events ${msg.d.eventSubscriptions})`);
        send(socket, { op: 2, d: { negotiatedRpcVersion: 1 } });
      } else if (msg.op === 6) {
        const { requestType, requestId, requestData } = msg.d;
        try {
          const responseData = answer(requestType, requestData ?? {});
          console.log(`${requestType} ${JSON.stringify(requestData ?? {})}${requestType === "SetCurrentProgramScene" ? `  → on air: ${current}` : ""}`);
          send(socket, { op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } });
        } catch (e) {
          const [code, comment] = Array.isArray(e) ? e : [500, String(e)];
          console.log(`${requestType}: ${comment}`);
          send(socket, { op: 7, d: { requestType, requestId, requestStatus: { result: false, code, comment } } });
        }
      }
    }
  });
  socket.on("close", () => clients.delete(c));
  socket.on("error", () => clients.delete(c));
});

server.listen(PORT, "127.0.0.1", () => console.log(`fake OBS on ws://127.0.0.1:${PORT}${PASSWORD ? " (with a password)" : ""}, on air: ${current}`));
