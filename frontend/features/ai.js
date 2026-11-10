import { state } from "../hooks/use-state.js";
import { $, show, turnOn } from "../utils/dom.js";
import { post } from "../services/api.js";
import { showFix } from "../components/fix-preview.js";
import { checkFix } from "./fix.js";
import { plainReason } from "./scan.js";
import { colLetter } from "../utils/sheet.js";
import { isOurs, plainError } from "../utils/errors.js";
import { recall } from "./memory.js";

// Ask AI: the API client in the workflow (the engine forwards to Gemini). Optional; fixes work without it.
// AH-151: with no key or invite of its own the engine uses John's relay ("free"), and the options say so
const FREE_ON = "AI help is on, using a free shared AI with a few requests a day for each internet connection. For more, paste your own free Google key below.";

export function setAi(on, provider = state.aiProvider) {
  state.aiAvailable = !!on;
  state.aiProvider = provider ?? null;
  show("ai-box", state.aiAvailable);
  show("ai-off", !state.aiAvailable);
  show("odd-box", state.aiAvailable);
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
  try {
    const out = await post("/key", { key: key.trim() });
    $("ai-key").value = ""; // the key never stays on screen
    setAi(out.ai_available, out.ai_provider);
    // the engine tested the key with Google: "Key works", or why it was saved untested
    // only Remove reaches here without a message (Save sends a key); a Claude key set in Windows can keep AI on
    keySaid(out.message || (out.ai_provider === "free" ? "Key removed. AI help uses the free shared AI again."
      : out.ai_available ? "Key removed. AI help still uses the paid Claude key set on this PC." : "Key removed. AI help is off."));
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
    const { columns, rows, startRow, startCol } = state.lastScan, reason = state.lastRows[f.i].reason;
    // AH-143: the fixes the user accepted before in the flagged column, the one the engine reads from the reason (the
    // longest header it names: "Column 31" over "Column 3"); the engine ranks them and picks which go (AH-153)
    const flagged = columns.map(String).filter((c) => c.trim() && String(reason ?? "").includes(c)).sort((a, b) => b.length - a.length)[0];
    const memory = flagged ? recall(flagged) : [];
    const out = await post("/fix", {
      columns, rows, row_index: f.i, start_row: startRow, start_col: startCol,
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
  $("fix-care").textContent = words;
  show("fix-care");
  if (state.undos[f.i]) return; // an accepted fix keeps its Undo and what it changed
  // no earlier suggestion beside the helpline message: a formula card next to it read as if the pane had not listened
  // (AH-125 live check, 2026-11-05)
  f.changes = [];
  show("fix-label", false);
  $("fix-changes").innerHTML = "";
  $("fix-explanation").textContent = "";
  show("fix-apply", false);
}

// The AI word check: a value that is a different KIND of thing from the rest of its column ("London" among products).
// The engine sends only each text column's distinct words. Worth a look, not proof: nothing is changed in the sheet.
export async function checkWords() {
  const { columns, rows, startRow, startCol } = state.lastScan;
  // AH-35: each line says it is the AI's view, and names the cell by the sheet's own header and column letter: the
  // engine's name for a repeated header ("Item.1") or a blank one ("") is not one the user can find
  const at = (o) => `Row ${startRow + o.row + 2}, column ${colLetter(startCol + o.col)}${String(columns[o.col] ?? "").trim() ? ` (${columns[o.col]})` : ""}`;
  const item = (text) => Object.assign(document.createElement("li"), { textContent: text }); // AI text is never HTML
  try {
    const { odd, partial } = await post("/odd-text", { columns, rows }, 300);
    $("odd-list").replaceChildren(...(odd.length ? odd.map((o) => item(`${at(o)}: "${o.value}". The AI says: ${o.why}`))
      : [item(partial ? "Nothing out of place so far." : "Nothing looks out of place.")]),
    ...(partial ? [item("Google got busy before every word was checked. Click again to check the rest. The finished part is kept.")] : []));
  } catch (e) { // Google busy (it often is), no key...: said right here, like Ask AI does
    // in the pane's notice box: as a bare line at body size it read as a heading (AH-149 review r2)
    $("odd-list").replaceChildren(Object.assign(item(plainError(e, "AI could not check")), { className: "notice" }));
  }
}
