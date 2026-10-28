"""
Updating AnkiBase from the web UI (Settings → Server / the header's Update button).

Safe by default:
- follows tagged releases (vX.Y.Z), unless UPDATE_CHANNEL=main in .env;
- builds and checks the new version in a temporary folder first: the frontend has to
  build, the Python dependencies have to install, and the new backend has to import;
- backs up the current code and data (users, Quizlet sets, stories, settings; the Anki
  collections have their own backups) to BACKUP_DIR, keeping the last few;
- after installing it restarts the service from a detached script that waits for the new
  version to answer, and puts the backup back if it doesn't.

install.sh --update does the same from the command line.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import AsyncIterator

BACKEND = Path(__file__).resolve().parent
VERSION_FILE = BACKEND / ".version"
REPO = os.getenv("UPDATE_REPO", "Macro002/AnkiBase")  # owner/name on GitHub, or any git URL/path
REPO_URL = REPO if ("://" in REPO or REPO.startswith("/")) else f"https://github.com/{REPO}.git"
BACKUP_DIR = Path(os.getenv("ANKIBASE_BACKUP_DIR") or BACKEND.parent / "backups")
KEEP_BACKUPS = 3
# In Docker the image is the update: pulling a new one replaces the code (data is in /data).
DOCKER = os.getenv("ANKIBASE_DOCKER") == "1"
DOCKER_UPDATE = "docker compose pull && docker compose up -d"
SERVICE = os.getenv("ANKIBASE_SERVICE", "ankibase")
# Never touched by an update.
KEEP = ["venv", ".env", "*.db", "*.db-wal", "*.db-shm", "data", ".version", "static", "__pycache__", "*.pyc"]
TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")


def channel() -> str:
    from config import get_settings
    return "main" if get_settings().update_channel.strip().lower() == "main" else "release"


def current() -> str:
    try:
        return VERSION_FILE.read_text().strip() or "unknown"
    except OSError:
        return "unknown"


def _git(*args: str, timeout: int = 30) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, timeout=timeout, check=True).stdout


def latest() -> tuple[str, str]:
    """(version, git ref to fetch): the newest release tag, or main's newest commit."""
    url = REPO_URL
    if channel() == "release":
        tags = []
        for line in _git("ls-remote", "--tags", "--refs", url).splitlines():
            name = line.split("refs/tags/")[-1]
            match = TAG.match(name)
            if match:
                tags.append((tuple(int(x) for x in match.groups()), name))
        if tags:
            name = max(tags)[1]
            return name, name
    head = _git("ls-remote", url, "HEAD").split()
    return (head[0], "HEAD") if head else ("unknown", "HEAD")


def check() -> dict:
    try:
        version, _ = latest()
    except Exception:
        version = "unknown"
    here = current()
    return {"current": here, "latest": version, "channel": channel(), "docker": DOCKER,
            "has_update": "unknown" not in (version, here) and version != here}


async def _run(cmd: list[str], cwd: Path | None = None, env: dict | None = None) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        *cmd, cwd=str(cwd) if cwd else None, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await process.communicate()
    return process.returncode, out.decode(errors="replace")


def _backup() -> Path:
    """The current code and data, for a rollback."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    target = BACKUP_DIR / time.strftime("%Y%m%d-%H%M%S")
    shutil.copytree(BACKEND, target / "backend", symlinks=True,
                    ignore=shutil.ignore_patterns("venv", "__pycache__", "*.pyc", "static"))
    if (BACKEND / "static").is_dir():
        shutil.copytree(BACKEND / "static", target / "static")
    backups = sorted(p for p in BACKUP_DIR.iterdir() if p.is_dir())
    for old in backups[:-KEEP_BACKUPS]:
        shutil.rmtree(old, ignore_errors=True)
    return target


RESTART_SCRIPT = """#!/bin/bash
# Restart AnkiBase on the new version; if it doesn't answer within two minutes, put the
# previous version back (from this backup) and restart that.
sleep 2
systemctl restart {service}
for i in $(seq 1 60); do
  sleep 2
  curl -fsS "http://127.0.0.1:{port}/api/setup/status" >/dev/null 2>&1 && exit 0
