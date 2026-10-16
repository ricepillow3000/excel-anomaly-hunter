"""Local HTTPS server, 127.0.0.1 only. Engine API + serves panel/ at same origin (no CORS, no build)."""
import csv
import datetime
import ipaddress
import json
import logging
import math
import os
import re
import ssl
import subprocess
import sys
import threading
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
from flask.json.provider import DefaultJSONProvider
from werkzeug.exceptions import HTTPException
from werkzeug.serving import WSGIRequestHandler

from anomaly_hunter.agents import checker, scan_agent
from anomaly_hunter.ai import client
from anomaly_hunter.engine.detectors import K
from anomaly_hunter.engine.load import load_from_records

# the pane, served as-is: beside the code in a checkout, inside the bundle in the one-file app (unpacked to _MEIPASS)
PANEL = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2])) / "frontend"
HOME = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local") / "AnomalyHunter"  # cert, key, log
CERT_NAME = "Anomaly Hunter local CA"  # install.bat finds the trusted CA by this name
PORT = 5055
LOCAL = {"127.0.0.1", "localhost"}
ORIGINS = {None, f"https://127.0.0.1:{PORT}", f"https://localhost:{PORT}"}  # None = not a browser (tests, curl)
# Only our own files plus Microsoft's office.js may run in the pane, so injected markup can't run script.
# Measured in real Excel 2026-10-11: those are the only loads; the pane is top-level (never framed).
CSP = ("default-src 'self'; script-src 'self' https://appsforoffice.microsoft.com; object-src 'none'; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
# http.server writes its own "Server: Werkzeug/x Python/y" before any app header: no versions to look up CVEs for
WSGIRequestHandler.version_string = lambda self: "Anomaly Hunter"
# Werkzeug logged every request line in full, refused or not: a 60 KB URL wrote 60 KB, about 600 MB a minute at flood
# rate until a restart (stress test 2026-10-16). Its warnings and errors stay; the engine's own errors go to app.logger
logging.getLogger("werkzeug").setLevel(logging.WARNING)
# a connection that goes quiet mid-handshake or mid-upload is dropped, not kept a thread forever. Every answer closes
# its connection (no keep-alive), so this never cuts off a scan, however long it runs.
WSGIRequestHandler.timeout = 60
MAX_CELLS = 2_000_000  # same as the pane's maxCells (frontend/utils/sheet.js): it never sends more in one scan
# OWASP CSV injection: text starting with these runs as a formula when the Power BI CSV is opened in Excel
FORMULA_START = tuple("=+-@\t\r\n＝＋－＠")
# two workbooks scanning at once shared one temp file: a replace found it gone and a file could mix both (2026-10-16)
_CSV_LOCK = threading.Lock()


def _inert(v):
    """A leading apostrophe keeps a formula-looking text cell as text (numbers untouched). Partial protection:
    OWASP notes Excel may drop it after a save and reopen."""
    return "'" + v if isinstance(v, str) and v.startswith(FORMULA_START) else v


def _bad(body):
    """Trust boundary: {columns, rows (same width; cells are text, numbers, true/false or blank), limits?, order_by?}
    -> error text or None. Anything else is a clear 400, never a crash deep in pandas."""
    if not isinstance(body, dict) or not isinstance(body.get("columns"), list) or not body["columns"]:
        return "'columns' must be a non-empty list"
    rows = body.get("rows")
    if not isinstance(rows, list) or any(not isinstance(r, list) or len(r) != len(body["columns"]) for r in rows):
        return "'rows' must be a list of lists, each as long as 'columns'"
    if len(rows) * len(body["columns"]) > MAX_CELLS:
        return f"too many cells - scan at most {MAX_CELLS:,} at once"
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


class _JSON(DefaultJSONProvider):
    def loads(self, s, **kw):
        """A body nested too deep for Python's parser is a bad body like any other (400), not a RecursionError (500)."""
        try:
            return super().loads(s, **kw)
        except RecursionError:
            raise ValueError("JSON nested too deeply") from None


def _strength(body):
    """The slider's 0-10 (checked by _bad); none sent = 5, the tuned default. (Not `or 5`: 0 is a real choice.)"""
    return 5 if body.get("strength") is None else body["strength"]


def create_app(scan_csv=None):
    """scan_csv: file every scan overwrites for Power BI (powerbi/anomaly-hunter.pbids). None = off (tests)."""
    app = Flask(__name__, static_folder=str(PANEL), static_url_path="")
    app.json = _JSON(app)
    # Werkzeug reads a body into memory only safely with a cap; 256 MB is far above a 2M-cell sheet (~20 MB measured)
    app.config["MAX_CONTENT_LENGTH"] = 256 * 1024 * 1024

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
        resp.headers["X-Content-Type-Options"] = "nosniff"  # a file is only ever run as the type we say it is
        resp.headers["Content-Security-Policy"] = CSP
        return resp

    @app.errorhandler(HTTPException)
    def json_error(e):  # 404, 405, 413...: JSON like every other answer, not Werkzeug's HTML page (ZAP active scan)
        return {"error": e.description}, e.code

    built = version()

    @app.get("/health")
    def health():
        return {"status": "ok", "version": built, "ai_available": client.api_key_configured(), "ai_provider": client.provider()}

    @app.post("/scan")
    def scan():
        body = request.get_json(silent=True)
        if err := _bad(body):
            return {"error": err}, 400
        cols, rows, limits = [str(c) for c in body["columns"]], body["rows"], body.get("limits")  # a year header 2024 is "2024"
        order_by = None if body.get("order_by") is None else str(body["order_by"])
        try:  # Agent 1, one scan, no stop
            df, out, suggested, used, status, fair = scan_agent.scan(cols, rows, limits, order_by, _strength(body))
        except Exception:  # a bug in the engine: full detail to the log, not pandas internals to the user
            app.logger.exception("scan failed")
            return {"error": "Engine error - details in server.log"}, 500
        if scan_csv:  # Power BI reads this file: no HTTPS/cert in its way, survives engine restarts
            try:
                taken = set(df.columns)  # a sheet's own "Severity" or "Reason" column is never overwritten
                flat = pd.DataFrame(rows, columns=df.columns).assign(**{
                    (k.capitalize() if k.capitalize() not in taken else f"Anomaly Hunter {k.capitalize()}"): [r[k] for r in out]
                    for k in ("severity", "bucket", "reason", "magnitude")})
                flat = flat.map(_inert).rename(columns=_inert)
                # errors="replace": one odd character (a lone surrogate) becomes "?" instead of failing the scan.
                # Text is always quoted: Excel in a ";" locale splits an unquoted "Pen;=cmd|..." into a live formula
                with _CSV_LOCK:
                    flat.to_csv(f"{scan_csv}.tmp", index=False, encoding="utf-8-sig", errors="replace",
                                quoting=csv.QUOTE_NONNUMERIC)
                    os.replace(f"{scan_csv}.tmp", scan_csv)  # Power BI never reads a half-written file
            except (OSError, OverflowError):  # file open elsewhere, or a 309-digit number: the scan still answers
                app.logger.exception("could not write %s", scan_csv)
        return {"rows": out, "suggested_limits": suggested, "limits": used, "fairness": fair, "summary": {
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
        # Our own words only, never the provider's text (2026-10-15 audit): details go to server.log
        except (anthropic.RateLimitError, anthropic.APIConnectionError):
            app.logger.exception("Claude busy or unreachable")
            return {"error": "Claude API busy or unreachable - try again shortly."}, 503
        except anthropic.APIError as e:
            app.logger.exception("Claude API error")
            return {"error": f"Claude API error{f' (HTTP {e.status_code})' if getattr(e, 'status_code', None) else ''} - details in server.log"}, 502
        except ValueError as e:
            return {"error": str(e)}, 502
        except Exception:  # anything new still answers in our words, never Werkzeug's or the provider's (2026-10-16)
            app.logger.exception("AI call failed")
            return {"error": "AI error - details in server.log"}, 502

    @app.post("/key")
    def key_route():
        """Save (or with "" remove) the free Gemini key in %LOCALAPPDATA%/AnomalyHunter - this PC only."""
        body = request.get_json(silent=True)
        key = body.get("key") if isinstance(body, dict) else None
        # classic keys "AIza..."; newer service-account-bound keys "AQ.Ab8..." contain dots
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_.\-]{0,200}", key.strip()):
            return {"error": "That doesn't look like an API key - copy it again from Google Cloud (APIs & Services > Credentials)."}, 400
        client.KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        if not key.strip():  # Remove key: an own key and an invite code alike
            client.KEY_FILE.unlink(missing_ok=True)
            client.INVITE_FILE.unlink(missing_ok=True)
            return {"ai_available": client.api_key_configured(), "ai_provider": client.provider()}
        if key.strip().startswith("inv_"):  # an invite code to John's relay: kept here, checked by the relay on use
            if not re.fullmatch(r"inv_[A-Za-z0-9_\-]{20,64}", key.strip()):
                return {"error": "That doesn't look like a whole invite code - copy it again."}, 400
            client.INVITE_FILE.write_text(key.strip(), encoding="utf-8")
            on = client.provider() == "relay"
            return {"ai_available": client.api_key_configured(), "ai_provider": client.provider(),
                    "message": "Invite code saved. AI help is on." if on else "Invite code saved - the shared AI isn't switched on yet."}
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
        # Excel's last column is XFD (16384): further right is no sheet address
        if not (nat("row_index", len(body["rows"])) and nat("start_row") and nat("start_col", 16384 - len(body["columns"]) + 1)):
            return {"error": "'row_index', 'start_row', 'start_col' must be whole numbers inside the sheet"}, 400
        intent = body.get("intent") or ""
        if not isinstance(intent, str) or len(intent) > 2000:
            return {"error": "'intent' must be text, at most 2000 characters"}, 400
        formulas = body.get("formulas")  # the flagged row's formulas, so Claude fixes inputs instead of overwriting them
        if formulas is not None and not (isinstance(formulas, list) and len(formulas) == len(body["columns"])):
            return {"error": "'formulas' must be a list as long as 'columns'"}, 400
        return ai(lambda: client.suggest_fix(body["columns"], body["rows"], body["row_index"], body["start_row"],
                                             body["start_col"], str(body.get("reason") or ""), intent, formulas))

    @app.post("/odd-text")
    def odd_text_route():
        """Optional AI text check: values a different KIND of thing from their column ("London" among products).
        Only category-like text columns (2-50 distinct values) go, as their distinct values - never rows or numbers."""
        body = request.get_json(silent=True)
        if err := _bad(body):
            return {"error": err}, 400
        df, types, _ = load_from_records(body["columns"], body["rows"])
        cells = {c: df[c].astype(str).str.strip() for c, t in types.items() if t == "text"}
        values = {c: sorted(set(s[(s != "") & ~s.str[:1].isin(list("=+-@"))])) for c, s in cells.items()}
        values = {c: v for c, v in values.items() if 2 <= len(v) <= 50}
        if not values:
            return {"odd": [], "partial": False}

        def found():  # partial: Google gave out before the last batch - asking again sends only what is left
            hits, partial = client.odd_text(values)
            return {"odd": [{"row": int(i), "col": list(df.columns).index(h["column"]), **h}
                            for h in hits for i in df.index[cells[h["column"]] == h["value"]]], "partial": partial}
        return ai(found)

    @app.post("/check")
    def check_route():
        """Agent 3: does this fix make the row look right? A full re-scan with the limits the first scan used."""
        body = request.get_json(silent=True)
        if err := _bad(body):
            return {"error": err}, 400
        i, changes, width = body.get("row_index"), body.get("changes"), len(body["columns"])
        cell = lambda v: v is None or isinstance(v, (str, bool, int)) or isinstance(v, float) and math.isfinite(v)
        if not (type(i) is int and 0 <= i < len(body["rows"]) and isinstance(changes, list) and 0 < len(changes) <= width and all(
                isinstance(c, dict) and type(c.get("col")) is int and 0 <= c["col"] < width and "value" in c and cell(c["value"])
                for c in changes)):  # a blank cell is "value": null, never a missing key (that crashed the checker)
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


class _HandshakeInThread(ssl.SSLContext):
    """Werkzeug wraps the LISTENING socket, so each TLS handshake ran in its one accept loop: a single connection that
    never said hello (a port scan, a stuck probe) froze every scan until it hung up. Handshake lazily instead: on the
    first read, in that request's own thread, bounded by WSGIRequestHandler.timeout."""

    def wrap_socket(self, sock, server_side=False, do_handshake_on_connect=True, *args, **kwargs):
        return super().wrap_socket(sock, server_side, False, *args, **kwargs)


def tls_context(crt, key):
    ctx = _HandshakeInThread(ssl.PROTOCOL_TLS_SERVER)  # TLS 1.2+ only, like Werkzeug's own
    ctx.load_cert_chain(crt, key)
    return ctx


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
    except Exception:  # noqa: S110 - any failure means "make a new one"
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


def version(panel=PANEL):
    """Which engine answers, shown in the pane: 2026-10-15 a laptop still ran a 3-day-old engine, scored a credit sheet
    2 of 279 rows, and nothing on screen said it was old. The exe build writes frontend/version.txt; a checkout asks git."""
    try:
        return (panel / "version.txt").read_text(encoding="utf-8").strip()
    except OSError:
        pass
    try:  # no console flashing up from the hidden (pythonw) engine
        out = subprocess.run(["git", "-C", str(panel.parent), "log", "-1", "--format=%h (%cs)"],  # noqa: S603, S607
                             capture_output=True, text=True, timeout=5, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return "dev"
    return f"dev {out.stdout.strip()}" if out.returncode == 0 and out.stdout.strip() else "dev"


def _already_running(folder=HOME, port=PORT):
    """Is OUR engine on the port? Only a server holding a cert our CA signed passes - a stranger can't fake it."""
    try:
        ctx = ssl.create_default_context(cafile=str(folder / "ca.pem"))
        # nosemgrep: dynamic-urllib-use-detected - fixed https://127.0.0.1 address, our own CA pinned
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
    create_app(HOME / "latest-scan.csv").run(host="127.0.0.1", port=PORT, ssl_context=tls_context(crt, key))


if __name__ == "__main__":
    main()
