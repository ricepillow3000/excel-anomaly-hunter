"""Local HTTPS server, 127.0.0.1 only. Engine API + serves panel/ at same origin (no CORS, no build)."""
import datetime
import ipaddress
import json
import math
import os
import re
import ssl
import sys
import urllib.request
from collections import Counter
from pathlib import Path

import anthropic
import pandas as pd
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from flask import Flask, request

from anomaly_hunter.agents import checker, scan_agent
from anomaly_hunter.ai import client
from anomaly_hunter.engine.detectors import K

PANEL = Path(__file__).resolve().parents[2] / "frontend"  # the pane, served as-is
HOME = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local") / "AnomalyHunter"  # cert, key, log
CERT_NAME = "Anomaly Hunter local CA"  # install.bat finds the trusted CA by this name
PORT = 5055
LOCAL = {"127.0.0.1", "localhost"}
ORIGINS = {None, f"https://127.0.0.1:{PORT}", f"https://localhost:{PORT}"}  # None = not a browser (tests, curl)


def _bad(body):
    """Trust boundary: {columns, rows (same width; cells are text, numbers, true/false or blank), limits?, order_by?}
    -> error text or None. Anything else is a clear 400, never a crash deep in pandas."""
    if not isinstance(body, dict) or not isinstance(body.get("columns"), list) or not body["columns"]:
        return "'columns' must be a non-empty list"
    rows = body.get("rows")
    if not isinstance(rows, list) or any(not isinstance(r, list) or len(r) != len(body["columns"]) for r in rows):
        return "'rows' must be a list of lists, each as long as 'columns'"
    if not all(isinstance(c, (str, int, float)) and not isinstance(c, bool) for c in body["columns"]):
        return "column names must be text or numbers"
    # NaN/Infinity parse as JSON in Python, not in Excel; a 400-digit whole number is just a (flagged) value
    if not all(v is None or isinstance(v, (str, bool, int)) or isinstance(v, float) and math.isfinite(v) for r in rows for v in r):
        return "cells must be text, numbers, true/false or blank"
    limits = body.get("limits")
    number = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and -1e300 < v < 1e300  # NaN fails too
    if limits is not None and not (isinstance(limits, dict) and all(
            isinstance(b, list) and len(b) == 4 and all(v is None or number(v) for v in b) for b in limits.values())):
        return "'limits' must give each column [base low, base high, weird low, weird high] as numbers or blanks"
    for col, b in (limits or {}).items():
        if any(lo is not None and hi is not None and lo > hi for lo, hi in (b[:2], b[2:])):
            return f"Limits for {col}: the low value is above the high value - fix it in Edit limits"
    if body.get("order_by") is not None and str(body["order_by"]) not in map(str, body["columns"]):
        return "'order_by' must be one of the columns"
    if body.get("strength") is not None and not (type(body["strength"]) is int and 0 <= body["strength"] <= 10):
        return "'strength' must be a whole number from 0 to 10"
    return None


def _strength(body):
    """The slider's 0-10 (checked by _bad); none sent = 5, the tuned default. (Not `or 5`: 0 is a real choice.)"""
    return 5 if body.get("strength") is None else body["strength"]


