import { SEV, RANK } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { $, only } from "../utils/dom.js";
import { n } from "../utils/text.js";
import { busy, notice } from "../components/progress.js";
import { post } from "../services/api.js";
import { getLimits, readSheet, watchSelection } from "../services/excel.js";
import { paint } from "./highlight.js";
import { renderResults } from "../pages/results.js";
import { onSelect } from "../pages/fix.js";

// Agent 2 in the workflow: read the sheet, have the engine check it, deliver the results to the pane.
// ---- Find problems: read, check, list, highlight ----
export async function runScan() {
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
  const body = await post("/scan", { columns: s.columns, rows: s.rows, limits: await getLimits(), order_by: null }, 300);
  state.lastScan = s;
  state.lastRows = body.rows;
  state.lastLimits = body.limits || {};
  state.undos = {};
  state.handled = new Set();
  $("sheet-name").textContent = s.sheet;
  renderResults(body.rows, s);
  await paint(body.rows, s);
  await watchSelection(s.sheet, onSelect);
  const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
  notice(`Done in ${secs} second${secs === 1 ? "" : "s"}.`);
  // a checked workbook reopens with this pane open (Office autoopen; manifest TaskpaneId)
  Office.context.document.settings.set("Office.AutoShowTaskpaneWithDocument", true);
  Office.context.document.settings.saveAsync();
}

// Pure: the rows worth a look - surest first, then biggest - each with its data-row index ("Noted" = fine)
export const flaggedRows = (rows) => rows.map((r, i) => ({ ...r, i })).filter((r) => SEV[r.severity])
  .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.magnitude - a.magnitude);

// Pure: the summary sentence
export function summaryOf(rows) {
  const sure = rows.filter((r) => r.severity === "High" || r.severity === "Medium").length;
  const maybe = rows.filter((r) => r.severity === "Low").length;
  const more = maybe ? ` ${n(maybe)}${sure ? " more" : ""} ${maybe === 1 ? "is" : "are"} worth a quick check.` : "";
  if (!sure && !maybe) return `No problems found in ${n(rows.length)} rows.`;
  return (sure ? `${n(sure)} of ${n(rows.length)} rows look wrong.` : `Nothing clearly wrong in ${n(rows.length)} rows.`) + more;
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
