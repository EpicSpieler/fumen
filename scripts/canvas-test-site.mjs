// The render test for the website: canvas-test.html and src/canvas-test.ts (the in-app page,
// Settings › Render test) turned into site/public/canvas-test.{html,js}, plus canvas-test.wav, a
// few seconds of beat for the test with sound. Then deploy the site.
//
//   npm run canvas-test
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "site", "public");

const html = readFileSync(join(root, "canvas-test.html"), "utf8").replace(
  `<script type="module" src="/src/canvas-test.ts"></script>`,
  `<script type="module" src="canvas-test.js"></script>`,
);
writeFileSync(join(out, "canvas-test.html"), html);

const source = readFileSync(join(root, "src", "canvas-test.ts"), "utf8");
const { code: js } = await transformWithOxc(source, "canvas-test.ts", { target: "es2022" });
writeFileSync(join(out, "canvas-test.js"), js);

// 8 s of 120 BPM, mono 16-bit at 22.05 kHz: a kick on every beat over a soft chord
const rate = 22050;
const n = rate * 8;
const pcm = Buffer.alloc(44 + n * 2);
pcm.write("RIFF", 0);
pcm.writeUInt32LE(36 + n * 2, 4);
pcm.write("WAVEfmt ", 8);
pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20);
pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(rate, 24);
pcm.writeUInt32LE(rate * 2, 28);
pcm.writeUInt16LE(2, 32);
pcm.writeUInt16LE(16, 34);
pcm.write("data", 36);
pcm.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) {
  const t = i / rate;
  const beat = t % 0.5;
  const kick = Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-beat * 30)) * beat) * Math.exp(-beat * 9);
  const chord = [220, 277.18, 329.63].reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) / 3;
  const v = 0.6 * kick + 0.15 * chord;
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2);
}
writeFileSync(join(out, "canvas-test.wav"), pcm);
console.log("✓ site/public/canvas-test.{html,js,wav}");
