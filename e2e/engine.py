"""The real engine on https://127.0.0.1:5055 with a throwaway cert."""
import sys
from pathlib import Path
from anomaly_hunter import triage
from anomaly_hunter.server import create_app, make_cert
d = Path(sys.argv[1]); make_cert(d)
triage.KEY_FILE = d / "gemini-key.txt"  # never the real key saved on this PC
create_app().run(host="127.0.0.1", port=5055, ssl_context=(str(d / "cert.pem"), str(d / "key.pem")))
