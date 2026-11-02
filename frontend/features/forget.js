import { DECISIONS_KEY, KEY, STRENGTH_KEY, UNDO_KEY } from "../constants/index.js";

// What the pane keeps inside the workbook (its document settings), named as the Privacy page names them. It stays in
// the file after an uninstall, and nothing in the pane could clear it (AH-87). selfcheck.js fails when the pane saves
// a key that is not listed here.
export const WORKBOOK_KEYS = [
  [KEY, "the limits you changed"],
  [STRENGTH_KEY, "the strength slider"],
  [UNDO_KEY, "the list of auto-fixes with their old values"],
  [DECISIONS_KEY, "the codes of the rows you fixed or dismissed"],
  ["Office.AutoShowTaskpaneWithDocument", "the setting that opens this pane with the file"],
];

// Remove each of them that the workbook holds, save, and say which were there -> [what was removed]. Never a cell:
// fixes already made, highlights and every value in the sheet stay as they are.
export async function forgetWorkbook() {
  const s = Office.context.document.settings;
  await new Promise((ok) => s.refreshAsync(() => ok())); // another pane of this workbook may have saved since
  const gone = WORKBOOK_KEYS.filter(([k]) => s.get(k) !== null && s.get(k) !== undefined);
  for (const [k] of gone) s.remove(k);
  const saved = await new Promise((ok) => s.saveAsync((r) => ok(!r || r.status === "succeeded")));
  if (!saved) throw new Error("Excel couldn't save the workbook's settings. Try again.");
  return gone.map(([, what]) => what);
}