def create_app(scan_csv=None):
    """scan_csv: file every scan overwrites for Power BI (powerbi/anomaly-hunter.pbids). None = off (tests)."""
    app = Flask(__name__, static_folder=str(PANEL), static_url_path="")

    @app.before_request
    def own_panel_only():
        # other websites in the user's browser can't drive the engine (cross-site POST, DNS rebinding)
        if request.host.split(":")[0] not in LOCAL or request.headers.get("Origin") not in ORIGINS:
            return {"error": "forbidden"}, 403

    @app.after_request
    def no_cache(resp):
        # panel files have no content hash; stale JS hid a bug once. Icons are the
        # exception: Office drops ribbon icons served with no-store/no-cache.
        cacheable = request.path.startswith("/assets/")
        resp.headers["Cache-Control"] = "public, max-age=86400" if cacheable else "no-store"
        return resp

    @app.get("/health")
    def health():
        return {"status": "ok", "ai_available": client.api_key_configured(), "ai_provider": client.provider()}

    @app.post("/scan")
    def scan():
        body = request.get_json(silent=True)
        if err := _bad(body):
            return {"error": err}, 400
        cols, rows, limits = [str(c) for c in body["columns"]], body["rows"], body.get("limits")  # a year header 2024 is "2024"
        order_by = None if body.get("order_by") is None else str(body["order_by"])
        try:  # Agent 1, one scan, no stop
            df, out, suggested, used, status = scan_agent.scan(cols, rows, limits, order_by, _strength(body))
        except Exception:  # a bug in the engine: full detail to the log, not pandas internals to the user
            app.logger.exception("scan failed")
            return {"error": "Engine error - details in server.log"}, 500
        if scan_csv:  # Power BI reads this file: no HTTPS/cert in its way, survives engine restarts
            try:
                taken = set(df.columns)  # a sheet's own "Severity" or "Reason" column is never overwritten
                flat = pd.DataFrame(rows, columns=df.columns).assign(**{
                    (k.capitalize() if k.capitalize() not in taken else f"Anomaly Hunter {k.capitalize()}"): [r[k] for r in out]
                    for k in ("severity", "bucket", "reason", "magnitude")})
                flat.to_csv(f"{scan_csv}.tmp", index=False, encoding="utf-8-sig")
                os.replace(f"{scan_csv}.tmp", scan_csv)  # Power BI never reads a half-written file
            except OSError:  # file open elsewhere: the scan itself still answers
                app.logger.exception("could not write %s", scan_csv)
        return {"rows": out, "suggested_limits": suggested, "limits": used, "summary": {
            "severity_counts": Counter(r["severity"] for r in out if r["severity"]),
            "bucket_counts": Counter(r["bucket"] for r in out if r["bucket"]),
            "detectors": status, "k": K}}

    def ai(call):
        """Run a Claude call; map its failures to HTTP errors the panel shows as-is."""
        if not client.api_key_configured():
            return {"error": "No AI key yet - paste a free Google AI key under Settings."}, 503
        try:
            return call()
        except anthropic.AuthenticationError:
            return {"error": "Invalid ANTHROPIC_API_KEY."}, 503
        except (anthropic.RateLimitError, anthropic.APIConnectionError) as e:
            return {"error": f"Claude API busy or unreachable - try again shortly. ({e})"}, 503
        except anthropic.APIError as e:
            return {"error": f"Claude API error: {e}"}, 502
        except ValueError as e:
            return {"error": str(e)}, 502

    @app.post("/key")
    def key_route():
        """Save (or with "" remove) the free Gemini key in %LOCALAPPDATA%/AnomalyHunter - this PC only."""
        body = request.get_json(silent=True)
        key = body.get("key") if isinstance(body, dict) else None
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_\-]{0,200}", key.strip()):
            return {"error": "That doesn't look like an API key - copy it again from aistudio.google.com."}, 400
        client.KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        if not key.strip():
            client.KEY_FILE.unlink(missing_ok=True)
            return {"ai_available": client.api_key_configured(), "ai_provider": client.provider()}
        ok, words = client.check_key(key.strip())  # tested now, not at the first Ask AI
        if ok is False:
            return {"error": words}, 400  # a rejected key is not kept
        client.KEY_FILE.write_text(key.strip(), encoding="utf-8")
        return {"ai_available": client.api_key_configured(), "ai_provider": client.provider(), "message": words}

    @app.post("/fix")
    def fix_route():
        body = request.get_json(silent=True)
        if err := _bad(body):
            return {"error": err}, 400
        nat = lambda k, hi=None: type(body.get(k)) is int and 0 <= body[k] and (hi is None or body[k] < hi)
        if not (nat("row_index", len(body["rows"])) and nat("start_row") and nat("start_col")):
            return {"error": "'row_index', 'start_row', 'start_col' must be whole numbers inside the sheet"}, 400
        intent = body.get("intent") or ""
        if not isinstance(intent, str) or len(intent) > 2000:
            return {"error": "'intent' must be text, at most 2000 characters"}, 400
        formulas = body.get("formulas")  # the flagged row's formulas, so Claude fixes inputs instead of overwriting them
        if formulas is not None and not (isinstance(formulas, list) and len(formulas) == len(body["columns"])):
            return {"error": "'formulas' must be a list as long as 'columns'"}, 400
        return ai(lambda: client.suggest_fix(body["columns"], body["rows"], body["row_index"], body["start_row"],
                                             body["start_col"], str(body.get("reason") or ""), intent, formulas))

    @app.post("/check")
    def check_route():
        """Agent 3: does this fix make the row look right? A full re-scan with the limits the first scan used."""
        body = request.get_json(silent=True)
        if err := _bad(body):
            return {"error": err}, 400
        i, changes, width = body.get("row_index"), body.get("changes"), len(body["columns"])
        cell = lambda v: v is None or isinstance(v, (str, bool, int)) or isinstance(v, float) and math.isfinite(v)
        if not (type(i) is int and 0 <= i < len(body["rows"]) and isinstance(changes, list) and 0 < len(changes) <= width and all(
                isinstance(c, dict) and type(c.get("col")) is int and 0 <= c["col"] < width and cell(c.get("value")) for c in changes)):
            return {"error": "'row_index' and 'changes' [{col, value}] must point inside the table"}, 400
        try:
            return checker.check([str(c) for c in body["columns"]], body["rows"], body.get("limits"), i, changes, _strength(body))
        except Exception:
            app.logger.exception("check failed")
            return {"error": "Engine error - details in server.log"}, 500

    @app.post("/suggest")
    def suggest_route():
        """Agent 3 for an only-unusual row: the one typing slip that would make it normal, or {}."""
        body = request.get_json(silent=True)
        if err := _bad(body):
            return {"error": err}, 400
        i, cols = body.get("row_index"), [str(c) for c in body["columns"]]
        if not (type(i) is int and 0 <= i < len(body["rows"]) and isinstance(body.get("column"), str) and body["column"] in cols):
            return {"error": "'row_index' and 'column' must point inside the table"}, 400
        try:
            return checker.suggest(cols, body["rows"], body.get("limits"), i, body["column"], _strength(body))
        except Exception:
            app.logger.exception("suggest failed")
            return {"error": "Engine error - details in server.log"}, 500

    return app


