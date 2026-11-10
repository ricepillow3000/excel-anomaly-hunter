import { CAP, LAST_SCAN_KEY, POWER_BI_KEY, SEV, RANK } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { $, only, show } from "../utils/dom.js";
import { n } from "../utils/text.js";
import { busy, counting, notice } from "../components/progress.js";
import { post } from "../services/api.js";
import { getLimits, readSheet, watchSelection } from "../services/excel.js";
import { shownAs } from "../utils/sheet.js";
import { paint } from "./highlight.js";
import { renderResults } from "../pages/results.js";
import { onSelect } from "../pages/fix.js";
import { strength } from "../pages/strength.js";
import { autoFix, autoOn, autoUndo } from "./autofix.js";
import { codes, decisionsFor, rowHash } from "./decisions.js";
import { undosFor } from "./undo-store.js";

// Keep each scan for Power BI (a plain-text copy of the sheet on this PC): off unless turned on, like auto-fix
export const powerBiOn = () => { try { return localStorage.getItem(POWER_BI_KEY) === "1"; } catch { return false; } };
export const setPowerBi = (on) => { try { localStorage.setItem(POWER_BI_KEY, on ? "1" : "0"); } catch { /* private mode: stays off */ } };

// Agent 2 in the workflow: read the sheet, have the engine check it, deliver the results to the pane.
// ---- Find problems: read, check, list, highlight ----
// The scan skeleton (AH-94): a still copy of the results' shape in taskpane.html (#scan-skeleton) stands where they will
// land from the click until they render, shown by one attribute: no node is made per scan. A scan the Find problems
// button started keeps it at least HOLD ms, so a fast scan still reads as "checked" instead of a flicker; a slider
// re-check or the re-check after auto-fix never waits for it. An error, an empty sheet or the engine gone hide it.
const HOLD = 450;
const scanning = (on) => $("main-ui").toggleAttribute("data-scanning", on);

export async function runScan(auto, held = false) { // auto === false: the re-check right after auto-fix (never auto-fixes twice)
  const t0 = Date.now();
  state.fix = null;
  if (state.view !== "results") only(state.lastScan ? "results" : "empty-state"); // no fix view left without its row
  scanning(true);
  $("main-ui").toggleAttribute("data-held", true); // the progress and then "Done" take one held space till the action ends (use-action.js)
  try {
    await scan(auto, held, t0);
  } finally {
    scanning(false);
  }
}

