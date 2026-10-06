"""Local HTTPS server, 127.0.0.1 only. Engine API + serves panel/ at same origin (no CORS, no build)."""
import subprocess
import sys
from collections import Counter
from pathlib import Path

import anthropic
from flask import Flask, jsonify, request

from anomaly_hunter import triage
from anomaly_hunter.detectors import K
from anomaly_hunter.limits import suggest_limits_dict
from anomaly_hunter.load import load_from_records, numbers
from anomaly_hunter.pipeline import score

PANEL = Path(__file__).resolve().parent.parent / "panel"
CERTS = Path.home() / ".office-addin-dev-certs"


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
            return {"results": triage.triage_rows(body["columns"], body["flagged"])}
        except anthropic.AuthenticationError:
            return {"error": "Invalid ANTHROPIC_API_KEY."}, 503
        except (anthropic.RateLimitError, anthropic.APIConnectionError) as e:
            return {"error": f"Claude API busy or unreachable - try again shortly. ({e})"}, 503
        except anthropic.APIError as e:
            return {"error": f"Claude API error: {e}"}, 502

    return app


def main():
    crt, key = CERTS / "localhost.crt", CERTS / "localhost.key"
    if not crt.exists():
        print("Installing HTTPS dev certs once (Office add-ins need HTTPS, even locally)...")
        subprocess.run("npx --yes office-addin-dev-certs@2.0.10 install", shell=True)
    if not (crt.exists() and key.exists()):
        # panel is hardcoded to https - plain http would start a server nothing can reach
        sys.exit(f"No HTTPS certs in {CERTS}. Run `npx office-addin-dev-certs install`, then retry.")
    create_app().run(host="127.0.0.1", port=5055, ssl_context=(str(crt), str(key)))


if __name__ == "__main__":
    main()
