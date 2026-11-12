// One real call through the live relay with an invite John made for this check alone (AH-108). The stranger probes
// prove only refusals, so a revoked Gemini key or a retired model would break Ask AI for every invited user while
// every probe stayed green. The body has the engine's own shape (ai/client.py _body and FIX_SCHEMA) and a made-up
// two-cell sheet, never anyone's data. Each call counts against that invite's daily cap and the shared one, like a
// user's. live-probe.mjs runs it when RELAY_CANARY_INVITE is set.
// AH-162: that secret was never set (an invite means re-uploading the whole TOKENS list from John's PC), so the check
// never ran. With no invite it calls as the public tier does, with no Authorization header at all (an empty Bearer is
// a 401), and spends one of the public tier's daily calls: that needs no secret and still proves the key and the model.
const FIX_SCHEMA = { type: "object", required: ["explanation", "changes"], properties: {
  explanation: { type: "string" },
  changes: { type: "array", items: { type: "object", required: ["cell", "new"],
    properties: { cell: { type: "string" }, new: { type: "string" } } } } } };

export const body = () => JSON.stringify({
  model: "gemini-3.8-flash", // the relay sets its own model; sent as the engine sends it
  messages: [{ role: "user", content: "A check that the service works. Made-up sheet: A1 = 2, A2 = 3. " +
    'Answer with the explanation "ok" and no changes.' }],
  response_format: { type: "json_schema", json_schema: { name: "fix", schema: FIX_SCHEMA } },
});

// -> { ok, line }: ok only for HTTP 200 and an answer the engine can read (choices[0].message.content is the fix JSON,
// not cut off). The line never holds the invite, even where an answer quotes it.
export async function canary(relay, invite, fetchFn = fetch) {
  const how = invite ? "with the canary invite" : "with no invite (public tier)";
  // split("") would put "[invite]" between every letter
  const hide = (text) => (invite ? String(text).split(invite).join("[invite]") : String(text));
  let status, text;
  try {
    const r = await fetchFn(relay.replace(/\/+$/, "") + "/fix", {
      method: "POST", body: body(), signal: AbortSignal.timeout(120000),
      headers: { "Content-Type": "application/json", ...(invite && { Authorization: `Bearer ${invite}` }) },
    });
    status = r.status;
    text = await r.text();
  } catch (e) {
    return { ok: false, line: `FAIL  canary: one real call ${how} -> ${hide(`${e.name}: ${e.message}`)}` };
  }
  let why = status === 200 ? "" : `HTTP ${status}`;
  if (!why) {
    try {
      const choice = JSON.parse(text).choices[0];
      const fix = JSON.parse(choice.message.content);
      if (choice.finish_reason === "length") why = "the answer was cut off";
      else if (typeof fix.explanation !== "string" || !Array.isArray(fix.changes)) why = "the answer is not the fix shape";
    } catch {
      why = "the answer is not the JSON the engine reads";
    }
  }
  return why
    ? { ok: false, line: `FAIL  canary: one real call ${how} -> ${why}: ${hide(text ?? "").slice(0, 120)}` }
    : { ok: true, line: `PASS  canary: one real call ${how} -> 200, an answer the engine can read` };
}
