import pytest

from anomaly_hunter.ai import client


@pytest.fixture(autouse=True)
def no_real_ai_keys(monkeypatch, tmp_path):
    """No test may see this PC's real AI key or invite code: tests would call Google with John's key and spend his
    free quota (it happened once a real key was saved). Each test gets empty key files of its own."""
    monkeypatch.setattr(client, "KEY_FILE", tmp_path / "gemini-key.txt")
    monkeypatch.setattr(client, "INVITE_FILE", tmp_path / "invite-code.txt")
    monkeypatch.setattr(client, "RELAY_URL", "")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
