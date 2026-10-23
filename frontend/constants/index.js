// Anomaly Hunter task pane. Talks to the local engine at the same origin. Plain JS, no build.
// One path for anyone: Find problems -> rows to check (highlighted in the sheet) -> click one -> Accept / Dismiss the suggested fix.
export const SERVER = "https://127.0.0.1:5055";

export const KEY = "anomalyHunterLimits"; // limits the user changed, saved inside the workbook
export const STRENGTH_KEY = "anomalyHunterStrength"; // the slider, saved inside the workbook
export const AUTO_KEY = "anomalyHunterAutoFix"; // the auto-fix toggle: this PC (localStorage), off unless turned on
export const UNDO_KEY = "anomalyHunterAutoUndo"; // what auto-fix changed, saved inside the workbook for Undo auto-fixes
export const POWER_BI_KEY = "anomalyHunterPowerBi"; // keep each scan for Power BI: this PC (localStorage), off unless turned on
export const DECISIONS_KEY = "anomalyHunterDecisions"; // rows fixed or dismissed, as codes, saved inside the workbook

// What each slider level does, in its own words (2, 4, 6, 8 and 10 once showed the level below's, so 6 opened
// "Recommended.", AH-20), then what that very level did on the industry bench's 27 sheets (backend/bench: 51 planted
// mistakes, 2,724 fine rows): [found, of them called probably or very likely wrong, fine rows listed as worth a check,
// fine rows called probably wrong]. Measured, not estimated:
// backend/tests/test_strength_promise.py scans the bench at every level and fails when a number here is not what the
// engine does (AH-15: John read 5 and 10 as the same; the slider mostly moves the borderline list, and says so).
export const MEASURED = {"sheets":27,"planted":51,"fine":2724,"levels":{"0":[43,42,0,0],"1":[44,44,0,0],"2":[44,44,0,0],"3":[51,45,18,0],"4":[51,46,23,0],"5":[51,48,25,0],"6":[51,48,30,0],"7":[51,48,43,0],"8":[51,48,50,0],"9":[51,51,74,0],"10":[51,51,96,3]}};
export const STRENGTH = [
  [0, "Basics: misspellings, totals that don't add up, duplicates, blanks, text in number columns, obvious typos (extra zeros, minus signs where none belong)."],
  [1, "Basics, plus numbers far outside their column's usual range."],
  [2, "A step up from 1: the same checks, with a slightly tighter range."],
  [3, "Plus sudden jumps in data over time."],
  [4, "A step up from 3: the same checks, a little tighter."],
  [5, "Recommended. Plus unusual mixes of values across columns."],
  [6, "A step past the recommended level: the same checks as 5, a little tighter."],
  [7, "Stricter: the same mistakes as at 5, plus values just past their column's usual range to check."],
  [8, "A step up from 7: the same mistakes as at 5, the same checks as 7, a little tighter."],
  [9, "Very strict: the same mistakes as at 5, plus anything slightly unusual - many more rows to check, most of them fine."],
  [10, "Strictest: the same mistakes as at 5, everything 9 checks at its tightest - the most rows to check, most of them fine."],
];

export const SEV = { High: "Very likely wrong", Medium: "Probably wrong", Low: "Worth a check" }; // Noted = fine, not shown

// one step off Excel's own Bad / Neutral / Note fills (#FFC7CE, #FFEB9C, #FFFFCC), which look the same: a reopened pane
// clears the cells wearing these and never a cell the user styled (AH-40: we colour single cells now, so the old
// "a full row is ours" test cannot tell them apart). OLD_COLOR: what whole rows were painted in before
export const COLOR = { High: "#FFC7CF", Medium: "#FFEB9D", Low: "#FFFFCD" };
export const OLD_COLOR = ["#FFC7CE", "#FFEB9C", "#FFFFCC"];

export const CAP = 50; // rows listed in the pane; all of them are highlighted in the sheet

export const CHUNK = 500; // rows highlighted per Excel call: big enough to be quick, small enough that Excel never freezes

export const READ_CELLS = 200000; // cells read per Excel call, so the progress bar moves and no single call is huge

export const VIEWS = ["empty-state", "results", "limits-editor", "fix-view"];

// The list's order: surest first ("Noted" = fine, not listed)
export const RANK = { High: 0, Medium: 1, Low: 2 };

// What Excel's own error codes mean, in plain words
export const EXCEL_ERRORS = {
  "#N/A": "a lookup (VLOOKUP/XLOOKUP/MATCH) found no match", "#DIV/0!": "it divides by zero or by a blank cell",
  "#REF!": "it points at a cell or sheet that was deleted", "#VALUE!": "one of its inputs is the wrong type (text where a number belongs)",
  "#NAME?": "a function or name in it is misspelled", "#NUM!": "the math is impossible (e.g. square root of a negative)",
  "#NULL!": "two ranges in it don't overlap", "#SPILL!": "its results are blocked by cells in the way", "#CALC!": "the calculation failed",
};
