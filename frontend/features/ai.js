import { state } from "../hooks/use-state.js";
import { $, show, turnOn } from "../utils/dom.js";
import { post } from "../services/api.js";
import { showFix } from "../components/fix-preview.js";
import { checkFix } from "./fix.js";
import { busy, counting } from "../components/progress.js";
import { plainReason } from "./scan.js";
import { colLetter } from "../utils/sheet.js";
import { biggest, local, place } from "../utils/layout.js";
import { isOurs, plainError } from "../utils/errors.js";
import { recall } from "./memory.js";
import { heldOf, keepRules } from "./rules.js";
import { CAP } from "../constants/index.js";
import { n } from "../utils/text.js";

// Ask AI: the API client in the workflow (the engine forwards to Gemini). Optional; fixes work without it.
// AH-151: with no key or invite of its own the engine uses John's relay ("free"), and the options say so
// AH-228 P-10: said in one line; the steps for a key of one's own fold under "Use your own Google key"
const FREE_ON = "AI help works now, free, with a daily limit. For more answers, use your own free Google key.";

export function setAi(on, provider = state.aiProvider) {
  state.aiAvailable = !!on;
  state.aiProvider = provider ?? null;
  show("ai-fold", state.aiAvailable);
  show("ai-off", !state.aiAvailable);
  show("odd-box", state.aiAvailable);
  show("rules-box", state.aiAvailable);
  show("ai-checks", state.aiAvailable); // AH-228 P-18: both under "More checks with AI"
  $("fix-ask").disabled = !state.aiAvailable || !!state.fix?.asking;
  keySaid(!state.aiAvailable ? "AI help is off. It's optional; fixes work without it."
    : state.aiProvider === "free" ? FREE_ON : "AI help is on.");
}

// The AI help line: what the engine said about the key, or, in the pane's notice box, why it could not be saved (AH-149
// review r2: "Arcas has stopped" there was a bare line among the steps and read as a heading)
export function keySaid(words, failed = false) {
  $("ai-state").textContent = words;
  $("ai-state").classList.toggle("notice", failed);
}

export async function saveKey(key) {
  // AH-157: said at once; Google is asked about a key for up to 15 s, and the line kept saying "AI help is on" meanwhile
  keySaid(!key.trim() ? "Removing the key…" : key.trim().startsWith("inv_") ? "Saving the invite code…" : "Testing the key with Google…");
  try {
    const out = await post("/key", { key: key.trim() });
    $("ai-key").value = ""; // the key never stays on screen
    setAi(out.ai_available, out.ai_provider);
    // the engine tested the key with Google: "Key works", or why it was saved untested
    // only Remove reaches here without a message (Save sends a key); a GEMINI_API_KEY set in Windows can keep AI on
    keySaid(out.message || (out.ai_provider === "free" ? "Key removed. AI help uses the free shared AI again."
      : out.ai_available ? "Key removed. AI help still uses the Google key set on this PC." : "Key removed. AI help is off."));
  } catch (e) {
    // a key the engine refused (Google said no, or it is not a key) is no use to retry: it leaves the screen like a
    // saved one (AH-15); a save that failed (the disk, the engine gone) keeps it in the box to try again
    if (e.status === 400) $("ai-key").value = "";
    keySaid(isOurs(e) ? e.message : plainError(e, "The key wasn't saved"), true);
  }
}

