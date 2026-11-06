"""Has a secret ever been committed, on any branch, in any commit? python tools/secret_history.py [--full]
A key deleted in a later commit is still in the history GitHub serves: every line ever added (git log --all -p) is
read for the shapes below, and every file ever added for the names a secret lives under (.env, *.pem, tokens.json...).
A hit prints its commit, file and the kind of secret, never the value (this output lands in a public CI log). Exit 1 = a
hit. A shallow checkout has no history to read: a skip with a note here, a failure with --full (CI fetches it all).
Before AH-87 nothing read the history: Semgrep's p/secrets and pip-audit read only the files of today's commit.
Stdlib only, so it runs before anything is installed."""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHAPES = {  # each is the provider's own published prefix and length, so an ordinary word cannot match
    # AH-140: and Google's newer keys, as server.py's key check and its comment give them ("AQ.Ab8...", dots inside, no
    # length stated); one that ends in ".." is that comment's own "AQ.Ab8...", never a key
    "a Google API key": r"AIza[0-9A-Za-z_-]{35}|(?<![\w.-])AQ\.Ab8[A-Za-z0-9_.-]*+(?<!\.\.)",
    "a private key block": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "a GitHub token": r"gh[pousr]_[A-Za-z0-9]{36,}",
    "a Slack token": r"xox[baprs]-[0-9A-Za-z-]{10,}",
    "an OpenAI or Anthropic key": r"(?<![\w-])sk-(?:ant-)?[A-Za-z0-9_-]{20,}",
    "a relay invite code": r"(?<![\w-])inv_[A-Za-z0-9_-]{20,64}",
}
# The made-up values the tests type on purpose, by their own prefixes, never by file: a real key pasted beside them in
# the same test must still be found. All three in the history on 2026-11-02 (AH-87): test_grounding.py's
# "AIzaSECRET-key-should-never..." and "inv_SECRETinvitecode...", e2e/run.mjs's "inv_e2eNotARealInviteCode...".
# A new fake says it is one in its own first letters and goes here, or carries the marker below.
FAKES = ("AIzaSECRET", "inv_SECRET", "inv_e2eNot", "AQ.Ab8_madeUp")  # the last: test_fix.py's "AQ.Ab8_madeUp-Test.key"
ALLOW = "gitleaks:allow"  # the marker gitleaks and this file both honour, for a fake that doesn't start like one above
NAMES = re.compile(r"(^|/)(\.env|\.dev\.vars|invite-code\.txt|gemini-key\.txt|relay/tokens\.json)$|\.(pem|key|p12|pfx)$")


def _git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, check=True).stdout.decode(  # noqa: S603, S607 - fixed git commands
        "utf-8", errors="replace")


def hits():
    """-> sorted [(commit, file, what)], what = a kind of secret or "a secret's file name". No values."""
    found, shapes = set(), [(what, re.compile(p)) for what, p in SHAPES.items()]
    commit = path = None
    for line in _git("log", "--all", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--format=commit %H").splitlines():
        if line.startswith("commit "):
            commit, path = line[7:15], None
        elif line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("+") and path and ALLOW not in line:
            for what, shape in shapes:
                if any(not m.group().startswith(FAKES) for m in shape.finditer(line)):
                    found.add((commit, path, what))
    commit = None
    for line in _git("log", "--all", "--diff-filter=A", "--name-only", "--no-color", "--format=commit %H").splitlines():
        if line.startswith("commit "):
            commit = line[7:15]
        elif line and NAMES.search(line):
            found.add((commit, line, "a secret's file name"))
    return sorted(found)


def main(argv):
    if _git("rev-parse", "--is-shallow-repository").strip() == "true":
        note = "a shallow checkout holds only its last commits: run git fetch --unshallow to read the whole history"
        print(("FAIL: " if "--full" in argv else "SKIP: ") + note)
        return 1 if "--full" in argv else 0
    found = hits()
    for commit, path, what in found:
        print(f"{commit}  {path}: {what}")
    print(f"{len(found)} secret(s) in the history: revoke each one first, then rewrite the history" if found
          else "no secret in any commit of the history")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
