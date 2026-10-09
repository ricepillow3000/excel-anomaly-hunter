export const n = (x) => x.toLocaleString("en-US");

// Pure: text safe inside HTML and inside "attribute values" (column headers come from the sheet)
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---- Limits: plain "flag below / flag above" per number column ----
// Pure: a saved limit as an input value - a number or nothing (a tampered workbook can't put markup in the page)
export const asNumber = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "" : Number(v));

// Pure: median of the numbers in a list (null if none)
export function median(xs) {
  const v = xs.filter((x) => typeof x === "number" && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
