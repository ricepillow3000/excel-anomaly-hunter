import { EXCEL_ERRORS } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { $, show } from "../utils/dom.js";
import { cellAt, colLetter, r1c1ToA1, readAs, sameRow, typedAsFormula } from "../utils/sheet.js";
import { setApplied } from "../components/fix-preview.js";
import { busy } from "../components/progress.js";
import { post } from "../services/api.js";
import { readCells, readRows, writeCells } from "../services/excel.js";
import { fillRow } from "./highlight.js";
import { plainReason } from "./scan.js";
import { codeAt, rowHash, saveDecisions } from "./decisions.js";
import { isOurs, plainError } from "../utils/errors.js";
import { forgetUndo, saveUndo } from "./undo-store.js";
import { forget, remember } from "./memory.js";

// Fix one row: the instant suggested fix (no AI), and Apply / Undo.
// Pure: a reason -> its parts ("Units weird limit is 0; this is -5" stays ONE part)
export function issuesOf(reason) {
  const parts = String(reason || "").replace(/^Flagged by \d+ of \d+: /, "").split("; ").filter(Boolean);
  return parts.reduce((a, p) => (/^this is /.test(p) && a.length ? (a[a.length - 1] += "; " + p) : a.push(p), a), []).map((text) => ({ text }));
}

// Pure: how a typo turned `fix` into `v`, in words: "extra zeros", "missing zeros", "sign flipped"
export function typoKind(v, fix) {
  if (v * fix < 0) return "sign flipped"; // the engine's fix is one slip: a sign or zeros, never both
  const k = Math.round(Math.log10(Math.abs(v / fix)));
  return `${k > 0 ? "extra" : "missing"} zeros, ${k > 0 ? "x" : "÷"}${10 ** Math.abs(k)}`;
}

// Pure: the reason's "Total 170.43 does not add up: Units × UnitCost = -14.95" parts -> [{text, total, rule, cols}]
const addUps = (reason) => String(reason || "").replace(/^Flagged by \d+ of \d+: /, "").split("; ")
  .map((s) => /^(.+) (\S+) does not add up: ((.+?) [×+] (.+)) = \S+$/.exec(s)).filter(Boolean)
  .map((m) => ({ text: m[0], total: `${m[1]} ${m[2]}`, rule: m[3], cols: [m[1], m[4], m[5]] }));

