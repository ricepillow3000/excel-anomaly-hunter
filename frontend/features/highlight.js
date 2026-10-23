import { COLOR, OLD_COLOR, CHUNK, READ_CELLS } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { n } from "../utils/text.js";
import { busy, notice } from "../components/progress.js";
import { spots } from "../utils/sheet.js";

const ours = (color) => Object.values(COLOR).includes(String(color).toUpperCase());

// Highlight cells: color each flagged row's named cells, CHUNK rows per Excel call. The old fill of each cell is
// remembered, so Remove highlights puts back exactly what was there.
export async function paint(rows, s, skip = {}) { // skip: rows fixed or dismissed before - not highlighted again
  await unpaint();
  const flagged = rows.flatMap((r, i) => (COLOR[r.severity] && !skip[i] ? [i] : []));
  const p = { sheet: s.sheet, startRow: s.startRow, startCol: s.startCol, width: s.columns.length, colors: {} };
  state.painted = p; // recorded before painting: a failure halfway still lets Remove highlights undo what got done
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(s.sheet);
    for (let k = 0; k < flagged.length; k += CHUNK) {
      busy(`Step 3 of 3: highlighting rows to check… ${n(k)} of ${n(flagged.length)}`, k / flagged.length);
      const part = flagged.slice(k, k + CHUNK).flatMap((i) => spots(rows[i], s.columns).map((j) => [i, j]));
      const fills = part.map(([i, j]) => sheet.getRangeByIndexes(s.startRow + 1 + i, s.startCol + j, 1, 1).format.fill.load("color"));
      await ctx.sync();
      part.forEach(([i, j], m) => ((p.colors[i] ||= {})[j] = fills[m].color));
      part.forEach(([i], m) => (fills[m].color = COLOR[rows[i].severity]));
      await ctx.sync();
    }
  });
}

// Put back the remembered fills - only on cells still wearing one of OUR colors (a cell the user recolored since is
// left alone).
export async function unpaint() {
  const p = state.painted;
  if (!p) return;
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItemOrNullObject(p.sheet).load("isNullObject");
    await ctx.sync();
    if (sheet.isNullObject) return; // that sheet was deleted: nothing left to restore
    const idx = Object.keys(p.colors).map(Number);
    for (let k = 0; k < idx.length; k += CHUNK) {
      busy(`Removing highlights… ${n(k)} of ${n(idx.length)}`, k / idx.length);
      const part = idx.slice(k, k + CHUNK).flatMap((i) => Object.keys(p.colors[i]).map((j) => [i, +j]));
      const fills = part.map(([i, j]) => sheet.getRangeByIndexes(p.startRow + 1 + i, p.startCol + j, 1, 1).format.fill.load("color"));
      await ctx.sync();
      fills.forEach((fill, m) => ours(fill.color) && put(fill, p.colors[part[m][0]][part[m][1]]));
      await ctx.sync();
    }
  });
  state.painted = null;
}

// A cell's remembered fill back: its own color, or none
const put = (fill, old) => (old && String(old).toUpperCase() !== "#FFFFFF" ? (fill.color = old) : fill.clear());

// One row's highlight off (fix accepted and re-checked, or dismissed) or back on (Undo). Like Grammarly's underline.
// Only a cell still wearing our color, or its own untouched fill, is changed: a fill the user put on since stays.
export async function fillRow(i, on) {
  const p = state.painted, color = COLOR[state.lastRows[i]?.severity];
  if (!p || !(i in p.colors) || (on && !color)) return; // pane reopened since painting: nothing remembered
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(p.sheet);
    const cells = Object.entries(p.colors[i]).map(([j, old]) => [old, sheet.getRangeByIndexes(p.startRow + 1 + i, p.startCol + +j, 1, 1).format.fill.load("color")]);
    await ctx.sync();
    for (const [old, fill] of cells) {
      const now = String(fill.color).toUpperCase();
      if (!on && ours(now)) put(fill, old);
      if (on && (ours(now) || now === String(old).toUpperCase())) fill.color = color;
    }
    await ctx.sync();
  });
}

// No record of what was painted (the pane was reopened): clear every cell wearing one of our colors, which are one step
// off Excel's own Bad / Neutral / Note fills so the user's styled cells are never taken for ours. Before AH-40 we
// painted whole table rows in Excel's very colors: a row that starts with one, across its full width, was ours too
export async function clearOurColors() {
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getActiveWorksheet();
    const used = sheet.getUsedRangeOrNullObject().load("rowIndex, columnIndex, rowCount, columnCount");
    await ctx.sync();
    if (used.isNullObject) return;
    const { rowIndex: r0, columnIndex: c0, rowCount: total, columnCount: w } = used;
    const old = new Set(OLD_COLOR);
    const step = Math.max(1, Math.floor(READ_CELLS / w));
    for (let k = 0; k < total; k += step) {
      busy(`Removing highlights… ${Math.round((100 * k) / total)}%`, k / total);
      const props = sheet.getRangeByIndexes(r0 + k, c0, Math.min(step, total - k), w).getCellProperties({ format: { fill: { color: true } } });
      await ctx.sync();
      let queued = 0;
      for (const [m, row] of props.value.entries()) {
        const colors = row.map((c) => String(c.format.fill.color).toUpperCase());
        if (old.has(colors[0]) && colors.every((c) => c === colors[0])) { // a whole row painted before AH-40
          sheet.getRangeByIndexes(r0 + k + m, c0, 1, w).format.fill.clear();
          if (++queued % CHUNK === 0) await ctx.sync();
          continue;
        }
        for (const [j, c] of colors.entries()) {
          if (!ours(c)) continue;
          sheet.getRangeByIndexes(r0 + k + m, c0 + j, 1, 1).format.fill.clear();
          if (++queued % CHUNK === 0) await ctx.sync();
        }
      }
      await ctx.sync();
    }
  });
}

export async function clearHighlights() {
  if (state.painted) await unpaint();
  else await clearOurColors();
  notice("Highlights removed. Your data was not changed.");
}