export async function askFix() { // talks to the engine only; the sheet is touched later, by Apply
  if (!state.fix || !state.aiAvailable || $("fix-ask").disabled) return;
  const f = state.fix, btn = $("fix-ask");
  f.asking = btn.disabled = true;
  btn.textContent = "Asking AI… (usually a few seconds; slower when Google is busy)";
  $("fix-status").textContent = "";
  $("fix-care").textContent = "";
  show("fix-care", false);
  show("fix-label");
  try {
    // the row's own table (AH-212): its rows alone, row f.i its row f.i - o
    const t = place(state.lastScan, f.i), { columns, rows, startRow, startCol } = local(t), reason = state.lastRows[f.i].reason;
    // AH-143: the fixes the user accepted before in the flagged column, the one the engine reads from the reason (the
    // longest header it names: "Column 31" over "Column 3"); the engine ranks them and picks which go (AH-153)
    const flagged = columns.map(String).filter((c) => c.trim() && String(reason ?? "").includes(c)).sort((a, b) => b.length - a.length)[0];
    const memory = flagged ? recall(flagged) : [];
    const out = await post("/fix", {
      columns, rows, row_index: f.i - (t.o || 0), start_row: startRow, start_col: startCol,
      reason, intent: $("fix-intent").value, formulas: f.calc, ...(memory.length ? { memory } : {}),
    }, 300);
    // AH-125: the engine read the request as someone in crisis and sent nothing to the AI. Its helpline message goes
    // on the card as text, with no fix to check and no Accept beside it
    if (out.care) {
      if (state.fix === f) careSaid(f, out.explanation);
      return;
    }
    const v = await checkFix(f, out.changes).catch(() => null); // Agent 3 looks first; null = a formula, judged after Accept
    if (v) out.explanation += v.clean ? " Checked: with this fix the row looks right."
      : ` Checked: with this fix the row would still look unusual: ${plainReason(v.reason, undefined, "; ")}.`;
    if (state.fix !== f) return; // the user moved to another row meanwhile
    // AH-153: the engine's own sentence when the AI's fix repeats a past fix of the user's, so a learned habit is told
    // apart from a fresh reading of the sheet (showFix sets the explanation as text)
    if (typeof out.memory_note === "string") out.explanation += ` ${out.memory_note}`;
    await showFix(f, "AI's fix", out);
    // AH-145: Google's main model was busy or used up for today and a backup Gemini model answered (the engine names it
    // only then). AH-150: the notice names it too, as the card's words said only "a backup"
    if (out.model) notice(`Google's main AI was busy, so the backup model ${out.model} answered. Check its change before you accept.`);
  } catch (e) {
    if (state.fix !== f) return;
    // every model used up for today, or busy: John's words, in the notice box. The free AI's used-up day is the engine's
    // own words (AH-151), which name your own Google key as the way to more
    if (Object.hasOwn(LIMITS, String(e.limit))) notice(e.limit === "day" && state.aiProvider === "free" ? e.message : LIMITS[e.limit]);
    else notice(plainError(e, "AI could not help")); // in the card's notice box, like the limits (AH-149 review r2)
  } finally {
    f.asking = false;
    if (state.fix === f) {
      if (state.aiAvailable) turnOn([btn]); // AI turned off meanwhile: it stays off
      btn.textContent = "Ask AI";
    }
  }
}

const LIMITS = { day: "Ask AI has used today's free requests. It works again tomorrow.", busy: "Google's AI is busy right now. Try again in a minute." };

function notice(words) { // the card's notice box (a hairline box and a square), the helpline message's
  $("fix-care").textContent = words;
  show("fix-care");
}

function careSaid(f, words) {
  notice(words);
  if (state.undos[f.i]) return; // an accepted fix keeps its Undo and what it changed
  // no earlier suggestion beside the helpline message: a formula card next to it read as if the pane had not listened
  // (AH-125 live check, 2026-11-05)
  f.changes = [];
  show("fix-label", false);
  $("fix-changes").innerHTML = "";
  $("fix-explanation").textContent = "";
  show("fix-apply", false);
}

const item = (text) => Object.assign(document.createElement("li"), { textContent: text }); // AI text is never HTML

// The AI word check: a value that is a different KIND of thing from the rest of its column ("London" among products).
// The engine sends only each text column's distinct words. Worth a look, not proof: nothing is changed in the sheet.
export async function checkWords() {
  const { columns, rows, startRow, startCol } = biggest(state.lastScan); // a sheet of several tables: its biggest (AH-212)
  busy("Asking the AI about your words…"); // AH-157: with its seconds; act() takes it off. The pane sat silent up to 300 s
  counting();
  try {
    const { odd, partial } = await post("/odd-text", { columns, rows }, 300);
    $("odd-list").replaceChildren(...(odd.length ? oddLines(odd, columns, startRow, startCol).map(item)
      : [item(partial ? "Nothing out of place so far." : "Nothing looks out of place.")]),
    ...(partial ? [item("Google got busy before every word was checked. Click again to check the rest. The finished part is kept.")] : []));
  } catch (e) { // Google busy (it often is), no key...: said right here, like Ask AI does
    // in the pane's notice box: as a bare line at body size it read as a heading (AH-149 review r2)
    $("odd-list").replaceChildren(Object.assign(item(plainError(e, "AI could not check")), { className: "notice" }));
  }
}

