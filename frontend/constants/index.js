// Anomaly Hunter task pane. Talks to the local engine at the same origin. Plain JS, no build.
// One path for anyone: Find problems -> rows to check (highlighted in the sheet) -> click one -> Apply fix / Undo.
export const SERVER = "https://127.0.0.1:5055";

export const KEY = "anomalyHunterLimits"; // limits the user changed, saved inside the workbook

export const SEV = { High: "Very likely wrong", Medium: "Probably wrong", Low: "Worth a check" }; // Noted = fine, not shown

export const COLOR = { High: "#FFC7CE", Medium: "#FFEB9C", Low: "#FFFFCC" };

export const CAP = 50; // rows listed in the pane; all of them are highlighted in the sheet

export const CHUNK = 500; // rows highlighted per Excel call: big enough to be quick, small enough that Excel never freezes

export const READ_CELLS = 200000; // cells read per Excel call, so the progress bar moves and no single call is huge

export const VIEWS = ["empty-state", "results", "limits-editor", "fix-view"];

// Pure: the rows worth a look - surest first, then biggest - each with its data-row index ("Noted" = fine)
export const RANK = { High: 0, Medium: 1, Low: 2 };

// What Excel's own error codes mean, in plain words
export const EXCEL_ERRORS = {
  "#N/A": "a lookup (VLOOKUP/XLOOKUP/MATCH) found no match", "#DIV/0!": "it divides by zero or by a blank cell",
  "#REF!": "it points at a cell or sheet that was deleted", "#VALUE!": "one of its inputs is the wrong type (text where a number belongs)",
  "#NAME?": "a function or name in it is misspelled", "#NUM!": "the math is impossible (e.g. square root of a negative)",
  "#NULL!": "two ranges in it don't overlap", "#SPILL!": "its results are blocked by cells in the way", "#CALC!": "the calculation failed",
};
