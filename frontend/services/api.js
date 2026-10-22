import { SERVER } from "../constants/index.js";

// Talking to the local back end (engine + AI client).
export async function getHealth() {
  const r = await fetch(`${SERVER}/health`);
  if (!r.ok) throw new Error("engine not answering");
  return r.json();
}

export async function post(path, body, seconds = 120) { // a stuck engine never leaves the pane waiting forever
  const r = await fetch(SERVER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(seconds * 1000),
  }).catch((e) => {
    if (e.name === "TimeoutError") throw new Error(`the checker took over ${seconds} seconds. Try again.`);
    // the exe is what most people have (install.bat only in a source folder or an invite kit), as #server-down says
    throw new Error("the checker isn't running. Double-click AnomalyHunter.exe again (from a source folder: install.bat), then try again.");
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && !j.error) throw new Error("the checker is out of date. Close Excel, then run the newest AnomalyHunter.exe (from a source folder: install.bat).");
  if (!r.ok) { // the status rides along: a refused key (400) is cleared from its box, a save that failed (503) is not
    const err = new Error(j.error || "the checker returned an error.");
    err.status = r.status;
    throw err;
  }
  return j;
}
