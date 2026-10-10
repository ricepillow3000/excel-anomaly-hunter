// Pane pure-logic check, no Office/fetch. Run: node frontend/selfcheck.js
import assert from "node:assert";
import { esc, asNumber, median } from "./utils/text.js";
import { cutNote, tableFromGrid, isDateFormat, excelDate, rowFromAddress, colLetter, cellAt, sameRow } from "./utils/sheet.js";
import { issuesOf, recommendFix, typoKind, spansDecade, wrote, unusualColumn } from "./features/fix.js";
import { plainReason, summaryOf, flaggedRows } from "./features/scan.js";
import { strengthHint, asStrength } from "./pages/strength.js";
import { exactFixes } from "./features/autofix.js";

// summary: "Noted" (inside the usual range) is fine, not a problem
assert.equal(summaryOf([{ severity: null }, { severity: "Noted" }, { severity: null }]), "No problems found in 3 rows.");
assert.equal(summaryOf([{ severity: "High" }, { severity: "Low" }, ...Array(1998).fill({ severity: null })]), "1 of 2,000 rows look wrong. 1 more is worth a quick check.");
assert.equal(summaryOf([{ severity: "Low" }, { severity: "Low" }]), "Nothing clearly wrong in 2 rows. 2 are worth a quick check.");
assert.deepEqual(flaggedRows([{ severity: "Low", magnitude: 99 }, { severity: "Medium", magnitude: 1 }, { severity: "High", magnitude: 0 }]).map((r) => r.i), [2, 1, 0], "surest first, not biggest");

assert.equal(excelDate(45658), "2025-01-01");
assert.equal(excelDate(46028), "2026-01-06"); // first OrderDate of the Contextures practice sheet
assert.equal(excelDate(45658.5), "2025-01-01 12:00:00"); // a time of day is kept: two trips on one day are not duplicates
for (const f of ["m/d/yyyy", "yyyy-mm-dd", "[$-409]mmmm d, yyyy", "d-mmm"]) assert.ok(isDateFormat(f), f);
for (const f of ["General", "0.00", "$#,##0.00", "[Red]0.00", '0 "days"']) assert.ok(!isDateFormat(f), f);

// clicked cell -> data row (header in sheet row 1 -> startRow 0; first data row is sheet row 2 = index 0)
assert.equal(rowFromAddress("C2", 0), 0);
assert.equal(rowFromAddress("B7:D7", 0), 5, "several cells of one row");
assert.equal(rowFromAddress("C3:C40", 0), null, "dragging down a column is not a row click");
assert.equal(rowFromAddress("'My Sheet'!$C$7", 0), 5);
assert.equal(rowFromAddress("7:7", 0), 5, "whole row selected");
assert.equal(rowFromAddress("C8", 3), 3, "data starting lower down");
assert.equal(rowFromAddress("C1", 0), null, "header row");
assert.equal(rowFromAddress("B:B", 0), null, "whole column");

assert.equal(median([3, 1, "x", "", null, 2]), 2);
assert.equal(median([4, 1, 2, 3]), 2.5);
assert.equal(median(["a"]), null);
assert.deepEqual([0, 25, 26, 27, 701, 702].map(colLetter), ["A", "Z", "AA", "AB", "ZZ", "AAA"]);
for (const n of [0, 25, 26, 701, 702]) assert.deepEqual(cellAt(colLetter(n) + "12"), { col: n, row: 12 }, "cellAt undoes colLetter");
assert.equal(cellAt("=A1"), null);

// the row Excel holds now vs the row the scan read: a date comes back as a serial, floats may wobble; any edit fails
assert.ok(sameRow([46028, "East", 40, 0.1 + 0.2], ["2026-01-06", "East", 40, 0.3]));
assert.ok(!sameRow([46028, "East", 41, 0.3], ["2026-01-06", "East", 40, 0.3]), "an edited cell");
assert.ok(!sameRow([46029, "East", 40, 0.3], ["2026-01-06", "East", 40, 0.3]), "a different row slid in (sorted / inserted)");
// does a cell still hold what a fix typed? (Excel makes "90" a number and tidies formulas)
assert.ok(wrote(90, "90") && wrote("=AVERAGEIFS(C:C, B:B, \"East\")", "=averageifs(C:C,B:B,\"East\")") && wrote("", ""));
assert.ok(!wrote(91, "90") && !wrote("", "90"), "edited after the fix");
// the column an "only unusual" reason points at
const uc = ["Units", "Unit Cost", "Total"];
assert.equal(unusualColumn("Flagged by 1 of 3: Unusual combination of values, mainly Unit Cost", uc), "Unit Cost");
assert.equal(unusualColumn("Flagged by 2 of 3: Units is unusual relative to its local trend near 2026-06-25", uc), "Units");
assert.equal(unusualColumn("Flagged by 1 of 3: Total jumped sharply near 2026-06-25", uc), "Total");
assert.equal(unusualColumn("Duplicate of row 2", uc), null);

