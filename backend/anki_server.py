"""
The Anki engine: one anki-cli server (https://github.com/Macro002/anki-cli) for all accounts.

Every AnkiBase account is an anki-cli *profile* (a folder with collection.anki2 and
collection.media) under ANKI_DATA_DIR. The server speaks AnkiConnect's protocol, so the rest
of the backend talks to it with the same actions as before; a profile is selected by the
URL prefix /profiles/<name>/.

On a server with systemd the engine runs as its own service (ankibase-anki), so restarting
AnkiBase doesn't close the collections. Elsewhere (development) it runs as a child process.
It lives in its own virtualenv (ANKI_DATA_DIR/.venv, pinned by engine-requirements.txt):
the `anki` package needs a newer protobuf than AnkiBase's AI SDKs allow.
"""
from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

import httpx

BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("ANKI_DATA_DIR") or BACKEND_DIR.parent / "anki-data")
HOST = "127.0.0.1"
PORT = int(os.getenv("ANKICLI_PORT", "8745"))  # below the old containers' 8765+
URL = os.getenv("ANKICLI_URL") or f"http://{HOST}:{PORT}"
SERVICE = "ankibase-anki"
UNIT_PATH = Path(f"/etc/systemd/system/{SERVICE}.service")
ENV_FILE = DATA_DIR / ".env"
VENV = DATA_DIR / ".venv"
REQUIREMENTS = BACKEND_DIR / "engine-requirements.txt"
RESTART_MARKER = VENV / ".restart"

# What the engine is doing, for friendly errors while it starts: "starting", "installing",
# "migrating", "ready" or "failed: …".
status = "starting"

_child: subprocess.Popen | None = None
_key: str | None = None


def api_key() -> str:
    """The server's API key, generated once and kept next to the collections (mode 0600)."""
    global _key
    if _key:
        return _key
    key = os.getenv("ANKICLI_API_KEY")
    if not key:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if ENV_FILE.exists():
            for line in ENV_FILE.read_text().splitlines():
                if line.startswith("ANKICLI_API_KEY="):
                    key = line.split("=", 1)[1].strip()
    if not key:
        key = secrets.token_urlsafe(32)
        fd = os.open(ENV_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write(f"ANKICLI_API_KEY={key}\n")
    _key = key
    return key


def profile_url(profile: str) -> str:
    """Base URL of one account's collection (AnkiConnect protocol at this URL)."""
    return f"{URL}/profiles/{urllib.parse.quote(profile, safe='')}/"


def auth_headers() -> dict:
    return {"Authorization": f"Bearer {api_key()}"}


# -- talking to the server --------------------------------------------------------------------

class EngineError(Exception):
    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.code = code


def call(method: str, profile: str | None = None, timeout: float = 30.0, **params):
    """A v1 call, synchronously (startup, account management)."""
    base = profile_url(profile) if profile else URL + "/"
    reply = httpx.post(base + "api/v1", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                       headers=auth_headers(), timeout=timeout).json()
    if "error" in reply:
        error = reply["error"]
        raise EngineError(error.get("message", "Anki error"), (error.get("data") or {}).get("type", ""))
    return reply["result"]


def healthy() -> bool:
    try:
        return call("server.info", timeout=3).get("name") == "anki-cli"
    except Exception:
        return False


# -- installing and running it -----------------------------------------------------------------

def engine_python() -> str:
    return os.getenv("ANKICLI_PYTHON") or str(VENV / "bin" / "python")


def install_engine() -> bool:
    """Install or update anki-cli in its virtualenv. Returns True if anything changed."""
    if os.getenv("ANKICLI_PYTHON"):
        return False
    wanted = REQUIREMENTS.read_text().strip()
    marker = VENV / ".requirements"
    if marker.exists() and marker.read_text().strip() == wanted and Path(engine_python()).exists():
        return False
    if not Path(engine_python()).exists():
        subprocess.run([sys.executable, "-m", "venv", "--clear", str(VENV)], check=True, capture_output=True)
    pip = [str(VENV / "bin" / "pip"), "install", "-q", "--disable-pip-version-check"]
    # Dependencies first, then the pinned commit itself: pip treats another commit of the
    # same version as already installed.
    for extra in ([], ["--force-reinstall", "--no-deps"]):
        result = subprocess.run(pip + extra + ["-r", str(REQUIREMENTS)], capture_output=True, text=True,
                                timeout=1200)
        if result.returncode != 0:
            raise RuntimeError("Installing anki-cli failed: " + (result.stderr or result.stdout)[-2000:])
    marker.write_text(wanted + "\n")
    RESTART_MARKER.touch()  # a running engine picks the new version up on the next start
    return True


def needs_restart() -> bool:
    return RESTART_MARKER.exists()


def restarted() -> None:
    RESTART_MARKER.unlink(missing_ok=True)


def _command() -> list[str]:
    return [engine_python(), "-m", "ankicli", "serve", "--base", str(DATA_DIR), "--host", HOST,
            "--port", str(PORT), "--backup-minutes", "60", "--log-level", "warning"]


def _unit() -> str:
    command = " ".join(f'"{part}"' if " " in part else part for part in _command())
    return f"""[Unit]
Description=AnkiBase Anki engine (anki-cli)
After=network.target

[Service]
Type=simple
EnvironmentFile={ENV_FILE}
ExecStart={command}
Restart=always
RestartSec=2
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
"""


def _systemd_available() -> bool:
    if os.getenv("ANKI_ENGINE_SYSTEMD", "1") == "0":
        return False
    return os.geteuid() == 0 and shutil.which("systemctl") is not None and Path("/run/systemd/system").is_dir()


def _wait(seconds: float) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if healthy():
            return True
        time.sleep(0.3)
    return False


def ensure_running() -> bool:
    """Start the engine if it isn't running (installing or updating its service as needed)."""
    global _child
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    api_key()
    if _systemd_available():
        unit = _unit()
        changed = not UNIT_PATH.exists() or UNIT_PATH.read_text() != unit
        if changed:
            UNIT_PATH.write_text(unit)
            subprocess.run(["systemctl", "daemon-reload"], check=False)
            subprocess.run(["systemctl", "enable", SERVICE], check=False, capture_output=True)
            subprocess.run(["systemctl", "restart", SERVICE], check=False)
        elif not healthy():
            subprocess.run(["systemctl", "restart", SERVICE], check=False)
        else:
            return True
        ok = _wait(30)
        print(f"{'✓' if ok else '✗'} Anki engine (anki-cli) {'running' if ok else 'did not start'} at {URL}")
        return ok
    if healthy():
        return True
    if _child is None or _child.poll() is not None:
        env = {**os.environ, "ANKICLI_API_KEY": api_key()}
        _child = subprocess.Popen(_command(), env=env)
    ok = _wait(30)
    print(f"{'✓' if ok else '✗'} Anki engine (anki-cli) {'running' if ok else 'did not start'} at {URL}")
    return ok


def stop_child() -> None:
    """Stop the development child process (the systemd service keeps running)."""
    if _child is not None and _child.poll() is None:
        _child.terminate()
        try:
            _child.wait(30)
        except subprocess.TimeoutExpired:
            _child.kill()


def stop() -> None:
    """Stop the engine (its collections are closed cleanly)."""
    if _systemd_available() and UNIT_PATH.exists():
        subprocess.run(["systemctl", "stop", SERVICE], check=False)
    stop_child()


def restart() -> bool:
    if _systemd_available():
        subprocess.run(["systemctl", "restart", SERVICE], check=False)
        return _wait(30)
    stop_child()
    return ensure_running()
