"""Local HTTP server wrapping the engine for the Office.js side panel.

Binds 127.0.0.1 only — this runs on the analyst's own machine and is never
meant to be reachable over the network. Also serves the built task pane
(panel/dist) at this same origin, so starting this one process is the whole
"on" switch for the add-in — no separate npm/node dev server at runtime.
"""
import subprocess
import sys
from collections import Counter
from pathlib import Path

import anthropic
from flask import Flask, jsonify, request

from anomaly_hunter import triage
from anomaly_hunter.detectors import K
from anomaly_hunter.limits import suggest_limits_dict
from anomaly_hunter.load import load_from_records
from anomaly_hunter.pipeline import score

PORT = 5055
PANEL_DIST = Path(__file__).resolve().parent.parent / "panel" / "dist"
DEV_CERTS_DIR = Path.home() / ".office-addin-dev-certs"


def create_app():
    app = Flask(__name__, static_folder=str(PANEL_DIST), static_url_path="")
    app.config["last_scan"] = None  # per-app cache for GET /latest-scan (Power BI export)

    @app.after_request
    def add_cors_headers(response):
        # Localhost-only server, analyst's own data in their own browser tab —
        # a permissive CORS header here doesn't expose anything to anyone else.
        response.headers["Access-Control-Allow-Origin"] = "*"
        # The panel's own JS/HTML changes across rebuilds (npm run build), but
        # filenames don't (no content hash) — without this, a browser that
        # already cached an older taskpane.js silently keeps running it after
        # an update, which is exactly how a real duplicate-row bug stayed
        # invisible through a server-side fix during testing.
        response.headers["Cache-Control"] = "no-store"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return response

    @app.route("/health", methods=["GET"])
    def health():
        return jsonify({"status": "ok", "ai_available": triage.api_key_configured()})

    @app.route("/triage", methods=["POST", "OPTIONS"])
    def triage_route():
        if request.method == "OPTIONS":
            return "", 204
        if not triage.api_key_configured():
            return jsonify({"error": "ANTHROPIC_API_KEY is not set — AI triage is unavailable."}), 503

        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or not isinstance(payload.get("flagged"), list):
            return jsonify({"error": "'flagged' must be a list"}), 400
        columns = payload.get("columns")
        if not isinstance(columns, list):
            return jsonify({"error": "'columns' must be a list"}), 400

        try:
            results = triage.triage_rows(columns, payload["flagged"])
        except anthropic.AuthenticationError:
            return jsonify({"error": "Invalid ANTHROPIC_API_KEY."}), 503
        except anthropic.RateLimitError:
            return jsonify({"error": "Claude API rate limited — try again shortly."}), 503
        except anthropic.APIConnectionError:
            return jsonify({"error": "Could not reach the Claude API — check your internet connection."}), 503
        except anthropic.APIStatusError as exc:
            return jsonify({"error": f"Claude API error: {exc.message}"}), 502

        return jsonify({"results": results})

    @app.route("/latest-scan", methods=["GET"])
    def latest_scan_route():
        cached = app.config.get("last_scan")
        if cached is None:
            return jsonify({"error": "No scan has run yet — run a scan from the Excel panel first."}), 404
        # Power BI export (sub-project 6): bare array, not wrapped — Power Query's
        # Json.Document turns this straight into a table with no extra drill-down.
        return jsonify(cached)

    @app.route("/suggest-limits", methods=["POST", "OPTIONS"])
    def suggest_limits_route():
        if request.method == "OPTIONS":
            return "", 204
        body, error = _parse_records_request(request.get_json(silent=True))
        if error:
            return jsonify({"error": error}), 400
        columns, rows = body
        df, column_types, _ = load_from_records(columns, rows)
        number_columns = [c for c, t in column_types.items() if t == "number"]
        try:
            return jsonify(suggest_limits_dict(df, number_columns))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500

    @app.route("/scan", methods=["POST", "OPTIONS"])
    def scan_route():
        if request.method == "OPTIONS":
            return "", 204
        payload = request.get_json(silent=True)
        body, error = _parse_records_request(payload)
        if error:
            return jsonify({"error": error}), 400
        columns, rows = body
        limits = (payload or {}).get("limits")
        order_by = (payload or {}).get("order_by")

        try:
            df, column_types, errors_log = load_from_records(columns, rows)
            number_columns = [c for c, t in column_types.items() if t == "number"]

            suggested = None
            if limits is None:
                suggested = suggest_limits_dict(df, number_columns)
                limits_for_scoring = {}
            else:
                limits_for_scoring = {col: tuple(bounds) for col, bounds in limits.items()}

            combined, detector_status = score(df, column_types, errors_log, limits_for_scoring, order_by)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500

        severity_counts = Counter(c["severity"] for c in combined if c["severity"])
        bucket_counts = Counter(c["bucket"] for c in combined if c["bucket"])
        detectors_summary = {
            name: ("ran" if status.get("ran", True) else f"sat out: {status.get('sit_out_reason')}")
            for name, status in detector_status.items()
        }

        app.config["last_scan"] = [
            {**dict(zip(columns, rows[i])), "Severity": c["severity"], "Bucket": c["bucket"],
             "Reason": c["reason"], "Magnitude": c["magnitude"]}
            for i, c in enumerate(combined)
        ]

        return jsonify({
            "rows": [
                {"severity": c["severity"], "bucket": c["bucket"], "reason": c["reason"], "magnitude": c["magnitude"]}
                for c in combined
            ],
            "summary": {
                "severity_counts": dict(severity_counts),
                "bucket_counts": dict(bucket_counts),
                "detectors": detectors_summary,
                "k": K,
            },
            "suggested_limits": suggested,
        })

    return app


def _parse_records_request(payload):
    """Returns ((columns, rows), None) or (None, error_message)."""
    if not isinstance(payload, dict):
        return None, "request body must be a JSON object"
    columns, rows = payload.get("columns"), payload.get("rows")
    if not isinstance(columns, list) or not columns:
        return None, "'columns' must be a non-empty list"
    if not isinstance(rows, list):
        return None, "'rows' must be a list"
    for row in rows:
        if not isinstance(row, list) or len(row) != len(columns):
            return None, "every row must be a list the same length as 'columns'"
    return (columns, rows), None


def _find_certs():
    cert, key = DEV_CERTS_DIR / "localhost.crt", DEV_CERTS_DIR / "localhost.key"
    return (str(cert), str(key)) if cert.exists() and key.exists() else None


def main():
    ssl_context = _find_certs()
    if ssl_context is None:
        print("No dev HTTPS certs found — installing them once via office-addin-dev-certs...")
        try:
            subprocess.run(["npx", "office-addin-dev-certs", "install"], check=True, shell=True)
        except (subprocess.CalledProcessError, FileNotFoundError) as exc:
            # The panel is hardcoded to https://127.0.0.1:5055 — serving plain HTTP here
            # would start a server nothing can actually talk to. Refuse loudly instead.
            sys.exit(
                f"Could not install HTTPS dev certs ({exc}). Office Add-ins require HTTPS "
                "even locally. Run `npx office-addin-dev-certs install` yourself, then retry."
            )
        ssl_context = _find_certs()
        if ssl_context is None:
            sys.exit(f"Install reported success but no certs found at {DEV_CERTS_DIR}. Can't start.")

    create_app().run(host="127.0.0.1", port=PORT, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
