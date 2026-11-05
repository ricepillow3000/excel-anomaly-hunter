import { SERVER } from "../constants/index.js";
import { ours } from "../utils/errors.js";

// Talking to the local back end (engine + AI client). Every error thrown here is a sentence of ours (utils/errors.js):
// the pane shows it as it is, where an Office or script error gets plain words instead (AH-110).
// An engine that takes the call and never answers (hung, or another program on the port) left the start-up check
// waiting for good, on the skeleton (AH-87): after 10 s it is "Arcas has stopped", with Try again
export async function getHealth(seconds = 10) {
  const r = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(seconds * 1000) });
  if (!r.ok) throw ours("engine not answering");
  return r.json();
}

export async function post(path, body, seconds = 120) { // a stuck engine never leaves the pane waiting forever
  const r = await fetch(SERVER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(seconds * 1000),
  }).catch((e) => {
    if (e.name === "TimeoutError") throw ours(`the checker took over ${seconds} seconds. Try again.`);
    // AH-135: as #server-down says it, in words a person with few computer skills can act on. The exe is what most people
    // have, in their Downloads folder; the pane can't tell a source folder or an invite kit from it, so it names only that.
    // "try again", not "press Try again": here it is the button they pressed (Find problems, Accept...)
    throw ours("Arcas has stopped. Wait half a minute and try again. If that doesn't work, open your Downloads folder, double-click Arcas.exe, then try again.");
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && !j.error) throw ours("the checker is out of date. Close Excel, then run the newest Arcas.exe (from a source folder: install.bat).");
  if (!r.ok) { // the status rides along: a refused key (400) is cleared from its box, a save that failed (503) is not
    const err = ours(typeof j.error === "string" && j.error ? j.error : "the checker returned an error.");
    err.status = r.status;
    throw err;
  }
  return j;
}
