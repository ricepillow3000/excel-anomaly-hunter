// Plain-Node self-check for computeHealthSummary/diffFlaggedRows — no Office.js/fetch needed.
// Run: node selfcheck.js
const { computeHealthSummary, diffFlaggedRows } = require("./src/taskpane/taskpane.js");

const clean = computeHealthSummary({
  rows: [{ severity: null }, { severity: null }, { severity: "Noted" }],
  summary: { severity_counts: { Noted: 1 }, bucket_counts: {} },
});
if (clean.flaggedCount !== 0) throw new Error("Noted-only rows must not count as flagged");
if (clean.healthPct !== 100) throw new Error("expected 100% health when nothing is flagged");

const dirty = computeHealthSummary({
  rows: [{ severity: "High" }, { severity: null }, { severity: null }, { severity: null }],
  summary: { severity_counts: { High: 1 }, bucket_counts: { Behavioral: 1 } },
});
if (dirty.flaggedCount !== 1) throw new Error("expected 1 flagged row");
if (dirty.healthPct !== 75) throw new Error(`expected 75% health, got ${dirty.healthPct}`);
if (dirty.healthLabel !== "Needs review") throw new Error("75% health should read as Needs review");

// diffFlaggedRows: a row going from clean to flagged is "new"; flagged to
// clean is "resolved"; no change produces no entry.
const diffs = diffFlaggedRows(
  [{ severity: null }, { severity: "High" }, { severity: "Low" }],
  [{ severity: "Medium" }, { severity: null }, { severity: "Low" }]
);
if (diffs.length !== 2) throw new Error(`expected 2 diff entries, got ${diffs.length}`);
if (diffs[0].kind !== "new" || diffs[0].rowIndex !== 0)
  throw new Error("row 0 should be a new flag");
if (diffs[1].kind !== "resolved" || diffs[1].rowIndex !== 1)
  throw new Error("row 1 should be resolved");

const firstScan = diffFlaggedRows(null, [{ severity: "High" }]);
if (firstScan.length !== 1 || firstScan[0].kind !== "new") {
  throw new Error("a null baseline (no prior scan) should treat existing flags as new");
}

console.log("self-check passed:", { clean, dirty, diffs });