// Pure: instant fix for a flagged row, no AI. A cell is written only when its value is known: an obvious typo the engine
// spotted, the row's own arithmetic, the column's usual spelling. Never a median: on 40 real sheets (2026-10-16) the
// median card filled 17,000 cells that were blank on purpose and overwrote real values (169 delegates -> 39); 3 of
// ~24 bench medians happened to land near the truth. A blank or an unexplained extreme value gets advice only.
// limits = {col: [baseLo, baseHi, weirdLo, weirdHi]}.
// calc = this row's formulas: a cell holding a formula is never overwritten - its inputs are what's wrong.
// formula = {column: R1C1}: the column's own formula for a cell that broke it (AH-152), written back ahead of anything else.
export function recommendFix(columns, rows, i, limits, reason, startRow, startCol, likely, calc, maybe, formula) {
  const row = startRow + 2 + i;
  const changes = [], typos = [], slips = [], calcCells = [], seen = new Set(); // seen: columns already explained
  let guessed = false; // a misspelling's fix is a guess too
  reason = reason || "";
  const sums = addUps(reason), solved = new Set(); // solved: columns the row's own arithmetic fixed
  columns.forEach((c, j) => {
    const v = rows[i][j], cell = `${colLetter(startCol + j)}${row}`;
    if (typeof formula?.[c] === "string") { // known from the column, so it beats the "does not add up" number (AH-152)
      seen.add(c), solved.add(c);
      return void changes.push({ cell, new: r1c1ToA1(formula[c], row, startCol + j), r1c1: formula[c] });
    }
    const lim = limits && limits[c], lo = lim && lim[2], hi = lim && lim[3];
    const past = (a, b) => typeof v === "number" && ((a != null && v < a) || (b != null && v > b));
    // AH-160: never a spelling Excel would read as a formula (a full-width ＝ is =): the engine once offered one
    const variant = likely && typeof likely[c] === "string" && typeof v === "string" && !typedAsFormula(likely[c]); // "sales" where the column says "Sales"
    const miss = !variant && maybe && typeof maybe[c] === "string" && typeof v === "string" && !typedAsFormula(maybe[c]); // "Pencl" where it says "Pencil"
    // a typo the numbers cannot prove (a value too small, a tenth among small whole numbers): offered only where the
    // engine's own limit sentence says "(maybe 2)", as a guess the user confirms, never "likely" (AH-21)
    const weak = typeof v === "number" && maybe && typeof maybe[c] === "number"
      && issuesOf(reason).some(({ text }) => text.startsWith(`${c} weird limit is`) && text.includes(" (maybe "));
    const blank = !!lim && (v === "" || v === null) && reason.includes(`Blank cell in column ${c},`);
    // only a value the engine flagged: it never votes on a regular repeated value (a 5.76 toll), so neither do we
    // or past the usual limit with the engine's exact typo behind it: a lone x10 in a skewed column (wide weird limit)
    const outside = !!lim && reason.includes(`${c} weird limit is`) && (past(lo, hi) || (likely && likely[c] != null && past(lim[0], lim[1])));
    // the engine solved this cell from a total that doesn't add up (Total ÷ UnitCost): exact, not a median. A sign flip
    // is the engine's typo, kept over the arithmetic where the rule holds with it within its rounding: "the row's own
    // numbers say 3314.28" was untrue beside Clicks × CPC = 3314.7 (AH-128)
    const sum = typeof v === "number" && likely && likely[c] != null && likely[c] !== -v ? sums.find((s) => s.cols.includes(c)) : null;
    if (!(variant || miss || weak || blank || outside || sum)) return;
    seen.add(c);
    if (calc && String(calc[j]).startsWith("=")) return void calcCells.push(cell); // never type over a formula
    if (variant) {
      changes.push({ cell, new: likely[c] });
      return void typos.push(`${c} says "${v}" where the rest of the column says "${likely[c]}": same word, different capitals/spaces`);
    }
    if (miss) {
      changes.push({ cell, new: maybe[c] });
      guessed = true;
      const said = reason.includes(`"${v}" looks like a short form of`) ? `probably a short form of "${maybe[c]}"`
        : reason.includes(`"${v}" is lowercase where`) ? `lowercase where the column's other labels are capitalised ("${maybe[c]}")`
          : `probably a misspelling of "${maybe[c]}", one letter off`;
      return void typos.push(`${c} says "${v}", ${said}`);
    }
    if (weak) {
      changes.push({ cell, new: String(maybe[c]) });
      guessed = true;
      return void typos.push(`${c} is ${v}; it may be a typo for ${maybe[c]} (${typoKind(v, maybe[c])}), but a real value can look the same`);
    }
    const typo = likely && likely[c];
    if (sum) {
      changes.push({ cell, new: String(typo) });
      solved.add(c);
      return void typos.push(`${c} is ${v}, but the row's own numbers say ${typo} (${sum.total} = ${sum.rule})`);
    }
    if (typo != null && outside) { // engine spotted an obvious typo: extra/missing zeros or a flipped sign
      changes.push({ cell, new: String(typo) });
      if (sums.some((s) => s.cols.includes(c))) solved.add(c); // the flip is what makes the row add up
      slips.push({ c, kind: typoKind(v, typo), change: changes[changes.length - 1], text: `${c} is ${v}, which looks like a typo for ${typo} (${typoKind(v, typo)})` });
      return void typos.push(slips[slips.length - 1].text);
    }
    seen.delete(c); // no value known (a blank, an extreme value): the advice below says what to check
  });
  // one slip changes one cell: 2+ typed cells of a row off by the same factor say the row is real or in other units
  // (California's fruit, all three columns "likely /1000", added up exactly - real sheet, 2026-10-16)
  for (const kind of new Set(slips.map((s) => s.kind))) {
    const same = slips.filter((s) => s.kind === kind);
    if (same.length < 2) continue;
    same.forEach((s) => (changes.splice(changes.indexOf(s.change), 1), typos.splice(typos.indexOf(s.text), 1)));
    typos.push(`${same.map((s) => s.c).join(", ")} are all off by the same step (${kind}). One typing slip changes one cell, ` +
      "so this row is probably real or entered in other units");
  }
  const notes = [];
  if (calcCells.length) notes.push(`${calcCells.join(", ")} ${calcCells.length > 1 ? "are" : "is"} calculated by a formula. ` +
    "Fix the cells it uses rather than typing over it.");
  if (typos.length) notes.push(`${typos.join("; ")}. Check it against the original receipt, invoice or report before you click Accept.`);
  const dup = /Duplicate of row (\d+)/.exec(reason); // engine counts from a header in row 1
  // which copy is the stray one the sheet's order says, not the engine: 5 of 14 blind pairs had the copy first
  if (dup) notes.push(`This row repeats row ${+dup[1] + startRow} in every column. If one of them is a double entry, delete ` +
    "the one that's out of place in the sheet's order: right-click its row number > Delete.");
  for (const [, raw, kind, col] of reason.matchAll(/Text "([^"]*)" in (number|date) column ([^;]+)/g))
    notes.push(`${col} holds the text "${raw}" where a ${kind} belongs. Retype it as a ${kind}.`);
  for (const [, raw, col] of reason.matchAll(/Placeholder "([^"]*)" in column ([^;]+)/g))
    // "ERROR" is a status or a log level as often as a stand-in (AH-45 review: a log's rare ERROR level was called "a
    // stand-in for a missing value"), so its card says both
    notes.push(/^error$/i.test(raw.trim()) ? `${col} says "${raw}": a value of the column's own (a status, a log level) or a stand-in ` +
      "for a missing one. If it stands in, fill in the real value or leave the cell empty; if it is a real status, leave it."
      : `${col} says "${raw}", a stand-in for a missing value. Fill in the real value, or leave the cell empty.`);
  // a limit crossed in a cell typed as text ("$1,000,000.00"): explained, never overwritten
  for (const { text } of issuesOf(reason)) { // anything the loop above didn't explain (text cells, no limits)
    const m = /^(.+?) weird limit is (\S+); this is (\S+)/.exec(text), b = /^Blank cell in column (.+?), which/.exec(text);
    if (m && !seen.has(m[1])) notes.push(`${m[1]} is ${m[3]}, past its limit of ${m[2]}. Check it against the source; if it's right, leave it.`);
    // a long-format sheet's blank is judged inside its group (AH-16): "the rest of the column" would be untrue there
    const g = / otherwise filled for (.+)$/.exec(text);
    if (b && !seen.has(b[1])) notes.push(`${b[1]} is blank where the rest of ${g ? g[1] : "the column"} is filled. Fill it in from the source.`);
  }
  for (const [, err, col] of reason.matchAll(/Excel error (#\S+) in ([^;]+)/g))
    notes.push(`${col} shows ${err}: ${EXCEL_ERRORS[err] || "its formula failed"}. Fix the formula or its inputs ` +
      `(or wrap it in IFERROR(...)) rather than typing a number over it.`);
  for (const s of sums.filter((s) => !s.cols.some((c) => solved.has(c))))
    notes.push(`${s.text}, so one of these numbers is wrong. Check them against the source.`);
  for (const { text } of issuesOf(reason)) // worth-a-check reasons with no value to write: say what to look for
    for (const [rx, hint] of HINTS) {
      const m = rx.exec(text); // a hint may quote what the reason names: the word to filter the column for (AH-45 review)
      if (m) notes.push(`${text}: ${typeof hint === "function" ? hint(m) : hint}. Check it against the source.`);
    }
  if (!notes.length)
    notes.push("Nothing here is clearly broken, but the values are unusual together. Check them against the source; if they're right, leave them.");
  return { explanation: notes.join(" "), changes, guess: guessed }; // guess = a misspelling's fix, or a typo the numbers cannot prove
}

// a far-off date got "Nothing here is clearly broken" (12 of 12 on 40 real sheets, 2026-10-16)
const HINTS = [
  [/ is far outside the column's dates /, "a mistyped year (2084 for 2024) is the usual cause"],
  [/ looks like a code, not a real value/, 'a code like 99999 often stands for "missing": put the real value or leave the cell empty'],
  [/ is above 100% - /, "it may be a whole percent typed where a fraction belongs (85 for 0.85)"],
  [/ looks like an? .+ value$/, "it may have been typed into the wrong column"],
  [/ is not a whole number - /, "check the decimal point"],
  // AH-152: a typed value or another formula among a column's formulas; the card never says "fix the cells it uses"
  [/ is (?:a typed number|typed text) where the column's other rows use a formula$/, "a value typed over the column's formula " +
    "stays the same when its inputs change; Accept puts the column's formula back in this cell"],
  [/ uses a different formula from the other rows of its column$/, "a formula that differs from its neighbours often points " +
    "at the wrong row or cell; Accept puts the column's own formula in its place"],
  // AH-55: a Birth month of 13 and a share of 200 got "the values are just unusual together", the cross-column check's words
  [/ is outside what .+ can be \(-?[\d.]+ to -?[\d.]+\)$/, "its column's name allows no such value, so a typing slip is the usual cause"],
  [/ is over 100, and every other .+ is a share between 0 and 100$/, "a share of a whole over 100 is usually a slip (an extra digit, " +
    "a doubled value); if it is a real figure over 100, leave it"],
  // AH-29: a top value far above the rest got "the values are just unusual together", the cross-column check's words
  [/ stands alone above the rest of the column, whose next highest is /, "an extra zero or a slipped decimal point is the usual " +
    "cause, but one real record above all the others looks the same"],
  // AH-28: many blanks spread through a column, one note for them all
  [/ is blank in \d+ of \d+ rows, spread through the sheet$/, "blanks this many and this spread out are usually values not known or " +
    "not needed, not slips; if the column must always be filled, filter it for blanks and fill them in"],
  // AH-45 review: the cells hold the word, not blanks ("filter it for blanks" found none of R's NA or 300 "Unknown")
  [/ is "([^"]+)" \(no value\) in \d+ of \d+ rows$/, (m) => `a word written this often and this spread out is usually how the ` +
    `source says a value is not known, not a slip; if the column must always hold a value, filter it for "${m[1]}" and fill those in`],
  // AH-48: many identical rows through a sheet with no ID, one note for them all
  [/ rows repeat an earlier row exactly, all through the sheet - /, "this many, spread out, are usually separate real records " +
    "that happen to match (nothing like an ID tells them apart); if every row must be unique, check them, then use Data > Remove Duplicates"],
  // AH-56: an unfinished record, a survey's skipped question, and many blanks where a layout would fill the column
  [/ usually filled cells in this row are blank: an unfinished record/, "the rest of this record was never entered; fill it in " +
    "from the source, or delete the row if it is not a real record"],
  [/ is unanswered in \d+ of \d+ rows: a survey question a respondent may skip$/, "a blank answer is usually a question the " +
    "respondent chose to skip, not a slip; leave it blank unless the answer is known"],
  // AH-62: a negative code the column writes for "no value" (a survey's -1, a turbine table's -9999), one note for them all
  [/ (-\d+) is written \d+ times: the column's code for no value$/, (m) => `${m[1]} is how this sheet writes "no value" in this ` +
    `column, not a slip: these cells mean the value is not known; leave them, or turn them into blanks if your tool needs that`],
  [/ is blank in \d+ of \d+ rows where .+ would fill it, spread through the sheet$/, "blanks this many and this spread out are " +
    "usually values the source does not have, not slips; if the column must always be filled there, filter it for blanks and fill them in"],
  // AH-74: a value past its limit in a row whose own arithmetic holds - no single slip leaves a sum or a product right
  [/, but the row adds up \(.+\): worth a check$/, "the row's own numbers agree with this value, so a typing slip is " +
    "unlikely (one slip changes one cell and breaks the sum); it may be a real record or another unit. If the total is a formula of " +
    "these cells it follows any slip and proves nothing, so check this value at its source; if it is right, leave it"],
  // AH-76: a date typed in another form, a column of many forms, a number in a column of dates
  [/ is written .+ where .+ \(read as \d{4}-\d\d-\d\d\)$|: it could be \d{4}-\d\d-\d\d or \d{4}-\d\d-\d\d$/, "a date typed in " +
    "another form is read by guessing its day and month, and sorts and filters apart from the column's real dates; check " +
    "which day it is against the source, then type it as a real date"],
  [/ writes its dates in \d+ forms: /, "dates written several ways are read by guessing each one's day and month; check the " +
    "ones whose day and month could swap (03/04) against the source, then type them all as real dates"],
  [/ is a number in a column of dates \(an Excel date serial for (\d{4}-\d\d-\d\d)\?\)$/, (m) => `a date cell formatted as a ` +
    `number shows its serial; if ${m[1]} is the right day, format the cell as a date (Home > Number Format > Short Date)`],
  // AH-75: a digit code shorter than its column's width ("2134" among ZIPs "02134"): flagged, never padded for the user
  [/ is \d+ digits? where the column writes \d+: did it lose its leading zeros?\?$/, "a cell formatted as a number drops a " +
    "code's leading zeros; format the column as Text and retype the code as the source writes it"],
  // AH-46: a sort puts blank cells last - the block at the end is where the sort put them, not where they went missing
  [/ is blank in \d+ of \d+ rows, all at the end of the table, which is sorted by /, "sorting puts blank cells last, so these rows " +
    "have no value here; if the column must always be filled, fill them in from the source"],
];

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
    explanation: `Nothing here is clearly broken, but the values are unusual together. ${col} ${v} could be a typo for ` +
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
    changes: at.map((a) => ({ col: a.col - startCol, value: a.value })) }, 300); // a full re-scan: as long as /scan gets
}

