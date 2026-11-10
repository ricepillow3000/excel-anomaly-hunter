// Arcas task pane - entry point. Plain JS modules, no build. Talks to the local back end at the same origin.
// Workflow: Home -> Find problems (Agent 1 in the engine) -> highlight -> results (Agent 2) -> a row's card: Accept / Dismiss / Ask AI
// -> Agent 3 in the engine checks AI fixes before they show, and every accepted fix after it is written.
import { state } from "./hooks/use-state.js";
import { $, show, only } from "./utils/dom.js";
import { act, oneClickEach } from "./hooks/use-action.js";
import { getHealth } from "./services/api.js";
import { activeSheet, saveLimits } from "./services/excel.js";
import { powerBiOn, runScan, setPowerBi } from "./features/scan.js";
import { clearHighlights } from "./features/highlight.js";
import { applyFix, undoFix } from "./features/fix.js";
import { setAi, askFix, checkWords } from "./features/ai.js";
import { openLimitsEditor, saveLimitsAndRescan } from "./pages/limits.js";
import { backToList, dismissFix, nextFix } from "./pages/fix.js";
import { initStrength } from "./pages/strength.js";
import { autoOn, setAuto, autoUndo, undoAutoFix } from "./features/autofix.js";
import { notice } from "./components/progress.js";
import { n } from "./utils/text.js";
import { initSettings } from "./pages/settings.js";
import { initMotion } from "./components/motion.js";
import { plainError } from "./utils/errors.js";

const CARD = "#fix-view"; // what a card does turns off only the card's buttons (AH-149)

if (typeof Office !== "undefined") {
  Office.onReady((info) => {
    if (info.host !== Office.HostType.Excel) return;
    show("sideload-msg", false);
    show("app-body");
    initMotion();
    oneClickEach();
    $("scan").onclick = act(() => runScan(true, true)); // held: the skeleton stays long enough to be seen
    $("retry-health").onclick = checkHealth;
    $("clear-highlights").onclick = act(clearHighlights);
    $("edit-limits").onclick = openLimitsEditor;
    $("cancel-limits").onclick = () => only(state.lastScan ? "results" : "empty-state");
    $("save-limits").onclick = act(saveLimitsAndRescan);
    $("auto-limits").onclick = act(async () => (saveLimits(null), await runScan()));
    $("fix-back").onclick = () => { backToList().catch((e) => notice(plainError(e))); };
    $("fix-apply").onclick = act(() => state.fix && applyFix(state.fix, state.fix.changes, state.fix.sheet), CARD);
    $("fix-undo").onclick = act(() => state.fix && undoFix(state.fix), CARD);
    $("fix-dismiss").onclick = act(dismissFix, CARD);
    $("fix-next").onclick = act(nextFix, CARD);
    $("fix-ask").onclick = askFix;
    // AH-149: a request to start from fills the box and sends nothing; Ask AI sends it
    for (const b of document.querySelectorAll("#fix-tries .try")) b.addEventListener("click", () => { $("fix-intent").value = b.textContent; $("fix-intent").focus(); });
    $("odd-check").onclick = act(checkWords);
    // only Ctrl+Enter (Cmd+Enter on a Mac) is ours; every other key types, Enter makes a new line. The old DOM0
    // `onkeydown = (e) => e.key === "Enter" && e.ctrlKey && askFix()` returned false for every other key, and a DOM0
    // handler returning false cancels the key: nothing could be typed in this box (2026-10-20)
    $("fix-intent").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      askFix();
    });
    initSettings();
    initStrength(act(runScan));
    $("auto-fix").checked = autoOn(); // off unless turned on, on this PC
    $("auto-fix").onchange = () => setAuto($("auto-fix").checked);
    $("power-bi").checked = powerBiOn(); // off unless turned on: no copy of the sheet is kept
    $("power-bi").onchange = () => setPowerBi($("power-bi").checked);
    $("undo-auto").onclick = act(async () => {
      const [back, left] = await undoAutoFix();
      await runScan(false); // checked again, but never auto-fixed again right away
      notice(`Put back ${n(back)} auto-fixed cell${back === 1 ? "" : "s"}` + (left ? `; ${n(left)} that changed since (edited or sorted) ${left === 1 ? "was" : "were"} left alone.` : "."));
    });
    show("undo-auto", !!autoUndo());
    activeSheet().then((name) => { $("sheet-name").textContent = name; }).catch(() => {}); // Excel refuses while a cell is being typed in: the name stays blank until the first scan (AH-58)
    only("empty-state");
    checkHealth();
  });
}

async function checkHealth() {
  try {
    const h = await getHealth();
    setAi(h.ai_available);
    // which engine answers: an old one gave 2 of 279 on a credit sheet and looked just like a new one (2026-10-15)
    $("engine-version").textContent = `Engine ${h.version || "from before 2026-10-15: update it"}`;
    show("main-ui");
    show("server-down", false);
  } catch {
    show("main-ui", false);
    show("server-down");
  }
}
