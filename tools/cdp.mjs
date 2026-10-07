// Drives the running app's WebView2 over the Chrome DevTools Protocol (dev only).
// Start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222, then:
//
//   node tools/cdp.mjs eval "<js expression>"   evaluate in the page (awaits promises)
//   node tools/cdp.mjs shot <out.png>           screenshot of the page
import { writeFileSync } from "node:fs";

const [cmd, arg] = process.argv.slice(2);
const port = process.env.CDP_PORT ?? "9222";
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

if (cmd === "eval") {
  const r = await send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
  const res = r.result?.result;
  console.log(r.result?.exceptionDetails ? JSON.stringify(r.result.exceptionDetails, null, 2) : JSON.stringify(res?.value ?? res, null, 2));
} else if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(arg, Buffer.from(r.result.data, "base64"));
  console.log(`saved ${arg}`);
} else {
  console.error("usage: cdp.mjs eval <expr> | shot <file>");
}
ws.close();
