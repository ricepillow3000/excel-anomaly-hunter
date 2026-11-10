"""Every gate, in layers, fastest first - run before every commit: python tools/check.py [--e2e] [--keep-going]
0 CI workflows parse  1 security lint (ruff, Bandit rules), secrets anywhere in the git history  2 pane self-check, website links and scripts  3 relay abuse tests  4 engine tests + API fuzzing
5 accuracy: the industry bench and the blind 14-domain bench (gates: no crash, no harmful fix, no new Medium+ false alarm)
6 dependencies with known vulnerabilities (needs the internet)  7 browser e2e and the website in a browser, with --e2e (needs .venv + playwright)
8 mutation testing, with --mutate: every guard broken on purpose must turn a test red (tools/mutate.py; --e2e adds the browser's mutants)
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
    # a key deleted later is still in every clone and on GitHub: nothing read the history before AH-87 (a shallow
    # checkout skips with a note; CI fetches the whole history and runs it with --full)
    ("secrets in the git history", [PY, "tools/secret_history.py"]),
    ("pane self-check", ["node", "frontend/selfcheck.js"]),
    ("website links and scripts", ["node", "tools/test_site.mjs"]),
    ("relay abuse tests", ["node", "relay/test.mjs"]),
    ("engine tests + fuzzing", [PY, "-m", "pytest", "-q", "backend/tests"]),
    ("industry bench", [PY, "backend/bench/score.py", "."]),
    ("blind 14-domain bench", [PY, "backend/bench/score.py", ".", "--blind"]),
    ("known-vulnerable dependencies", [PY, "-m", "pip_audit", "--skip-editable"]),
    # every pin too, not only what this PC installed: setuptools (the build tool) and the Windows-only pins are never
    # installed here, and setuptools 84.0.0 carried GHSA-xmj3-9gf7-h52w while the line above was green (AH-96)
    # --strict: a mistyped or made-up name in constraints.txt only printed "Dependency not found on PyPI" and passed (AH-105)
    ("known-vulnerable pins", [PY, "-m", "pip_audit", "-r", "constraints.txt", "--no-deps", "--disable-pip", "--strict"]),
]
if "--e2e" in sys.argv:
    LAYERS.append(("browser e2e", ["bash", "e2e/all.sh"]))
    LAYERS.append(("website in a browser", ["node", "tools/test_site.mjs", "--browser"]))
# AH-155: 15 of 110 planted bugs passed every test above while all of them were green
if "--mutate" in sys.argv:
    LAYERS.append(("mutation testing", [PY, "tools/mutate.py", *(["--e2e"] if "--e2e" in sys.argv else [])]))


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
