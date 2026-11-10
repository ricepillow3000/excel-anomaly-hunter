// WCAG contrast of what a page really shows, read from the browser (AH-87). Used by e2e/run.mjs (the pane) and
// tools/test_site.mjs --browser (the website). Ratios worked out from the CSS tokens by hand went wrong: the pane's
// global.css said navy was 16.6:1 on paper (it is 15.9), and nothing saw that a fixed row's opacity of 0.6 took its
// small print to 2.69:1. This reads every visible text's own colour, faded by every opacity above it, against the
// background colours stacked under it, and every text field's border against the field and the panel around it.
// Disabled controls are left out (WCAG 1.4.3 exempts inactive components); background images (the paper's grain, its
// 4.5% grid) are not colours a text sits on and are left out too.
//
// contrastProblems is passed to page.evaluate, so it must hold everything it uses.
export function contrastProblems() {
  // any CSS colour, as the browser itself draws it: through a 1x1 canvas. AH-149 mixes the pane's tints in OKLCH, and a
  // computed colour of color-mix() reads "oklch(...)", which a rgb() parser took for transparent
  const pen = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const rgba = (s) => {
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = "rgb(0 0 0 / 0)";
    pen.fillStyle = s;
    pen.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pen.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  // colours as premultiplied RGBA, so an opacity fades a whole element (its background and its text together) over
  // what lies under it, the way the browser flattens it: each element's group starts see-through, holds its own
  // background, and is laid at its opacity onto its parent's
  const pre = (c) => [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
  const over = (top, under) => top.map((v, k) => v + under[k] * (1 - top[3]));
  const groups = (el) => { const g = []; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const c = getComputedStyle(e); g.push([pre(rgba(c.backgroundColor)), Number(c.opacity)]); } return g; };
  const paint = (color, gs) => { // what reaches the screen when `color` is drawn inside the innermost group
    let x = pre(color);
    for (const [bg, op] of gs) x = over(x, bg).map((v) => v * op);
    return over(x, [255, 255, 255, 1]);
  };
  const ground = (el) => paint([0, 0, 0, 0], groups(el));
  const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.classList.length ? "." + [...el.classList].join(".") : "");
  const bad = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement;
    if (!t.nodeValue.trim() || seen.has(el) || el.closest("svg, script, style, [inert], [aria-hidden='true'], :disabled")) continue;
    seen.add(el);
    if (!el.checkVisibility({ opacityProperty: false, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue; // a visually hidden label (the skip link at rest)
    const c = getComputedStyle(el), size = parseFloat(c.fontSize), bold = Number(c.fontWeight) >= 700;
    const gs = groups(el), bg = paint([0, 0, 0, 0], gs), shown = paint(rgba(c.color), gs);
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5; // large text: 18 pt, or 14 pt bold
    const got = ratio(shown, bg);
    if (got < need) bad.push(`${name(el)} "${t.nodeValue.trim().slice(0, 40)}": ${hex(shown)} on ${hex(bg)} is ${got.toFixed(2)}:1, under ${need}:1`);
  }
  // a text field's edge must show against the field and against what is around it (WCAG 1.4.11: 3:1)
  for (const el of document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select")) {
    if (el.disabled || !el.checkVisibility()) continue;
    const c = getComputedStyle(el), edge = paint(rgba(c.borderTopColor), groups(el.parentElement));
    for (const [where, bg] of [["the field", ground(el)], ["around it", ground(el.parentElement)]]) {
      const got = ratio(edge, bg);
      if (got < 3) bad.push(`${name(el)} border ${hex(edge)} against ${where} ${hex(bg)} is ${got.toFixed(2)}:1, under 3:1`);
    }
    // its placeholder is text too: Chromium's own grey is 2.5:1 on white
    if (el.placeholder) {
      const p = getComputedStyle(el, "::placeholder"), pf = rgba(p.color), gs = groups(el), bg = paint([0, 0, 0, 0], gs);
      const shown = paint([pf[0], pf[1], pf[2], pf[3] * Number(p.opacity || 1)], gs), got = ratio(shown, bg);
      if (got < 4.5) bad.push(`${name(el)} placeholder "${el.placeholder.slice(0, 30)}": ${hex(shown)} on ${hex(bg)} is ${got.toFixed(2)}:1, under 4.5:1`);
    }
  }
  return bad;
}
