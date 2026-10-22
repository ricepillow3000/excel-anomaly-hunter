import { POWER_BI_KEY, SEV, RANK } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { $, only, show } from "../utils/dom.js";
import { n } from "../utils/text.js";
import { busy, notice } from "../components/progress.js";
import { post } from "../services/api.js";
import { getLimits, readSheet, watchSelection } from "../services/excel.js";
import { paint } from "./highlight.js";
import { renderResults } from "../pages/results.js";
import { onSelect } from "../pages/fix.js";
import { strength } from "../pages/strength.js";
import { autoFix, autoOn, autoUndo } from "./autofix.js";
import { codes, decisionsFor, rowHash } from "./decisions.js";

// Keep each scan for Power BI (a plain-text copy of the sheet on this PC): off unless turned on, like auto-fix
export const powerBiOn = () => { try { return localStorage.getItem(POWER_BI_KEY) === "1"; } catch { return false; } };
export const setPowerBi = (on) => { try { localStorage.setItem(POWER_BI_KEY, on ? "1" : "0"); } catch { /* private mode: stays off */ } };

// Agent 2 in the workflow: read the sheet, have the engine check it, deliver the results to the pane.
// ---- Find problems: read, check, list, highlight ----
export async function runScan(auto) { // auto === false: the re-check right after auto-fix (never auto-fixes twice)
  const t0 = Date.now();
  state.fix = null;
  if (state.view !== "results") only(state.lastScan ? "results" : "empty-state"); // no fix view left without its row
  busy("Step 1 of 3: reading your sheet…", 0);
  const s = await readSheet((p) => busy(`Step 1 of 3: reading your sheet… ${Math.round(p * 100)}%`, p));
  if (!s) {
    only("empty-state");
    return notice("Not enough data here. Put a row of column names on top, with at least one row of data below it.");
  }
  busy(`Step 2 of 3: checking ${n(s.rows.length)} rows…`);
  const level = strength(), limits = await getLimits(); // getLimits re-reads the workbook's settings first
  // the rows fixed or dismissed before, in any session: found again by their codes, wherever a sort moved them
  const hashes = s.rows.map(rowHash), keys = codes(hashes), kept = decisionsFor(s.sheet), decided = {};
  keys.forEach((k, i) => kept[k] && (decided[i] = kept[k]));
  // start_row and sheet: where the table sits, so the Power BI copy's "Excel Row" is the row number shown here;
  // decisions: its Status (Open, Fixed, Dismissed)
  const body = await post("/scan", { columns: s.columns, rows: s.rows, limits, order_by: null, strength: level,
    power_bi: powerBiOn(), start_row: s.startRow, sheet: String(s.sheet).slice(0, 31),
    decisions: Object.keys(decided).length ? s.rows.map((_, i) => decided[i] || null) : null }, 300);
  state.lastStrength = level; // Agent 3 judges fixes at the level this scan used
  state.lastScan = s;
  state.lastRows = body.rows;
  state.lastLimits = body.limits || {};
  state.undos = {};
  Object.assign(state, { hashes, codes: keys, decided });
  $("sheet-name").textContent = s.sheet;
  renderResults(body.rows, s, body.fairness);
  await paint(body.rows, s, decided); // a decided row is not highlighted again
  await watchSelection(s.sheet, onSelect);
  const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
  notice(`Done in ${secs} second${secs === 1 ? "" : "s"}.` + (body.power_bi_saved === false
    ? " The Power BI copy couldn't be saved (is latest-scan.csv open in another program?) - details in server.log." : ""));
  // a checked workbook reopens with this pane open (Office autoopen; manifest TaskpaneId)
  Office.context.document.settings.set("Office.AutoShowTaskpaneWithDocument", true);
  Office.context.document.settings.saveAsync();
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
  const kept = `Fairness: ${cols.join(", ")} ${cols.length === 1 ? "is" : "are"} never used to decide which rows are unusual.`;
  const more = gaps.length > 3 ? ` - and ${gaps.length - 3} more under "All fairness checks"` : "";
  const context = [...new Set(gaps.slice(0, 3).map((t) => t.context).filter((c) => typeof c === "string" && c))];
  if (gaps.length) return `${kept} Check these gaps between groups: ${gaps.slice(0, 3).map((t) => t.text).join("; ")}${more}.${context.map((c) => ` ${c}`).join("")}`;
  // no gap: name only the checks that ran ("Flags, blanks and outcomes are even" was said on a sheet that ran one
  // flag-rate check, AH-17), then the ones too few rows could prove, never "even" for them
  const tests = fair.tests || [], ran = ["flag", "missing", "outcome"].filter((m) => tests.some((t) => t.verdict === "even" && t.measure === m));
  const unclear = tests.filter((t) => t.verdict === "unclear").slice(0, 3).map((t) => t.text);
  const kinds = ran.map((m) => ({ flag: "flags", missing: "blanks", outcome: "outcomes" })[m]);
  const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}` : kinds[0] || "";
  const said = (list ? ` ${list[0].toUpperCase()}${list.slice(1)} are even across ${cols.length === 1 ? "its" : "their"} groups.` : "") +
    (unclear.length ? ` Not enough rows to tell: ${unclear.join("; ")}.` : "");
  return `${kept}${said || ` Nothing to compare between ${cols.length === 1 ? "its" : "their"} groups: no flags, blanks or yes/no results in groups of 20 rows or more.`}`;
}

// Pure: every fairness test, gaps first, the widest gap (in rate points) first
export function fairnessTests(fair) {
  const width = (t) => { const r = Object.values(t.groups || {}).map((g) => g[1]); return r.length ? Math.max(...r) - Math.min(...r) : 0; };
  return [...(fair?.tests || [])].sort((a, b) => (b.verdict === "gap") - (a.verdict === "gap") || width(b) - width(a));
}

// Pure: the engine's reason in plain words, for the list and the fix view
export function plainReason(reason) {
  return String(reason || "")
    .replace(/^Flagged by \d+ of \d+: /, "")
    .replace(/(\S[^;]*?) weird limit is ([^;\s]+); this is ([^;\s]+)/g, (_, c, lim, v) => `${c} is ${v}, ${+v < +lim ? "below" : "above"} its usual limit of ${lim}`)
    .replace(/Unusual combination of values, mainly (.+?)(?=;|$)/g, "Unusual mix of values, mostly in $1")
    .replace(/ is unusual relative to its local trend near/g, " breaks its usual pattern near")
    .replace(/ 00:00:00/g, "")
    .split("; ").join(" · ");
}
