import { COLOR, CHUNK, READ_CELLS } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { n } from "../utils/text.js";
import { busy, notice } from "../components/progress.js";

// Highlight cells: color the flagged rows, CHUNK rows per Excel call. The old fill of each row is remembered,
// so Remove highlights puts back exactly what was there.
// ---- Highlights: color the flagged rows, CHUNK rows per Excel call. The old fill of each row is remembered,
// so Remove highlights puts back exactly what was there. ----
export async function paint(rows, s) {
  await unpaint();
  const flagged = rows.flatMap((r, i) => (COLOR[r.severity] ? [i] : []));
  const p = { sheet: s.sheet, startRow: s.startRow, startCol: s.startCol, width: s.columns.length, colors: {} };
  state.painted = p; // recorded before painting: a failure halfway still lets Remove highlights undo what got done
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(s.sheet);
    for (let k = 0; k < flagged.length; k += CHUNK) {
      busy(`Step 3 of 3: highlighting rows to check… ${n(k)} of ${n(flagged.length)}`, k / flagged.length);
      const part = flagged.slice(k, k + CHUNK);
      const ranges = part.map((i) => sheet.getRangeByIndexes(s.startRow + 1 + i, s.startCol, 1, p.width));
      const fills = ranges.map((r) => r.format.fill.load("color"));
      await ctx.sync();
      // a row whose cells have different fills reads as null: keep every cell's own color
      const mixed = part.flatMap((i, m) => (fills[m].color === null ? [[i, ranges[m].getCellProperties({ format: { fill: { color: true } } })]] : []));
      if (mixed.length) await ctx.sync();
      part.forEach((i, m) => (p.colors[i] = fills[m].color));
      mixed.forEach(([i, props]) => (p.colors[i] = props.value[0].map((c) => c.format.fill.color)));
      part.forEach((i, m) => (fills[m].color = COLOR[rows[i].severity]));
      await ctx.sync();
    }
  });
}

// Put back the remembered fills - only on rows still wearing one of OUR colors (a row the user recolored since
// is left alone).
export async function unpaint() {
  const p = state.painted;
  if (!p) return;
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItemOrNullObject(p.sheet).load("isNullObject");
    await ctx.sync();
    if (sheet.isNullObject) return; // that sheet was deleted: nothing left to restore
    const idx = Object.keys(p.colors).map(Number);
    const ours = new Set(Object.values(COLOR));
    for (let k = 0; k < idx.length; k += CHUNK) {
      busy(`Removing highlights… ${n(k)} of ${n(idx.length)}`, k / idx.length);
      const part = idx.slice(k, k + CHUNK);
      const fills = part.map((i) => sheet.getRangeByIndexes(p.startRow + 1 + i, p.startCol, 1, p.width).format.fill.load("color"));
      await ctx.sync();
      const put = (fill, old) => (old && String(old).toUpperCase() !== "#FFFFFF" ? (fill.color = old) : fill.clear());
      fills.forEach((fill, m) => {
        if (!ours.has(String(fill.color).toUpperCase())) return;
        const old = p.colors[part[m]];
        if (!Array.isArray(old)) return put(fill, old);
        old.forEach((c, j) => put(sheet.getRangeByIndexes(p.startRow + 1 + part[m], p.startCol + j, 1, 1).format.fill, c));
      });
      await ctx.sync();
    }
  });
  state.painted = null;
}

// No record of what was painted (the pane was reopened): on each row that starts with one of our three colors,
// clear just the cells in a row that wear it (what painting covered), never the user's own fills.
export async function clearOurColors() {
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getActiveWorksheet();
    const used = sheet.getUsedRangeOrNullObject().load("rowIndex, columnIndex, rowCount, columnCount");
    await ctx.sync();
    if (used.isNullObject) return;
    const { rowIndex: r0, columnIndex: c0, rowCount: total, columnCount: w } = used;
    const ours = new Set(Object.values(COLOR));
    const step = Math.max(1, Math.floor(READ_CELLS / w));
    for (let k = 0; k < total; k += step) {
      busy(`Removing highlights… ${Math.round((100 * k) / total)}%`, k / total);
      const props = sheet.getRangeByIndexes(r0 + k, c0, Math.min(step, total - k), w).getCellProperties({ format: { fill: { color: true } } });
      await ctx.sync();
      let queued = 0;
      for (const [m, row] of props.value.entries()) {
        const color = String(row[0].format.fill.color).toUpperCase();
        if (!ours.has(color)) continue;
        let run = 1;
        while (run < w && String(row[run].format.fill.color).toUpperCase() === color) run++;
        sheet.getRangeByIndexes(r0 + k + m, c0, 1, run).format.fill.clear();
        if (++queued % CHUNK === 0) await ctx.sync();
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