async function scan(auto, held, t0) {
  busy("Step 1 of 3: reading your sheet…", 0);
  const s = await readSheet((p) => busy(`Step 1 of 3: reading your sheet… ${Math.round(p * 100)}%`, p));
  if (!s) {
    only("empty-state");
    return notice("Not enough data here. Put a row of column names on top, with at least one row of data below it.");
  }
  busy(`Step 2 of 3: checking ${n(s.rows.length)} rows…`);
  counting(); // the seconds it has taken: the only true measure while the engine checks (AH-149)
  const level = strength(), limits = await getLimits(); // getLimits re-reads the workbook's settings first
  // the scan before this one, to say what a new level changed (not after auto-fix's own re-check: the level is the same)
  const before = auto !== false && state.lastRows ? { level: state.lastStrength, rows: state.lastRows, hashes: state.hashes, sheet: state.lastScan?.sheet } : null;
  // the rows fixed or dismissed before, in any session: found again by their codes, wherever a sort moved them
  const hashes = s.rows.map(rowHash), keys = codes(hashes), kept = decisionsFor(s.sheet), decided = {};
  keys.forEach((k, i) => kept[k] && (decided[i] = kept[k]));
  // start_row and sheet: where the table sits, so the Power BI copy's "Excel Row" is the row number shown here;
  // decisions: its Status (Open, Fixed, Dismissed)
  const body = await post("/scan", { columns: s.columns, rows: s.rows, limits, order_by: null, strength: level,
    power_bi: powerBiOn(), start_row: s.startRow, sheet: String(s.sheet).slice(0, 31),
    decisions: Object.keys(decided).length ? s.rows.map((_, i) => decided[i] || null) : null,
    formulas: s.calc.some((r) => r.some(Boolean)) ? s.calc : null }, 300); // AH-152: each cell's formula, only if any
  if (held) await new Promise((go) => setTimeout(go, Math.max(0, HOLD - (Date.now() - t0))));
  scanning(false); // the results take the skeleton's place
  state.lastStrength = level; // Agent 3 judges fixes at the level this scan used
  state.lastScan = s;
  state.lastRows = body.rows;
  state.lastLimits = body.limits || {};
  state.undos = undosFor(s, keys); // an accepted fix found again keeps its Undo, after a reload too (AH-118)
  Object.assign(state, { hashes, codes: keys, decided });
  $("sheet-name").textContent = s.sheet;
  renderResults(body.rows, s, body.fairness);
  if (auto !== false) {
    const said = levelChange(before, { level, rows: body.rows, hashes, sheet: s.sheet });
    $("level-change").textContent = said;
    show("level-change", !!said);
  }
  // AH-157: this check's numbers, never a value or a reason, for the empty state when the file opens again. Saved only by
  // the saves a scan makes anyway (its highlights' old fills just below, the opening setting): a save of its own made
  // Excel ask to save a workbook nothing had changed (AH-150)
  const count = (sev) => body.rows.filter((r) => r.severity === sev).length;
  Office.context.document.settings.set(LAST_SCAN_KEY, { sheet: String(s.sheet).slice(0, 31), at: Date.now(), level,
    rows: body.rows.length, high: count("High"), medium: count("Medium"), low: count("Low") });
  sayLastScan();
  await paint(body.rows, s, decided); // a decided row is not highlighted again
  await watchSelection(s.sheet, onSelect);
  const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
  notice(`Done in ${secs} second${secs === 1 ? "" : "s"}.` + (body.power_bi_saved === false
    ? " The files for Power BI could not be saved. If latest-scan.csv is open in another program, close it, then click Find problems again." : ""));
  // a checked workbook reopens with this pane open (Office autoopen; manifest TaskpaneId). Set once: written on every
  // scan it made Excel ask to save a workbook nothing had changed, and opened the pane for everyone it went to (AH-150)
  const settings = Office.context.document.settings;
  if (!settings.get("Office.AutoShowTaskpaneWithDocument")) {
    settings.set("Office.AutoShowTaskpaneWithDocument", true);
    settings.saveAsync();
  }
  if (auto !== false && autoOn()) { // step 3: exact slips fixed, then the sheet checked again so the list is current
    busy("Fixing exact mistakes…");
    const fixed = await autoFix();
    if (fixed) {
      await runScan(false);
      notice(`Fixed ${n(fixed)} capitals/spaces slip${fixed === 1 ? "" : "s"} by itself, then checked again. "Undo auto-fixes" puts ${fixed === 1 ? "it" : "them"} back.`);
    }
  }
  show("undo-auto", !!autoUndo());
}

// Pure: the rows worth a look - surest first, then biggest - each with its data-row index ("Noted" = fine)
export const flaggedRows = (rows) => rows.map((r, i) => ({ ...r, i })).filter((r) => SEV[r.severity])
  .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.magnitude - a.magnitude);

// Pure: the list's rows: the flagged ones worst first, then rows decided before that are no longer flagged (a fixed
// row looks right now: it is listed as Fixed instead of vanishing), in sheet order
export const listOrder = (rows, decided = {}) => [...flaggedRows(rows).map((r) => r.i),
  ...Object.keys(decided).map(Number).filter((i) => rows[i] && !SEV[rows[i].severity]).sort((a, b) => a - b)];

// Pure: whatever the workbook holds -> the last check's numbers, or null. A crafted .xlsx can carry anything here: only a
// sheet's name and whole numbers
export function asLastScan(v) {
  const whole = (x) => Number.isInteger(x) && x >= 0;
  if (!v || typeof v !== "object" || typeof v.sheet !== "string" || !whole(v.at) || ![v.level, v.rows, v.high, v.medium, v.low].every(whole)) return null;
  return { sheet: v.sheet.slice(0, 31), at: v.at, level: v.level, rows: v.rows, high: v.high, medium: v.medium, low: v.low };
}

