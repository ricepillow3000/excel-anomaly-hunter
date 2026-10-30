// The field behind the page (AH-72): contour lines of a domain-warped noise field, drawn by the GPU on one fixed canvas
// between the sections' paper and their text. Navy lines on paper, cream lines on the navy band, one level in gold (AH-79).
// Its shape is a function of the scroll position (it morphs and drifts slower than the page), so it stops exactly
// when the scroll does; it draws only when motion.js gives it a frame (scroll, resize, the pointer, its fade-in).
// No WebGL 2, or a shader that fails: no canvas, and the paper's CSS texture is the whole background, as before.
(() => {
  const AH = window.AH, html = document.documentElement;
  if (!AH) return;
  const canvas = document.createElement("canvas");
  canvas.id = "field";
  canvas.setAttribute("aria-hidden", "true");
  canvas.dataset.state = "moving";
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl) { html.dataset.gl = "off"; return; }

  const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
  const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;    // drawing buffer, px
uniform float uPx;    // buffer px per CSS px
uniform float uY;     // scroll position, CSS px
uniform vec2 uBand;   // the dark band's top and bottom, CSS px from the top of the screen
uniform vec3 uPtr;    // pointer x, y (CSS px) and how much it bends the field, 0 to 1
uniform float uFade;  // the fade-in on load, 0 to 1
out vec4 o;
vec2 hash(vec2 p) { // Dave Hoskins' hash: no sin(), so the same on every GPU
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy) * 2.0 - 1.0;
}
float noise(vec2 p) { // gradient noise with a quintic fade: smooth to the second derivative, so contours stay round
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
  c -= d * exp(-dot(d, d) / 32000.0) * 0.42 * uPtr.z;   // a soft lens around the pointer
  float t = uY * 0.0007 + (1.0 - uFade) * 0.6;           // the field flows into place as it fades in
  vec2 p = (c + vec2(0.0, uY * 0.35)) / 620.0;           // drifts at a third of the page's speed: depth
  vec2 w = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t * 0.8));
  float lv = fbm(p + 1.6 * w + vec2(1.7, 9.2) + 0.2 * t) * 22.0;
  float g = fwidth(lv);
  float idx = floor(lv + 0.5);
  float px = abs(fract(lv + 0.5) - 0.5) / max(g, 1e-4); // distance to the nearest level, in buffer px
  bool major = mod(idx, 4.0) == 0.0, gold = idx == 5.0;
  float wid = (gold ? 1.5 : major ? 1.1 : 0.75) * uPx;
  float line = 1.0 - smoothstep(wid * 0.5 - 0.5, wid * 0.5 + 0.5, px);
  line *= 1.0 - smoothstep(0.18, 0.4, g);               // where levels crowd closer than a few px, let them go
  float dark = step(uBand.x, c.y) * step(c.y, uBand.y);
  float a = gold ? 0.62 : mix(major ? 0.17 : 0.085, major ? 0.2 : 0.11, dark);
  // navy #0C1938 on paper, cream #EFE6D2 on the band; the gold level #997D3A on paper, #C9A85A on navy
  vec3 ink = gold ? mix(vec3(0.600, 0.490, 0.227), vec3(0.788, 0.659, 0.353), dark) : mix(vec3(0.047, 0.098, 0.220), vec3(0.937, 0.902, 0.824), dark);
  float grain = 0.75 + 0.5 * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453); // ink on paper
  a *= line * grain * uFade;
  o = vec4(ink * a, a);
}`;

  let prog, loc;
  function init() {
    const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, "p");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one triangle covers the screen
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    loc = Object.fromEntries(["uRes", "uPx", "uY", "uBand", "uPtr", "uFade"].map((n) => [n, gl.getUniformLocation(prog, n)]));
    return true;
  }
  if (!init()) { html.dataset.gl = "off"; return; }
  document.body.prepend(canvas);
  html.dataset.gl = "on";

  // 1.5 device px per CSS px at most, and about 1.6 million pixels a frame: past that the lines get no finer to the eye.
  // A GPU draws that in about a millisecond; a software renderer took 100 ms (SwiftShader, 1440 x 900, 2026-10-30),
  // which held every frame of the page's scroll motion back, so there the field is drawn at half size (25 ms)
  const BUDGET = 1.6e6;
  let name = gl.getParameter(gl.RENDERER);
  if (/^WebKit/.test(name)) { const d = gl.getExtension("WEBGL_debug_renderer_info"); if (d) name = gl.getParameter(d.UNMASKED_RENDERER_WEBGL); }
  const soft = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  let born = 0, lost = false, drawn = "";
  const ptr = { tx: 0, ty: 0, x: 0, y: 0, ta: 0, a: 0, last: 0, moving: false };

  function draw(s) {
    if (lost || !s.vw) return false;
    let k = soft ? 0.5 : Math.min(window.devicePixelRatio || 1, 1.5);
    if (s.vw * s.vh * k * k > BUDGET) k *= Math.sqrt(BUDGET / (s.vw * s.vh * k * k));
    const w = Math.round(s.vw * k), h = Math.round(s.vh * k);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    if (!born) born = s.now;
    const fade = AH.still ? 1 : Math.min(1, (s.now - born) / 900);
    // the pointer's bend, eased by the clock (a 220 ms time constant) until it settles
    if (ptr.moving) {
      const e = 1 - Math.exp(-Math.max(s.now - ptr.last, 0) / 220); // by the clock however slow the frames come
      ptr.last = s.now;
      ptr.x += (ptr.tx - ptr.x) * e; ptr.y += (ptr.ty - ptr.y) * e; ptr.a += (ptr.ta - ptr.a) * e;
      if (Math.abs(ptr.tx - ptr.x) + Math.abs(ptr.ty - ptr.y) < 0.3 && Math.abs(ptr.ta - ptr.a) < 0.002) {
        ptr.x = ptr.tx; ptr.y = ptr.ty; ptr.a = ptr.ta; ptr.moving = false;
      }
    }
    // data-state says when the picture is final (faded in, the pointer's bend at rest), so a test that counts its pixels
    // waits for that instead of a guessed delay: the count was 5812 one run and 5752 the next, when Chromium's own
    // mousemove at 0,0 after load reached the listener and bent the corner (tools/test_site.mjs, 2026-10-30)
    const busy = ptr.moving || fade < 1, state = busy ? "moving" : "settled";
    // the same picture asked for twice (a resize report, an entrance frame after the fade) is not drawn again
    const key = [w, h, s.y, s.band, ptr.x, ptr.y, ptr.a, fade].join();
    if (key === drawn) { if (canvas.dataset.state !== state) canvas.dataset.state = state; return busy; }
    drawn = key;
    gl.uniform2f(loc.uRes, w, h);
    gl.uniform1f(loc.uPx, w / s.vw);
    gl.uniform1f(loc.uY, s.y);
    gl.uniform2f(loc.uBand, s.band ? s.band[0] : -1, s.band ? s.band[1] : -1);
    gl.uniform3f(loc.uPtr, ptr.x, ptr.y, ptr.a);
    gl.uniform1f(loc.uFade, fade);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (canvas.dataset.state !== state) canvas.dataset.state = state;
    return busy;
  }

  if (!AH.still && matchMedia("(hover: hover) and (pointer: fine)").matches) {
    const wake = () => { if (!ptr.moving) { ptr.moving = true; ptr.last = performance.now(); } AH.request(); };
    addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      if (!ptr.ta && !ptr.a) { ptr.x = e.clientX; ptr.y = e.clientY; } // the lens grows where the pointer enters
      ptr.tx = e.clientX; ptr.ty = e.clientY; ptr.ta = 1; wake();
    }, { passive: true });
    document.addEventListener("pointerout", (e) => { if (!e.relatedTarget) { ptr.ta = 0; wake(); } });
  }
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); lost = true; canvas.hidden = true; });
  canvas.addEventListener("webglcontextrestored", () => { lost = !init(); canvas.hidden = lost; drawn = ""; AH.request(); });
  AH.onFrame(draw);
})();
