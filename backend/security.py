"""
Who may do what, and the protections every request gets.

- Users and permissions: the session only says *who* is logged in. Their rights are read
  from the database on every request, so a changed permission or a deleted user takes
  effect at once.
- Profiles: each login session has its own active profile, limited to the profiles that
  user may use (admins: all). `current_profile` holds it for the request; database.py's
  get_active_account() reads it, so everything (Anki, stories, Quizlet, sessions) follows
  the user's own profile instead of one shared server-wide.
- Secrets: the app's signing key and the key that encrypts stored API keys are generated
  once into data/.secrets (mode 0600) unless the environment provides them.
- Outgoing requests to addresses users type in are checked so they can't reach the
  server's own network (SSRF).
"""
from __future__ import annotations

import base64
import ipaddress
import json
import os
import secrets
import socket
from contextvars import ContextVar
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
SECRETS_FILE = os.path.join(BACKEND_DIR, "data", ".secrets")

# Permission name -> users table column. Admins have every permission.
PERMISSIONS = {
    "manage_profiles": "can_add_containers",   # create, rename and delete profiles
    "server_theme": "can_edit_server_accent",  # change the theme everyone gets by default
    "use_ai": "can_use_ai",                    # stories, AI lookups and explanations
    "manage_ai_keys": "can_manage_ai_keys",    # see and change the AI providers' API keys
    "import": "can_import",                    # import decks (.apkg, AnkiWeb, Quizlet)
}
# Defaults for users created before a permission existed (and for new users).
PERMISSION_DEFAULTS = {"can_use_ai": 1, "can_manage_ai_keys": 0, "can_import": 1}

_UNSET = object()
current_profile: ContextVar[Any] = ContextVar("current_profile", default=_UNSET)
current_user: ContextVar[Optional[dict]] = ContextVar("current_user", default=None)


# -- secrets --------------------------------------------------------------------------------------

def _stored_secrets() -> dict:
    try:
        with open(SECRETS_FILE) as file:
            return json.load(file)
    except (OSError, ValueError):
        return {}


