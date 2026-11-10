import { COLOR, CHUNK, HIGHLIGHT_KEY } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { n } from "../utils/text.js";
import { busy, notice } from "../components/progress.js";
import { A1, colLetter, spots } from "../utils/sheet.js";

const ours = (color) => Object.values(COLOR).includes(String(color).toUpperCase());

// The fill each highlighted cell had before is kept in the workbook (AH-150). In the pane's memory alone it was lost when
// the pane closed: a reopened pane cleared every cell in our colours to no fill (a user's green under a highlight went,
// and a whole row in Excel's own Neutral style with it), and Find problems after a reopen took our colour for the cell's
// own fill, so no button could take that highlight off again. {sheet, cells: {A1: old fill}}. Document settings hold
// about 2 MB per add-in, shared with the decisions and Undo: at most KEPT cells (a highlight past them comes off in this
// session only).
export const KEPT = 20000;
const HEX = /^#[0-9A-F]{6}$/i;
const settings = () => Office.context.document.settings;

// Pure: whatever the workbook holds -> {sheet, cells} or null. A crafted .xlsx can carry anything here: only A1 cells and
// #RRGGBB fills, in a null-prototype object so no key a workbook names reaches a prototype
export function asHighlights(v) {
  if (!v || typeof v !== "object" || typeof v.sheet !== "string" || !v.cells || typeof v.cells !== "object") return null;
  const cells = Object.create(null);
  for (const [a, old] of Object.entries(v.cells).slice(0, KEPT)) if (A1.test(a) && (old === null || HEX.test(String(old)))) cells[a] = old;
  return { sheet: v.sheet, cells };
}

// What is painted now, into the workbook; nothing painted and nothing kept writes nothing
function keep(p) {
  const cells = Object.fromEntries(Object.entries(p?.cells || {}).slice(0, KEPT));
  if (Object.keys(cells).length) settings().set(HIGHLIGHT_KEY, { sheet: p.sheet, cells });
  else if (settings().get(HIGHLIGHT_KEY) == null) return;
  else settings().remove(HIGHLIGHT_KEY);
  settings().saveAsync();
}

// Highlight cells: color each flagged row's named cells, CHUNK rows per Excel call. The old fill of each cell is
// remembered, so Remove highlights puts back exactly what was there.
export async function paint(rows, s, skip = {}) { // skip: rows fixed or dismissed before - not highlighted again
  await unpaint();
  const flagged = rows.flatMap((r, i) => (COLOR[r.severity] && !skip[i] ? [i] : []));
  const p = { sheet: s.sheet, cells: {}, rows: {} }; // rows: {row: [A1]}, for one row's highlight off or on (fillRow)
  state.painted = p; // recorded before painting: a failure halfway still lets Remove highlights undo what got done
  try {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getItem(s.sheet);
      for (let k = 0; k < flagged.length; k += CHUNK) {
        busy(`Step 3 of 3: highlighting rows to check… ${n(k)} of ${n(flagged.length)}`, k / flagged.length);
        const part = flagged.slice(k, k + CHUNK).flatMap((i) => spots(rows[i], s.columns).map((j) => [i, colLetter(s.startCol + j) + (s.startRow + 2 + i)]));
        const fills = part.map(([, a]) => sheet.getRange(a).format.fill.load("color"));
        await ctx.sync();
        // a cell already in our colour that the workbook kept no fill for is an earlier highlight (its record forgotten,
        // or painted by a pane from before AH-150), never the user's fill: what it goes back to is no fill
        part.forEach(([i, a], m) => { p.cells[a] = ours(fills[m].color) ? null : fills[m].color; (p.rows[i] ||= []).push(a); });
        part.forEach(([i], m) => (fills[m].color = COLOR[rows[i].severity]));
        await ctx.sync();
      }
    });
  } finally {
    keep(p);
  }
}

// Put back the remembered fills - only on cells still wearing one of OUR colors (a cell the user recolored since is
// left alone). Remembered in this pane, or else in the workbook: a cell no record names is never ours to clear
async function unpaint() {
  const p = state.painted || asHighlights(settings().get(HIGHLIGHT_KEY));
  if (!p) return;
  const at = Object.keys(p.cells);
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItemOrNullObject(p.sheet).load("isNullObject");
    await ctx.sync();
    if (sheet.isNullObject) return; // that sheet was deleted: nothing left to restore
    for (let k = 0; k < at.length; k += CHUNK) {
      busy(`Removing highlights… ${n(k)} of ${n(at.length)}`, k / at.length);
      const part = at.slice(k, k + CHUNK), fills = part.map((a) => sheet.getRange(a).format.fill.load("color"));
      await ctx.sync();
      fills.forEach((fill, m) => ours(fill.color) && put(fill, p.cells[part[m]]));
      await ctx.sync();
    }
  });
  state.painted = null;
  keep(null);
}

// A cell's remembered fill back: its own color, or none
const put = (fill, old) => (old && String(old).toUpperCase() !== "#FFFFFF" ? (fill.color = old) : fill.clear());

// One row's highlight off (fix accepted and re-checked, or dismissed) or back on (Undo). Like Grammarly's underline.
// Only a cell still wearing our color, or its own untouched fill, is changed: a fill the user put on since stays.
export async function fillRow(i, on) {
  const p = state.painted, color = COLOR[state.lastRows[i]?.severity];
  if (!p?.rows?.[i] || (on && !color)) return; // not painted in this pane (highlights removed since)
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(p.sheet);
    const cells = p.rows[i].map((a) => [p.cells[a], sheet.getRange(a).format.fill.load("color")]);
    await ctx.sync();
    for (const [old, fill] of cells) {
      const now = String(fill.color).toUpperCase();
      if (!on && ours(now)) put(fill, old);
      if (on && (ours(now) || now === String(old ?? "#FFFFFF").toUpperCase())) fill.color = color;
    }
    await ctx.sync();
  });
}

export async function clearHighlights() {
  await unpaint();
  notice("Highlights removed. Your data was not changed.");
}
