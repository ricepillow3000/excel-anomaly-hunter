// Panel pure-logic check, no Office/fetch. Run: node panel/selfcheck.js
const assert = require("node:assert");
const { textFormats, cutNote, asNumber, plainOf, routePath, issuesOf, districtCounts, flaggedRows, computeHealthSummary, diffFlaggedRows, isDateFormat, excelDate, rowFromAddress, colLetter, median, recommendFix, tableFromGrid, typoKind, spansDecade } = require("./taskpane.js");

const clean = computeHealthSummary({
  rows: [{ severity: null }, { severity: null }, { severity: "Noted" }],
  summary: { severity_counts: { Noted: 1 }, bucket_counts: {} },
});
assert.equal(clean.flaggedCount, 0, "Noted must not count as flagged");
assert.equal(clean.healthPct, 100);

const dirty = computeHealthSummary({
  rows: [{ severity: "High" }, { severity: null }, { severity: null }, { severity: null }],
  summary: { severity_counts: { High: 1 }, bucket_counts: { Behavioral: 1 } },
});
assert.equal(dirty.flaggedCount, 1);
assert.equal(dirty.healthPct, 75);
assert.equal(dirty.healthLabel, "Needs review");

const diffs = diffFlaggedRows(
  [{ severity: null }, { severity: "High" }, { severity: "Low" }],
  [{ severity: "Medium" }, { severity: null }, { severity: "Low" }]);
assert.deepEqual(diffs.map((d) => [d.rowIndex, d.kind]), [[0, "new"], [1, "resolved"]]);
assert.deepEqual(diffFlaggedRows(null, [{ severity: "High" }]).map((d) => d.kind), ["new"], "no prior scan = all new");

assert.equal(excelDate(45658), "2025-01-01");
assert.equal(excelDate(46028), "2026-01-06"); // first OrderDate of the Contextures practice sheet
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

// instant recommendation: data A1:C5, header row 1, limits on Units only
const cols = ["Date", "Region", "Units"];
const data = [["2026-01-06", "East", 40], ["2026-01-07", "West", -5], ["2026-01-08", "East", ""], ["2026-01-09", "East", 41]];
const lim = { Units: [10, 80, 0, 120] };
let rec = recommendFix(cols, data, 1, lim, "Flagged by 2 of 4: Units weird limit is 0; this is -5", 0, 0);
assert.deepEqual(rec.changes, [{ cell: "C3", new: "40.5" }], "median of the OTHER rows (40, 41; blank skipped), as a plain value");
assert.ok(rec.explanation.startsWith("Units is -5, outside its limits (0 to 120)"), rec.explanation);
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

// L6: each issue in the engine's own wording goes to exactly one department, worst-to-fix first
const R = 'Flagged by 3 of 4: Units weird limit is 105; this is 9999 (likely 99.99); Duplicate of row 7; Excel error #DIV/0! in Ratio; ' +
  'Dept "sales" looks like "Sales" (same word, different capitals/spaces); Text "12O" in number column Qty; Blank cell in column Qty, which is otherwise filled; ' +
  "Unusual combination of values, mainly Price; Does not belong to any group of similar rows; Units jumped sharply near 2026-01-26 00:00:00 (1-order change); " +
  "Units is unusual relative to its local trend near 2026-01-26 00:00:00";
assert.deepEqual(issuesOf(R, ["Units", "Qty"], null).map((x) => x.dept),
  ["Formulas", "Duplicates", "Irregularities", "Irregularities", "Irregularities", "Irregularities", "Anomalies", "Anomalies", "Anomalies", "Anomalies"]);
assert.equal(issuesOf(R, ["Units"], null).find((x) => x.dept === "Irregularities").text, "Units weird limit is 105; this is 9999 (likely 99.99)", "limit clause kept whole");
assert.equal(issuesOf("Flagged by 1 of 4: Variance weird limit is 0; this is -5", ["Variance"], ["=B2-C2"])[0].dept, "Formulas", "odd value in a formula cell");
assert.deepEqual(issuesOf("", [], null), []);
const dc = districtCounts([{ severity: "High", reason: "Flagged by 2 of 4: A weird limit is 1; this is 9; Duplicate of row 2" }, { severity: "Noted", reason: "A baseline limit is 1; this is 2" },
  { severity: null, reason: "" }], ["A"], null);
