// The browser trusts the test engine's own certificate, the way a real install trusts it (the installer adds ca.pem).
// With only ignoreHTTPSErrors, Chromium refused each new TLS connection first and retried past it: 2,036
// "certificate unknown" alerts in 60 pane loads, and under load a file ran out of retries (ERR_TOO_MANY_RETRIES on
// assets/plus-jakarta-sans.woff2, 5 failed e2e runs on 23 Oct). Trusting this one key: 0 alerts in 60 loads (AH-43).
import crypto from "node:crypto";
import fs from "node:fs";

export function trustArgs(dir) {
  let pem;
  try { pem = fs.readFileSync(dir + "cert/cert.pem"); } catch { return []; } // run alone against another engine
  const spki = new crypto.X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
  return [`--ignore-certificate-errors-spki-list=${crypto.createHash("sha256").update(spki).digest("base64")}`];
}
