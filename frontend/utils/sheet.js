// A scan reads at most this many cells: Excel refuses one read over 5M cells, and the engine's time grows with it.
// Only the bottom is cut, so row numbers never shift.
export const maxCells = () => globalThis.MAX_CELLS || 2e6;

// Pure: the honest line for a sheet too big to read at once
export const cutNote = ([last, total]) =>
  `Too large to scan at once: checked down to row ${last.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}. Rows below ${last.toLocaleString("en-US")} were not checked.`;

// Pure: used-range values -> {columns, rows, startRow, startCol}, or null if there's no header + data row.
// Header = first row that is mostly filled, so title rows above it ("Cost Report - Period 9") are skipped.
export function tableFromGrid(values, formats, rowIndex, colIndex, formulas) {
  const filled = (r) => r.filter((v) => v !== "" && v !== null).length;
  const widest = Math.max(0, ...values.slice(0, 20).map(filled));
  const h = values.findIndex((r, k) => k < 10 && filled(r) >= Math.max(Math.min(2, widest), 0.6 * widest));
  if (h < 0 || h + 1 >= values.length) return null; // need header + 1 row
  // Excel hands dates over as serial numbers; send real dates so the engine finds its time axis. A column holds dates
  // when most of its first 20 filled cells wear a date format (AH-150: row 2 alone decided, so a sort that put a blank or
  // a text there sent the whole column as serial numbers)
  const isDate = formats ? values[h].map((_, j) => {
    const seen = values.slice(h + 1, formats.length).flatMap((r, k) => (r[j] === "" || r[j] === null ? [] : [formats[h + 1 + k][j]])).slice(0, 20);
    return seen.length ? 2 * seen.filter(isDateFormat).length > seen.length : isDateFormat(formats[h + 1]?.[j]);
  }) : [];
  const rows = values.slice(h + 1).map((r) => readAs(r, isDate));
  const calc = formulas && formulas.slice(h + 1); // each data row's formulas ("=B2-C2"), so a fix never types over one
  const columns = []; // name duplicate headers like the engine does ("Dept", "Dept.1", skipping taken names): limits and fixes are keyed by these
  values[h].forEach((c) => {
    let name = String(c);
    for (let k = 1; columns.includes(name); k++) name = `${c}.${k}`;
    columns.push(name);
  });
  // ...but a header two columns share is said as the sheet says it, with its column letter: "Units.1" is no name the
  // user can find (AH-128, as Check words does since AH-35). Every column is a key, so "Units sold" stays whole
  const twice = (c) => values[h].filter((d) => String(d) === String(c)).length > 1;
  const names = values[h].some(twice) ? Object.fromEntries(values[h].map((c, j) => [columns[j], !twice(c) ? columns[j]
    : `${String(c).trim() ? `${String(c).trim()} (column ${colLetter(colIndex + j)})` : `column ${colLetter(colIndex + j)}`}`])) : {};
  return { columns, rows, startRow: rowIndex + h, startCol: colIndex, calc, dates: isDate, names };
}

// Pure: each column name in a sentence said as the sheet's names say it (names: engine name -> shown). A name counts
// only standing whole, longest first, never inside quotes (a value "Units" is a value)
export function shownAs(text, names) {
  const keys = Object.keys(names || {}).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!keys.length) return text;
  const edge = (ch) => ch === undefined || " ,;:()·".includes(ch);
  let out = "";
  for (let k = 0; k < text.length;) {
    const hit = edge(text[k - 1]) && keys.find((c) => text.startsWith(c, k) && edge(text[k + c.length]));
    if (hit) (out += names[hit]), (k += hit.length);
    else out += text[k++];
  }
  return out;
}

// Pure: one row of Excel's values -> the row as a scan reads it (dates[j]: column j holds dates)
export const readAs = (values, dates = []) => values.map((v, j) => (dates[j] && typeof v === "number" ? excelDate(v) : v));

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

// Pure: an R1C1 formula as Excel shows it in A1 form in sheet row `row` (1-based), column `col` (0-based): "=RC[-2]*RC[-1]"
// in D31 -> "=B31*C31" (AH-152: what the card shows; Excel itself converts what Accept writes, through formulasR1C1)
export const r1c1ToA1 = (f, row, col) => f.replace(/(?<![A-Za-z_\d])R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?(?![A-Za-z_\d(])/g, (m, r, c) => {
  const rel = (x) => Number(x.slice(1, -1)); // "[-2]" -> -2; a bare number is absolute ("R2C1" = $A$2)
  const rn = !r ? row : r[0] === "[" ? row + rel(r) : Number(r), cn = !c ? col : c[0] === "[" ? col + rel(c) : Number(c) - 1;
  return `${c && c[0] !== "[" ? "$" : ""}${colLetter(cn)}${r && r[0] !== "[" ? "$" : ""}${rn}`;
});

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

// Pure: the cells (column indexes) a row's reasons are about - the pane colours those, no other (AH-40: it coloured the
// whole row, so a reason about one cell lit up every cell beside it). An engine from before AH-40 names none: the row.
export function spots(r, columns) {
  const j = (r?.cells || []).map((c) => columns.indexOf(c)).filter((k) => k >= 0);
  return j.length ? j : columns.map((_, k) => k);
}

// A value kept in the workbook goes back into a cell only as a plain value, into a plain A1 cell: a crafted .xlsx can
// carry any record (2026-10-15 audit). Text Excel would read as a formula is refused, a signed number is not
export const A1 = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;
export const typedAsFormula = (v) => typeof v === "string" && /^[=+\-@＝＋－＠\t\r]/.test(v) && !/^[+\-]?\d[\d.,]*$/.test(v);
