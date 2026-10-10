import { EXCEL_ERRORS } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { $ } from "../utils/dom.js";
import { cellAt, colLetter, sameRow } from "../utils/sheet.js";
import { median } from "../utils/text.js";
import { setApplied } from "../components/fix-preview.js";
import { busy } from "../components/progress.js";
import { post } from "../services/api.js";
import { readCells, readRows, writeCells } from "../services/excel.js";
import { fillRow } from "./highlight.js";
import { plainReason } from "./scan.js";

// Fix one row: the instant suggested fix (no AI), and Apply / Undo.
// Pure: a reason -> its parts ("Units weird limit is 0; this is -5" stays ONE part)
export function issuesOf(reason) {
  const parts = String(reason || "").replace(/^Flagged by \d+ of \d+: /, "").split("; ").filter(Boolean);
  return parts.reduce((a, p) => (/^this is /.test(p) && a.length ? (a[a.length - 1] += "; " + p) : a.push(p), a), []).map((text) => ({ text }));
}

// Pure: how a typo turned `fix` into `v`, in words: "extra zeros", "missing zeros", "sign flipped"
export function typoKind(v, fix) {
  if (v === -fix) return "sign flipped";
  const k = Math.round(Math.log10(Math.abs(v / fix)));
  return `${k > 0 ? "extra" : "missing"} zeros - ${k > 0 ? "x" : "÷"}${10 ** Math.abs(k)}`;
}

// Pure: do the positive numbers span more than 10x between their 5th and 95th percentile? (claims, deal sizes)
export function spansDecade(xs) {
  const v = xs.filter((x) => typeof x === "number" && x > 0).sort((a, b) => a - b);
  return v.length >= 10 && v[Math.floor(0.95 * (v.length - 1))] > 10 * v[Math.floor(0.05 * (v.length - 1))];
}

