import { AUTO_KEY, UNDO_KEY } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { cellAt, colLetter, sameRow } from "../utils/sheet.js";
import { readCells, readRows, writeCells } from "../services/excel.js";
import { afterFix } from "./fix.js";

// Step 3: fix exact mistakes by itself. Exact = a capitals/spaces slip ("east " for "East") where the usual spelling
// is 5x as common - never a number, a median, a typo guess or a misspelling, never a formula cell. Off by default
// (this PC only). Undo is kept in the workbook, so closing the pane doesn't lose it.
export const autoOn = () => { try { return localStorage.getItem(AUTO_KEY) === "1"; } catch { return false; } };
export const setAuto = (on) => { try { localStorage.setItem(AUTO_KEY, on ? "1" : "0"); } catch { /* private mode: stays off */ } };

const settings = () => Office.context.document.settings;
export const autoUndo = () => settings().get(UNDO_KEY) || null;

// Pure: the scan's verdicts -> [{k, j, value}], one per exact fix (k = data row, j = column)
export const exactFixes = (rows, columns) => rows.flatMap((r, k) =>
  Object.entries(r?.exact || {}).map(([c, value]) => ({ k, j: columns.indexOf(c), value }))).filter((x) => x.j >= 0);

// Right after a scan: write the exact fixes -> how many were written
export async function autoFix() {
  const { columns, rows, startRow, startCol, sheet } = state.lastScan;
  const fixes = exactFixes(state.lastRows, columns);
  if (!fixes.length) return 0;
  const cells = fixes.map((x) => `${colLetter(startCol + x.j)}${startRow + 2 + x.k}`);
  const olds = await readCells(sheet, cells);
  // only rows still where the scan saw them (the sheet stays editable during a long scan: a sort moves records)
  const now = await readRows(sheet, fixes.map((x) => ({ row: startRow + 1 + x.k, col: startCol, width: columns.length })));
  const writes = fixes.map((x, m) => ({ cell: cells[m], old: olds[m], value: x.value }))
    .filter((w, m) => sameRow(now[m].values, rows[fixes[m].k], now[m].calc) && !String(w.old).startsWith("="));
  if (!writes.length) return 0;
  const typedIn = writes.map((w) => ({ cell: w.cell, new: w.value }));
  writes.forEach((w) => { // the whole row as auto-fix leaves it: Undo checks it is still the same record (sorts move rows)
    const r = cellAt(w.cell).row;
    Object.assign(w, { row: r - 1, col: startCol, expect: afterFix(rows[r - startRow - 2], typedIn, startCol, r) });
  });
  await writeCells(sheet, writes.map((w) => ({ cell: w.cell, value: w.value })));
  const prev = autoUndo(); // ponytail: Undo covers this sheet's auto-fixes; auto-fixing another sheet keeps only that one's
  settings().set(UNDO_KEY, { sheet, writes: [...(prev?.sheet === sheet ? prev.writes : []), ...writes] });
  settings().saveAsync();
  return writes.length;
}

// The undo record lives in the workbook, so a crafted .xlsx can carry its own: only plain values go back, only into a
// plain A1 cell (2026-10-15 audit). A real record never holds a formula - autoFix skips formula cells.
const A1 = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;
const typedAsFormula = (v) => typeof v === "string" && /^[=+\-@＝＋－＠\t\r]/.test(v) && !/^[+\-]?\d[\d.,]*$/.test(v);
export const safeUndo = (writes) => writes.filter((w) => A1.test(String(w?.cell)) && !typedAsFormula(w.old));

// Put the auto-fixed cells back - only where the row still looks as auto-fix left it (same record, not edited since)
// -> [put back, left alone]
export async function undoAutoFix() {
  const u = autoUndo();
  if (!u) return [0, 0];
  const now = await readRows(u.sheet, u.writes.map((w) => ({ row: w.row, col: w.col, width: w.expect.length })));
  const back = safeUndo(u.writes.filter((w, m) => sameRow(now[m].values, w.expect, now[m].calc)));
  await writeCells(u.sheet, back.map((w) => ({ cell: w.cell, value: w.old })));
  settings().remove(UNDO_KEY);
  settings().saveAsync();
  return [back.length, u.writes.length - back.length];
}