assert.deepEqual([dc.counts, dc.flagged], [{ Formulas: 0, Duplicates: 1, Irregularities: 1, Anomalies: 0 }, 1], "Noted rows aren't counted");
// L6 trace: plain words with the cell, no "weird limit" jargon, repeats collapsed, at most 3 lines
assert.deepEqual(plainOf(issuesOf("Flagged by 1 of 4: Units weird limit is 0; this is -5", ["Region", "Units"], null), ["Region", "Units"], 1, 11),
  ["C11 Units = -5 · limit 0"]);
assert.deepEqual(plainOf(issuesOf("Units jumped sharply near 2026-01-26 00:00:00 (1-order change); Units jumped sharply near 2026-01-26 00:00:00 (2-order change)", [], null), ["Units"], 0, 5),
  ["A5 Units jumped sharply near 2026-01-26"], "repeats collapse, timestamps trimmed");
assert.equal(plainOf(issuesOf("Blank cell in column Units Sold, which is otherwise filled", [], null), ["Units", "Units Sold"], 0, 3)[0].slice(0, 3), "B3 ", "longest header wins");
const many = plainOf(issuesOf(R, ["Units", "Qty", "Ratio", "Dept", "Price"], null), ["Units", "Qty", "Ratio", "Dept", "Price"], 0, 9);
assert.deepEqual([many.length, many[0], /\(\+7 more\)$/.test(many[2])], [3, "C9 Excel error #DIV/0! in Ratio", true], "long lists are cut, the rest counted");
assert.equal(routePath("Irregularities", "engine"), "M158 64H150V152H54V161", "route starts at the case");
assert.equal(routePath("Anomalies", "web"), "M142 80H150V152H246V161");

// Batch 1: header names never collide (same rule as the engine); the limits editor only shows numbers
assert.deepEqual(tableFromGrid([["Dept", "Dept", "Dept.1"], ["a", "b", "c"]], null, 0, 0).columns, ["Dept", "Dept.1", "Dept.1.1"]);
assert.deepEqual(tableFromGrid([["Name", "Name", "Name"], ["a", "b", "c"]], null, 0, 0).columns, ["Name", "Name.1", "Name.2"]);
assert.deepEqual([asNumber(5), asNumber("2.5"), asNumber(null), asNumber(""), asNumber('1" onfocus="alert(1)'), asNumber(Infinity)], [5, 2.5, "", "", "", ""]);

assert.equal(cutNote([250001, 1048576]), "Too large to scan at once: checked down to row 250,001 of 1,048,576. Rows below 250,001 were NOT checked.");

// Batch 3: new engine wording reaches the right department and gets a plain-English note; text cells are never overwritten
assert.deepEqual(issuesOf('Placeholder "ERROR" in column Pay; Text "UNKNOWN" in date column When', ["Pay", "When"], null).map((x) => x.dept), ["Irregularities", "Irregularities"]);
const ph = recommendFix(["Pay", "Amt"], [["ERROR", 5], ["Card", 6]], 0, {}, 'Placeholder "ERROR" in column Pay', 0, 0, null, null);
assert.ok(ph.explanation.includes('Pay says "ERROR" - a stand-in for a missing value') && !ph.changes.length);
const tx = recommendFix(["When"], [["UNKNOWN"]], 0, {}, 'Text "UNKNOWN" in date column When', 0, 0, null, null);
assert.ok(tx.explanation.includes("where a date belongs - retype it as a date"));
const money = recommendFix(["Price"], [["$1,000,000.00"], ["$1,200.00"]], 0, { Price: [900, 1500, 500, 2000] },
  "Flagged by 1 of 3: Price weird limit is 2000; this is 1000000", 0, 0, null, null);
assert.ok(!money.changes.length && money.explanation.startsWith("Price is 1000000, past its limit of 2000."), money.explanation);

// Final re-attack: copying a row to the Anomalies sheet never creates a live formula; a crafted reason can't freeze the pane
assert.deepEqual(textFormats(["=WEBSERVICE(A1)", " +1", "@SUM(1)", "-x", 5, "2024-01-05", "ok", null]), ["@", "@", "@", "@", "General", "General", "General", "General"]);
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
