// The pane's shared state, in one place. Modules read and write fields of `state`.
export const state = {
  lastScan: null, // {columns, rows, startRow, startCol, sheet, cut, dates} what the last scan read
  hashes: [], // each scanned row's hash, and its code (hash + which identical copy): what a decision is kept under
  codes: [],
  lastRows: null, // the engine's verdict per row
  lastLimits: {}, // the limits that scan used: {col: [noteLo, noteHi, flagLo, flagHi]}
  lastStrength: 5, // the slider level that scan used (0-10)
  painted: null, // {sheet, startRow, startCol, width, colors: {row: old fill}} - what Remove highlights puts back
  picker: null, // {sheet, handle}: clicking a highlighted row in the sheet opens its fix
  fix: null, // the row open in the fix view: {i, sheet, calc, changes}
  undos: {}, // row -> cells to put back, while an applied fix isn't undone
  decided: {}, // row -> "fixed" | "dismissed": kept in the workbook (features/decisions.js), so it outlives the pane; "Next row" skips them
  order: [], // the flagged rows, worst first, as the last scan listed them
  aiAvailable: false,
  working: false, // one sheet action at a time; while one runs the buttons are disabled, never silently queued
  view: null, // which page is showing
};
globalThis.__state = state; // the browser tests reach in (e.g. "pane reopened" = forget what was painted)
