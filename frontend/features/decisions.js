import { DECISIONS_KEY } from "../constants/index.js";

// Fixed and Dismissed outlive the pane: each decision is kept in the workbook (its document settings, like the slider
// and the limits) under a short code of the row's values. They lived only in the pane's memory, so after a reload or a
// re-scan a dismissed row came back flagged and an accepted fix vanished from the list and from Power BI (2026-10-20).
// A code, never the values: the workbook keeps no second copy of its rows (the privacy pages say so).
// {sheet: {code: "fixed" | "dismissed"}}, newest last. Document settings hold about 2 MB per add-in: at most
// PER_SHEET codes per sheet (about 140 KB) and SHEETS sheets, the oldest dropped first.
export const PER_SHEET = 5000;
export const SHEETS = 8;
const KINDS = new Set(["fixed", "dismissed"]);
const CODE = /^[0-9a-z]{1,11}\.\d{1,7}$/;

// Pure: cyrb53, a fast 53-bit string hash -> base 36. Not crypto: it only has to tell a sheet's rows apart.
export function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Pure: each row's values as the scan read them -> its hash
export const rowHash = (row) => hash(JSON.stringify(row));

// Pure: hashes in sheet order -> codes: the hash plus which copy it is among identical rows, so two identical rows
// are two rows. A sort keeps every code; an edited row gets a new one, and is judged again.
export function codes(hashes) {
  const seen = new Map();
  return hashes.map((h) => {
    const k = seen.get(h) || 0;
    seen.set(h, k + 1);
    return `${h}.${k}`;
  });
}

// Pure: the code row i would have if its hash were h (the rows above it unchanged) - a row just fixed
export const codeAt = (hashes, i, h) => `${h}.${hashes.slice(0, i).filter((x) => x === h).length}`;

// Pure: whatever the workbook holds -> a clean book. A crafted workbook can carry anything here: only codes and our
// two words survive. Null-prototype objects: a sheet may be named "__proto__".
export function asBook(v) {
  const book = Object.create(null);
  if (!v || typeof v !== "object" || Array.isArray(v)) return book;
  for (const [sheet, rows] of Object.entries(v).slice(-SHEETS)) {
    if (!rows || typeof rows !== "object" || Array.isArray(rows)) continue;
    const kept = Object.create(null);
    for (const [code, what] of Object.entries(rows).slice(-PER_SHEET)) if (CODE.test(code) && KINDS.has(what)) kept[code] = what;
    if (Object.keys(kept).length) book[sheet] = kept;
  }
  return book;
}

// Pure: the book with these [code, "fixed" | "dismissed" | null] set (null removes it), newest last, capped
export function decide(book, sheet, pairs) {
  const rows = Object.assign(Object.create(null), book[sheet]);
  for (const [code, what] of pairs) {
    delete rows[code]; // set again = newest
    if (KINDS.has(what)) rows[code] = what;
  }
  const keys = Object.keys(rows);
  keys.slice(0, Math.max(0, keys.length - PER_SHEET)).forEach((k) => delete rows[k]);
  const out = Object.assign(Object.create(null), book);
  delete out[sheet]; // this sheet becomes the newest
  if (keys.length) out[sheet] = rows;
  const sheets = Object.keys(out);
  sheets.slice(0, Math.max(0, sheets.length - SHEETS)).forEach((s) => delete out[s]);
  return out;
}

const settings = () => Office.context.document.settings;

// This sheet's decisions, as the workbook holds them now: {code: "fixed" | "dismissed"}
export const decisionsFor = (sheet) => asBook(settings().get(DECISIONS_KEY))[sheet] || Object.create(null);

export function saveDecisions(sheet, pairs) {
  settings().set(DECISIONS_KEY, decide(asBook(settings().get(DECISIONS_KEY)), sheet, pairs));
  settings().saveAsync();
}