def _ku(**on):
    names = ("digital_signature", "content_commitment", "key_encipherment", "data_encipherment",
             "key_agreement", "key_cert_sign", "crl_sign", "encipher_only", "decipher_only")
    return x509.KeyUsage(**{n: n in on for n in names})


def make_cert(folder=HOME, days=5 * 365):
    """HTTPS chain good for 127.0.0.1/localhost ONLY:
    ca.pem   = throwaway CA (Windows trusts this one), name-constrained to localhost/127.0.0.1.
               Its key is never saved, so nothing can ever sign another cert with it.
    cert.pem + key.pem = server cert it signed. Stolen key -> can only pretend to be localhost.
    -> True if a new chain was written (installer must trust ca.pem), False if current one has > 60 days left."""
    now = datetime.datetime.now(datetime.timezone.utc)
    try:
        if (folder / "ca.pem").exists() and (folder / "key.pem").exists() and x509.load_pem_x509_certificate(
                (folder / "cert.pem").read_bytes()).not_valid_after_utc > now + datetime.timedelta(days=60):
            return False
    except Exception:
        pass  # missing or corrupt -> make a fresh chain
    ca_key, key = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, CERT_NAME)])
    here = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]

    def build(subject, public_key, *exts):
        b = (x509.CertificateBuilder().subject_name(subject).issuer_name(ca_name).public_key(public_key)
             .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
             .not_valid_after(now + datetime.timedelta(days=days))
             .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), False)
             .add_extension(x509.SubjectKeyIdentifier.from_public_key(public_key), False))
        for ext, critical in exts:
            b = b.add_extension(ext, critical)
        return b.sign(ca_key, hashes.SHA256())

    ca = build(ca_name, ca_key.public_key(),
               (x509.BasicConstraints(ca=True, path_length=0), True), (_ku(key_cert_sign=1, crl_sign=1), True),
               (x509.NameConstraints(permitted_subtrees=[x509.DNSName("localhost"),
                                                         x509.IPAddress(ipaddress.ip_network("127.0.0.1/32"))],
                                     excluded_subtrees=None), True))
    leaf = build(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]), key.public_key(),
                 (x509.SubjectAlternativeName(here), False), (x509.BasicConstraints(ca=False, path_length=None), True),
                 (_ku(digital_signature=1), True), (x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False))
    folder.mkdir(parents=True, exist_ok=True)
    pem = serialization.Encoding.PEM
    (folder / "cert.pem").unlink(missing_ok=True)  # cert.pem = "done" marker: crash mid-write -> regenerated next run
    (folder / "key.pem").write_bytes(key.private_bytes(pem, serialization.PrivateFormat.PKCS8,
                                                       serialization.NoEncryption()))
    (folder / "ca.pem").write_bytes(ca.public_bytes(pem))
    (folder / "cert.pem").write_bytes(leaf.public_bytes(pem))
    return True


def _already_running(folder=HOME, port=PORT):
    """Is OUR engine on the port? Only a server holding a cert our CA signed passes - a stranger can't fake it."""
    try:
        ctx = ssl.create_default_context(cafile=str(folder / "ca.pem"))
        with urllib.request.urlopen(f"https://127.0.0.1:{port}/health", context=ctx, timeout=2) as r:
            return json.load(r).get("status") == "ok"
    except Exception:
        return False


def main():
    if "--cert" in sys.argv:  # installer: exit 3 = new chain written, trust ca.pem
        sys.exit(3 if make_cert() else 0)
    if _already_running():
        print("Anomaly Hunter engine already running.")
        return
    HOME.mkdir(parents=True, exist_ok=True)
    if sys.stderr is None:  # pythonw (autostart) has no console: fresh log file each start
        sys.stdout = sys.stderr = open(HOME / "server.log", "w", encoding="utf-8", errors="replace", buffering=1)
    crt, key = HOME / "cert.pem", HOME / "key.pem"
    if not (crt.exists() and key.exists()):
        sys.exit(f"No HTTPS cert in {HOME}. Run install.bat.")
    create_app(HOME / "latest-scan.csv").run(host="127.0.0.1", port=PORT, ssl_context=(str(crt), str(key)))


if __name__ == "__main__":
    main()
