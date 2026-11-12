import { ACCEPT_UNDO_KEY } from "../constants/index.js";
import { A1, cellAt, readAs, typedAsFormula } from "../utils/sheet.js";

// Accept's Undo outlives the pane (AH-118). Auto-fix kept its old values in the workbook, but an accepted fix kept them
// only in the pane's memory (state.undos), so closing or reloading the pane lost the user's old values for good. Each
// accepted fix is kept here under the fixed row's code, the code the next scan gives that row (features/decisions.js):
// a scan finds it again and the card offers Undo, as it did right after the Accept.
// [{sheet, code, before, was, cells: [[cell, old value, old number format, new as typed, what Excel made of it]]}],
// newest last. Document settings hold about 2 MB per add-in, shared with the decisions: at most MAX_UNDOS records,
// each at most MAX_CHARS long once written (a long text cell's fix is undone in this session only).
export const MAX_UNDOS = 50;
export const MAX_CHARS = 4000;
const CODE = /^[0-9a-z]{1,11}\.\d{1,7}$/;
const WAS = new Set([null, "fixed", "dismissed"]);
export const plain = (v) => typeof v === "number" ? Number.isFinite(v) : typeof v === "string" || typeof v === "boolean";
const fits = (r) => JSON.stringify(r).length <= MAX_CHARS;

// Pure: one cell as kept -> the same, or null. A crafted .xlsx can carry anything here: only plain values, only into a
// plain A1 cell, never an old value Excel would read as a formula (Undo types it back in)
const asCell = (c) => Array.isArray(c) && c.length === 5 && A1.test(String(c[0])) && plain(c[1]) && !typedAsFormula(c[1])
  && typeof c[2] === "string" && c[2].length <= 255 && plain(c[3]) && plain(c[4]) ? [...c] : null;

// Pure: whatever the workbook holds -> clean records. Null-prototype objects, so no key a workbook names reaches a prototype
export function asUndos(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const r of v.slice(-MAX_UNDOS)) {
    if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.sheet !== "string" || !CODE.test(String(r.code))
      || !CODE.test(String(r.before)) || !WAS.has(r.was ?? null) || !Array.isArray(r.cells) || !r.cells.length) continue;
    const cells = r.cells.map(asCell);
    if (cells.includes(null)) continue;
    const rec = Object.assign(Object.create(null), { sheet: r.sheet, code: r.code, before: r.before, was: r.was ?? null, cells });
    if (fits(rec)) out.push(rec);
  }
  return out;
}

// Pure: the records with this one kept (newest, replacing one for the same row), capped; a record too big stays out
export const keepUndo = (list, rec) => [...dropUndo(list, rec.sheet, rec.code), ...(fits(rec) ? [rec] : [])].slice(-MAX_UNDOS);
export const dropUndo = (list, sheet, code) => list.filter((r) => !(r.sheet === sheet && r.code === code));

// Pure: the pane's Undo record (fix.js applyFix) -> what the workbook keeps, or null when an old value is a formula
// (only this session's memory may type a formula back in)
export function undoRecord(u) {
  const cells = u.writes.map((w, k) => [w.cell, w.value, w.format ?? "General", u.changes[k]?.new, u.after[k]]);
  const rec = Object.assign(Object.create(null), { sheet: u.sheet, code: u.code, before: u.before, was: u.was ?? null, cells });
  return asUndos([rec]).length ? rec : null;
}

const settings = () => Office.context.document.settings;
const kept = () => asUndos(settings().get(ACCEPT_UNDO_KEY));
const save = (list) => {
  if (list.length) settings().set(ACCEPT_UNDO_KEY, list);
  else settings().remove(ACCEPT_UNDO_KEY);
  settings().saveAsync();
};

export function saveUndo(u) {
  const rec = undoRecord(u);
  save(rec ? keepUndo(kept(), rec) : dropUndo(kept(), u.sheet, u.code));
}

export const forgetUndo = (sheet, code) => save(dropUndo(kept(), sheet, code));

// After a scan: the Undo records of rows that are still the rows they fixed and still where the fix was written ->
// {row index: Undo record as fix.js keeps it}. A row sorted elsewhere since keeps its record but offers no Undo: its
// cells' addresses would name another record
export function undosFor(scan, codes) {
  const out = {}, at = new Map(codes.map((c, i) => [c, i]));
  for (const r of kept()) {
    const i = at.get(r.code);
    if (r.sheet !== scan.sheet || i === undefined) continue;
    const spots = r.cells.map(([cell]) => cellAt(cell));
    if (spots.some((p) => p.row !== scan.startRow + 2 + i || p.col < scan.startCol || p.col >= scan.startCol + scan.columns.length)) continue;
    const row = [...scan.rows[i]]; // the row as it was before the fix: the scanned row with the old values back
    spots.forEach((p, k) => (row[p.col - scan.startCol] = readAs([r.cells[k][1]], [scan.dates?.[p.col - scan.startCol]])[0]));
    out[i] = { sheet: r.sheet, code: r.code, before: r.before, was: r.was || undefined, row, verdict: null,
      changes: r.cells.map(([cell, , , nw]) => ({ cell, new: nw })), after: r.cells.map((c) => c[4]),
      writes: r.cells.map(([cell, value, format]) => ({ cell, value, format })) };
  }
  return out;
}