// Pure: the last check in words, as the summary says a scan ("Last check on Sales, 9 Nov: 12 of 300 rows looked wrong")
export function lastScanSaid(r, now = Date.now()) {
  if (!r) return "";
  const when = new Date(r.at), year = when.getFullYear() !== new Date(now).getFullYear();
  const day = when.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
  const sure = r.high + r.medium, of = `of ${n(r.rows)} row${r.rows === 1 ? "" : "s"}`, were = (k) => (k === 1 ? "was" : "were");
  const found = sure ? `${n(sure)} ${of} looked wrong${r.low ? ` and ${n(r.low)} more ${were(r.low)} worth a quick check` : ""}`
    : r.low ? `${n(r.low)} ${of} ${were(r.low)} worth a quick check` : `no problems found in ${n(r.rows)} row${r.rows === 1 ? "" : "s"}`;
  return `Last check on ${r.sheet}, ${day}: ${found}.`;
}

// The empty state says the workbook's last check, at once when the pane opens: no scan runs by itself (a scan paints)
export function sayLastScan() {
  const said = lastScanSaid(asLastScan(Office.context.document.settings.get(LAST_SCAN_KEY)));
  $("last-scan").textContent = said;
  show("last-scan", !!said);
}

// Pure: what a new slider level changed, counted from the two scans' own rows (AH-15: John moved 5 to 10 and saw the
// same list, so he read the slider as just for show). Said only when the same sheet, unchanged, was checked at another
// level: an edit between the scans would be counted as the level's doing. The rows that look wrong (High, Medium) and
// those worth a check (Low) are counted apart: the slider mostly moves the second. When 50+ rows look wrong, the new
// rows worth a check sit past the list's first 50, under "+ N more": the line says so (4,000 sales lines: 69 rows look
// wrong at 5 and at 10, and the 48 rows 10 adds were all out of sight).
export function levelChange(before, after) {
  if (!before || !after || before.level === after.level || before.sheet !== after.sheet) return "";
  if (!Array.isArray(before.rows) || before.rows.length !== after.rows.length || before.hashes?.length !== after.hashes?.length
    || before.hashes.some((h, i) => h !== after.hashes[i])) return "";
  const sure = (r) => r.severity === "High" || r.severity === "Medium", low = (r) => r.severity === "Low";
  const ids = (rows, f) => new Set(rows.flatMap((r, i) => (f(r) ? [i] : [])));
  const [s0, s1, l0, l1] = [ids(before.rows, sure), ids(after.rows, sure), ids(before.rows, low), ids(after.rows, low)];
  const gone = (a, b) => [...a].filter((i) => !b.has(i)).length;
  const some = (k, word) => `${n(k)} ${word} row${k === 1 ? "" : "s"}`; // "3 more rows", "1 fewer row"
  const head = `Slider moved from ${before.level} to ${after.level}:`;
  if (!gone(s0, s1) && !gone(s1, s0) && !gone(l0, l1) && !gone(l1, l0))
    return `${head} the same rows as at ${before.level}. Nothing on this sheet falls between the two levels.`;
  const parts = [], d = l1.size - l0.size;
  if (d) parts.push(`${some(Math.abs(d), d > 0 ? "more" : "fewer")} worth a check${d > 0 && after.level > before.level ? " (values close to the edge of usual)" : ""}`);
  else if (gone(l0, l1)) parts.push(`${some(gone(l0, l1), "other")} worth a check`);
  const up = gone(s1, s0), down = gone(s0, s1), look = (k) => (k === 1 ? "looks" : "look");
  parts.push(!up && !down ? "the rows that look wrong are the same"
    : [up && `${some(up, "more")} ${look(up)} wrong`, down && `${some(down, "fewer")} ${look(down)} wrong`].filter(Boolean).join(", "));
  // the list puts every row that looks wrong before the ones worth a check: with CAP or more of those, a new row worth a
  // check is past the first CAP, out of sight
  const hidden = s1.size >= CAP && d > 0
    ? ` The list shows the ${CAP} surest rows first, so the new ones are in the "+ more" line at its end. Your sheet colours them all.` : "";
  return `${head} ${parts.join("; ")}.${hidden}`;
}