// the slider: every level has words; a missing or broken saved value is 5
assert.ok([...Array(11).keys()].every((s) => strengthHint(s).length > 10));
assert.ok(strengthHint(0).startsWith("Basics") && strengthHint(5).startsWith("Recommended") && strengthHint(10).startsWith("Strictest"));
assert.deepEqual([0, 10, 7, undefined, null, "3", 11, -1, 2.5].map(asStrength), [0, 10, 7, 5, 5, 5, 5, 5, 5]);
// a misspelling's fix is offered, labelled a guess
const mr = recommendFix(["Item"], [["Pencl"], ["Pencil"]], 0, {}, 'Item "Pencl" looks like a misspelling of "Pencil"', 0, 0, {}, null, { Item: "Pencil" });
assert.deepEqual(mr.changes, [{ cell: "A2", new: "Pencil" }]);
assert.ok(mr.guess && mr.explanation.includes("misspelling"));

// auto-fix: only the engine's exact fixes, on known columns; text must match exactly for Undo
assert.deepEqual(exactFixes([{ exact: { Region: "East" } }, null, { severity: "Low", likely: { Units: 5 } }, { exact: { Nope: "x" } }], ["Date", "Region"]),
  [{ k: 0, j: 1, value: "East" }]);
assert.ok(wrote("East", "East") && !wrote("EAST", "East"), "a re-typed case is the user's edit");

// instant recommendation: data A1:C5, header row 1, limits on Units only
const cols = ["Date", "Region", "Units"];
const data = [["2026-01-06", "East", 40], ["2026-01-07", "West", -5], ["2026-01-08", "East", ""], ["2026-01-09", "East", 41]];
const lim = { Units: [10, 80, 0, 120] };
let rec = recommendFix(cols, data, 1, lim, "Flagged by 2 of 4: Units weird limit is 0; this is -5", 0, 0);
assert.deepEqual(rec.changes, [{ cell: "C3", new: "40.5" }], "median of the OTHER rows (40, 41; blank skipped), as a plain value");
assert.ok(rec.explanation.startsWith("Units is -5, outside its limits (0 to 120)"), rec.explanation);
assert.equal(rec.guess, true, "a median is a best guess, and the card says so");
assert.equal(recommendFix(cols, data, 1, lim, "x", 0, 0, { Units: 5 }).guess, false, "an obvious typo (-5 for 5) is not a guess");
rec = recommendFix(cols, data, 0, lim, "x", 0, 0);
assert.deepEqual(rec.changes, [], "inside limits: no change");
assert.ok(rec.explanation.includes("Nothing here is clearly broken"));
rec = recommendFix(cols, data, 2, lim, "Flagged by 0 of 4: Blank cell in column Units, which is otherwise filled", 0, 0);
assert.deepEqual(rec.changes, [{ cell: "C4", new: "40" }], "blank in a filled number column: median of 40, -5, 41");
assert.deepEqual(recommendFix(cols, data, 3, lim, "x", 0, 0).changes, [], "a blank elsewhere isn't touched");
rec = recommendFix(cols, data, 0, { Units: [10, 80, 50, null] }, "x", 4, 2); // data starts at C5
assert.deepEqual(rec.changes, [{ cell: "E6", new: "18" }], "first row, offset data: median of -5, 41 (blank skipped)");
assert.ok(rec.explanation.includes("(50 to no high)"));
rec = recommendFix(cols, data, 0, null, 'Flagged by 1 of 4: Duplicate of row 2', 4, 0); // header in row 5
assert.ok(rec.explanation.includes("repeats row 6"), "duplicate row number shifts with the data: " + rec.explanation);
rec = recommendFix(cols, data, 0, null, 'Flagged by 1 of 4: Duplicate of row 2; Text "12O" in number column Units', 0, 0);
assert.ok(rec.explanation.includes("repeats row 2") && rec.explanation.includes('Units holds the text "12O"'), rec.explanation);
assert.deepEqual(recommendFix(cols, [["a", "b", 999]], 0, lim, "x", 0, 0).changes, [], "one data row: nothing to take a median of");

// header below title rows; numeric year headers kept; dates converted using the first DATA row's format
let tg = tableFromGrid([["Cost Report"], ["Period 9"], [""], ["Code", "Item", "Budget"], ["03-1", "Pour", 500], ["03-2", "Form", 700]],
  null, 0, 0);
