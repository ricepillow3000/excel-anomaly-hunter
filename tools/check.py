"""Every gate, in layers, fastest first - run before every commit: python tools/check.py [--e2e] [--keep-going]
0 CI workflows parse  1 security lint (ruff, Bandit rules)  2 pane self-check  3 relay abuse tests  4 engine tests + API fuzzing
5 accuracy: the industry bench and the blind 14-domain bench (gates: no crash, no harmful fix, no new Medium+ false alarm)
6 dependencies with known vulnerabilities (needs the internet)  7 browser e2e, with --e2e (needs .venv + playwright)
Stops at the first red layer (a broken base hides the real failure); --keep-going runs them all. Exit 1 = a red layer."""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable
LAYERS = [
    # a ": " in a step name made build-exe.yml unreadable to GitHub: no job ran, and nothing here noticed (2026-10-15)
    ("CI workflows parse", [PY, "-c", "import sys, yaml; [yaml.safe_load(open(f, encoding='utf-8')) for f in sys.argv[1:]]",
                            *map(str, sorted(ROOT.glob(".github/workflows/*.yml")))]),
    ("security lint", [PY, "-m", "ruff", "check", "--select", "S", "--ignore", "S101", "backend/anomaly_hunter", "tools"]),
    ("pane self-check", ["node", "frontend/selfcheck.js"]),
    ("relay abuse tests", ["node", "relay/test.mjs"]),
    ("engine tests + fuzzing", [PY, "-m", "pytest", "-q", "backend/tests"]),
    ("industry bench", [PY, "backend/bench/score.py", "."]),
    ("blind 14-domain bench", [PY, "backend/bench/score.py", ".", "--blind"]),
    ("known-vulnerable dependencies", [PY, "-m", "pip_audit", "--skip-editable"]),
]
if "--e2e" in sys.argv:
    LAYERS.append(("browser e2e", ["bash", "e2e/all.sh"]))


def main():
    results = []
    for name, cmd in LAYERS:
        t = time.time()
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)  # noqa: S603 - fixed commands from LAYERS above
        ok = r.returncode == 0
        last = [line for line in (r.stdout + r.stderr).strip().splitlines() if line.strip()][-1:] or [""]
        results.append((name, ok))
        print(f"{'PASS' if ok else 'FAIL'}  {name:30s} {time.time() - t:5.0f}s  {last[0][:110]}", flush=True)
        if not ok:
            print((r.stdout + r.stderr)[-4000:])
            if "--keep-going" not in sys.argv:
                break
    red = [n for n, ok in results if not ok]
    print("ALL GREEN" if not red and len(results) == len(LAYERS) else f"RED: {', '.join(red) or 'stopped early'}")
    return 1 if red else 0


if __name__ == "__main__":
    sys.exit(main())