// Pure: each cell an accepted fix wrote, as Ask AI's memory keeps it (AH-143): [header, old value, new value]
const remembered = (u, columns, startCol) => u.changes.map((c, k) => [columns[cellAt(c.cell).col - startCol], u.writes[k].value, c.new])
  .filter(([h]) => String(h ?? "").trim());

// AH-149 review: a failed Accept or Undo is said once, in the card's notice box (a hairline box and a square). It was
// said on the status line and, thrown on to act(), again in #notice; act() still puts the buttons back. The next try
// clears only this failure, never a helpline message (AH-125) that sits beside an Undo
function failed(f, e, lead) {
  const words = plainError(e, lead);
  if (state.fix !== f) return;
  $("fix-status").textContent = "";
  $("fix-care").textContent = f.failed = words;
  show("fix-care");
}
const tryAgain = (f) => $("fix-care").textContent === f.failed && show("fix-care", false);

export async function applyFix(f, changes, sheet) { // the fix, its changes and sheet as they were when Accept was clicked
  if (state.undos[f.i]) return;
  tryAgain(f);
  $("fix-apply").disabled = true;
  const status = (t, ok = false) => { if (state.fix === f) ($("fix-status").textContent = t), $("fix-status").classList.toggle("tick", ok); };
  // AH-149: said on the card at once, in the same frame as the press; what follows says what the sheet really holds
  status("Writing to your sheet…");
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
    await writeCells(sheet, changes.map((c) => ({ cell: c.cell, value: c.new, r1c1: c.r1c1 })));
    const after = await readCells(sheet, cells); // exactly what Excel made of it ("12%" -> 0.12): Undo checks against this
    // the row as the next scan will read it: its code is what "fixed" is kept under in the workbook
    const [fixed] = await readRows(sheet, [{ row: startRow + 1 + f.i, col: startCol, width: columns.length }]);
    const code = codeAt(state.hashes, f.i, rowHash(readAs(fixed.values, state.lastScan.dates)));
    // all read before any write; the cells (with their number formats), the row and its verdict as they were, for Undo
    state.undos[f.i] = { sheet, changes, after, writes: cells.map((cell, k) => ({ cell, value: olds[k], format: formats[k] })),
      row: state.lastScan.rows[f.i], verdict: state.lastRows[f.i], was: state.decided[f.i], code, before: state.codes[f.i] }; // dismissed: stays so
    saveUndo(state.undos[f.i]); // kept in the workbook too: a reload no longer loses the old values (AH-118)
    const parts = issuesOf(state.lastRows[f.i]?.reason).map((p) => p.text);
    for (const [h, old, nw] of remembered(state.undos[f.i], columns, startCol))
      remember(h, parts.find((t) => t.includes(String(h))) || "fix", old, nw);
    state.decided[f.i] = "fixed";
    saveDecisions(sheet, [[state.codes[f.i], null], [code, "fixed"]]); // an Accept after a Dismiss replaces it
    if (state.fix === f) setApplied(true);
  } catch (e) {
    if (state.fix === f) $("fix-apply").disabled = false;
    return failed(f, e, "Accept failed");
  }
  status("Accepted. Checking the row again…");
  let v;
  try {
    v = await checkFix(f, changes);
  } catch (e) {
    const why = isOurs(e) ? ` (${e.message})` : (console.error(e), ""); // never a script's own words on the card (AH-110)
    return status(`Accepted. Couldn't check it again${why}. Click Find problems to check the sheet.`);
  }
  if (!v) return status("Accepted. A formula is checked when you click Find problems again.");
  const { startRow, startCol } = state.lastScan, row = [...state.lastScan.rows[f.i]];
  changes.forEach((c) => (row[cellAt(c.cell).col - startCol] = typed(c.new)));
  state.lastScan.rows[f.i] = row; // later checks and fixes see the fixed row
  state.lastRows[f.i] = { ...state.lastRows[f.i], severity: v.severity, reason: v.reason };
  await fillRow(f.i, !v.clean); // fixed: highlight off. Still odd: recolored by its new severity
  status(v.clean ? `Accepted and checked again: row ${startRow + f.i + 2} looks right now.`
    : `Accepted, but the checker still sees a problem: ${plainReason(v.reason, undefined, "; ")}. Undo it, or describe a better fix to AI.`, v.clean);
}