assert.deepEqual([tg.columns, tg.startRow, tg.rows.length], [["Code", "Item", "Budget"], 3, 2]);
tg = tableFromGrid([["($mm)", 2024, 2025], ["Revenue", 10, 12]], null, 4, 2);
assert.deepEqual([tg.columns, tg.startRow, tg.startCol], [["($mm)", 2024, 2025], 4, 2], "a year header is still the header");
tg = tableFromGrid([["Date", "Units"], [46028, 5]], [["General", "General"], ["m/d/yyyy", "0"]], 0, 0);
assert.deepEqual(tg.rows, [["2026-01-06", 5]]);
assert.equal(tableFromGrid([["Title only"]], null, 0, 0), null);
assert.equal(tableFromGrid([["A", "B"]], null, 0, 0), null, "header with no data");

// engine-spotted typo becomes the fix; wide columns are never median-overwritten
assert.equal(typoKind(2600, 26), "extra zeros - x100");
assert.equal(typoKind(0.26, 26), "missing zeros - ÷100");
assert.equal(typoKind(-26, 26), "sign flipped");
rec = recommendFix(cols, data, 1, lim, "x", 0, 0, { Units: 5 });
assert.deepEqual(rec.changes, [{ cell: "C3", new: "5" }]);
assert.ok(rec.explanation.startsWith("Units is -5 - looks like a typo for 5 (sign flipped)"), rec.explanation);
assert.ok(spansDecade([1, 2, 5, 10, 40, 80, 120, 300, 900, 2000]) && !spansDecade([20, 22, 25, 30, 31, 33, 35, 38, 40, 41]));
const wide = [["a", 100], ["b", 900], ["c", 15000], ["d", 2200], ["e", 400], ["f", 7000], ["g", 30000], ["h", 1300], ["i", 600], ["j", 5000], ["k", 999999]];
rec = recommendFix(["Id", "Paid"], wide, 10, { Paid: [0, 20000, 0, 40000] }, "x", 0, 0);
assert.deepEqual(rec.changes, [], "a huge value in a naturally wide column is not overwritten");
assert.ok(rec.explanation.includes("may be real"), rec.explanation);

// a formula cell is never overwritten: its inputs are what's wrong
rec = recommendFix(cols, data, 1, lim, "x", 0, 0, { Units: 5 }, ["", "", "=A3*2"]);
assert.deepEqual(rec.changes, [], "no write into a formula cell");
assert.ok(rec.explanation.startsWith("C3 is calculated by a formula"), rec.explanation);
assert.ok(!rec.explanation.includes("Replace") && !rec.explanation.includes("typo for"), "no contradicting advice");
assert.deepEqual(tableFromGrid([["A", "B"], [1, 2]], null, 0, 0, [["A", "B"], [1, "=A2*2"]]).calc, [[1, "=A2*2"]]);
// spelling variant -> the usual spelling
rec = recommendFix(["Dept", "Hours"], [["sales", 40]], 0, {}, "x", 0, 0, { Dept: "Sales" });
assert.deepEqual(rec.changes, [{ cell: "A2", new: "Sales" }]);

// one-column sheet still has a header; duplicate headers use the engine's names ("Dept", "Dept.1")
assert.deepEqual(tableFromGrid([["Sq Ft"], [1900], [2100]], null, 0, 0).columns, ["Sq Ft"]);
assert.deepEqual(tableFromGrid([["Dept", "Dept", "Dept"], ["a", "b", "c"]], null, 0, 0).columns, ["Dept", "Dept.1", "Dept.2"]);
rec = recommendFix(["Dept", "Dept.1"], [["sales", "ops"]], 0, {}, "x", 0, 0, { Dept: "Sales" });
assert.deepEqual(rec.changes, [{ cell: "A2", new: "Sales" }], "fix only the column the engine named");

// L2: flagged rows worst first, clean rows out, data-row index kept
assert.deepEqual(flaggedRows([{ severity: null, magnitude: 0 }, { severity: "Low", magnitude: 2 }, { severity: "High", magnitude: 9 }]).map((r) => r.i), [2, 1]);

// reasons in plain words: no "weird limit", no vote count, a limit clause stays whole
assert.equal(plainReason("Flagged by 2 of 3: Units weird limit is 0; this is -5"), "Units is -5, below its usual limit of 0");
assert.equal(plainReason("fare amount weird limit is 35; this is 52 (likely 5.2); Duplicate of row 7"),
  "fare amount is 52, above its usual limit of 35 (likely 5.2) · Duplicate of row 7");
