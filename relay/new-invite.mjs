// Make an invite kit for one person: node relay/new-invite.mjs "Ana"
// Writes kits/Ana.zip = this repo as committed + Ana's invite-code.txt beside install.bat, so installing switches AI help
// on with nothing to paste. Keeps relay/tokens.json = {"<hash>": "name"}, the WHOLE TOKENS secret (never in git: upload
// it after every change). The relay keeps only hashes, so even its settings can't reveal anyone's code.
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const name = process.argv[2];
// the name becomes a file name: ASCII letters, digits, space . _ - only (no path tricks)
if (!/^[\w .-]{1,40}$/.test(name || "") || /^\.+$/.test(name)) throw new Error('usage: node relay/new-invite.mjs "Name"  (letters, digits, space . _ -)');
const relay = dirname(fileURLToPath(import.meta.url)), repo = dirname(relay);
if (readFileSync(join(repo, "backend/anomaly_hunter/ai/client.py"), "utf8").includes('"ANOMALY_HUNTER_RELAY", "")'))
  console.log("WARNING: RELAY_URL isn't set in client.py yet - this kit's AI help stays off. Rebuild it after the deploy.\n");

// one code per person: a new code for someone replaces (switches off) their old one
const code = "inv_" + randomBytes(18).toString("base64url");
const tokensFile = join(relay, "tokens.json");
// tokens.json lives on ONE PC (never in git) and an upload replaces the whole list: a fresh list here = everyone else off
if (!existsSync(tokensFile))
  console.log("WARNING: no relay/tokens.json on this PC - uploading this list switches OFF every invite not in it.\n" +
    "Copy tokens.json (hashes only) from the PC that made the other kits first, unless this is the very first invite.\n");
const tokens = Object.fromEntries(Object.entries(existsSync(tokensFile) ? JSON.parse(readFileSync(tokensFile, "utf8")) : {})
  .filter(([, who]) => who !== name));
tokens[createHash("sha256").update(code).digest("hex")] = name;

// the kit: committed files only (HEAD), so nothing local - keys, .venv, other kits - can slip in
if (execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim())
  console.log("WARNING: uncommitted changes are NOT in this kit (it is built from the last commit).\n");
const tmp = mkdtempSync(join(tmpdir(), "invite-"));
writeFileSync(join(tmp, "invite-code.txt"), code);
mkdirSync(join(repo, "kits"), { recursive: true });
const zip = join(repo, "kits", `${name}.zip`);
try {
  execFileSync("git", ["-C", repo, "archive", "--format=zip", "--prefix=anomaly-hunter/", `--add-file=${join(tmp, "invite-code.txt")}`, "-o", zip, "HEAD"]);
} finally {
  rmSync(tmp, { recursive: true });
}
writeFileSync(tokensFile, JSON.stringify(tokens)); // only once the kit exists: no code without a kit

console.log(`Kit for ${name}: ${zip}`);
console.log("1. Upload the invite list (the whole list - it replaces the old one), from the relay folder:");
console.log("     type tokens.json | npx wrangler secret put TOKENS");
console.log("2. Share the zip by a Google Drive or OneDrive link (email blocks .bat files, even zipped).");
console.log("   They unzip it, close Excel, double-click install.bat: AI help is on, nothing to paste.");
console.log(`Switch ${name} off later: delete their entry from tokens.json, then step 1 again.`);
