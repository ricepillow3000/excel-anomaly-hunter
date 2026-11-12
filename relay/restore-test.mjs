// Backup restore rehearsal for the invite list (AH-124): node relay/restore-test.mjs (relay/test.mjs runs it too, so
// tools/check.py and CI's security job run it on every push). docs/RUNBOOK.md says to keep a second copy of
// relay/tokens.json, because Cloudflare can't give the TOKENS secret back; a backup nobody has restored is a hope.
// This makes the list the way new-invite.mjs does, copies it to a backup folder, loses the original, restores it,
// loads it the way the worker loads TOKENS (the file's text, as `type tokens.json | wrangler secret put TOKENS` sends
// it) and proves both invites still work and the daily caps still count. It also shows what the backup saves people
// from: a fresh list made without it switches every old invite off.
import assert from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker, { Counter } from "./worker.js";

const hash = (code) => createHash("sha256").update(code).digest("hex"); // new-invite.mjs's own hash
const invite = () => "inv_" + randomBytes(18).toString("base64url"); // and its own codes

// a Durable Object stub: one Counter, requests handled one at a time (as Cloudflare does)
function namespace() {
  const store = new Map(), obj = new Counter({ storage: { get: async (k) => store.get(k), put: async (k, v) => store.set(k, v) } });
  let queue = Promise.resolve();
  return { idFromName: () => "caps", get: () => ({ fetch: (u, init) => (queue = queue.then(() => obj.fetch(new Request(u, init)))) }) };
}

const realFetch = globalThis.fetch;
let reachedGoogle = 0;
globalThis.fetch = async () => { // a stand-in Google that always answers
  reachedGoogle++;
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"explanation":"x","changes":[]}' } }] }), { status: 200 });
};
const good = JSON.stringify({ messages: [{ role: "user", content: "Fix row 7" }], response_format: { type: "json_schema", json_schema: { name: "fix", schema: {} } } });
const call = (env, code) => worker.fetch(new Request("https://relay.example/fix", {
  method: "POST", headers: { Authorization: `Bearer ${code}` }, body: good }), env);

const dir = mkdtempSync(join(tmpdir(), "restore-"));
try {
  // 1. John's PC: two invites made, the list saved as new-invite.mjs saves it, and a copy kept in a second place
  const ana = invite(), ben = invite();
  const tokensFile = join(dir, "relay", "tokens.json"), backup = join(dir, "second-private-place", "tokens.json");
  mkdirSync(join(dir, "relay"));
  mkdirSync(join(dir, "second-private-place"));
  writeFileSync(tokensFile, JSON.stringify({ [hash(ana)]: "Ana", [hash(ben)]: "Ben" }));
  copyFileSync(tokensFile, backup);
  const original = readFileSync(tokensFile, "utf8");
  assert.ok(!original.includes(ana) && !original.includes(ben), "the list holds hashes, never the codes");

  // 2. the PC is lost: tokens.json is gone, and Cloudflare can't give the secret back
  rmSync(tokensFile);
  assert.ok(!existsSync(tokensFile));

  // what the backup saves people from: a fresh list for a new invite, uploaded, switches every old invite off
  const cara = invite();
  const fresh = { TOKENS: JSON.stringify({ [hash(cara)]: "Cara" }), GEMINI_KEY: "AQ.test", COUNTER: namespace(), DAILY_PER_INVITE: "2", DAILY_TOTAL: "3" };
  assert.equal((await call(fresh, ana)).status, 401, "without the backup, Ana's invite is off");
  assert.equal((await call(fresh, ben)).status, 401, "and so is Ben's");

  // 3. restored from the backup, byte for byte, and uploaded as the TOKENS secret (the file's text)
  copyFileSync(backup, tokensFile);
  const restored = readFileSync(tokensFile, "utf8");
  assert.equal(restored, original, "the restored list is the list that was lost");
  const env = { TOKENS: restored, GEMINI_KEY: "AQ.test", COUNTER: namespace(), DAILY_PER_INVITE: "2", DAILY_TOTAL: "3" };

  // 4. both invites work again, and the caps still count: 2 a day each, 3 for everyone together
  const before = reachedGoogle;
  assert.equal((await call(env, ana)).status, 200, "Ana's invite works after the restore");
  assert.equal((await call(env, ben)).status, 200, "Ben's invite works after the restore");
  assert.equal((await call(env, ana)).status, 200, "Ana's 2nd fix today");
  assert.equal((await call(env, ana)).status, 429, "Ana's daily cap still counts");
  assert.equal((await call(env, ben)).status, 429, "the shared daily cap still counts (3 used)");
  assert.equal(reachedGoogle - before, 3, "exactly 3 calls reached Google");
  assert.equal((await call(env, "inv_" + "x".repeat(24))).status, 401, "a code that was never invited stays out");
} finally {
  rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = realFetch;
}
console.log("relay restore rehearsal passed");
