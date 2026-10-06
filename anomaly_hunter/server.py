"""Local HTTPS server, 127.0.0.1 only. Engine API + serves panel/ at same origin (no CORS, no build)."""
import datetime
import ipaddress
import json
import os
import ssl
import sys
import urllib.request
from collections import Counter
from pathlib import Path

import anthropic
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from flask import Flask, jsonify, request

from anomaly_hunter import triage
from anomaly_hunter.detectors import K
from anomaly_hunter.limits import suggest_limits_dict
from anomaly_hunter.load import load_from_records, numbers
from anomaly_hunter.pipeline import score

PANEL = Path(__file__).resolve().parent.parent / "panel"
HOME = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local") / "AnomalyHunter"  # cert, key, log
CERT_NAME = "Anomaly Hunter local CA"  # install.bat finds the trusted CA by this name
PORT = 5055
LOCAL = {"127.0.0.1", "localhost"}
ORIGINS = {None, f"https://127.0.0.1:{PORT}", f"https://localhost:{PORT}"}  # None = not a browser (Power BI, tests)


def _bad(body):
    """Trust boundary: body must be {columns: [...], rows: [[...] same width]}. -> error text or None."""
    if not isinstance(body, dict) or not isinstance(body.get("columns"), list) or not body["columns"]:
        return "'columns' must be a non-empty list"
    rows = body.get("rows")
    if not isinstance(rows, list) or any(not isinstance(r, list) or len(r) != len(body["columns"]) for r in rows):
        return "'rows' must be a list of lists, each as long as 'columns'"
    return None


def create_app():
    app = Flask(__name__, static_folder=str(PANEL), static_url_path="")
    app.config["last_scan"] = None  # per-app cache for GET /latest-scan (Power BI)

    @app.before_request
    def own_panel_only():
        # other websites in the user's browser can't drive the engine (cross-site POST, DNS rebinding)
        if request.host.split(":")[0] not in LOCAL or request.headers.get("Origin") not in ORIGINS:
            return {"error": "forbidden"}, 403

    @app.after_request
    def no_cache(resp):
        resp.headers["Cache-Control"] = "no-store"  # panel files have no content hash; stale JS hid a bug once
        return resp

    @app.get("/health")
    def health():
        return {"status": "ok", "ai_available": triage.api_key_configured()}

    @app.post("/scan")
    def scan():
        body = request.get_json(silent=True)
        if err := _bad(body):
            return {"error": err}, 400
        cols, rows, limits = body["columns"], body["rows"], body.get("limits")
        try:
            df, types, errors = load_from_records(cols, rows)
            suggested = suggest_limits_dict(df, numbers(types)) if limits is None else None
            out, status = score(df, types, errors, limits or {}, body.get("order_by"))
        except Exception as e:
            return {"error": str(e)}, 500
        app.config["last_scan"] = [{**dict(zip(cols, row)), **{k.capitalize(): v for k, v in r.items()}}
                                   for row, r in zip(rows, out)]
        return {"rows": out, "suggested_limits": suggested, "summary": {
            "severity_counts": Counter(r["severity"] for r in out if r["severity"]),
            "bucket_counts": Counter(r["bucket"] for r in out if r["bucket"]),
            "detectors": status, "k": K}}

    @app.get("/latest-scan")
    def latest_scan():
        if app.config["last_scan"] is None:
            return {"error": "No scan has run yet - run a scan from the Excel panel first."}, 404
        return jsonify(app.config["last_scan"])  # bare array: Power Query turns it straight into a table

    @app.post("/triage")
    def triage_route():
        if not triage.api_key_configured():
            return {"error": "ANTHROPIC_API_KEY is not set - AI triage is unavailable."}, 503
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or not all(isinstance(body.get(k), list) for k in ("columns", "flagged")):
            return {"error": "'columns' and 'flagged' must be lists"}, 400
        try:
            # panel sends <= 25 shown rows; cap so a bug can't run up the Claude bill
            return {"results": triage.triage_rows(body["columns"], body["flagged"][:25])}
        except anthropic.AuthenticationError:
            return {"error": "Invalid ANTHROPIC_API_KEY."}, 503
        except (anthropic.RateLimitError, anthropic.APIConnectionError) as e:
            return {"error": f"Claude API busy or unreachable - try again shortly. ({e})"}, 503
        except anthropic.APIError as e:
            return {"error": f"Claude API error: {e}"}, 502

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
    files = {"key.pem": key.private_bytes(pem, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()),
             "ca.pem": ca.public_bytes(pem), "cert.pem": leaf.public_bytes(pem)}  # cert.pem last = "done" marker
    for name, data in files.items():
        (folder / (name + ".tmp")).write_bytes(data)
    for name in files:
        os.replace(folder / (name + ".tmp"), folder / name)
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
    create_app().run(host="127.0.0.1", port=PORT, ssl_context=(str(crt), str(key)))


if __name__ == "__main__":
    main()
