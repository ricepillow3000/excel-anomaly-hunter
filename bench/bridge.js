// Runs the REAL panel functions on JSON from stdin. Usage: node bridge.js <path-to-taskpane.js>
const p = require(process.argv[2]);
const jobs = JSON.parse(require("fs").readFileSync(0, "utf8"));
const out = jobs.map((j) => {
  if (j.op === "table") {
    if (p.tableFromGrid) return p.tableFromGrid(j.grid, j.formats || null, 0, 0, j.formulas || null);
    // baseline panel: header = first row of the used range
    return { columns: j.grid[0], rows: j.grid.slice(1), startRow: 0, startCol: 0 };
  }
  if (j.op === "rec") return p.recommendFix(j.columns, j.rows, j.i, j.limits, j.reason, j.startRow, j.startCol, j.extra && j.extra.likely, j.calc);
});
process.stdout.write(JSON.stringify(out));