// Pure: the summary sentence
export function summaryOf(rows) {
  const sure = rows.filter((r) => r.severity === "High" || r.severity === "Medium").length;
  const maybe = rows.filter((r) => r.severity === "Low").length;
  const more = maybe ? ` ${n(maybe)}${sure ? " more" : ""} ${maybe === 1 ? "is" : "are"} worth a quick check.` : "";
  if (!sure && !maybe) return `No problems found in ${n(rows.length)} rows.`;
  return (sure ? `${n(sure)} of ${n(rows.length)} rows look wrong.` : `Nothing clearly wrong in ${n(rows.length)} rows.`) + more;
}

// Pure: the fairness line under the summary (engine/fairness.py) - which columns are protected, and the biggest real
// gaps (a census sheet has 15: the line names 3, the full list sits under "All fairness checks"), then the engine's
// measured public context for those gaps, each sentence once (ai/bias_rules.json): a real gap is not a data error
export function fairnessNote(fair) {
  const cols = Object.keys(fair?.protected || {});
  if (!cols.length) return "";
  const gaps = fairnessTests(fair).filter((t) => t.verdict === "gap");
  const named = cols.length > 1 ? `${cols.slice(0, -1).join(", ")} or ${cols.at(-1)}` : cols[0];
  const kept = `To be fair to people, Arcas never uses ${named} to pick which rows look wrong.`;
  const more = gaps.length > 3 ? `, and ${gaps.length - 3} more under "All fairness checks"` : "";
  const context = [...new Set(gaps.slice(0, 3).map((t) => t.context).filter((c) => typeof c === "string" && c))];
  if (gaps.length) return `${kept} Groups that differ: ${gaps.slice(0, 3).map((t) => t.text).join("; ")}${more}.${context.map((c) => ` ${c}`).join("")}`;
  // no gap: name only the checks that ran ("Flags, blanks and outcomes are even" was said on a sheet that ran one
  // flag-rate check, AH-17), then the ones too few rows could prove, never "even" for them
  const tests = fair.tests || [], ran = ["flag", "missing", "outcome", "amount"].filter((m) => tests.some((t) => t.verdict === "even" && t.measure === m));
  const unclear = tests.filter((t) => t.verdict === "unclear").slice(0, 3).map((t) => t.text);
  const kinds = ran.map((m) => ({ flag: "flagged rows", missing: "blank cells", outcome: "yes/no answers", amount: "amounts" })[m]);
  const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}` : kinds[0] || "";
  const said = (list ? ` ${list[0].toUpperCase()}${list.slice(1)} come out about the same in each group.` : "") +
    (unclear.length ? ` Not enough rows to tell: ${unclear.join("; ")}.` : "");
  return `${kept}${said || " Nothing to compare: no group of 20 rows or more has flagged rows, blank cells or yes/no answers."}`;
}

// Pure: every fairness test, gaps first, the widest gap (in rate points) first
export function fairnessTests(fair) {
  // a rate's width in points; an amount's (AH-49: medians, in the column's own units) as a share of its largest median
  const width = (t) => { const r = Object.values(t.groups || {}).map((g) => g[1]); const w = r.length ? Math.max(...r) - Math.min(...r) : 0;
    return t.measure === "amount" ? (Math.max(...r) > 0 ? w / Math.max(...r) : 0) : w; };
  return [...(fair?.tests || [])].sort((a, b) => (b.verdict === "gap") - (a.verdict === "gap") || width(b) - width(a));
}

// Pure: the engine's reason in plain words, for the list and the fix view (names: tableFromGrid's, a repeated header).
// Each reason on its own line (AH-149: joined by " · " they read as one long sentence); sep "; " inside a sentence
export function plainReason(reason, names = state.lastScan?.names, sep = "\n") {
  return shownAs(String(reason || "")
    .replace(/^Flagged by \d+ of \d+: /, "")
    .replace(/(\S[^;]*?) weird limit is ([^;\s]+); this is ([^;\s]+)/g, (_, c, lim, v) => `${c} is ${v}, ${+v < +lim ? "below" : "above"} its usual limit of ${lim}`)
    .replace(/Unusual combination of values, mainly (.+?)(?=;|$)/g, "Unusual mix of values, mostly in $1")
    .replace(/ is unusual relative to its local trend near/g, " breaks its usual pattern near")
    .replace(/ 00:00:00/g, "")
    .split("; ").join(sep), names);
}
