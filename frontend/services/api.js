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
    throw new Error("the checker isn't running. Double-click install.bat, then try again.");
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && !j.error) throw new Error("the checker is out of date. Close Excel and double-click install.bat.");
  if (!r.ok) throw new Error(j.error || "the checker returned an error.");
  return j;
}
