"""tools/secret_history.py on throwaway git repos: a secret anywhere in the history is found and never printed."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parents[2] / "tools" / "secret_history.py"
# built here, so no test file ever holds a whole secret's shape for the real scan to find
GOOGLE = "AIza" + "Qx7_" * 8 + "abc"
INVITE = "inv_" + "Zk3-" * 6
PRIVATE = "-----BEGIN " + "EC PRIVATE KEY-----"
GITHUB = "ghp_" + "a1B2" * 9

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="needs git")


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
                    *args], check=True, capture_output=True)


def repo_with(tmp_path, *commits):
    """commits: {path: text or None (delete)} each -> a repo with the scanner beside it, untracked."""
    repo = tmp_path / "repo"
    repo.mkdir(parents=True)
    git(repo, "init", "-q", "-b", "main")
    for files in commits:
        for name, text in files.items():
            if text is None:
                git(repo, "rm", "-q", name)
            else:
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                (repo / name).write_text(text, encoding="utf-8")
                git(repo, "add", name)
        git(repo, "commit", "-q", "-m", "c")
    (repo / "tools").mkdir(exist_ok=True)
    shutil.copy(TOOL, repo / "tools" / "secret_history.py")
    return repo


def scan(repo, *args):
    r = subprocess.run([sys.executable, str(repo / "tools" / "secret_history.py"), *args], capture_output=True, text=True, timeout=60, check=False)
    return r.returncode, r.stdout + r.stderr


def test_a_clean_history_passes(tmp_path):
    repo = repo_with(tmp_path, {"app.py": "KEY_FILE = 'gemini-key'  # read from this PC, never the repo\n"},
                     {"README.md": "Paste a key that starts with AIza. Invite codes start with inv_.\n"})
    assert scan(repo) == (0, "no secret in any commit of the history\n")


@pytest.mark.parametrize("secret,what", [(GOOGLE, "a Google API key"), (INVITE, "a relay invite code"),
                                         (PRIVATE, "a private key block"), (GITHUB, "a GitHub token")])
def test_a_secret_deleted_in_a_later_commit_is_still_found_and_never_printed(tmp_path, secret, what):
    repo = repo_with(tmp_path, {"README.md": "hello\n"}, {"config.py": f"KEY = '{secret}'\n"}, {"config.py": None})
    code, out = scan(repo)
    assert code == 1 and f"config.py: {what}" in out, out
    assert secret not in out and secret[6:20] not in out  # not the value, nor a piece of it


def test_a_file_named_like_a_secret_ever_added_is_found(tmp_path):
    for name in (".env", "relay/tokens.json", "invite-code.txt", "server.key", "certs/key.pem", ".dev.vars"):
        repo = repo_with(tmp_path / name.replace("/", "_"), {name: "x=1\n"}, {name: None})
        code, out = scan(repo)
        assert code == 1 and f"{name}: a secret's file name" in out, (name, out)


def test_the_tests_own_made_up_values_pass_but_a_real_key_beside_them_does_not(tmp_path):
    fakes = ("GEMINI = 'AIzaSECRET-key-should-never-be-in-a-prompt'\nINVITE = 'inv_SECRETinvitecodeneverinaprompt'\n"
             "CODE = 'inv_e2eNotARealInviteCode123'\n" f"OTHER = '{GOOGLE}'  # gitleaks:allow - made-up\n")
    assert scan(repo_with(tmp_path / "a", {"test_x.py": fakes}))[0] == 0
    code, out = scan(repo_with(tmp_path / "b", {"test_x.py": fakes + f"REAL = '{INVITE}'\n"}))
    assert code == 1 and "test_x.py: a relay invite code" in out and INVITE not in out


def test_a_shallow_checkout_is_a_skip_and_a_failure_when_the_whole_history_is_required(tmp_path):
    repo = repo_with(tmp_path, {"a.txt": "1\n"}, {"a.txt": "2\n"})
    shallow = tmp_path / "shallow"
    subprocess.run(["git", "clone", "-q", "--depth", "1", repo.as_uri(), str(shallow)], check=True, capture_output=True)
    (shallow / "tools").mkdir()
    shutil.copy(TOOL, shallow / "tools" / "secret_history.py")
    code, out = scan(shallow)
    assert code == 0 and out.startswith("SKIP:") and "unshallow" in out
    code, out = scan(shallow, "--full")
    assert code == 1 and out.startswith("FAIL:")
