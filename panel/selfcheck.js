// Panel pure-logic check, no Office/fetch. Run: node panel/selfcheck.js
const assert = require("node:assert");
const { computeHealthSummary, diffFlaggedRows, isDateFormat, excelDate, rowFromAddress } = require("./taskpane.js");

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
assert.equal(rowFromAddress("B7:D9", 0), 5);
assert.equal(rowFromAddress("'My Sheet'!$C$7", 0), 5);
assert.equal(rowFromAddress("7:7", 0), 5, "whole row selected");
assert.equal(rowFromAddress("C8", 3), 3, "data starting lower down");
assert.equal(rowFromAddress("C1", 0), null, "header row");
assert.equal(rowFromAddress("B:B", 0), null, "whole column");

console.log("panel self-check passed");
