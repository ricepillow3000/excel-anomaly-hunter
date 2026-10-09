// Anomaly Hunter task pane - entry point. Plain JS modules, no build. Talks to the local back end at the same origin.
// Workflow: Home -> Find problems (Agent 1 in the engine) -> highlight -> results (Agent 2) -> fix a row / Ask AI.
import { state } from "./hooks/use-state.js";
import { $, show, only } from "./utils/dom.js";
import { act } from "./hooks/use-action.js";
import { getHealth } from "./services/api.js";
import { saveLimits } from "./services/excel.js";
import { runScan } from "./features/scan.js";
import { clearHighlights } from "./features/highlight.js";
import { applyFix, undoFix } from "./features/fix.js";
import { setAi, askFix } from "./features/ai.js";
import { showHome } from "./pages/home.js";
import { openLimitsEditor, saveLimitsAndRescan } from "./pages/limits.js";
import { initSettings } from "./pages/settings.js";

if (typeof Office !== "undefined") {
  Office.onReady((info) => {
    if (info.host !== Office.HostType.Excel) return;
    show("sideload-msg", false);
    show("app-body");
    $("scan").onclick = act(runScan);
    $("retry-health").onclick = checkHealth;
    $("clear-highlights").onclick = act(clearHighlights);
    $("edit-limits").onclick = openLimitsEditor;
    $("cancel-limits").onclick = () => only(state.lastScan ? "results" : "empty-state");
    $("save-limits").onclick = act(saveLimitsAndRescan);
    $("auto-limits").onclick = act(async () => (saveLimits(null), await runScan()));
    $("fix-back").onclick = () => ((state.fix = null), only("results"));
    $("fix-apply").onclick = act(() => state.fix && applyFix(state.fix, state.fix.changes, state.fix.sheet));
    $("fix-undo").onclick = act(() => state.fix && undoFix(state.fix));
    $("fix-ask").onclick = askFix;
    $("fix-intent").onkeydown = (e) => e.key === "Enter" && e.ctrlKey && askFix();
    initSettings();
    Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet().load("name");
      await ctx.sync();
      $("sheet-name").textContent = sheet.name;
    });
    showHome();
    checkHealth();
  });
}

async function checkHealth() {
  try {
    setAi((await getHealth()).ai_available);
    show("main-ui");
    show("server-down", false);
  } catch {
    show("main-ui", false);
    show("server-down");
  }
}