// Pure: the AI's odd words as lines. AH-35: each line says it is the AI's view, and names the cell by the sheet's own
// header and column letter: the engine's name for a repeated header ("Item.1") or a blank one ("") is not one the user
// can find. AH-170: one line per word in its column, with how many rows and the first 3, at most CAP lines: one odd word
// in 100 cells gave 100 identical lines, and the pane was 9,700 px tall at 320 px
export function oddLines(odd, columns, startRow, startCol) {
  const words = new Map();
  for (const o of odd) {
    const k = JSON.stringify([o.col, o.value]);
    if (!words.has(k)) words.set(k, { ...o, rows: [] });
    words.get(k).rows.push(startRow + o.row + 2);
  }
  const col = (o) => `column ${colLetter(startCol + o.col)}${String(columns[o.col] ?? "").trim() ? ` (${columns[o.col]})` : ""}`;
  const lines = [...words.values()].map((w) => {
    const r = w.rows.sort((a, b) => a - b).map(n), first = r.slice(0, 3);
    const list = r.length > 3 ? `${first.join(", ")} and ${n(r.length - 3)} more` : `${first.slice(0, -1).join(", ")} and ${first.at(-1)}`;
    const where = r.length === 1 ? `Row ${r[0]}, ${col(w)}: "${w.value}"` : `C${col(w).slice(1)}: "${w.value}" in ${n(r.length)} rows (${list})`;
    return `${where}. The AI says: ${w.why}`;
  });
  return lines.length > CAP ? [...lines.slice(0, CAP), `+ ${n(lines.length - CAP)} more words the AI found out of place.`] : lines;
}

// AH-202: Check subject rules with AI. The engine sends the AI only the sheet's headers and each column's kind, never a
// cell; the AI names rules its subject makes true (Net = Debit − Credit) and the engine checks each on every row. AH-217:
// the ones that held are kept in the workbook in place of the sheet's last ones, and every scan checks them, with no AI
export async function checkRules() {
  const { columns, rows, startRow, startCol } = biggest(state.lastScan); // a sheet of several tables: its biggest (AH-212)
  const sheet = state.lastScan.sheet;
  busy("Asking the AI about your headers…");
  counting();
  try {
    const out = await post("/rules", { columns, rows }, 300);
    keepRules(sheet, heldOf(out));
    $("rules-list").replaceChildren(...rulesLines(out, columns, startRow, startCol).map(item));
  } catch (e) {
    $("rules-list").replaceChildren(Object.assign(item(plainError(e, "AI could not check")), { className: "notice" }));
  }
}

// Pure: what /rules found, as lines. Each rule once, with what the sheet showed of it and the AI's why; after a rule
// that holds, the rows against it, each by its sheet row and its cells' column letters and headers (never "Units.1"),
// as oddLines names them. At most CAP lines
export function rulesLines(out, columns, startRow, startCol) {
  const col = (j) => `${colLetter(startCol + j)}${String(columns[j] ?? "").trim() ? ` (${columns[j]})` : ""}`;
  const cells = (js) => (js.length === 1 ? `column ${col(js[0])}` : `columns ${js.slice(0, -1).map(col).join(", ")} and ${col(js.at(-1))}`);
  const lines = out.sent < out.headers ? [`Only the first ${n(out.sent)} of ${n(out.headers)} column headers were sent.`] : [];
  const kept = heldOf(out).length; // AH-217: said before the rules, so CAP never cuts it
  if (kept) lines.push(`Arcas keeps the ${kept === 1 ? "rule" : `${n(kept)} rules`} that held in this workbook and checks ${kept === 1 ? "it" : "them"} in every scan of this sheet, with no AI.`);
  out.rules.forEach((r, k) => {
    const why = ` The AI says: ${r.why}`;
    if (r.total < 10) lines.push(`Too few rows to check: ${r.said} (${n(r.total)} rows).${why}`);
    else if (!r.holds) lines.push(`Did not hold, so nothing was flagged: ${r.said} (true on ${n(r.held)} of ${n(r.total)} rows).${why}`);
    else lines.push(`${r.held === r.total ? `True on all ${n(r.total)} rows` : `True on ${n(r.held)} of ${n(r.total)} rows`}: ${r.said}.${why}`);
    for (const x of out.rows.filter((x) => x.rule === k)) lines.push(`Row ${n(startRow + x.row + 2)}, ${cells(x.cells)}: ${x.reason}`);
  });
  if (!out.rules.length) lines.push("The AI found no rules to check in your headers.");
  return lines.length > CAP ? [...lines.slice(0, CAP), `+ ${n(lines.length - CAP)} more lines.`] : lines;
}
