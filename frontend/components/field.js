// The contour field behind the pane's hero, the website's field (site/field.js, AH-72) at pane size: iso-lines of a
// domain-warped noise field, navy lines at low alpha on paper and one level in dark gold. Drawn on demand only, when
// something changes it: its fade-in when the hero first gets a size, a resize, the mouse's soft lens. No frame loop
// runs while nothing moves, nothing is read back from the GPU, and with no WebGL 2 (or a shader that fails) there is
// no canvas at all: the paper's CSS texture is the whole background.
const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;    // drawing buffer, px
uniform float uPx;    // buffer px per CSS px
uniform vec3 uPtr;    // pointer x, y (CSS px) and how much it bends the field, 0 to 1
uniform float uFade;  // the fade-in, 0 to 1
out vec4 o;
vec2 hash(vec2 p) { // Dave Hoskins' hash: no sin(), so the same on every GPU
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy) * 2.0 - 1.0;
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(dot(hash(i), f), dot(hash(i + vec2(1, 0)), f - vec2(1, 0)), u.x),
             mix(dot(hash(i + vec2(0, 1)), f - vec2(0, 1)), dot(hash(i + vec2(1, 1)), f - vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 3; i++) { s += a * noise(p); p = r * p * 2.03; a *= 0.5; }
  return s;
}
void main() {
  vec2 c = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uPx;
  vec2 d = c - uPtr.xy;
  c -= d * exp(-dot(d, d) / 9000.0) * 0.38 * uPtr.z;     // a soft lens around the pointer
  float t = (1.0 - uFade) * 0.6;                           // the field flows into place as it fades in
  vec2 p = c / 300.0;
  vec2 w = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t * 0.8));
  float lv = fbm(p + 1.6 * w + vec2(1.7, 9.2) + 0.2 * t) * 18.0;
  float g = fwidth(lv);
  float idx = floor(lv + 0.5);
  float px = abs(fract(lv + 0.5) - 0.5) / max(g, 1e-4);  // distance to the nearest level, in buffer px
  bool major = mod(idx, 4.0) == 0.0, gold = idx == 2.0;
  float wid = (gold ? 1.4 : major ? 1.1 : 0.75) * uPx;
  float line = 1.0 - smoothstep(wid * 0.5 - 0.5, wid * 0.5 + 0.5, px);
  line *= 1.0 - smoothstep(0.18, 0.4, g);
  float a = gold ? 0.5 : major ? 0.16 : 0.08;
  vec3 ink = gold ? vec3(0.600, 0.490, 0.227) : vec3(0.047, 0.098, 0.220);
  float fall = 1.0 - smoothstep(0.55, 1.0, c.y * uPx / uRes.y); // fades out toward the hero's foot: no hard edge
  a *= line * fall * uFade;
  o = vec4(ink * a, a);
}`;
const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

export function initField(hero, still) {
  if (!hero) return;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl) return;
  let loc = null;
  function init() {
    const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, "p");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one triangle covers it
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    loc = Object.fromEntries(["uRes", "uPx", "uPtr", "uFade"].map((n) => [n, gl.getUniformLocation(prog, n)]));
    return true;
  }
  // a software renderer (SwiftShader, llvmpipe, Windows' Basic Render Driver) draws ~100x slower than a GPU, and with no
  // GPU to composite on, Chromium reads every frame back to the CPU ("GPU stall due to ReadPixels" warnings in the
  // console, headless e2e, 2026-10-30): there the paper's texture is enough
  let name = gl.getParameter(gl.RENDERER);
  if (/^WebKit/.test(name)) { const x = gl.getExtension("WEBGL_debug_renderer_info"); if (x) name = gl.getParameter(x.UNMASKED_RENDERER_WEBGL); }
  if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)) return;
  if (!init()) return;
  hero.prepend(canvas);

  const ptr = { tx: 0, ty: 0, x: 0, y: 0, ta: 0, a: 0, last: 0, moving: false };
  let born = 0, lost = false, raf = 0, drawn = "", vw = 0, vh = 0;

  function frame(now) {
    raf = 0;
    if (lost || !vw || !vh) return;
    const k = Math.min(window.devicePixelRatio || 1, 1.5); // past 1.5 the lines get no finer to the eye
    const w = Math.round(vw * k), h = Math.round(vh * k);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); drawn = ""; }
    if (!born) born = now;
    const fade = still ? 1 : Math.min(1, (now - born) / 900);
    if (ptr.moving) { // the lens follows with a 220 ms time constant, by the clock however slow the frames come
      const e = 1 - Math.exp(-Math.max(now - ptr.last, 0) / 220);
      ptr.last = now;
      ptr.x += (ptr.tx - ptr.x) * e; ptr.y += (ptr.ty - ptr.y) * e; ptr.a += (ptr.ta - ptr.a) * e;
      if (Math.abs(ptr.tx - ptr.x) + Math.abs(ptr.ty - ptr.y) < 0.3 && Math.abs(ptr.ta - ptr.a) < 0.002) {
        ptr.x = ptr.tx; ptr.y = ptr.ty; ptr.a = ptr.ta; ptr.moving = false;
      }
    }
    const key = [w, h, ptr.x, ptr.y, ptr.a, fade].join();
    if (key !== drawn) {
      drawn = key;
      gl.uniform2f(loc.uRes, w, h);
      gl.uniform1f(loc.uPx, w / vw);
      gl.uniform3f(loc.uPtr, ptr.x, ptr.y, ptr.a);
      gl.uniform1f(loc.uFade, fade);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (ptr.moving || fade < 1) request();
  }
  const request = () => { if (!raf) raf = requestAnimationFrame(frame); };

  new ResizeObserver(([e]) => { vw = e.contentRect.width; vh = e.contentRect.height; request(); }).observe(canvas);
  if (!still && matchMedia("(hover: hover) and (pointer: fine)").matches) {
    const wake = () => { if (!ptr.moving) { ptr.moving = true; ptr.last = performance.now(); } request(); };
    hero.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      const r = hero.getBoundingClientRect();
      if (!ptr.ta && !ptr.a) { ptr.x = e.clientX - r.left; ptr.y = e.clientY - r.top; } // the lens grows where the pointer enters
      ptr.tx = e.clientX - r.left; ptr.ty = e.clientY - r.top; ptr.ta = 1; wake();
    }, { passive: true });
    hero.addEventListener("pointerleave", () => { ptr.ta = 0; wake(); });
  }
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); lost = true; canvas.hidden = true; });
  canvas.addEventListener("webglcontextrestored", () => { lost = !init(); canvas.hidden = lost; drawn = ""; request(); });
}
