"""Is every package the app installs pinned in constraints.txt, at the version installed? python tools/pinned.py [--exe]
Walks the requirements from pyproject.toml (runtime + dev, + exe with --exe) through what is installed. Exit 1 = a package
missing from constraints.txt or at another version. 2026-10-11: scikit-learn 1.9.1, pulled in unpinned by pyod, broke
every Windows install; any of the ~45 unpinned packages could ship to every user the same way.
Regenerate after changing pyproject.toml: uv pip compile pyproject.toml --extra dev --extra exe --universal -p 3.14
-o constraints.txt (it keeps the pins already in the file; --upgrade-package NAME moves one)."""
import importlib.metadata as md
import re
import sys
import tomllib
from pathlib import Path

from packaging.requirements import Requirement

ROOT = Path(__file__).resolve().parents[1]
canon = lambda name: re.sub(r"[-_.]+", "-", name).lower()


def problems(exe=False):
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    extras = project.get("optional-dependencies", {})
    todo = [Requirement(r) for r in project["dependencies"] + extras.get("dev", []) + (extras.get("exe", []) if exe else [])]
    pins = dict(re.findall(r"^([A-Za-z0-9_.-]+)==(\S+)", (ROOT / "constraints.txt").read_text(encoding="utf-8"), re.M))
    pins = {canon(k): v for k, v in pins.items()}
    seen, out = set(), []
    while todo:
        req = todo.pop()
        if canon(req.name) in seen:
            continue
        seen.add(canon(req.name))
        try:
            dist = md.distribution(req.name)
        except md.PackageNotFoundError:  # not installed here (a dev tool this PC doesn't have): nothing ships from it
            continue
        if pins.get(canon(req.name)) != dist.version:
            out.append(f"{req.name} {dist.version} (constraints.txt: {pins.get(canon(req.name), 'not pinned')})")
        for r in map(Requirement, dist.requires or []):
            if r.marker is None or any(r.marker.evaluate({"extra": e}) for e in [""] + list(req.extras)):
                todo.append(r)
    return out


if __name__ == "__main__":
    bad = problems("--exe" in sys.argv)
    print("\n".join(bad) or "every installed package is pinned")
    sys.exit(1 if bad else 0)
