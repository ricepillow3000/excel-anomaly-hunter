import { KEY, READ_CELLS } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { maxCells, tableFromGrid } from "../utils/sheet.js";

// Talking to Excel (Office.js): read and write the sheet, workbook settings, clicks in the sheet.
export const getLimits = () =>
  new Promise((ok) => Office.context.document.settings.refreshAsync(() => ok(Office.context.document.settings.get(KEY) || null)));

export function saveLimits(limits) {
  if (limits) Office.context.document.settings.set(KEY, limits);
  else Office.context.document.settings.remove(KEY);
  Office.context.document.settings.saveAsync();
}

// Values only, in slices (formulas are read per row when a fix opens; number formats only for the top rows,
// where the header and first data row are). This was 3x the data in one call - the freeze on big sheets.
export async function readSheet(onSlice) {
  return Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getActiveWorksheet().load("name");
    const used = sheet.getUsedRange().load("rowIndex, columnIndex, rowCount, columnCount");
    await ctx.sync();
    const { rowIndex: r0, columnIndex: c0, columnCount: w } = used;
    const total = Math.min(used.rowCount, Math.floor(maxCells() / w));
    const top = sheet.getRangeByIndexes(r0, c0, Math.min(total, 12), w).load("numberFormat");
    const step = Math.max(1, Math.floor(READ_CELLS / w)), values = [];
    for (let k = 0; k < total; k += step) {
      const part = sheet.getRangeByIndexes(r0 + k, c0, Math.min(step, total - k), w).load("values");
      await ctx.sync();
      for (const row of part.values) values.push(row);
      onSlice(values.length / total);
    }
    await ctx.sync();
    const t = tableFromGrid(values, top.numberFormat, r0, c0, null);
    return t && { ...t, sheet: sheet.name, cut: total < used.rowCount && [r0 + total, r0 + used.rowCount] };
  });
}

export async function readCells(sheetName, cells) {
  return Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(sheetName);
    const ranges = cells.map((c) => sheet.getRange(c).load("formulas"));
    await ctx.sync();
    return ranges.map((r) => r.formulas[0][0]);
  });
}

// Writes as if typed: "=..." becomes a formula, "42" a number. Old contents kept for Undo.
export async function writeCells(sheetName, writes) {
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(sheetName);
    writes.forEach((w) => (sheet.getRange(w.cell).formulas = [[w.value]]));
    await ctx.sync();
  });
}

// Clicking a highlighted row in the sheet calls `handler` (only one watcher, on the last checked sheet).
export async function watchSelection(sheetName, handler) {
  if (state.picker && state.picker.sheet === sheetName) return;
  const old = state.picker;
  state.picker = null;
  if (old) await Excel.run(old.handle.context, async (ctx) => (old.handle.remove(), ctx.sync())).catch(() => {}); // old sheet gone: nothing to remove
  try {
    await Excel.run(async (ctx) => {
      const handle = ctx.workbook.worksheets.getItem(sheetName).onSelectionChanged.add(handler);
      await ctx.sync();
      state.picker = { sheet: sheetName, handle };
    });
  } catch (e) {
    console.error("could not watch selection", e); // list clicks still work
  }
}
