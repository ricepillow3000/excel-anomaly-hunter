// Make an invite code for one person: node relay/new-invite.mjs "Ana"
// Prints the code (give it to that person, privately) and the line to add to the relay's TOKENS secret.
// The relay keeps only the hash, so even the relay's settings can't reveal anyone's code.
import { randomBytes, createHash } from "node:crypto";

const name = process.argv[2];
if (!name) throw new Error('usage: node relay/new-invite.mjs "Name"');
const code = "inv_" + randomBytes(18).toString("base64url");
const hash = createHash("sha256").update(code).digest("hex");
console.log(`Invite code for ${name} (send privately, shown once): ${code}`);
console.log(`Add to the TOKENS secret JSON:  "${hash}": "${name}"`);
console.log("Switch it off later by removing that line and running: npx wrangler secret put TOKENS");
