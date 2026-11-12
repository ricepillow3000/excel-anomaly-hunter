"""Break every guard on purpose and see a test turn red: python tools/mutate.py [--only ID,ID] [-j N] [--e2e]
Each mutant in tools/mutations.json is one exact replacement in one file (a guard loosened, or tightened so it keeps the
right out) and the tests that must fail with it. A mutant they survive is a guard nothing holds: exit 1, naming it.
AH-155 (John, 2026-11-10): 110 mutants of 55 guards, all written with tests that were green, and 15 survived. Green
checks prove nothing until a planted bug turns them red.
Runs in throwaway copies of the repo, never in these files: an interrupted run can never leave a bug behind.
--e2e also runs the mutants only the browser test can catch (needs playwright and a free port 5055, one at a time)."""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from queue import Queue

ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable
E2E = "e2e"  # a mutant's test that is the browser flow (e2e/all.sh, flow mode)
WAIT = 900  # seconds one test command may take; longer is a hang the mutant caused, counted as caught


def load(only):
    mutants = json.loads((ROOT / "tools/mutations.json").read_text(encoding="utf-8"))
    if only:
        unknown = set(only) - {m["id"] for m in mutants}
        if unknown:
            sys.exit(f"No such mutant: {', '.join(sorted(unknown))}")
        mutants = [m for m in mutants if m["id"] in only]
    # a mutant whose text is gone (or is there twice) plants nothing, and "survived" or "killed" would both be a lie
    stale = [f"{m['id']}: {m['file']} has its text {(ROOT / m['file']).read_text(encoding='utf-8').count(m['old'])} times"
             for m in mutants if (ROOT / m["file"]).read_text(encoding="utf-8").count(m["old"]) != 1]
    if stale:
        sys.exit("Stale mutants (each must match exactly once; update tools/mutations.json with the code):\n  " + "\n  ".join(stale))
    return mutants


def copy_repo(to):
    """The working tree as git sees it (tracked and new files, not ignored ones), committed (for /health's version and
    the invite kit's git archive), and a .venv/bin/python for e2e/all.sh."""
    files = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=ROOT, capture_output=True,  # noqa: S603, S607
                           check=True).stdout.decode().split("\0")
    for f in filter(None, files):
        src = ROOT / f
        if src.is_file():
            (to / f).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, to / f)
    git = ["git", "-C", str(to), "-c", "user.name=mutate", "-c", "user.email=mutate@localhost"]
    subprocess.run([*git, "init", "-q"], check=True)  # noqa: S603
    subprocess.run([*git, "add", "-A"], check=True)  # noqa: S603 - the tests that read HEAD (git archive) see these files
    subprocess.run([*git, "commit", "-q", "-m", "mutation copy"], check=True)  # noqa: S603
    venv = to / ".venv/bin/python"
    venv.parent.mkdir(parents=True)
    venv.write_text(f'#!/bin/sh\nexec "{PY}" "$@"\n')
    venv.chmod(0o755)
    env = {**os.environ, "PYTHONPATH": str(to / "backend"), "MODES": "flow"}
    # an installed (editable) anomaly_hunter must not stand in for the copy's: every mutant would then "survive"
    where = subprocess.run([PY, "-c", "import anomaly_hunter; print(anomaly_hunter.__file__)"], cwd=to, env=env,  # noqa: S603
                           capture_output=True, text=True, check=True).stdout.strip()
    if not Path(where).resolve().is_relative_to(to.resolve()):
        sys.exit(f"The copy imports anomaly_hunter from {where}, not from itself")
    return env


def command(test):
    if test == E2E:
        return ["bash", "e2e/all.sh"]
    if test.startswith("node "):
        return test.split()
    return [PY, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider", test]


def run(test, copy, env):
    """True when the test passes."""
    try:
        r = subprocess.run(command(test), cwd=copy, env=env, capture_output=True, text=True, timeout=WAIT)  # noqa: S603
    except subprocess.TimeoutExpired:
        return False
    return r.returncode == 0


def baseline(mutants, copy, env):
    """Every listed test green on the unchanged code first: a red one would kill every mutant for free."""
    tests = list(dict.fromkeys(t for m in mutants for t in m["tests"]))
    pytest_ids = [t for t in tests if command(t)[0] == PY]
    red = []
    if pytest_ids:
        r = subprocess.run([PY, "-m", "pytest", "-q", "-p", "no:cacheprovider", *pytest_ids], cwd=copy, env=env,  # noqa: S603
                           capture_output=True, text=True, timeout=3 * WAIT)
        if r.returncode != 0:
            red.append("pytest:\n" + (r.stdout + r.stderr)[-3000:])
    red += [t for t in tests if command(t)[0] != PY and not run(t, copy, env)]
    if red:
        sys.exit("The listed tests are red before any mutant, so no mutant can be judged:\n" + "\n".join(red))


def judge(m, copy, env):
    target = copy / m["file"]
    before = target.read_bytes()
    text = before.decode("utf-8")
    t = time.time()
    try:
        target.write_bytes(text.replace(m["old"], m["new"]).encode("utf-8"))
        by = next((test for test in m["tests"] if not run(test, copy, env)), None)
    finally:
        target.write_bytes(before)
    if target.read_bytes() != before:
        raise RuntimeError(f"{m['file']} in {copy} was not put back after {m['id']}")
    return {**m, "by": by, "s": time.time() - t}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated mutant ids")
    ap.add_argument("-j", type=int, default=min(4, os.cpu_count() or 1), help="copies run side by side")
    ap.add_argument("--e2e", action="store_true", help="also the mutants only the browser test can catch")
    a = ap.parse_args()
    start = time.time()
    mutants = load([i for i in a.only.split(",") if i])
    browser = [m for m in mutants if E2E in m["tests"]]
    if not a.e2e:
        mutants = [m for m in mutants if E2E not in m["tests"]]
        if browser:
            print(f"Skipping {len(browser)} mutants only the browser test catches (run with --e2e): {', '.join(m['id'] for m in browser)}")
    quick = [m for m in mutants if E2E not in m["tests"]]
    slow = [m for m in mutants if E2E in m["tests"]]
    with tempfile.TemporaryDirectory(prefix="mutate-") as tmp:
        copies = Queue()
        envs = {}
        for k in range(max(1, min(a.j, len(quick) or 1))):
            c = Path(tmp) / str(k)
            envs[c] = copy_repo(c)
            copies.put(c)
        first = next(iter(envs))
        baseline(mutants, first, envs[first])
        print(f"Baseline green ({time.time() - start:.0f} s). {len(mutants)} mutants, {copies.qsize()} at a time", flush=True)

        def one(m):
            c = copies.get()
            try:
                r = judge(m, c, envs[c])
            finally:
                copies.put(c)
            print(f"{'killed  ' if r['by'] else 'SURVIVED'} {m['id']:28s} {r['s']:5.0f} s  {r['by'] or ''}", flush=True)
            return r

        with ThreadPoolExecutor(copies.qsize()) as pool:
            results = list(pool.map(one, quick))
        results += [one(m) for m in slow]  # the browser test needs port 5055: one at a time
    survivors = [r for r in results if not r["by"]]
    print(f"\n{len(results) - len(survivors)} killed, {len(survivors)} survived, of {len(results)} mutants in {time.time() - start:.0f} s")
    for r in survivors:
        print(f"\nSURVIVED {r['id']} ({r['kind']}): {r['guard']}\n  {r['file']}: {r['old'].strip()!r}\n  became {r['new'].strip()!r}"
              f"\n  and every test passed: {', '.join(r['tests'])}")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
