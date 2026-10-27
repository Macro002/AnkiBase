"""
Your own Anki sync server, run by AnkiBase next to the Anki engine.

It is Anki's own sync server (`python -m anki.syncserver`, part of the `anki` package the
engine already uses), so Anki Desktop, AnkiMobile, AnkiDroid and the AnkiBase app sync with
it exactly as with AnkiWeb. AnkiBase serves it at https://<your AnkiBase>/syncserver/
(main.py proxies to it), so it gets AnkiBase's HTTPS and needs no port of its own.

Accounts are kept in ANKI_DATA_DIR/.sync/accounts.json with PBKDF2 hashes (the format Anki's
server checks with PASSWORDS_HASHED), never the passwords. Each account's collection is a
folder under ANKI_DATA_DIR/.sync/data/<name>/. Like the engine, the server is a systemd
service (ankibase-sync) where available, otherwise a child process.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import time
from pathlib import Path

import httpx

import anki_server

DIR = anki_server.DATA_DIR / ".sync"
ACCOUNTS = DIR / "accounts.json"
STATE = DIR / "state.json"
LAUNCHER = DIR / "run.py"
HOST = "127.0.0.1"
PORT = int(os.getenv("ANKIBASE_SYNC_PORT", "8748"))
URL = f"http://{HOST}:{PORT}"
PREFIX = "/syncserver"
SERVICE = "ankibase-sync"
UNIT_PATH = Path(f"/etc/systemd/system/{SERVICE}.service")
NAME = re.compile(r"^[A-Za-z0-9._@+-]{1,64}$")

# Sets Anki's SYNC_* variables from the accounts file, then runs Anki's sync server. A file
# rather than environment variables in the unit: the hashes contain "$".
LAUNCHER_CODE = '''\
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
accounts = json.load(open(os.path.join(here, "accounts.json")))
if not accounts:
    sys.exit("No sync accounts")
for i, account in enumerate(accounts, 1):
    os.environ[f"SYNC_USER{i}"] = account["name"] + ":" + account["hash"]
os.environ["PASSWORDS_HASHED"] = "1"
os.environ["SYNC_BASE"] = os.path.join(here, "data")
os.environ["SYNC_HOST"] = sys.argv[1]
os.environ["SYNC_PORT"] = sys.argv[2]
from anki.syncserver import run_sync_server
run_sync_server()
'''

_child: subprocess.Popen | None = None


# -- accounts -------------------------------------------------------------------------------------

def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode().rstrip("=")


def hash_password(password: str, rounds: int = 600_000) -> str:
    """A PHC-format PBKDF2-SHA256 hash, as Anki's sync server verifies them."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, rounds, 32)
    return f"$pbkdf2-sha256$i={rounds},l=32${_b64(salt)}${_b64(digest)}"


def accounts() -> list[dict]:
    try:
        return json.loads(ACCOUNTS.read_text())
    except (OSError, ValueError):
        return []


def _save_accounts(items: list[dict]) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    temporary = ACCOUNTS.with_suffix(".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(items, file, indent=1)
    temporary.replace(ACCOUNTS)


def add_account(name: str, password: str) -> None:
    name = name.strip()
    if not NAME.match(name):
        raise ValueError("Use letters, numbers and . _ @ + - for the name (up to 64)")
    if len(password) < 6:
        raise ValueError("The password needs at least 6 characters")
    items = [a for a in accounts() if a["name"] != name]
    items.append({"name": name, "hash": hash_password(password), "created": int(time.time())})
    _save_accounts(items)


def remove_account(name: str, delete_data: bool = False) -> None:
    _save_accounts([a for a in accounts() if a["name"] != name])
    if delete_data and NAME.match(name):
        shutil.rmtree(DIR / "data" / name, ignore_errors=True)


def collection_size(name: str) -> int:
    folder = DIR / "data" / name
    return sum(f.stat().st_size for f in folder.rglob("*") if f.is_file()) if folder.is_dir() else 0


# -- running it -----------------------------------------------------------------------------------

def _state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


def enabled() -> bool:
    return bool(_state().get("enabled"))


def _set_enabled(on: bool) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps({"enabled": on}))


def installed() -> bool:
    """Anki's sync server comes with the `anki` package in the engine's virtualenv."""
    python = anki_server.engine_python()
    if not Path(python).exists():
        return False
    result = subprocess.run([python, "-c", "import anki.syncserver"], capture_output=True, timeout=60)
    return result.returncode == 0


def install() -> None:
    """Make sure the engine (and with it Anki's sync server) is installed."""
    if not installed():
        anki_server.install_engine()
    if not installed():
        raise RuntimeError("Anki's sync server isn't available in the engine's environment")
    DIR.mkdir(parents=True, exist_ok=True)
    (DIR / "data").mkdir(exist_ok=True)
    LAUNCHER.write_text(LAUNCHER_CODE)


def _command() -> list[str]:
    return [anki_server.engine_python(), str(LAUNCHER), HOST, str(PORT)]


def _unit() -> str:
    command = " ".join(f'"{part}"' if " " in part else part for part in _command())
    return f"""[Unit]
Description=AnkiBase sync server (Anki's own)
After=network.target

[Service]
Type=simple
Environment=RUST_LOG=anki=warn
ExecStart={command}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
"""


def healthy() -> bool:
    try:
        # Anki's server answers its own paths; anything else is a 404 from it.
        return httpx.get(URL + "/", timeout=2).status_code < 500
    except httpx.HTTPError:
        return False


def _wait(seconds: float) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if healthy():
            return True
        time.sleep(0.3)
    return False


def start() -> bool:
    """(Re)start the server with the current accounts."""
    global _child
    install()
    if not accounts():
        raise ValueError("Add an account first")
    _set_enabled(True)
    if anki_server._systemd_available():
        unit = _unit()
        if not UNIT_PATH.exists() or UNIT_PATH.read_text() != unit:
            UNIT_PATH.write_text(unit)
            subprocess.run(["systemctl", "daemon-reload"], check=False)
            subprocess.run(["systemctl", "enable", SERVICE], check=False, capture_output=True)
        subprocess.run(["systemctl", "restart", SERVICE], check=False)
        return _wait(20)
    stop_child()
    _child = subprocess.Popen(_command(), env={**os.environ, "RUST_LOG": "anki=warn"})
    return _wait(20)


def stop_child() -> None:
    global _child
    if _child is not None and _child.poll() is None:
        _child.terminate()
        try:
            _child.wait(15)
        except subprocess.TimeoutExpired:
            _child.kill()
    _child = None


def stop() -> None:
    _set_enabled(False)
    if anki_server._systemd_available() and UNIT_PATH.exists():
        subprocess.run(["systemctl", "stop", SERVICE], check=False)
        subprocess.run(["systemctl", "disable", SERVICE], check=False, capture_output=True)
    stop_child()


def ensure_running() -> None:
    """At startup: bring the server back if it was turned on."""
    if enabled() and accounts() and not healthy():
        try:
            start()
        except Exception as error:  # noqa: BLE001 - reported in the status, not fatal
            print(f"✗ Sync server didn't start: {error}")


def status() -> dict:
    running = healthy()
    return {
        "installed": LAUNCHER.exists() and installed() if not running else True,
        "enabled": enabled(),
        "running": running,
        "accounts": [{"name": a["name"], "created": a.get("created"), "size": collection_size(a["name"])}
                     for a in accounts()],
    }