def secret(name: str, make) -> str:
    """A secret from the environment, else from data/.secrets (generated on first use)."""
    env = os.getenv(name.upper(), "").strip()
    if env and env not in ("change-me-in-production", "change_this_to_a_random_string"):
        return env
    stored = _stored_secrets()
    if not stored.get(name):
        stored[name] = make()
        os.makedirs(os.path.dirname(SECRETS_FILE), exist_ok=True)
        fd = os.open(SECRETS_FILE + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as file:
            json.dump(stored, file)
        os.replace(SECRETS_FILE + ".tmp", SECRETS_FILE)
    return stored[name]


def signing_key() -> str:
    return secret("app_secret_key", lambda: secrets.token_urlsafe(32))


def _fernet():
    from cryptography.fernet import Fernet
    return Fernet(secret("ankiweb_encryption_key", lambda: Fernet.generate_key().decode()).encode())


def encrypt(text: str) -> str:
    return "enc:" + _fernet().encrypt(text.encode()).decode()


def decrypt(text: str) -> str:
    """Stored values written before encryption are returned as they are."""
    if not text or not text.startswith("enc:"):
        return text
    try:
        return _fernet().decrypt(text[4:].encode()).decode()
    except Exception:
        return ""


# -- users ----------------------------------------------------------------------------------------

def _cookie(scope: dict, name: str) -> Optional[str]:
    for key, value in scope.get("headers", []):
        if key == b"cookie":
            for part in value.decode("latin-1").split(";"):
                k, _, v = part.strip().partition("=")
                if k == name:
                    return v
    return None


def load_user(session_id: Optional[str]) -> Optional[dict]:
    """The logged-in user for a session, with their current rights; None if logged out."""
    from main import sessions
    from database import get_user
    if not session_id:
        return None
    session = sessions.get(session_id)
    if not session:
        return None
    row = get_user(session["user_id"])
    if not row:
        del sessions[session_id]  # the user was deleted
        return None
    user = {
        "user_id": row["id"],
        "username": row["username"],
        "is_admin": bool(row["is_admin"]),
        "language": row.get("language") or "en",
        "session_id": session_id,
        "profile_id": session.get("profile_id"),
    }
    for column in PERMISSIONS.values():
        user[column] = bool(row.get(column, PERMISSION_DEFAULTS.get(column, 0)))
    return user


def can(user: dict, permission: str) -> bool:
    return bool(user.get("is_admin") or user.get(PERMISSIONS[permission]))


def permissions_of(user: dict) -> dict:
    return {name: can(user, name) for name in PERMISSIONS}


def accessible_profiles(user: dict) -> list[dict]:
    from database import get_user_accessible_containers
    return get_user_accessible_containers(user["user_id"])


def _resolve_profile(user: dict) -> Optional[dict]:
    """The session's profile if the user may still use it, else their first one."""
    from main import sessions
    profiles = accessible_profiles(user)
    chosen = next((p for p in profiles if p["id"] == user.get("profile_id")), None)
    if chosen is None and profiles:
        chosen = profiles[0]
        sessions.update(user["session_id"], profile_id=chosen["id"])
    return chosen


class RequestContext:
    """ASGI middleware: who's asking, and which of their profiles the request is about."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        import asyncio
        user = await asyncio.to_thread(load_user, _cookie(scope, "session_id"))
        user_token = current_user.set(user)
        profile_token = current_profile.set(
            await asyncio.to_thread(_resolve_profile, user) if user else _UNSET)
        try:
            await self.app(scope, receive, send)
        finally:
            current_profile.reset(profile_token)
            current_user.reset(user_token)


def request_profile() -> Any:
    """For database.get_active_account(): the request's profile, or `UNSET` outside requests
    from a logged-in user (startup, background work)."""
    return current_profile.get()


UNSET = _UNSET


# -- FastAPI dependencies -------------------------------------------------------------------------

async def require_auth(request: Request) -> dict:
    user = current_user.get()
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


async def require_admin(user: dict = Depends(require_auth)) -> dict:
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


def require(permission: str):
    async def check(user: dict = Depends(require_auth)) -> dict:
        if not can(user, permission):
            raise HTTPException(status_code=403, detail="You don't have permission to do that. Ask an admin.")
        return user
    return check


# -- cookies --------------------------------------------------------------------------------------

def is_https(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    return (proto or request.url.scheme) == "https"


def set_session_cookie(response, request: Request, session_id: str) -> None:
    """HttpOnly and SameSite=Lax always; Secure on HTTPS (plain-HTTP home installs work too)."""
    response.set_cookie("session_id", session_id, httponly=True, secure=is_https(request), samesite="lax",
                        max_age=7 * 24 * 3600, path="/")


def client_ip(request: Request) -> str:
    """The visitor's address; behind a reverse proxy on this machine or the LAN, the one it
    reports (so one proxy address doesn't lock everybody out after failed logins)."""
    host = request.client.host if request.client else "unknown"
    forwarded = request.headers.get("x-forwarded-for") or request.headers.get("x-real-ip")
    try:
        if forwarded and ipaddress.ip_address(host).is_private | ipaddress.ip_address(host).is_loopback:
            return forwarded.split(",")[0].strip()
    except ValueError:
        pass
    return host


# -- outgoing requests ----------------------------------------------------------------------------

def check_public_url(url: str) -> None:
    """Refuse URLs that point at this machine or the private network (or aren't http(s))."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise HTTPException(status_code=400, detail="Only http(s) addresses are allowed")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="That address can't be found")
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (address.is_private or address.is_loopback or address.is_link_local or address.is_multicast
                or address.is_reserved or address.is_unspecified):
            raise HTTPException(status_code=400, detail="That address isn't allowed")


async def fetch_public(url: str, max_bytes: int, timeout: float = 20) -> tuple[bytes, str]:
    """GET a public URL (following redirects, each checked), at most `max_bytes`."""
    import httpx
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        for _ in range(5):
            check_public_url(url)
            async with client.stream("GET", url, headers={"User-Agent": "Mozilla/5.0 AnkiBase"}) as response:
                if response.is_redirect and response.headers.get("location"):
                    url = str(response.url.join(response.headers["location"]))
                    continue
                response.raise_for_status()
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > max_bytes:
                        raise HTTPException(status_code=413, detail="That file is too big")
                return bytes(data), response.headers.get("content-type", "").split(";")[0].strip()
    raise HTTPException(status_code=400, detail="Too many redirects")


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()