// Pure: instant fix for a flagged row, no AI. A number past its weird limits, or a blank in a mostly-filled
// number column -> the median of the OTHER rows' values in that column, written as a plain number (a formula
// over the column could loop back through a totals row = circular reference). Anything else -> advice only.
// limits = {col: [baseLo, baseHi, weirdLo, weirdHi]}.
// calc = this row's formulas: a cell holding a formula is never overwritten - its inputs are what's wrong.
export function recommendFix(columns, rows, i, limits, reason, startRow, startCol, likely, calc, maybe) {
  const row = startRow + 2 + i;
  const changes = [], why = [], typos = [], real = [], calcCells = [], seen = new Set(); // seen: columns already explained
  let guessed = false; // a misspelling's fix is a guess too
  reason = reason || "";
  columns.forEach((c, j) => {
    const v = rows[i][j], cell = `${colLetter(startCol + j)}${row}`;
    const lim = limits && limits[c], lo = lim && lim[2], hi = lim && lim[3];
    const variant = likely && typeof likely[c] === "string" && typeof v === "string"; // "sales" where the column says "Sales"
    const miss = !variant && maybe && typeof maybe[c] === "string" && typeof v === "string"; // "Pencl" where it says "Pencil"
    const blank = !!lim && (v === "" || v === null) && reason.includes(`Blank cell in column ${c},`);
    // only a value the engine flagged: it never votes on a regular repeated value (a 5.76 toll), so neither do we
    const outside = !!lim && typeof v === "number" && ((lo != null && v < lo) || (hi != null && v > hi)) && reason.includes(`${c} weird limit is`);
    if (!(variant || miss || blank || outside)) return;
    seen.add(c);
    if (calc && String(calc[j]).startsWith("=")) return void calcCells.push(cell); // never type over a formula
    if (variant) {
      changes.push({ cell, new: likely[c] });
      return void typos.push(`${c} says "${v}" where the rest of the column says "${likely[c]}" - same word, different capitals/spaces`);
    }
    if (miss) {
      changes.push({ cell, new: maybe[c] });
      guessed = true;
      return void typos.push(`${c} says "${v}" - probably a misspelling of "${maybe[c]}", one letter off`);
    }
    const typo = likely && likely[c];
    if (typo != null && outside) { // engine spotted an obvious typo: extra/missing zeros or a flipped sign
      changes.push({ cell, new: String(typo) });
      return void typos.push(`${c} is ${v} - looks like a typo for ${typo} (${typoKind(v, typo)})`);
    }
    const others = rows.filter((_, k) => k !== i).map((r) => r[j]);
    if (outside && spansDecade(others)) // wide column (claims, deal sizes): a huge value can be real - don't overwrite it
      return void real.push(`${c} is ${v}, far outside its usual range - but ${c} naturally varies more than 10x, so this may be real`);
    const med = median(others);
    if (med === null) return void seen.delete(c);
    changes.push({ cell, new: String(+med.toPrecision(10)) });
    why.push(blank ? `${c} is blank` : `${c} is ${v}, outside its limits (${lo ?? "no low"} to ${hi ?? "no high"})`);
  });
  const notes = [];
  if (calcCells.length) notes.push(`${calcCells.join(", ")} ${calcCells.length > 1 ? "are" : "is"} calculated by a formula - ` +
    "fix the cells it uses rather than typing over it.");
  if (typos.length) notes.push(`${typos.join("; ")}. Check it against the source before applying.`);
  if (real.length) notes.push(`${real.join("; ")}. Check it against the source; if it's right, leave it.`);
  if (why.length) {
    const how = why.length > 1 ? "them each with the median of the rest of its column" : "it with the median of the rest of the column";
    notes.push(`${why.join("; ")}. Replace ${how} - a typical value that ignores outliers.`);
  }
  const dup = /Duplicate of row (\d+)/.exec(reason); // engine counts from a header in row 1
  if (dup) notes.push(`This row repeats row ${+dup[1] + startRow}. If it's a double entry, delete it: right-click the row number > Delete.`);
  for (const [, raw, kind, col] of reason.matchAll(/Text "([^"]*)" in (number|date) column ([^;]+)/g))
    notes.push(`${col} holds the text "${raw}" where a ${kind} belongs - retype it as a ${kind}.`);
  for (const [, raw, col] of reason.matchAll(/Placeholder "([^"]*)" in column ([^;]+)/g))
    notes.push(`${col} says "${raw}" - a stand-in for a missing value. Fill in the real value, or leave the cell empty.`);
  // a limit crossed in a cell typed as text ("$1,000,000.00"): explained, never overwritten
  for (const { text } of issuesOf(reason, columns)) { // anything the loop above didn't explain (text cells, no limits)
    const m = /^(.+?) weird limit is (\S+); this is (\S+)/.exec(text), b = /^Blank cell in column (.+?), which/.exec(text);
    if (m && !seen.has(m[1])) notes.push(`${m[1]} is ${m[3]}, past its limit of ${m[2]}. Check it against the source; if it's right, leave it.`);
    if (b && !seen.has(b[1])) notes.push(`${b[1]} is blank where the rest of the column is filled - fill it in from the source.`);
  }
  for (const [, err, col] of reason.matchAll(/Excel error (#\S+) in ([^;]+)/g))
    notes.push(`${col} shows ${err}: ${EXCEL_ERRORS[err] || "its formula failed"}. Fix the formula or its inputs ` +
      `(or wrap it in IFERROR(...)) rather than typing a number over it.`);
  if (!notes.length)
    notes.push("Nothing here is clearly broken - the values are just unusual together. Check them against the source; if they're right, leave them.");
  return { explanation: notes.join(" "), changes, guess: why.length > 0 || guessed }; // guess = a median or a misspelling's fix
}

// Pure: the column an "only unusual" reason points at (an odd mix across columns, or a break in a series), else null
export function unusualColumn(reason, columns) {
  for (const { text } of issuesOf(reason)) {
    const m = /^Unusual combination of values, mainly (.+)$/.exec(text) || /^(.+?) (?:is unusual relative to its local trend|jumped sharply)/.exec(text);
    if (m && columns.includes(m[1])) return m[1];
  }
  return null;
}

// A row that is only unusual gets no instant fix. Agent 3 hunts for the one typing slip (digits swapped, extra digit,
// decimal point, sign) that makes the row normal again; none or two = the advice stays, nothing is guessed.
export async function suggestTypo(f, r, rec) {
  const { columns, rows, startRow, startCol } = state.lastScan;
  const col = unusualColumn(r.reason, columns), j = columns.indexOf(col);
  if (rec.changes.length || !col || String(f.calc?.[j] ?? "").startsWith("=")) return rec;
  busy("Looking for a likely typo…");
  const s = await post("/suggest", { columns, rows, limits: state.lastLimits, strength: state.lastStrength, row_index: f.i, column: col });
  if (s.value === undefined) return rec;
  const v = rows[f.i][j];
  return { typo: true, guess: true, changes: [{ cell: `${colLetter(startCol + j)}${startRow + 2 + f.i}`, new: String(s.value) }],
    explanation: `Nothing here is clearly broken - the values are just unusual together. But ${col} ${v} could be a typo for ` +
      `${s.value} (${s.kind}): with ${s.value} the whole row looks normal again. If ${v} is right, click Dismiss.` };
}

export const typed = (v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : v); // "90" lands in Excel as 90

// Pure: a row as it should look after a fix: the scanned row with the fix's cells (those in sheet row rowNum) typed in.
// Undo auto-fixes compares the sheet to this, so after a sort it never writes the old value into a different record.
export const afterFix = (row, changes, startCol, rowNum) => changes.reduce((r, c) => {
  const at = cellAt(c.cell);
  if (at.row === rowNum) r[at.col - startCol] = typed(c.new);
  return r;
}, [...row]);

// Agent 3 (in the engine): would these changes make row f.i look right? The engine scans the whole table again with
// the first scan's limits. -> {clean, severity, reason}, or null when it can't be judged yet (a formula, a cell off the row).
export async function checkFix(f, changes) {
  const { columns, rows, startRow, startCol } = state.lastScan;
  const at = changes.map((c) => ({ ...cellAt(c.cell), value: typed(c.new) }));
  const off = (a) => a.row !== startRow + 2 + f.i || a.col < startCol || a.col >= startCol + columns.length || String(a.value).startsWith("=");
  if (!at.length || at.some(off)) return null;
  return post("/check", { columns, rows, limits: state.lastLimits, strength: state.lastStrength, row_index: f.i,
    changes: at.map((a) => ({ col: a.col - startCol, value: a.value })) });
}

export async function applyFix(f, changes, sheet) { // the fix, its changes and sheet as they were when Accept was clicked
  if (state.undos[f.i]) return;
  $("fix-apply").disabled = true;
  const status = (t) => state.fix === f && ($("fix-status").textContent = t);
  try {
    // the scan's addresses are only right while the rows are where the scan saw them: never write into a moved row
    const { startRow, startCol, columns, rows } = state.lastScan;
    const ks = [...new Set(changes.map((c) => cellAt(c.cell).row - startRow - 2))].filter((k) => rows[k]);
    const now = await readRows(sheet, ks.map((k) => ({ row: startRow + 1 + k, col: startCol, width: columns.length })));
    const moved = ks.find((k, m) => !sameRow(now[m].values, rows[k], now[m].calc));
    if (moved !== undefined) // an answer, not a failure: say so on the card, write nothing
      return status(`Nothing written: row ${startRow + moved + 2} changed since the scan (edited, sorted or rows added). Click Find problems, then try again.`);
    const cells = changes.map((c) => c.cell);
    const olds = await readCells(sheet, cells), formats = await readCells(sheet, cells, "numberFormat");
    await writeCells(sheet, changes.map((c) => ({ cell: c.cell, value: c.new })));
    const after = await readCells(sheet, cells); // exactly what Excel made of it ("12%" -> 0.12): Undo checks against this
    // all read before any write; the cells (with their number formats), the row and its verdict as they were, for Undo
    state.undos[f.i] = { sheet, changes, after, writes: cells.map((cell, k) => ({ cell, value: olds[k], format: formats[k] })),
      row: state.lastScan.rows[f.i], verdict: state.lastRows[f.i], wasHandled: state.handled.has(f.i) }; // dismissed: stays so
    state.handled.add(f.i);
    if (state.fix === f) setApplied(true);
  } catch (e) {
    if (state.fix === f) $("fix-apply").disabled = false;
    status("Accept failed: " + e.message);
    throw e;
  }
  status("Accepted. Checking the row again…");
  let v;
  try {
    v = await checkFix(f, changes);
  } catch (e) {
    return status(`Accepted. Couldn't check it again (${e.message}) - click Find problems to check the sheet.`);
  }
  if (!v) return status("Accepted. A formula is checked when you click Find problems again.");
  const { startRow, startCol } = state.lastScan, row = [...state.lastScan.rows[f.i]];
  changes.forEach((c) => (row[cellAt(c.cell).col - startCol] = typed(c.new)));
  state.lastScan.rows[f.i] = row; // later checks and fixes see the fixed row
  state.lastRows[f.i] = { ...state.lastRows[f.i], severity: v.severity, reason: v.reason };
  await fillRow(f.i, !v.clean); // fixed: highlight off. Still odd: recolored by its new severity
  status(v.clean ? `Accepted and checked again: row ${startRow + f.i + 2} looks right now.`
    : `Accepted, but the checker still sees a problem: ${plainReason(v.reason)}. Undo it, or describe a better fix to AI.`);
}

export async function undoFix(f) {
  const u = state.undos[f.i];
  if (!u) return;
  try {
    // Undo only types into the same record it fixed: the row's other cells must still be what the scan read (a sort or
    // an inserted row moves another record under these addresses), and each fixed cell must still hold exactly what
    // Excel made of the fix - a cell edited by hand since is the user's now
    const { startRow, startCol, columns } = state.lastScan, rowNum = startRow + 2 + f.i;
    const [row] = await readRows(u.sheet, [{ row: rowNum - 1, col: startCol, width: columns.length }]);
    const now = await readCells(u.sheet, u.writes.map((w) => w.cell));
    const edited = u.writes.filter((w, k) => now[k] !== u.after[k]).map((w) => w.cell);
    const say = (t) => void (state.fix === f && ($("fix-status").textContent = t)); // an answer, not a failure
    const fixedHere = row.calc.map((calc, j) => calc || u.changes.some((c) => cellAt(c.cell).row === rowNum && cellAt(c.cell).col === startCol + j));
    if (!sameRow(row.values, u.row, fixedHere))
      return say(`Undo left the sheet alone: row ${rowNum} changed after the fix (edited, sorted or rows added).`);
    if (edited.length) return say(`${edited.join(", ")} changed after the fix, so Undo left the row alone.`);
    await writeCells(u.sheet, u.writes); // back on the sheet it was applied to
    delete state.undos[f.i];
    state.lastScan.rows[f.i] = u.row;
    state.lastRows[f.i] = u.verdict;
    if (!u.wasHandled) state.handled.delete(f.i);
    await fillRow(f.i, !u.wasHandled); // flagged again - unless it had been dismissed, then it stays unhighlighted
    if (state.fix === f) {
      setApplied(false);
      $("fix-status").textContent = "Undone - the cells are back to what they were.";
    }
  } catch (e) {
    if (state.fix === f) $("fix-status").textContent = "Undo failed: " + e.message;
    throw e;
  }
}