assert.equal(plainReason("Flagged by 1 of 3: Unusual combination of values, mainly tolls; Units is unusual relative to its local trend near 2026-01-26 00:00:00"),
  "Unusual mix of values, mostly in tolls · Units breaks its usual pattern near 2026-01-26");
assert.equal(plainReason(""), "");
assert.equal(esc('x" autofocus onfocus="alert(1)'), "x&quot; autofocus onfocus=&quot;alert(1)", "a sheet header can't break out of an attribute");
assert.equal(esc("<b>'&"), "&lt;b&gt;&#39;&amp;");
assert.equal(plainReason("Flagged by 3 of 3: Units weird limit is 105; this is 9999; Units jumped sharply near 2026-01-26 00:00:00"),
  "Units is 9999, above its usual limit of 105 · Units jumped sharply near 2026-01-26", "the ; after the value is a separator, not part of it");
assert.deepEqual(issuesOf("Flagged by 1 of 3: Units weird limit is 105; this is 9999 (likely 99.99); Duplicate of row 7").map((x) => x.text),
  ["Units weird limit is 105; this is 9999 (likely 99.99)", "Duplicate of row 7"], "limit clause kept whole");
assert.deepEqual(issuesOf(""), []);
assert.deepEqual(flaggedRows([{ severity: "Noted", magnitude: 5 }, { severity: "Low", magnitude: 2 }]).map((r) => r.i), [1], "Noted rows aren't listed");

// Batch 1: header names never collide (same rule as the engine); the limits editor only shows numbers
assert.deepEqual(tableFromGrid([["Dept", "Dept", "Dept.1"], ["a", "b", "c"]], null, 0, 0).columns, ["Dept", "Dept.1", "Dept.1.1"]);
assert.deepEqual(tableFromGrid([["Name", "Name", "Name"], ["a", "b", "c"]], null, 0, 0).columns, ["Name", "Name.1", "Name.2"]);
assert.deepEqual([asNumber(5), asNumber("2.5"), asNumber(null), asNumber(""), asNumber('1" onfocus="alert(1)'), asNumber(Infinity), asNumber(undefined)], [5, 2.5, "", "", "", "", ""]);

assert.equal(cutNote([250001, 1048576]), "Too large to scan at once: checked down to row 250,001 of 1,048,576. Rows below 250,001 were NOT checked.");

// Batch 3: text cells are never overwritten; placeholders and text get a plain-English note
const ph = recommendFix(["Pay", "Amt"], [["ERROR", 5], ["Card", 6]], 0, {}, 'Placeholder "ERROR" in column Pay', 0, 0, null, null);
assert.ok(ph.explanation.includes('Pay says "ERROR" - a stand-in for a missing value') && !ph.changes.length);
const tx = recommendFix(["When"], [["UNKNOWN"]], 0, {}, 'Text "UNKNOWN" in date column When', 0, 0, null, null);
assert.ok(tx.explanation.includes("where a date belongs - retype it as a date"));
const money = recommendFix(["Price"], [["$1,000,000.00"], ["$1,200.00"]], 0, { Price: [900, 1500, 500, 2000] },
  "Flagged by 1 of 3: Price weird limit is 2000; this is 1000000", 0, 0, null, null);
assert.ok(!money.changes.length && money.explanation.startsWith("Price is 1000000, past its limit of 2000."), money.explanation);

// Final re-attack: a crafted reason can't freeze the pane
const evil = "Flagged by 1 of 3: " + " weird limit is a".repeat(2000) + "; this is 5";
let t0 = Date.now();
recommendFix(["Amt"], [[evil]], 0, {}, evil, 0, 0, null, null);
assert.ok(Date.now() - t0 < 500, `recommendFix took ${Date.now() - t0}ms on a crafted reason`);

const both = recommendFix(["Amt", "Price"], [["$1,000,000.00", 1000], ["$1,200.00", 10]], 0, { Price: [5, 20, 0, 50] },
  "Flagged by 2 of 3: Amt weird limit is 2000; this is 1000000; Price weird limit is 50; this is 1000", 0, 0, null, null);
assert.ok(both.explanation.includes("Amt is 1000000, past its limit of 2000") && both.changes.length === 1 && !both.explanation.includes("null"), both.explanation);
const note = recommendFix(["Name", "Notes"], [["a", ""], ["b", "x"]], 0, {}, "Blank cell in column Notes, which is otherwise filled", 0, 0, null, null);
assert.ok(note.explanation.startsWith("Notes is blank where the rest of the column is filled"), note.explanation);

console.log("panel self-check passed");
