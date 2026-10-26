"""
One-time move from per-account headless-anki Docker containers to anki-cli profiles.

For every account still on a container: stop the container, copy its collection (SQLite's
backup API, so a WAL file is included consistently) and media (hard links where possible) into
ANKI_DATA_DIR/<account>/, carry over the AnkiWeb login from Anki's prefs21.db, then remove the
container. Docker volumes are left alone so nothing is lost if something looks wrong; remove
them by hand once you're happy (`docker volume ls`).
"""
from __future__ import annotations

import json
import os
import pickle
import shutil
import sqlite3
import subprocess
from pathlib import Path

import anki_server
from database import get_all_accounts, get_db

VOLUMES = Path(os.getenv("DOCKER_VOLUMES_DIR", "/var/lib/docker/volumes"))
MIGRATED_PREFIX = "anki-cli:"


def pending() -> list[dict]:
    return [a for a in get_all_accounts() if not str(a.get("volume_name") or "").startswith(MIGRATED_PREFIX)]


def _mark(account_id: int, name: str) -> None:
    with get_db() as conn:
        conn.execute("UPDATE anki_accounts SET volume_name = ? WHERE id = ?", (MIGRATED_PREFIX + name, account_id))
        conn.commit()


def _docker(*args: str, timeout: float = 90) -> bool:
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", *args], capture_output=True, timeout=timeout).returncode == 0
    except Exception:
        return False


class _Stub:
    def __init__(self, *args, **kwargs):
        pass

    def __setstate__(self, state):
        pass


class _ProfileUnpickler(pickle.Unpickler):
    """Anki pickles Qt objects (window geometry) into profiles; read only plain values."""

    def find_class(self, module, name):
        if module == "builtins" and name in ("dict", "list", "set", "tuple", "str", "int", "float", "bytes"):
            return super().find_class(module, name)
        return _Stub


def _sync_login(volume: Path, profile: str) -> dict:
    db = volume / "prefs21.db"
    if not db.exists():
        return {}
    try:
        with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
            row = conn.execute("SELECT data FROM profiles WHERE name = ?", (profile,)).fetchone()
        data = _ProfileUnpickler(__import__("io").BytesIO(row[0])).load() if row else {}
    except Exception as error:
        print(f"  ! couldn't read the AnkiWeb login from prefs21.db: {error}")
        return {}
    if not isinstance(data, dict) or not data.get("syncKey"):
        return {}
    login = {"syncKey": data["syncKey"], "syncUser": data.get("syncUser")}
    endpoint = data.get("currentSyncUrl") or data.get("customSyncUrl")
    if isinstance(endpoint, str) and endpoint:
        login["syncEndpoint"] = endpoint
    return login


def _find_profile(volume: Path) -> Path | None:
    preferred = volume / "User 1"
    if (preferred / "collection.anki2").exists():
        return preferred
    for entry in sorted(volume.iterdir()) if volume.is_dir() else []:
        if entry.is_dir() and (entry / "collection.anki2").exists():
            return entry
    return None


def _copy_db(src: Path, dst: Path) -> None:
    tmp = dst.with_name(dst.name + ".part")
    tmp.unlink(missing_ok=True)
    with sqlite3.connect(f"file:{src}?mode=ro", uri=True) as source, sqlite3.connect(tmp) as target:
        source.backup(target)
    os.replace(tmp, dst)


def _link_tree(src: Path, dst: Path) -> int:
    count = 0
    for root, _dirs, files in os.walk(src):
        target = dst / Path(root).relative_to(src)
        target.mkdir(parents=True, exist_ok=True)
        for name in files:
            if (target / name).exists():
                continue
            try:
                os.link(Path(root) / name, target / name)
            except OSError:
                shutil.copy2(Path(root) / name, target / name)
            count += 1
    return count


def _save_logins(logins: dict[str, dict]) -> None:
    if not logins:
        return
    path = anki_server.DATA_DIR / "anki-cli.json"
    settings = json.loads(path.read_text()) if path.exists() else {}
    for name, login in logins.items():
        settings.setdefault("profiles", {}).setdefault(name, {}).update(login)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(settings, file, indent=2)


def migrate() -> list[str]:
    """Move every pending account. Must run while the engine is stopped. Returns their names."""
    accounts = pending()
    if not accounts:
        return []
    anki_server.DATA_DIR.mkdir(parents=True, exist_ok=True)
    logins: dict[str, dict] = {}
    moved = []
    for account in accounts:
        name = account["container_name"]
        dest = anki_server.DATA_DIR / name
        print(f"Migrating Anki account '{name}' to anki-cli…")
        if (dest / "collection.anki2").exists():
            print("  already copied")
            _mark(account["id"], name)
            moved.append(name)
            continue
        volume = VOLUMES / str(account.get("volume_name") or "") / "_data"
        _docker("update", "--restart=no", name)
        _docker("stop", "-t", "60", name)
        profile = _find_profile(volume)
        dest.mkdir(parents=True, exist_ok=True)
        if profile is None:
            print(f"  ! no collection found in {volume}; starting with an empty one")
        else:
            _copy_db(profile / "collection.anki2", dest / "collection.anki2")
            if (profile / "collection.media.db2").exists():
                _copy_db(profile / "collection.media.db2", dest / "collection.media.db2")
            files = _link_tree(profile / "collection.media", dest / "collection.media") \
                if (profile / "collection.media").is_dir() else 0
            print(f"  ✓ collection and {files} media files copied")
            login = _sync_login(volume, profile.name)
            if login:
                logins[name] = login
                if login.get("syncUser"):
                    with get_db() as conn:
                        conn.execute("UPDATE anki_accounts SET ankiweb_email = ? WHERE id = ?",
                                     (login["syncUser"], account["id"]))
                        conn.commit()
                print(f"  ✓ AnkiWeb login carried over ({login.get('syncUser') or 'account'})")
        _mark(account["id"], name)
        if profile is not None:
            _docker("rm", name)
        moved.append(name)
    _save_logins(logins)
    return moved
