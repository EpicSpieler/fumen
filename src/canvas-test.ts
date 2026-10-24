/* canvas-test.ts — the render test page (canvas-test.html) in Fumen's own window: a canvas the
 * size of the window drawn every frame, 2D or WebGL, full or quarter size, with its frame rate;
 * and with sound: the song Fumen had loaded (Settings put its address in sessionStorage), as a
 * plain audio element or through Web Audio with analysers read every frame, as the visualizer
 * does (lib/eq). The website's copy (site/public/canvas-test.js, `npm run canvas-test`) is this
 * file without types; it plays canvas-test.wav and has no way back. */
export {}; // a module: its names aren't the window's (window.frames)

const inApp = "__TAURI_INTERNALS__" in window;
const songUrl = inApp ? sessionStorage.getItem("fumen.renderTestSong") : "canvas-test.wav";

let mode: "2d" | "webgl" = "2d";
let size = 1;
let sound: "off" | "audio" | "webaudio" = "off";
let canvas: HTMLCanvasElement | null = null;
let raf = 0;
let frames = 0;
let since = performance.now();
const fps = document.getElementById("fps")!;
if (!inApp) document.querySelector<HTMLElement>(".back")!.hidden = true;

// ── sound ────────────────────────────────────────────────────────────────
let audio: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
let long: AnalyserNode | null = null;
let short: AnalyserNode | null = null;
let fLong = new Float32Array(0);
let fShort = new Float32Array(0);
let wave = new Float32Array(0);

/** false when there's no song to play */
function setSound(next: typeof sound): boolean {
  if (next !== "off" && !songUrl) return false;
  sound = next;
  // Web Audio can't be taken off an element again: a fresh element (and context) each time
  audio?.pause();
  audio = null;
  void ctx?.close();
  ctx = long = short = null;
  if (sound === "off") return true;
  audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.loop = true;
  audio.src = songUrl!;
  if (sound === "webaudio") {
    ctx = new AudioContext();
    const source = ctx.createMediaElementSource(audio);
    long = ctx.createAnalyser();
    long.fftSize = 4096;
    long.smoothingTimeConstant = 0;
    short = ctx.createAnalyser();
    short.fftSize = 2048;
    short.smoothingTimeConstant = 0;
    const volume = ctx.createGain();
    volume.gain.value = 0.5;
    source.connect(long);
    long.connect(short);
    short.connect(volume);
    volume.connect(ctx.destination);
    fLong = new Float32Array(long.frequencyBinCount);
    fShort = new Float32Array(short.frequencyBinCount);
    wave = new Float32Array(short.fftSize);
  } else audio.volume = 0.5;
  void audio.play().catch((e) => (fps.textContent = `The song doesn't play: ${e}`));
  return true;
}

/** what the visualizer reads every frame */
function readAnalysers(): void {
  if (!long || !short) return;
  long.getFloatFrequencyData(fLong);
  short.getFloatFrequencyData(fShort);
  short.getFloatTimeDomainData(wave);
}

// ── drawing ──────────────────────────────────────────────────────────────
function make(): void {
  cancelAnimationFrame(raf);
  canvas?.remove();
  const cv = (canvas = document.createElement("canvas"));
  cv.style.width = cv.style.height = size === 1 ? "100%" : "50%";
  document.body.prepend(cv);
  const r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * devicePixelRatio);
  cv.height = Math.round(r.height * devicePixelRatio);
  document.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  document.querySelectorAll<HTMLElement>("[data-size]").forEach((b) => b.classList.toggle("on", +b.dataset.size! === size));
  document.querySelectorAll<HTMLElement>("[data-sound]").forEach((b) => b.classList.toggle("on", b.dataset.sound === sound));

  let draw: (t: number) => void;
  if (mode === "2d") {
    const c = cv.getContext("2d")!;
    draw = (t) => {
      const { width: w, height: h } = cv;
      c.fillStyle = "#101018";
      c.fillRect(0, 0, w, h);
      for (let i = 0; i < 60; i++) {
        const x = ((t / 4 + i * 97) % (w + 200)) - 100;
        const y = (i * 53) % h;
        c.fillStyle = `hsl(${(i * 37) % 360} 70% 60%)`;
        c.beginPath();
        c.roundRect(x, y, 120, 24, 8);
        c.fill();
      }
    };
  } else {
    const gl = cv.getContext("webgl");
    if (!gl) {
      fps.textContent = "WebGL not available here";
      return;
    }
    draw = (t) => {
      gl.viewport(0, 0, cv.width, cv.height);
      gl.clearColor(0.06 + 0.04 * Math.sin(t / 300), 0.06, 0.1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      for (let i = 0; i < 60; i++) {
        const x = Math.round(((t / 4 + i * 97) % (cv.width + 200)) - 100);
        const y = (i * 53) % cv.height;
        gl.scissor(Math.max(0, x), y, 120, 24);
        gl.clearColor(((i * 37) % 360) / 360, 0.6, 0.8, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.disable(gl.SCISSOR_TEST);
    };
  }

  frames = 0;
  since = performance.now();
  fps.textContent = "…";
  const frame = (t: number) => {
    readAnalysers();
    draw(t);
    frames++;
    const now = performance.now();
    if (now - since >= 1000) {
      const heard = sound === "off" ? "no sound" : sound === "audio" ? "song" : "song + Web Audio";
      fps.textContent = `${Math.round((frames * 1000) / (now - since))} fps · ${mode === "2d" ? "2D" : "WebGL"} · ${cv.width}×${cv.height} · ${heard}`;
      frames = 0;
      since = now;
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}

document.querySelector(".bar")!.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("button");
  if (!b) return;
  if (b.classList.contains("back")) {
    location.href = "/";
    return;
  }
  if (b.dataset.mode) mode = b.dataset.mode as typeof mode;
  if (b.dataset.size) size = +b.dataset.size;
  if (b.dataset.sound && !setSound(b.dataset.sound as typeof sound)) {
    fps.textContent = "No song: play one in Fumen first, then open the test again";
    return;
  }
  make();
});
addEventListener("resize", () => make());
make();
