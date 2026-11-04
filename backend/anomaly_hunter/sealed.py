"""The AI key and the invite code on disk. On Windows they are sealed with DPAPI for this Windows account (AH-104): a
plain-text gemini-key.txt went wherever a backup, a synced folder or another program's copy of the folder went, and
worked there. Sealed bytes open only for the Windows account that sealed them. Off Windows (`serve` on Linux or a
Mac) there is no DPAPI: the file stays plain text that only its owner can read (0600)."""
import base64
import os

PREFIX = b"DPAPI1:"  # then base64 of the DPAPI blob; a file without it is plain text an older version wrote


def write_private(path, data):
    """A secret file only its owner can read. On Linux and a Mac (`serve`) the key, the invite code and key.pem were
    written 0644 by the default umask: any account on the machine could read them (AH-87 audit). Windows has no such
    bits: the file sits in %LOCALAPPDATA%, whose ACL already gives it to this user (and SYSTEM, admins) alone."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)  # 0600 from birth
    with os.fdopen(fd, "wb") as f:
        if os.name != "nt":
            os.fchmod(fd, 0o600)  # a file an older version wrote 0644 is tightened too
        f.write(data.encode("utf-8") if isinstance(data, str) else data)


def _dpapi():
    """(seal, open) through crypt32, this user's scope; no package for it (one more download and pin for two calls)."""
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes, kernel32.LocalFree.restype = [ctypes.c_void_p], ctypes.c_void_p
    forbid_ui = 0x1  # CRYPTPROTECT_UI_FORBIDDEN: the hidden engine can never show a prompt
    calls = []
    for fn in (crypt32.CryptProtectData, crypt32.CryptUnprotectData):
        fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                       wintypes.DWORD, ctypes.POINTER(Blob)]
        fn.restype = wintypes.BOOL

        def call(data, fn=fn):
            buf = ctypes.create_string_buffer(data, len(data))
            out = Blob()
            if not fn(ctypes.byref(Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))), None, None, None,
                      None, forbid_ui, ctypes.byref(out)):
                raise OSError(ctypes.get_last_error(), "DPAPI refused")
            try:
                return ctypes.string_at(out.pbData, out.cbData)
            finally:
                kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))
        calls.append(call)
    return tuple(calls)


SEAL = _dpapi() if os.name == "nt" else None  # (seal, open); a test swaps in its own to run the Windows path anywhere


def save(path, text):
    write_private(path, PREFIX + base64.b64encode(SEAL[0](text.encode("utf-8"))) if SEAL else text)


def read(path):
    """The saved text, or "" when there is none or this account can't open it (a file copied from another account or
    PC, a damaged one): AI help then reads as off and the pane can save a new key, never an engine error."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return ""
    if raw.startswith(PREFIX):
        try:
            return SEAL[1](base64.b64decode(raw[len(PREFIX):], validate=True)).decode("utf-8").strip() if SEAL else ""
        except (OSError, ValueError):
            return ""
    text = raw.decode("utf-8", errors="replace").strip()
    if SEAL and text:  # written by install.bat or a version before AH-104: sealed now, so an update keeps the key
        try:
            save(path, text)
        except OSError:
            pass  # a read-only file or a full disk: still this user's key, sealed at a later read
    return text