export async function undoFix(f) {
  const u = state.undos[f.i];
  if (!u) return;
  if (state.fix === f) $("fix-status").classList.remove("tick");
  // AH-157: said on the card in the frame of the press, as Accept's "Writing to your sheet…"; what follows says what the
  // sheet really holds
  if (state.fix === f) $("fix-status").textContent = "Putting the old values back…";
  tryAgain(f);
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
    forgetUndo(u.sheet, u.code);
    for (const [h, old, nw] of remembered(u, columns, startCol)) forget(h, old, nw);
    // an Undo kept in the workbook (AH-118) carries no verdict (the engine's sentence about the old values stays out of
    // the file): the row as it is again is checked once more, the way an Accept is
    const v = u.verdict ? null : await checkFix(f, u.writes.map((w) => ({ cell: w.cell, new: w.value }))).catch(() => null);
    state.lastScan.rows[f.i] = u.row;
    state.lastRows[f.i] = u.verdict || (v ? { ...state.lastRows[f.i], severity: v.severity, reason: v.reason }
      : { ...state.lastRows[f.i], severity: "Low", reason: "Undo put the old values back. Click Find problems to check this row again" });
    if (u.was) state.decided[f.i] = u.was;
    else delete state.decided[f.i];
    const before = u.before || state.codes[f.i]; // after a re-scan the list knows this row by its fixed code
    saveDecisions(u.sheet, [[u.code, null], [before, u.was || null]]); // the fix's decision goes; a Dismiss before it comes back
    state.codes[f.i] = before;
    state.hashes[f.i] = before.slice(0, before.lastIndexOf("."));
    await fillRow(f.i, !u.was); // flagged again - unless it had been dismissed, then it stays unhighlighted
    if (state.fix === f) {
      setApplied(false);
      $("fix-status").textContent = "Undone. The cells are back to what they were.";
    }
  } catch (e) {
    failed(f, e, "Undo failed");
  }
}