done
echo "AnkiBase didn't start after the update; restoring {backup}" >&2
rsync -a --exclude venv "{backup}/backend/" "{backend}/"
rsync -a --delete "{backup}/static/" "{backend}/static/"
systemctl restart {service}
"""


async def apply() -> AsyncIterator[dict]:
    """Update, reporting progress as {type: step|log|done|error, message, progress}."""
    if DOCKER:
        yield {"type": "error", "message": f"This AnkiBase runs in Docker: update it with `{DOCKER_UPDATE}`."}
        return
    tmp = Path(tempfile.mkdtemp(prefix="ankibase-update-"))
    try:
        yield {"type": "step", "message": "Looking for the new version…", "progress": 3}
        try:
            version, ref = await asyncio.to_thread(latest)
        except Exception as error:
            yield {"type": "error", "message": f"Couldn't reach GitHub: {error}"}
            return
        clone = ["git", "clone", "--depth", "1"] + (["--branch", ref] if ref != "HEAD" else [])
        code, out = await _run(clone + [REPO_URL, str(tmp / "src")])
        if code:
            yield {"type": "error", "message": "Downloading failed: " + out[-400:]}
            return
        src = tmp / "src"
        if ref == "HEAD":
            version = (await _run(["git", "-C", str(src), "rev-parse", "HEAD"]))[1].strip()

        yield {"type": "step", "message": f"Building {version[:12]}…", "progress": 15}
        npm = ["npm", "ci"] if (src / "frontend" / "package-lock.json").exists() else ["npm", "install"]
        for step, progress in ((npm, 25), (["npm", "run", "build"], 45)):
            code, out = await _run(step, cwd=src / "frontend")
            if code:
                yield {"type": "error", "message": f"{' '.join(step)} failed (nothing was changed):\n" + out[-800:]}
                return
            yield {"type": "log", "message": f"✓ {' '.join(step)}", "progress": progress}

        yield {"type": "step", "message": "Installing Python dependencies…", "progress": 55}
        python = str(BACKEND / "venv" / "bin" / "python")
        code, out = await _run([python, "-m", "pip", "install", "-q", "-r", str(src / "backend" / "requirements.txt")])
        if code:
            yield {"type": "error", "message": "Installing dependencies failed (nothing was changed):\n" + out[-800:]}
            return

        yield {"type": "step", "message": "Checking the new version…", "progress": 65}
        env = {**os.environ, "ANKI_DATA_DIR": str(tmp / "anki-data")}
        code, out = await _run([python, "-c", "import main"], cwd=src / "backend", env=env)
        if code:
            yield {"type": "error", "message": "The new version doesn't start (nothing was changed):\n" + out[-800:]}
            return

        yield {"type": "step", "message": "Backing up…", "progress": 72}
        backup = await asyncio.to_thread(_backup)
        yield {"type": "log", "message": f"✓ Backup in {backup}", "progress": 75}

        yield {"type": "step", "message": "Installing…", "progress": 80}
        excludes = [f"--exclude={pattern}" for pattern in KEEP]
        code, out = await _run(["rsync", "-a", *excludes, f"{src / 'backend'}/", f"{BACKEND}/"])
        if not code:
            code, out = await _run(["rsync", "-a", "--delete", f"{src / 'frontend' / 'dist'}/", f"{BACKEND / 'static'}/"])
        if code:
            yield {"type": "error", "message": "Copying the files failed; restoring the backup:\n" + out[-400:]}
            await _run(["rsync", "-a", "--exclude", "venv", f"{backup / 'backend'}/", f"{BACKEND}/"])
            return
        VERSION_FILE.write_text(version + "\n")

        yield {"type": "step", "message": "Updating Anki…", "progress": 88}
        code, out = await _run([python, "-c", "import anki_server; anki_server.install_engine()"], cwd=BACKEND)
        if code:
            yield {"type": "log", "message": "Anki's engine wasn't updated (the old one keeps running):\n" + out[-400:]}

        yield {"type": "step", "message": "Restarting…", "progress": 94}
        port = os.getenv("APP_PORT", "8000")
        script = backup / "restart.sh"
        script.write_text(RESTART_SCRIPT.format(port=port, backup=backup, backend=BACKEND, service=SERVICE))
        script.chmod(0o700)
        # Outside the service, which the restart stops (with everything it started).
        if shutil.which("systemd-run"):
            command = ["systemd-run", "--unit", f"ankibase-update-{int(time.time())}", "--collect", "bash", str(script)]
        else:
            command = ["setsid", "bash", str(script)]
        await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL,
                                             stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
        yield {"type": "done", "message": f"Updated to {version[:12]}. Restarting…", "progress": 100}
    except Exception as error:  # noqa: BLE001 - reported to the admin
        yield {"type": "error", "message": str(error)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def json_event(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"
