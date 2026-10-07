// Panel pure-logic check, no Office/fetch. Run: node panel/selfcheck.js
const assert = require("node:assert");
const { computeHealthSummary, diffFlaggedRows, isDateFormat, excelDate, rowFromAddress, colLetter, median, recommendFix } = require("./taskpane.js");

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

console.log("panel self-check passed");
