// Runs the REAL pane functions on JSON from stdin. Usage: node bridge.js <path-to-frontend-folder>
const path = require("path");
const { tableFromGrid } = require(path.join(process.argv[2], "utils", "sheet.js"));
const { recommendFix } = require(path.join(process.argv[2], "features", "fix.js"));
const jobs = JSON.parse(require("fs").readFileSync(0, "utf8"));
const out = jobs.map((j) => {
  if (j.op === "table") return tableFromGrid(j.grid, j.formats || null, 0, 0, j.formulas || null);
  if (j.op === "rec") return recommendFix(j.columns, j.rows, j.i, j.limits, j.reason, j.startRow, j.startCol, j.extra && j.extra.likely, j.calc);
});
process.stdout.write(JSON.stringify(out));
