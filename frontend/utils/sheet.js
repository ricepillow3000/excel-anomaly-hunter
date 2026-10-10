// A scan reads at most this many cells: Excel refuses one read over 5M cells, and the engine's time grows with it.
// Only the bottom is cut, so row numbers never shift.
export const maxCells = () => globalThis.MAX_CELLS || 2e6;

// Pure: the honest line for a sheet too big to read at once
export const cutNote = ([last, total]) =>
  `Too large to scan at once: checked down to row ${last.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}. Rows below ${last.toLocaleString("en-US")} were NOT checked.`;

// Pure: used-range values -> {columns, rows, startRow, startCol}, or null if there's no header + data row.
// Header = first row that is mostly filled, so title rows above it ("Cost Report - Period 9") are skipped.
export function tableFromGrid(values, formats, rowIndex, colIndex, formulas) {
  const filled = (r) => r.filter((v) => v !== "" && v !== null).length;
  const widest = Math.max(0, ...values.slice(0, 20).map(filled));
  const h = values.findIndex((r, k) => k < 10 && filled(r) >= Math.max(Math.min(2, widest), 0.6 * widest));
  if (h < 0 || h + 1 >= values.length) return null; // need header + 1 row
  // Excel hands dates over as serial numbers; send real dates so the engine finds its time axis
  const isDate = formats ? formats[h + 1].map(isDateFormat) : [];
  const rows = values.slice(h + 1).map((r) => r.map((v, j) => (isDate[j] && typeof v === "number" ? excelDate(v) : v)));
  const calc = formulas && formulas.slice(h + 1); // each data row's formulas ("=B2-C2"), so a fix never types over one
  const columns = []; // name duplicate headers like the engine does ("Dept", "Dept.1", skipping taken names): limits and fixes are keyed by these
  values[h].forEach((c) => {
    let name = String(c);
    for (let k = 1; columns.includes(name); k++) name = `${c}.${k}`;
    columns.push(name);
  });
  return { columns, rows, startRow: rowIndex + h, startCol: colIndex, calc };
}

// Pure: number format shows a date? (ignore [colors/locales] and "quoted text", e.g. "[Red]0.00")
export const isDateFormat = (f) => /[dy]/i.test(String(f).replace(/\[[^\]]*\]|"[^"]*"/g, ""));

// Pure: Excel serial day -> "yyyy-mm-dd", plus " hh:mm:ss" when it has a time (25569 = 1970-01-01).
// Dropping the time made two taxi trips on one day with equal fares look like duplicates.
export const excelDate = (n) => {
  const s = new Date(Math.round((n - 25569) * 864e2) * 1e3).toISOString();
  return Number.isInteger(n) ? s.slice(0, 10) : `${s.slice(0, 10)} ${s.slice(11, 19)}`;
};

// Pure: "C7", "B7:D7", "Sheet1!C7", "7:7" -> 0-based data row index (header at startRow), or null.
// A selection spanning several rows (dragging down a column) is not a click on a row -> null.
export function rowFromAddress(address, startRow) {
  const m = /^(?:.*!)?\$?[A-Z]*\$?(\d+)(?::\$?[A-Z]*\$?(\d+))?$/i.exec(String(address));
  if (!m || (m[2] && m[2] !== m[1])) return null;
  const i = Number(m[1]) - startRow - 2;
  return i >= 0 ? i : null;
}

// Pure: 0-based column index -> Excel letters (0 -> A, 26 -> AA)
export function colLetter(n) {
  let s = "";
  for (n += 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Pure: does a row Excel holds now still match what we expect there? Dates come back as serial numbers, and numbers
// may differ in the last float bits. A row that was sorted, edited or shifted by an inserted row fails.
// calc[j] = a formula cell: skipped (a running total changes whenever a row above is fixed).
const sameCell = (now, was) => now === was || (typeof now === "number" &&
  (typeof was === "string" ? excelDate(now) === was : typeof was === "number" && Math.abs(now - was) <= 1e-9 * Math.max(1, Math.abs(now))));
export const sameRow = (now, was, calc = []) => now.length === was.length && now.every((v, j) => calc[j] || sameCell(v, was[j]));

// Pure: "AA12" -> {col: 26, row: 12} (0-based column, sheet row number), or null
export function cellAt(cell) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(cell));
  return m && { col: [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, row: +m[2] };
}
