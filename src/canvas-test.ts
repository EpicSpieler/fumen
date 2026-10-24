/* canvas-test.ts — the render test page (canvas-test.html) in Fumen's own window: a canvas the
 * size of the window drawn every frame, 2D or WebGL, full or quarter size, with its frame rate.
 * The same drawing as site/public/canvas-test.js, so the numbers compare. */
export {}; // a module: its names aren't the window's (window.frames)
let mode: "2d" | "webgl" = "2d";
let size = 1;
let canvas: HTMLCanvasElement | null = null;
let raf = 0;
let frames = 0;
let since = performance.now();
const fps = document.getElementById("fps")!;

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
    draw(t);
    frames++;
    const now = performance.now();
    if (now - since >= 1000) {
      fps.textContent = `${Math.round((frames * 1000) / (now - since))} fps · ${mode === "2d" ? "2D" : "WebGL"} · ${cv.width}×${cv.height}`;
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
  if (b.dataset.mode) mode = b.dataset.mode as "2d" | "webgl";
  if (b.dataset.size) size = +b.dataset.size;
  make();
});
addEventListener("resize", () => make());
make();
