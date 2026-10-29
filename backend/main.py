from fastapi import FastAPI, HTTPException, Depends, Request, Response, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional
import secrets
import os
import tempfile
import shutil
from pathlib import Path

from config import get_settings, get_api_keys, get_api_key_info, get_custom_endpoint, save_api_key, delete_api_key, encrypt_stored_keys
import security
from security import require_auth, require_admin, require
from anki_client import AnkiConnectClient, AnkiError
from story_generator import StoryGenerator, PROVIDERS, NoValidKeysError
from database import (
    save_story, get_story, get_all_stories, delete_story,
    get_active_account, get_all_accounts, set_ankiweb_email,
    migrate_to_user_system,
    create_quizlet_deck, get_quizlet_decks, get_quizlet_deck, delete_quizlet_deck,
    rename_quizlet_deck, record_quizlet_review, get_quizlet_daily_counts,
    get_quizlet_deck_stats, get_quizlet_favorites, toggle_quizlet_favorite,
    update_quizlet_card,
    get_quizlet_study_state, set_quizlet_study_state, delete_quizlet_study_state,
    list_study_sessions, get_study_session, upsert_study_session, delete_study_session,
    get_quizlet_stats_data, search_quizlet_cards, add_quizlet_card, get_quizlet_set_words,
    set_story_annotations,
    get_setting, set_setting, get_user_accent, set_user_accent, clear_user_accent,
    get_server_base_colors, set_server_base_colors,
    get_user_base_colors, set_user_base_colors, clear_user_base_colors,
    get_user,
)
from ankiweb_credentials import AnkiWebCredentials
from anki_accounts import AnkiAccountManager
import anki_server
import sync_server
import updater

app = FastAPI(title="AnkiBase", version="1.0.0")

# CORS: only for a separately served frontend (development); the app itself is same-origin.
_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Who's asking and which of their profiles (security.py).
app.add_middleware(security.RequestContext)


class SecurityHeaders:
    """Headers every answer gets: no MIME sniffing, no framing by other sites, no referrers
    leaking to other sites."""

    HEADERS = [(b"x-content-type-options", b"nosniff"), (b"x-frame-options", b"SAMEORIGIN"),
               (b"referrer-policy", b"same-origin"),
               (b"permissions-policy", b"camera=(), microphone=(), geolocation=()")]

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                names = {k.lower() for k, _ in message.get("headers", [])}
                message["headers"] = list(message.get("headers", [])) + [h for h in self.HEADERS if h[0] not in names]
            await send(message)
        await self.app(scope, receive, send_with_headers)


app.add_middleware(SecurityHeaders)

# session_id -> {user_id, profile_id}, kept in the database across restarts; who the user is
# and what they may do is read fresh on every request (security.py).
from database import login_sessions as sessions

# Login rate limiting constants (DB-backed, persistent)
_LOGIN_WINDOW      = 900   # 15-minute sliding window
_USERNAME_MAX_FAIL = 5     # per username
_IP_MAX_FAIL       = 20    # per IP (allows multiple users on same network)


BACKEND_DIR = Path(__file__).resolve().parent


def _start_anki_engine() -> None:
    """Install and start the Anki engine (anki-cli), first moving accounts off the old Docker
    containers. Runs in the background so the app is up meanwhile."""
    import anki_migration
    anki_server.status = "installing"
    anki_server.install_engine()
    if anki_migration.pending():
        anki_server.status = "migrating"
        if anki_server.healthy():
            anki_server.stop()  # its settings file gets the migrated AnkiWeb logins
        moved = anki_migration.migrate()
        if moved:
            print(f"✓ Moved {len(moved)} Anki account(s) to anki-cli: {', '.join(moved)}")
    anki_server.status = "starting"
    if anki_server.needs_restart() and anki_server.healthy():
        anki_server.restart()  # a new anki-cli version was installed
    anki_server.restarted()
    if not anki_server.ensure_running():
        anki_server.status = "failed: the engine did not start (journalctl -u ankibase-anki)"
        return
    anki_server.status = "ready"
    sync_server.ensure_running()
    try:
        anki_server.install_pages()
    except Exception as e:
        print(f"✗ Couldn't fetch Anki's pages: {e}")
    # Accounts that only had an encrypted AnkiWeb password (no key in Anki's profile yet):
    # log in once, then the password isn't needed any more.
    for account in get_all_accounts():
        if not (BACKEND_DIR / "data" / account["container_name"] / ".credentials").exists():
            continue
        creds = AnkiWebCredentials(container_name=account["container_name"])
        try:
            name = account["container_name"]
            if not anki_server.call("sync.account", profile=name)["loggedIn"]:
                saved = creds.load_credentials() or {}
                anki_server.call("sync.login", profile=name, timeout=60,
                                 username=saved["email"], password=saved["password"])
                set_ankiweb_email(account["id"], saved["email"])
            creds.delete_credentials()
        except Exception as e:
            print(f"✗ AnkiWeb login for '{account['container_name']}' failed: {e}")


def _start_anki_engine_safely() -> None:
    try:
        _start_anki_engine()
    except Exception as e:
        import traceback
        traceback.print_exc()
        anki_server.status = f"failed: {e}"
        print(f"✗ Anki engine startup failed: {e}")


@app.on_event("startup")
async def startup_event():
    import asyncio
    app.state.anki_engine = asyncio.create_task(asyncio.to_thread(_start_anki_engine_safely))
    try:
        # Upgrading from the single-password versions: that password becomes root's.
        if get_all_accounts():
            migrate_to_user_system(get_settings().app_password)
    except Exception as e:
        print(f"Error during user migration: {e}")
    try:
        encrypt_stored_keys()  # API keys saved before they were encrypted
    except Exception as e:
        print(f"✗ Couldn't encrypt stored API keys: {e}")


@app.on_event("shutdown")
async def shutdown_event():
    anki_server.stop_child()
    sync_server.stop_child()


# Auth models
class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ChangeLanguageRequest(BaseModel):
    language: str


class UserPermissions(BaseModel):
    is_admin: Optional[bool] = None
    can_add_containers: Optional[bool] = None      # manage profiles
    can_edit_server_accent: Optional[bool] = None  # server theme
    can_use_ai: Optional[bool] = None
    can_manage_ai_keys: Optional[bool] = None
    can_import: Optional[bool] = None


class CreateUserRequest(UserPermissions):
    username: str
    password: str
    container_ids: list[int] = []


class UpdateUserRequest(UserPermissions):
    username: Optional[str] = None
    password: Optional[str] = None

MIN_PASSWORD = 8


class SetAccentRequest(BaseModel):
    accent: str
    hover: Optional[str] = None


class BaseColorsRequest(BaseModel):
    bg_primary: str
    bg_secondary: str
    bg_tertiary: str
    text_primary: str
    text_secondary: str


class SetUserContainersRequest(BaseModel):
    container_ids: list[int]


class AnkiWebLoginRequest(BaseModel):
    email: str
    password: str
    # A self-hosted sync server (Anki's sync server) instead of AnkiWeb.
    endpoint: Optional[str] = None


def _sync_endpoint(endpoint: Optional[str]) -> Optional[str]:
    """A sync server address as Anki expects it (http(s), trailing slash); None for AnkiWeb."""
    from urllib.parse import urlsplit
    endpoint = (endpoint or "").strip()
    if not endpoint:
        return None
    if "://" not in endpoint:
        endpoint = "https://" + endpoint
    parts = urlsplit(endpoint)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise HTTPException(status_code=400, detail=f"{endpoint} isn't a valid sync server address")
    return endpoint if endpoint.endswith("/") else endpoint + "/"


def _is_ankiweb(endpoint: Optional[str]) -> bool:
    from urllib.parse import urlsplit
    host = urlsplit(endpoint or "").hostname or ""
    return host == "ankiweb.net" or host.endswith(".ankiweb.net")


class CreateAccountRequest(BaseModel):
    container_name: str


class SwitchAccountRequest(BaseModel):
    account_id: int


class LoginResponse(BaseModel):
    success: bool
    message: str
    user: Optional[dict] = None


_SERVER_ACCENT_DEFAULT = '#e94560'
_SERVER_HOVER_DEFAULT  = '#ff6b6b'

def _resolve_user_accent(user_id: int) -> dict:
    """Return accent fields for a user: personal override if set, else server default."""
    personal = get_user_accent(user_id)
    if personal:
        return {
            'accent_color': personal['accent'],
            'accent_hover': personal['hover'],
            'has_personal_accent': True,
        }
    return {
        'accent_color': get_setting('server_accent_color', _SERVER_ACCENT_DEFAULT),
        'accent_hover': get_setting('server_accent_hover', _SERVER_HOVER_DEFAULT),
        'has_personal_accent': False,
    }


def _resolve_user_base_colors(user_id: int) -> dict:
    """Return base color fields for a user: personal override if set, else server default."""
    personal = get_user_base_colors(user_id)
    return {
        'base_colors': personal if personal is not None else get_server_base_colors(),
        'has_personal_base_colors': personal is not None,
    }


# ============================================================================
# Setup endpoints (first-run wizard)
# ============================================================================

class SetupAdminRequest(BaseModel):
    username: str
    password: str
    language: Optional[str] = None


# The web UI's languages (frontend/src/locales).
SUPPORTED_LANGUAGES = ["en", "de", "fr", "es", "it", "pt", "ja", "zh"]


@app.get("/api/setup/status")
async def setup_status():
    from database import get_user_count, get_all_accounts
    return {
        "needs_setup": get_user_count() == 0,
        "has_admin": get_user_count() > 0,
        "has_container": len(get_all_accounts()) > 0,
    }


@app.post("/api/setup/admin")
async def setup_create_admin(request: SetupAdminRequest, response: Response, req: Request):
    """The setup wizard's first step: the first user, an admin (only while there are none)."""
    from database import get_user_count, create_user, get_user_by_username
    if get_user_count() > 0:
        raise HTTPException(status_code=400, detail="Setup is already done")
    username = request.username.strip()
    if len(username) < 2:
        raise HTTPException(status_code=400, detail="Username must be at least 2 characters")
    if len(request.password) < MIN_PASSWORD:
        raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD} characters")
    user_id = create_user(username, request.password, is_admin=True, can_add_containers=True,
                          can_edit_server_accent=True, can_manage_ai_keys=True)
    set_setting(OWNER_ID_SETTING, str(user_id))
    if request.language in SUPPORTED_LANGUAGES:
        from database import update_user_language
        update_user_language(user_id, request.language)
    session_id = secrets.token_urlsafe(32)
    sessions[session_id] = {"user_id": user_id}
    security.set_session_cookie(response, req, session_id)
    return {"success": True, "username": get_user_by_username(username)["username"]}


class SetupProfileRequest(BaseModel):
    name: str = "Default"


@app.post("/api/setup/profile")
async def setup_profile_stream(request: SetupProfileRequest, _: dict = Depends(require("manage_profiles"))):
    """The setup wizard's profile step: waits for the Anki engine (installed on first start)
    and creates the profile, reporting progress as server-sent events."""
    import asyncio, json

    name = request.name.strip() or "Default"

    async def generate():
        def event(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        try:
            yield event({"type": "step", "message": "Starting Anki…", "progress": 15})
            task = getattr(app.state, "anki_engine", None)
            if task is not None and not task.done():
                yield event({"type": "log", "message": "Installing Anki (only on the very first start, about a minute)…",
                             "progress": 30})
                while not task.done():
                    await asyncio.sleep(1)
                    yield ": waiting\n\n"  # keeps proxies from closing the stream
            if not await asyncio.to_thread(anki_server.ensure_running):
                yield event({"type": "error", "message": "Anki didn't start. Check: journalctl -u ankibase-anki -n 50"})
                return
            if any(a["container_name"] == name for a in get_all_accounts()):
                yield event({"type": "done", "message": f"Profile “{name}” is ready", "progress": 100})
                return
            yield event({"type": "step", "message": f"Creating the profile “{name}”…", "progress": 70})
            try:
                await asyncio.to_thread(container_manager.create_account, name)
            except Exception as e:
                yield event({"type": "error", "message": str(e)})
                return
            yield event({"type": "done", "message": f"Profile “{name}” is ready", "progress": 100})
        except Exception as e:
            yield event({"type": "error", "message": str(e)})

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# Auth endpoints
@app.post("/api/auth/login", response_model=LoginResponse)
async def login(request: LoginRequest, response: Response, req: Request):
    from database import (
        verify_user_credentials, record_login_attempt, count_recent_attempts, clear_login_attempts, get_lockout_wait,
    )

    ip_key = f"ip:{security.client_ip(req)}"
    user_key = f"user:{request.username.lower()}"

    for key, limit in ((ip_key, _IP_MAX_FAIL), (user_key, _USERNAME_MAX_FAIL)):
        wait = get_lockout_wait(key, _LOGIN_WINDOW, limit)
        if wait > 0:
            raise HTTPException(status_code=429, detail={"message": "Too many failed login attempts.", "wait_seconds": wait})

    user = verify_user_credentials(request.username, request.password)
    if user:
        clear_login_attempts(ip_key, user_key)
        session_id = secrets.token_urlsafe(32)
        sessions[session_id] = {"user_id": user["id"]}
        security.set_session_cookie(response, req, session_id)
        return LoginResponse(success=True, message="Login successful", user={
            "username": user["username"], "is_admin": bool(user["is_admin"]), "language": user.get("language", "en"),
        })
    record_login_attempt(ip_key)
    record_login_attempt(user_key)

    remaining = max(_USERNAME_MAX_FAIL - count_recent_attempts(user_key, _LOGIN_WINDOW), 0)
    if remaining == 0:
        wait = get_lockout_wait(user_key, _LOGIN_WINDOW, _USERNAME_MAX_FAIL)
        raise HTTPException(status_code=429, detail={"message": "Too many failed login attempts.", "wait_seconds": wait})
    raise HTTPException(status_code=401, detail={"message": "Invalid username or password", "remaining": remaining})


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    session_id = request.cookies.get("session_id")
    if session_id and session_id in sessions:
        del sessions[session_id]
    response.delete_cookie("session_id", path="/")
    return {"success": True}


def _user_info(user: dict) -> dict:
    """What the web UI knows about the logged-in user."""
    profile = get_active_account()
    return {
        "username": user["username"],
        "is_admin": user["is_admin"],
        "can_add_containers": security.can(user, "manage_profiles"),
        "can_edit_server_accent": security.can(user, "server_theme"),
        "permissions": security.permissions_of(user),
        "language": user["language"],
        "profile": {"id": profile["id"], "name": profile["container_name"]} if profile else None,
        **_resolve_user_accent(user["user_id"]),
        **_resolve_user_base_colors(user["user_id"]),
    }


@app.get("/api/auth/check")
async def check_auth():
    user = security.current_user.get()
    return {"authenticated": user is not None, "user": _user_info(user) if user else None}


@app.get("/api/auth/me")
async def get_current_user(user: dict = Depends(require_auth)):
    return _user_info(user)


@app.get("/api/theme")
async def get_theme():
    """Return the current server-default accent colors (no auth required)."""
    return {
        "accent": get_setting('server_accent_color', _SERVER_ACCENT_DEFAULT),
        "hover":  get_setting('server_accent_hover',  _SERVER_HOVER_DEFAULT),
    }


@app.patch("/api/theme")
async def set_theme(request: SetAccentRequest, user: dict = Depends(require_auth)):
    """Set server-default accent (requires can_edit_server_accent or admin)."""
    db_user = get_user(user['user_id']) or {}
    if not db_user.get('can_edit_server_accent') and not user.get('is_admin'):
        raise HTTPException(status_code=403, detail="Permission to edit server accent required")
    accent = request.accent.strip()
    hover  = (request.hover or '').strip() or None
    set_setting('server_accent_color', accent)
    if hover:
        set_setting('server_accent_hover', hover)
    return {"success": True, "accent": accent, "hover": hover or get_setting('server_accent_hover', _SERVER_HOVER_DEFAULT)}


@app.patch("/api/auth/accent")
async def set_personal_accent(request: SetAccentRequest, user: dict = Depends(require_auth)):
    """Save the current user's personal accent override."""
    accent = request.accent.strip()
    hover  = (request.hover or '').strip() or accent
    set_user_accent(user['user_id'], accent, hover)
    return {"success": True}


@app.delete("/api/auth/accent")
async def clear_personal_accent(user: dict = Depends(require_auth)):
    """Remove the current user's personal accent override (revert to server default)."""
    clear_user_accent(user['user_id'])
    server = {"accent": get_setting('server_accent_color', _SERVER_ACCENT_DEFAULT),
              "hover":  get_setting('server_accent_hover',  _SERVER_HOVER_DEFAULT)}
    return {"success": True, **server}


@app.get("/api/theme/base")
async def get_theme_base():
    """Return server-default base colors (no auth required)."""
    return get_server_base_colors()


@app.patch("/api/theme/base")
async def set_theme_base(request: BaseColorsRequest, user: dict = Depends(require_auth)):
    """Set server-default base colors (requires can_edit_server_accent or admin)."""
    db_user = get_user(user['user_id']) or {}
    if not db_user.get('can_edit_server_accent') and not user.get('is_admin'):
        raise HTTPException(status_code=403, detail="Permission to edit server theme required")
    set_server_base_colors(request.model_dump())
    return {"success": True, **get_server_base_colors()}


@app.patch("/api/auth/base-colors")
async def set_personal_base_colors(request: BaseColorsRequest, user: dict = Depends(require_auth)):
    """Save the current user's personal base color overrides."""
    set_user_base_colors(user['user_id'], request.model_dump())
    return {"success": True}


@app.delete("/api/auth/base-colors")
async def clear_personal_base_colors(user: dict = Depends(require_auth)):
    """Remove the current user's personal base color overrides."""
    clear_user_base_colors(user['user_id'])
    return {"success": True, **get_server_base_colors()}


@app.post("/api/auth/change-password")
async def change_password_endpoint(
    request: ChangePasswordRequest,
    user: dict = Depends(require_auth)
):
    """Change the current user's password"""
    from database import get_user, update_user_password, verify_password

    # Get full user info including password hash
    full_user = get_user(user['user_id'])
    if not full_user:
        raise HTTPException(status_code=404, detail="User not found")

    # Verify current password (400, not 401: a wrong password here isn't a logout)
    if not verify_password(request.current_password, full_user['password_hash']):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    if len(request.new_password) < MIN_PASSWORD:
        raise HTTPException(status_code=400, detail=f"New password must be at least {MIN_PASSWORD} characters")

    try:
        update_user_password(user['user_id'], request.new_password)
        # Other devices logged in with the old password are logged out.
        sessions.drop_user(user['user_id'], keep=user['session_id'])
        return {"success": True, "message": "Password changed successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to change password: {str(e)}")


@app.post("/api/auth/change-language")
async def change_language_endpoint(
    request: ChangeLanguageRequest,
    user: dict = Depends(require_auth),
    req: Request = None
):
    """Change the current user's language preference"""
    from database import update_user_language

    # Validate language
    if request.language not in SUPPORTED_LANGUAGES:
        raise HTTPException(status_code=400, detail=f"Invalid language. Supported: {', '.join(SUPPORTED_LANGUAGES)}")

    try:
        update_user_language(user['user_id'], request.language)
        return {"success": True, "message": "Language changed successfully", "language": request.language}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to change language: {str(e)}")


# User management endpoints (admin only)
OWNER_ID_SETTING = "owner_user_id"


def _owner_id() -> int:
    """The first admin (created by the setup wizard): only they can change their own account."""
    from database import get_all_users
    stored = get_setting(OWNER_ID_SETTING, "")
    if stored.isdigit():
        return int(stored)
    admins = [u["id"] for u in get_all_users() if u["is_admin"]]
    return min(admins) if admins else 0


def _user_row(row: dict) -> dict:
    from database import get_user_container_permissions
    return {**{k: (bool(v) if k.startswith(("is_", "can_")) else v) for k, v in row.items()},
            "is_owner": row["id"] == _owner_id(),
            "container_ids": get_user_container_permissions(row["id"])}


@app.get("/api/users")
async def list_users(_: dict = Depends(require_admin)):
    """All users with their permissions and profiles (admin only)."""
    from database import get_all_users
    return {"users": [_user_row(u) for u in get_all_users()], "profiles": get_all_accounts()}


def _validate_username(name: str) -> str:
    import re
    name = name.strip()
    if not re.fullmatch(r"[A-Za-z0-9._@-]{3,40}", name):
        raise HTTPException(status_code=400, detail="Usernames are 3–40 letters, numbers or . _ @ -")
    return name


@app.post("/api/users")
async def create_user_endpoint(request: CreateUserRequest, _: dict = Depends(require_admin)):
    """Create a user (admin only)."""
    from database import create_user, get_user_by_username, set_user_container_permissions
    username = _validate_username(request.username)
    if get_user_by_username(username):
        raise HTTPException(status_code=400, detail="Username already exists")
    if len(request.password) < MIN_PASSWORD:
        raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD} characters")
    flags = {k: v for k, v in request.model_dump().items() if k.startswith(("is_", "can_")) and v is not None}
    user_id = create_user(username, request.password, **flags)
    known = {a["id"] for a in get_all_accounts()}
    set_user_container_permissions(user_id, [c for c in request.container_ids if c in known])
    return {"success": True, "user_id": user_id, "message": "User created"}


@app.put("/api/users/{user_id}")
async def update_user_endpoint(user_id: int, request: UpdateUserRequest, admin: dict = Depends(require_admin)):
    """Change a user's name, password or permissions (admin only)."""
    from database import get_user, update_user, update_user_username, update_user_password, count_admins
    target = get_user(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if user_id == _owner_id() and admin["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the owner can change the owner's account")
    if request.is_admin is False and target["is_admin"]:
        if user_id == admin["user_id"]:
            raise HTTPException(status_code=400, detail="You can't remove your own admin rights")
        if count_admins() <= 1:
            raise HTTPException(status_code=400, detail="There has to be at least one admin")
    try:
        if request.username:
            update_user_username(user_id, _validate_username(request.username))
        if request.password:
            if len(request.password) < MIN_PASSWORD:
                raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD} characters")
            update_user_password(user_id, request.password)
            sessions.drop_user(user_id, keep=admin["session_id"] if user_id == admin["user_id"] else None)
        flags = {k: v for k, v in request.model_dump().items() if k.startswith(("is_", "can_")) and v is not None}
        if flags:
            update_user(user_id, **flags)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"success": True, "message": "User updated"}


@app.delete("/api/users/{user_id}")
async def delete_user_endpoint(user_id: int, admin: dict = Depends(require_admin)):
    """Delete a user (admin only; not yourself, not the owner)."""
    from database import delete_user, get_user
    if user_id == admin["user_id"]:
        raise HTTPException(status_code=400, detail="You can't delete yourself")
    if user_id == _owner_id():
        raise HTTPException(status_code=403, detail="The owner can't be deleted")
    if not get_user(user_id) or not delete_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")
    sessions.drop_user(user_id)
    return {"success": True, "message": "User deleted"}


@app.get("/api/users/{user_id}/containers")
async def get_user_containers(user_id: int, _: dict = Depends(require_admin)):
    """The profiles a user may use (admin only)."""
    from database import get_user_container_permissions, get_user
    if not get_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")
    return {"container_ids": get_user_container_permissions(user_id)}


@app.put("/api/users/{user_id}/containers")
async def set_user_containers(user_id: int, request: SetUserContainersRequest, _: dict = Depends(require_admin)):
    """Set the profiles a user may use (admin only)."""
    from database import set_user_container_permissions, get_user
    if not get_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")
    known = {a["id"] for a in get_all_accounts()}
    set_user_container_permissions(user_id, [c for c in request.container_ids if c in known])
    return {"success": True, "message": "Profiles updated"}


# Anki client factory
def get_anki_client() -> AnkiConnectClient:
    """The active account's collection on the anki-cli engine."""
    if anki_server.status != "ready":
        detail = {"installing": "Anki is being installed (first start after an update, about a minute)…",
                  "migrating": "Moving your Anki collections to the new engine…",
                  "starting": "Anki is starting…"}.get(anki_server.status, f"Anki is unavailable ({anki_server.status})")
        raise HTTPException(status_code=503, detail=detail)
    active_account = get_active_account()
    if not active_account:
        raise HTTPException(status_code=503, detail="You don't have a profile yet. Ask an admin to give you one.")
    return AnkiConnectClient(anki_server.profile_url(active_account["container_name"]), anki_server.api_key())


# Deck endpoints
@app.get("/api/decks/names")
async def get_deck_names(client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)):
    """Just deck names and ids — much cheaper than /api/decks (no per-deck counts)."""
    try:
        return {"decks": await client.get_deck_names_and_ids()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/decks")
async def get_decks(client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)):
    try:
        decks = await client.get_deck_names_and_ids()
        stats = await client.get_deck_stats(list(decks.keys()))
        return {"decks": decks, "stats": stats}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Studying through Anki's reviewer ------------------------------------------------

class ReviewRequest(BaseModel):
    deck: str
    card_id: Optional[int] = None
    ease: Optional[int] = None


@app.post("/api/review/current")
async def review_current(request: ReviewRequest, client: AnkiConnectClient = Depends(get_anki_client),
                         user: dict = Depends(require_auth)):
    """Open (or continue) the deck in Anki's reviewer and return the current card."""
    import review
    try:
        out = await review.current(client, request.deck)
    except Exception as e:
        print(f"Reviewer unavailable for {request.deck!r}, using due-date fallback: {e}")
        try:
            out = await review.legacy_next(client, request.deck)
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    out["media_token"] = review.media_token(security.signing_key(), user["user_id"], (get_active_account() or {}).get("id", 0))
    return out


@app.post("/api/review/answer")
async def review_answer(request: ReviewRequest, client: AnkiConnectClient = Depends(get_anki_client),
                        user: dict = Depends(require_auth)):
    """Answer the current card and return the next one in the same round trip."""
    import review
    if request.card_id is None or request.ease not in (1, 2, 3, 4):
        raise HTTPException(status_code=400, detail="card_id and ease (1-4) required")
    try:
        out = await review.answer(client, request.deck, request.card_id, request.ease)
    except Exception as e:
        print(f"Reviewer answer failed for {request.deck!r}, using fallback: {e}")
        try:
            await client.answer_card(request.card_id, request.ease)
            out = await review.legacy_next(client, request.deck)
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    out["media_token"] = review.media_token(security.signing_key(), user["user_id"], (get_active_account() or {}).get("id", 0))
    return out


@app.post("/api/review/undo")
async def review_undo(request: ReviewRequest, client: AnkiConnectClient = Depends(get_anki_client),
                      user: dict = Depends(require_auth)):
    import review
    try:
        out = await review.undo(client, request.deck)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    out["media_token"] = review.media_token(security.signing_key(), user["user_id"], (get_active_account() or {}).get("id", 0))
    return out


@app.get("/api/media-file/{filename:path}")
async def media_file(filename: str, t: str = ""):
    """
    A collection media file as a real (cacheable) file. Authorised by a signed token rather
    than the session cookie, because cards render in a sandboxed frame without cookies.
    """
    import mimetypes
    import review
    from fastapi.responses import Response
    signed = review.check_media_token(security.signing_key(), t)
    if not signed:
        raise HTTPException(status_code=401, detail="Invalid media token")
    # The token's profile, if its user may still use it.
    from database import get_user_accessible_containers
    profile = next((p for p in get_user_accessible_containers(signed[0]) if p["id"] == signed[1]), None)
    if profile is None:
        raise HTTPException(status_code=403, detail="No access to this profile")
    client = AnkiConnectClient(anki_server.profile_url(profile["container_name"]), anki_server.api_key())
    if "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(status_code=400, detail="Invalid file name")
    data = await client.retrieve_media_file(filename)
    if not data:
        raise HTTPException(status_code=404, detail="Media file not found")
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return Response(review.decode_media(data), media_type=mime,
                    # Card media is from anywhere: a file opened on its own can't run scripts here.
                    headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
                             "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; media-src 'self'; style-src 'unsafe-inline'"})


# Card endpoints
@app.get("/api/media/{filename}")
async def get_media_file(
    filename: str, client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)
):
    """Get a media file (audio, image) from Anki as base64."""
    try:
        data = await client.retrieve_media_file(filename)
        if not data:
            raise HTTPException(status_code=404, detail="Media file not found")
        return {"filename": filename, "data": data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Search tab: dictionary + your cards ---------------------------------------

def _anki_escape(text: str) -> str:
    """Make free text safe inside an Anki search: quote it and escape wildcards."""
    t = text.replace("\\", "\\\\").replace('"', '\\"').replace("*", "\\*").replace("_", "\\_")
    return f'"nc:{t}"'


@app.get("/api/search/cards")
async def search_your_cards(
    q: str,
    limit: int = 40,
    client: AnkiConnectClient = Depends(get_anki_client),
    user: dict = Depends(require_auth),
):
    """Find a word in your Anki notes and Quizlet cards — accent-insensitive, best matches first."""
    import re
    import dictionary as dic

    q = q.strip()[:200]
    if not q:
        return {"anki": [], "quizlet": [], "anki_error": None}
    result = {"anki": [], "quizlet": search_quizlet_cards(user["user_id"], q, limit), "anki_error": None, "anki_total": 0}
    try:
        note_ids = await client.find_notes(_anki_escape(q))
        result["anki_total"] = len(note_ids)
        notes = await client.get_notes_info(note_ids[:200]) if note_ids else []
        target = dic.fold(q)

        def plain(v: str) -> str:
            return dic.fold(re.sub(r"<[^>]+>|\[sound:[^\]]+\]", " ", v or ""))

        def rank(n) -> tuple:
            fields = sorted(n["fields"].items(), key=lambda kv: kv[1]["order"])
            first = plain(fields[0][1]["value"]) if fields else ""
            if first == target: return (0, len(first))
            if first.startswith(target): return (1, len(first))
            if target in first: return (2, len(first))
            return (3, len(first))

        notes.sort(key=rank)
        notes = notes[:limit]
        first_cards = [n["cards"][0] for n in notes if n.get("cards")]
        infos = {c["cardId"]: c for c in (await client.get_cards_info(first_cards) if first_cards else [])}
        for n in notes:
            card = infos.get(n["cards"][0]) if n.get("cards") else None
            state = None
            if card:
                if card.get("queue") == -1: state = "suspended"
                elif card.get("type") == 0: state = "new"
                elif card.get("type") in (1, 3): state = "learning"
                else: state = "mature" if (card.get("interval") or 0) >= 21 else "young"
            result["anki"].append({
                "note_id": n["noteId"],
                "model": n["modelName"],
                "tags": n.get("tags", []),
                "fields": [{"name": k, "value": v["value"]} for k, v in sorted(n["fields"].items(), key=lambda kv: kv[1]["order"])],
                "deck": card.get("deckName") if card else None,
                "deck_id": None,
                "state": state,
            })
        try:
            ids = await client.get_deck_names_and_ids()
            for r in result["anki"]:
                r["deck_id"] = ids.get(r["deck"])
        except Exception:
            pass
    except Exception as e:
        result["anki_error"] = f"Couldn't search Anki: {e}"
    return result


@app.get("/api/dictionary")
async def dictionary_lookup(q: str, lang: str = "", _: dict = Depends(require_auth)):
    """Wiktionary entry (any language) for a word, plus Jisho for Japanese."""
    import dictionary as dic

    q = q.strip()[:100]
    if not q:
        raise HTTPException(status_code=400, detail="Empty query")
    out: dict = {"wiktionary": None, "jisho": [], "error": None}
    try:
        out["wiktionary"] = await dic.lookup(q, lang or None)
    except Exception as e:
        out["error"] = f"Dictionary unavailable: {e}"
    if dic.has_japanese(q) or lang == "Japanese":
        try:
            out["jisho"] = await dic.jisho(q)
        except Exception:
            pass
    return out


class NoteFieldsUpdate(BaseModel):
    fields: dict[str, str]


@app.put("/api/notes/{note_id}/fields")
async def update_note_fields(note_id: int, request: NoteFieldsUpdate,
                             client: AnkiConnectClient = Depends(get_anki_client), _: dict = Depends(require_auth)):
    try:
        await client.update_note_fields(note_id, request.fields)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class QuickCardRequest(BaseModel):
    front: str
    back: str


@app.post("/api/notes/basic")
async def add_basic_note(deck: str, request: QuickCardRequest,
                         client: AnkiConnectClient = Depends(get_anki_client), _: dict = Depends(require_auth)):
    """Add a front/back note to an Anki deck (uses the 'Basic' note type, or the first with 2+ fields)."""
    try:
        models = await client.get_model_names()
        model = "Basic" if "Basic" in models else None
        names: list[str] = []
        for m in ([model] if model else []) + [m for m in models if m != model]:
            names = await client.get_model_field_names(m)
            if len(names) >= 2:
                model = m
                break
        if not model or len(names) < 2:
            raise HTTPException(status_code=400, detail="No note type with two fields found")
        note_id = await client.add_note(deck, model, {names[0]: request.front, names[1]: request.back})
        return {"success": True, "note_id": note_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/quizlet/decks/{deck_id}/words")
async def quizlet_set_words(deck_id: int, side: str = "term", user: dict = Depends(require_auth)):
    """A Quizlet set's terms (or definitions) as story vocabulary, with Learn progress as categories."""
    data = get_quizlet_set_words(user["user_id"], deck_id, "definition" if side == "definition" else "term")
    if data is None:
        raise HTTPException(status_code=404, detail="Set not found")
    return data


@app.post("/api/quizlet/decks/{deck_id}/cards")
async def quizlet_add_card(deck_id: int, request: QuickCardRequest, _: dict = Depends(require_auth)):
    card_id = add_quizlet_card(deck_id, request.front, request.back)
    if card_id is None:
        raise HTTPException(status_code=404, detail="Set not found")
    return {"success": True, "card_id": card_id}


# Story generation endpoints
class StoryRequest(BaseModel):
    words: list[str]
    word_data: Optional[dict] = None  # word -> {fields: {...}, category: str}
    style: str = "casual"
    length: str = "medium"
    language: str = "auto"  # "auto" to detect from words
    target_language: Optional[str] = None
    custom_instructions: Optional[str] = None  # For custom style
    provider: Optional[str] = None
    model: Optional[str] = None
    deck_name: Optional[str] = None
    name: Optional[str] = None  # Story name for saving (auto-generated if not provided)
    lookup_fields: Optional[list[str]] = None  # Fields to use for word lookup (e.g., ["Meaning", "Reading"])
    lookup_language: str = "auto"  # Language for AI-generated lookups
    level: Optional[str] = None  # CEFR level (A1..C2) of the learner


class LookupRequest(BaseModel):
    word: str
    language: str = "auto"
    provider: Optional[str] = None
    model: Optional[str] = None
    lookup_fields: Optional[list[str]] = None
    force_ai: bool = False


@app.post("/api/story/generate")
async def generate_story_endpoint(
    request: StoryRequest, _: str = Depends(require("use_ai"))
):
    api_keys = get_api_keys()
    if not any(api_keys.values()):
        raise HTTPException(status_code=500, detail="No AI provider API keys configured")

    try:
        word_categories = {}
        if request.word_data:
            for word, data in request.word_data.items():
                if isinstance(data, dict) and "category" in data:
                    word_categories[word] = data["category"]

        generator = StoryGenerator(api_keys, get_custom_endpoint())
        result = await generator.generate_story(
            words=request.words,
            style=request.style,
            length=request.length,
            language=request.language,
            target_language=request.target_language,
            custom_instructions=request.custom_instructions,
            provider=request.provider,
            model=request.model,
            word_categories=word_categories,
            level=request.level,
        )

        story_name = request.name or result.get("title") or f"Story with {len(request.words)} words"

        # Prepare instant word lookups for Reading (best effort — the story is kept either way).
        story_lang = request.target_language or (request.language if request.language != "auto" else None)
        gloss = _gloss_language(request.lookup_language, request.language if request.target_language else None)
        annotations = None
        try:
            annotations = await generator.annotate_story(result["story"], request.words, story_lang, gloss,
                                                         result.get("provider_used"), result.get("model_used"))
            if not any(annotations["paragraphs"]):
                annotations = None
        except Exception:
            annotations = None
        detected = (annotations or {}).get("language")
        story_id = save_story(
            name=story_name,
            content=result["story"],
            words=request.words,
            style=request.style,
            length=request.length,
            language=request.language,
            target_language=request.target_language,
            word_data=request.word_data,
            lookup_fields=request.lookup_fields,
            lookup_language=request.lookup_language,
            provider=result.get("provider_used"),
            model=result.get("model_used"),
            deck_name=request.deck_name,
            level=request.level,
            word_forms=result.get("word_forms"),
            annotations=annotations,
        )
        if detected and not story_lang:
            set_story_annotations(story_id, annotations, detected)

        return {
            "story": result["story"],
            "story_id": story_id,
            "title": story_name,
            "word_forms": result.get("word_forms") or {},
            "annotated": annotations is not None,
            "provider_used": result.get("provider_used"),
            "model_used": result.get("model_used"),
        }
    except NoValidKeysError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _gloss_language(lookup_language: Optional[str], translation_language: Optional[str]) -> str:
    """Language for meanings and explanations: the chosen lookup language, else the translation language, else English."""
    if lookup_language and lookup_language != "auto":
        return lookup_language
    return translation_language or "English"


class AiChoiceRequest(BaseModel):
    provider: Optional[str] = None
    model: Optional[str] = None


@app.post("/api/stories/{story_id}/annotate")
async def annotate_story_endpoint(story_id: int, request: AiChoiceRequest, _: dict = Depends(require("use_ai"))):
    """Prepare instant word lookups for a story written before annotations existed."""
    story_row = get_story(story_id)
    if not story_row:
        raise HTTPException(status_code=404, detail="Story not found")
    api_keys = get_api_keys()
    if not any(api_keys.values()):
        raise HTTPException(status_code=400, detail="Add an AI key in Story → AI settings first")
    lang = story_row.get("target_language") or (story_row.get("language") if story_row.get("language") not in (None, "", "auto") else None)
    gloss = _gloss_language(story_row.get("lookup_language"), story_row.get("language") if story_row.get("target_language") else None)
    try:
        annotations = await StoryGenerator(api_keys, get_custom_endpoint()).annotate_story(
            story_row["content"], story_row.get("words") or [], lang, gloss, request.provider, request.model)
    except NoValidKeysError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not any(annotations["paragraphs"]):
        raise HTTPException(status_code=502, detail="The AI didn't return usable annotations — try again")
    set_story_annotations(story_id, annotations, annotations.get("language"))
    return {"annotations": annotations}


class ExplainRequest(BaseModel):
    passage: str
    context: str = ""
    language: Optional[str] = None
    gloss_language: Optional[str] = None
    level: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None


@app.post("/api/story/explain")
async def explain_passage_endpoint(request: ExplainRequest, _: dict = Depends(require("use_ai"))):
    """Explain a passage the reader selected: translation, word breakdown, grammar."""
    passage = request.passage.strip()[:600]
    if not passage:
        raise HTTPException(status_code=400, detail="Nothing selected")
    api_keys = get_api_keys()
    if not any(api_keys.values()):
        raise HTTPException(status_code=400, detail="Add an AI key in Story → AI settings first")
    try:
        text = await StoryGenerator(api_keys, get_custom_endpoint()).explain_passage(
            passage, request.context.strip()[:1500], request.language, request.gloss_language or "English",
            request.level, request.provider, request.model)
    except NoValidKeysError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"explanation": text}


@app.post("/api/lookup")
async def lookup_word_endpoint(
    request: LookupRequest, _: str = Depends(require("use_ai"))
):
    """AI-powered word lookup for words not in vocabulary list."""
    api_keys = get_api_keys()
    if not any(api_keys.values()):
        raise HTTPException(status_code=500, detail="No AI provider API keys configured")

    try:
        generator = StoryGenerator(api_keys, get_custom_endpoint())
        result = await generator.lookup_word(
            word=request.word,
            language=request.language,
            provider=request.provider,
            model=request.model,
            lookup_fields=request.lookup_fields,
            force_ai=request.force_ai,
        )
        return result
    except NoValidKeysError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Story storage endpoints
class UpdateStoryRequest(BaseModel):
    name: Optional[str] = None
    lookup_fields: Optional[list[str]] = None


@app.get("/api/stories")
async def list_stories(
    limit: int = 100,
    offset: int = 0,
    _: str = Depends(require_auth)
):
    """Get all saved stories."""
    stories = get_all_stories(limit, offset)
    return {"stories": stories}


@app.get("/api/stories/{story_id}")
async def get_story_endpoint(story_id: int, _: str = Depends(require_auth)):
    """Get a specific story by ID."""
    story = get_story(story_id)
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    return {"story": story}


@app.patch("/api/stories/{story_id}")
async def update_story_endpoint(
    story_id: int,
    request: UpdateStoryRequest,
    _: str = Depends(require_auth)
):
    """Update a story's name and/or lookup fields."""
    from database import update_story
    if not update_story(story_id, name=request.name, lookup_fields=request.lookup_fields):
        raise HTTPException(status_code=404, detail="Story not found")
    return {"success": True}


@app.delete("/api/stories/{story_id}")
async def delete_story_endpoint(story_id: int, _: str = Depends(require_auth)):
    """Delete a story."""
    if not delete_story(story_id):
        raise HTTPException(status_code=404, detail="Story not found")
    return {"success": True}


# API Key Management endpoints
class ApiKeyRequest(BaseModel):
    provider: str
    api_key: str = ""
    admin_key: str = ""
    base_url: str = ""  # "custom" only: the OpenAI-compatible server


async def _find_openai_api(base_url: str, api_key: str) -> str:
    """The working API root for a server address: as given, or with /v1 (Ollama, LM Studio, vLLM)
    or /api (Open WebUI) added. Raises HTTPException when none answers."""
    import httpx
    from urllib.parse import urlparse
    url = base_url.strip().rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Enter the server's address, e.g. http://192.168.1.10:11434")
    candidates = [url] if parsed.path not in ("", "/") else [url + "/v1", url, url + "/api"]
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    error = ""
    async with httpx.AsyncClient(timeout=10.0) as client:
        for candidate in candidates:
            try:
                r = await client.get(candidate + "/models", headers=headers)
            except httpx.HTTPError as e:
                error = f"Couldn't reach {url}: {e.__class__.__name__}"
                continue
            if r.status_code in (401, 403):
                error = "The server refused the API key" if api_key else "The server needs an API key"
                break
            else:
                try:
                    if r.is_success and isinstance(r.json(), dict):
                        return candidate
                except ValueError:
                    pass
                error = f"{candidate}/models answered {r.status_code}; is this an OpenAI-compatible API?"
    raise HTTPException(status_code=400, detail=error)


def _saved(provider: str) -> bool:
    """Whether the profile saved this provider itself (not from the server's .env)."""
    info = get_api_key_info(provider)
    return bool(info["api_key"] or info.get("base_url"))


def _mask(key: str) -> str:
    if not key:
        return ""
    return key[:8] + "..." + key[-4:] if len(key) > 12 else "***configured***"


@app.get("/api/settings/api-keys")
async def get_api_keys_endpoint(user: dict = Depends(require_auth)):
    """Which AI providers have a key; the (masked) keys themselves for those who manage them."""
    keys = get_api_keys()
    configured = {k: bool(v) for k, v in keys.items()}
    if not security.can(user, "manage_ai_keys"):
        return {"keys": {}, "admin_keys": {}, "configured": configured, "has_admin_key": {}, "is_env_key": {}}
    info = {provider: get_api_key_info(provider) for provider in keys}
    return {
        # The custom server shows its address, which isn't secret.
        "keys": {p: k if p == "custom" else _mask(k) for p, k in keys.items()},
        "admin_keys": {p: _mask(i["admin_key"]) for p, i in info.items()},
        "configured": configured,
        "has_admin_key": {p: bool(i["admin_key"]) for p, i in info.items()},
        # Keys from the server's environment (.env) rather than saved here.
        "is_env_key": {p: bool(k) and not _saved(p) for p, k in keys.items()},
    }


@app.post("/api/settings/api-keys")
async def set_api_key_endpoint(request: ApiKeyRequest, _: str = Depends(require("manage_ai_keys"))):
    """Set API key(s) for a provider."""
    if request.provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {request.provider}")

    if request.provider == "custom":
        # Check the server answers before saving, and find its API root.
        # Re-saving the same server without retyping its key keeps the key.
        saved, url = get_custom_endpoint(), request.base_url.strip().rstrip("/")
        api_key = request.api_key or (saved["api_key"] if saved["base_url"] in (url, url + "/v1") else "")
        base_url = await _find_openai_api(request.base_url, api_key)
        save_api_key("custom", api_key=request.api_key, base_url=base_url)
        return {"success": True, "message": f"Connected to {base_url}"}

    if not request.api_key and not request.admin_key:
        raise HTTPException(status_code=400, detail="At least one key (api_key or admin_key) must be provided")

    save_api_key(request.provider, api_key=request.api_key, admin_key=request.admin_key)
    return {"success": True, "message": f"API key(s) saved for {request.provider}"}


@app.delete("/api/settings/api-keys/{provider}")
async def delete_api_key_endpoint(provider: str, _: str = Depends(require("manage_ai_keys"))):
    """Delete a saved API key (keys from the server's environment stay; remove them from .env)."""
    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")
    if not _saved(provider) and get_api_keys().get(provider):
        raise HTTPException(status_code=400, detail="That key comes from the server's .env file; remove it there.")
    delete_api_key(provider)
    return {"success": True, "message": f"API key deleted for {provider}"}


@app.get("/api/settings/api-keys/{provider}/full")
async def get_full_api_key_endpoint(provider: str, user: dict = Depends(require("manage_ai_keys"))):
    """Get the full unmasked API keys for a provider (keys from the server's environment:
    admins only)."""
    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")
    if not _saved(provider) and not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Only admins can see the server's own keys")

    if provider == "custom":
        endpoint = get_custom_endpoint()
        if not endpoint["base_url"]:
            raise HTTPException(status_code=404, detail="No AI server set")
        return {"api_key": endpoint["api_key"], "admin_key": "", "base_url": endpoint["base_url"]}

    # Try manual key first
    keys = get_api_keys()
    key_info = get_api_key_info(provider)

    if provider in keys and keys[provider]:
        return {
            "api_key": keys[provider],
            "admin_key": key_info.get("admin_key", "")
        }

    raise HTTPException(status_code=404, detail=f"No API key found for {provider}")


@app.get("/api/settings/api-keys/{provider}/usage")
async def get_provider_usage_endpoint(provider: str, _: str = Depends(require("manage_ai_keys"))):
    """Get usage information for a provider (requires admin key)."""
    import httpx
    from datetime import datetime, timedelta

    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")

    # Get admin key
    key_info = get_api_key_info(provider)
    admin_key = key_info.get("admin_key", "")

    if not admin_key:
        raise HTTPException(status_code=404, detail=f"No admin key configured for {provider}")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            if provider == "openai":
                # Query OpenAI usage API for the current month
                # Get usage for current day to show daily usage
                now = datetime.utcnow()
                start_of_day = datetime(now.year, now.month, now.day)
                start_time = int(start_of_day.timestamp())

                response = await client.get(
                    f"https://api.openai.com/v1/organization/usage/completions?start_time={start_time}&limit=1",
                    headers={
                        "Authorization": f"Bearer {admin_key}",
                        "Content-Type": "application/json"
                    }
                )
                response.raise_for_status()
                data = response.json()

                # Extract usage data
                total_tokens = 0
                if data.get("data") and len(data["data"]) > 0:
                    bucket = data["data"][0]
                    # Sum up all token usage
                    for result in bucket.get("results", []):
                        total_tokens += result.get("input_tokens", 0) + result.get("output_tokens", 0)

                return {
                    "provider": provider,
                    "has_usage": True,
                    "usage_type": "tokens",
                    "tokens_used_today": total_tokens,
                    "message": f"Used {total_tokens:,} tokens today"
                }

            elif provider == "anthropic":
                # Query Anthropic usage API for the current day
                now = datetime.utcnow()
                start_of_day = datetime(now.year, now.month, now.day)
                end_of_day = start_of_day + timedelta(days=1)

                response = await client.get(
                    "https://api.anthropic.com/v1/organizations/usage_report/messages",
                    params={
                        "start_time": start_of_day.isoformat() + "Z",
                        "end_time": end_of_day.isoformat() + "Z",
                        "bucket_width": "1d"
                    },
                    headers={
                        "x-api-key": admin_key,
                        "anthropic-version": "2023-06-01"
                    }
                )
                response.raise_for_status()
                data = response.json()

                # Extract usage data
                total_tokens = 0
                if data.get("data") and len(data["data"]) > 0:
                    bucket = data["data"][0]
                    total_tokens += bucket.get("input_tokens", 0)
                    total_tokens += bucket.get("output_tokens", 0)
                    total_tokens += bucket.get("cache_creation_input_tokens", 0)
                    total_tokens += bucket.get("cache_read_input_tokens", 0)

                return {
                    "provider": provider,
                    "has_usage": True,
                    "usage_type": "tokens",
                    "tokens_used_today": total_tokens,
                    "message": f"Used {total_tokens:,} tokens today"
                }

            else:
                # Provider not supported for usage tracking
                return {
                    "provider": provider,
                    "has_usage": False,
                    "message": "Usage tracking not available for this provider"
                }

    except httpx.HTTPStatusError as e:
        if e.response.status_code == 401:
            raise HTTPException(status_code=401, detail="Invalid admin key")
        elif e.response.status_code == 403:
            raise HTTPException(status_code=403, detail="Admin key does not have permission to access usage data")
        else:
            raise HTTPException(status_code=500, detail=f"Failed to fetch usage: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch usage: {str(e)}")


@app.get("/api/settings/api-keys/{provider}/models")
async def get_provider_models_endpoint(provider: str, _: str = Depends(require_auth)):
    """Get available models for a specific provider by querying their API."""
    import httpx

    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")

    # Try to get API key
    keys = get_api_keys()
    api_key = keys.get(provider)
    if not api_key:
        raise HTTPException(status_code=404, detail=f"No API key found for {provider}")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            if provider == "custom":
                endpoint = get_custom_endpoint()
                response = await client.get(
                    endpoint["base_url"] + "/models",
                    headers={"Authorization": f"Bearer {endpoint['api_key']}"} if endpoint["api_key"] else {},
                )
                response.raise_for_status()
                models = [{"id": m["id"], "name": m.get("name") or m["id"]}
                          for m in response.json().get("data", []) if m.get("id")]
                return {"models": models, "default_model": models[0]["id"] if models else ""}

            elif provider == "openai":
                response = await client.get(
                    "https://api.openai.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"}
                )
                response.raise_for_status()
                data = response.json()
                # Filter and format models
                models = [
                    {"id": m["id"], "name": m["id"]}
                    for m in data.get("data", [])
                    if "gpt" in m["id"].lower() and not m["id"].startswith("ft:")
                ]
                return {"models": models, "default_model": "gpt-4o-mini"}

            elif provider == "anthropic":
                response = await client.get(
                    "https://api.anthropic.com/v1/models",
                    headers={
                        "X-Api-Key": api_key,
                        "anthropic-version": "2023-06-01"
                    }
                )
                response.raise_for_status()
                data = response.json()
                models = [
                    {"id": m["id"], "name": m.get("display_name", m["id"])}
                    for m in data.get("data", [])
                ]
                ids = [m["id"] for m in models]
                return {"models": models, "default_model": "claude-opus-5-5" if "claude-opus-5-5" in ids or not ids else ids[0]}

            elif provider == "gemini":
                response = await client.get(
                    f"https://generativelanguage.googleapis.com/v1/models?key={api_key}"
                )
                response.raise_for_status()
                data = response.json()
                # Filter for generation models
                models = [
                    {"id": m["name"].replace("models/", ""), "name": m.get("displayName", m["name"])}
                    for m in data.get("models", [])
                    if "generateContent" in m.get("supportedGenerationMethods", [])
                ]
                return {"models": models, "default_model": "gemini-2.0-flash"}

    except httpx.HTTPError:
        # Fallback to hardcoded models on error
        return {
            "models": PROVIDERS[provider]["models"],
            "default_model": PROVIDERS[provider]["default_model"]
        }


@app.get("/api/settings/providers")
async def get_providers_endpoint(_: str = Depends(require_auth)):
    """Get list of available AI providers and their models."""
    providers = {}
    api_keys = get_api_keys()

    for provider_id, info in PROVIDERS.items():
        providers[provider_id] = {
            "name": info["name"],
            "models": info["models"],
            "default_model": info["default_model"],
            "configured": bool(api_keys.get(provider_id)),
        }

    return {"providers": providers}


# Common field names that typically contain the main word/term
WORD_FIELD_PRIORITIES = [
    "Word", "Front", "Expression", "Vocabulary", "Term", "Question",
    "Kanji", "Japanese", "Chinese", "Korean", "Spanish", "German", "French",
    "English", "Target", "Source", "Text", "Item", "Phrase", "Sentence"
]


def find_best_word_field(fields: dict) -> str | None:
    """Find the best field to extract words from, prioritizing common vocab field names."""
    field_names = list(fields.keys())

    # First try priority fields (case-insensitive)
    for priority in WORD_FIELD_PRIORITIES:
        for name in field_names:
            if name.lower() == priority.lower():
                return name

    # Fall back to first field (usually the main content)
    if field_names:
        # Sort by order if available, otherwise use first
        sorted_fields = sorted(field_names, key=lambda f: fields[f].get("order", 0))
        return sorted_fields[0]

    return None


# Card type constants from Anki
# type: 0=new, 1=learning, 2=review, 3=relearning
# queue: 0=new, 1=learning, 2=review, 3=day learning, -1=suspended, -2=buried
# For review cards: interval < 21 days = "young", interval >= 21 days = "mature"

def categorize_card(card: dict) -> str:
    """Categorize a card based on its type, queue, and interval."""
    card_type = card.get("type", 0)
    queue = card.get("queue", 0)
    interval = card.get("interval", 0)

    if queue == -1:
        return "suspended"
    if queue == -2:
        return "buried"

    if card_type == 0:  # New card
        return "new"
    elif card_type == 1:  # Learning
        return "learning"
    elif card_type == 3:  # Relearning (failed mature card)
        return "relearning"
    elif card_type == 2:  # Review
        if interval < 21:
            return "young"
        else:
            return "mature"

    return "unknown"


# Get words from a deck with card categories and field data for story generation
@app.get("/api/decks/{deck_name}/words")
async def get_deck_words(
    deck_name: str,
    limit: int = 500,
    field: str = "",  # Empty means auto-detect the word/expression field
    client: AnkiConnectClient = Depends(get_anki_client),
    _: str = Depends(require_auth),
):
    import re

    def clean_field(value: str) -> str:
        """Clean HTML and media references from field value."""
        if not value:
            return ""
        value = re.sub(r"<[^>]+>", "", value)
        value = re.sub(r"\[sound:[^\]]+\]", "", value)
        value = re.sub(r"\[image:[^\]]+\]", "", value)
        return value.strip()

    try:
        # Find ALL cards to get accurate category counts
        card_ids = await client.find_cards(f'"deck:{deck_name}"')
        if not card_ids:
            return {"words": [], "word_data": {}, "field_used": None, "available_fields": [], "categories": {}, "category_counts": {}}

        # Get card info for ALL cards (for accurate counts)
        # But limit to reasonable number for performance
        cards = await client.get_cards_info(card_ids[:2000])

        # Get note IDs for the cards
        note_ids = list(set(card.get("note") for card in cards if card.get("note")))
        notes_info = await client.get_notes_info(note_ids) if note_ids else []

        # Build note ID -> note info map
        note_map = {n.get("noteId"): n for n in notes_info}

        # Build note ID -> best card category (prefer learning > relearning > young > mature > new)
        category_priority = {"learning": 0, "relearning": 1, "young": 2, "new": 3, "mature": 4, "suspended": 5, "buried": 6, "unknown": 7}
        note_categories = {}  # note_id -> category

        for card in cards:
            note_id = card.get("note")
            if not note_id:
                continue
            category = categorize_card(card)
            # Keep the highest priority category for this note
            if note_id not in note_categories or category_priority.get(category, 99) < category_priority.get(note_categories[note_id], 99):
                note_categories[note_id] = category

        words = []
        word_data = {}  # word -> {fields: {fieldname: value, ...}, category: str}
        word_categories = {}  # word -> category
        field_used = field if field else None
        available_fields = []
        seen_words = set()

        for note_id, note in note_map.items():
            fields = note.get("fields", {})

            # Get available fields from first note
            if not available_fields and fields:
                available_fields = sorted(fields.keys(), key=lambda f: fields[f].get("order", 0))

            # Auto-detect word field if not specified
            if not field_used and fields:
                field_used = find_best_word_field(fields)

            if field_used and field_used in fields:
                word = clean_field(fields[field_used].get("value", ""))

                if word and word not in seen_words:
                    seen_words.add(word)
                    words.append(word)

                    # Get category for this note
                    category = note_categories.get(note_id, "unknown")
                    word_categories[word] = category

                    # Store all field values for this word (for lookups)
                    # Keep raw values (with [sound:] and [image:] tags) so frontend can extract media
                    field_values = {}
                    for fname, fdata in fields.items():
                        raw_value = fdata.get("value", "") if isinstance(fdata, dict) else fdata
                        if raw_value and raw_value.strip():
                            field_values[fname] = raw_value
                    word_data[word] = {
                        "fields": field_values,
                        "category": category,
                    }

                    # Only return up to limit words
                    if len(words) >= limit:
                        break

        # Count by category (from ALL notes, not just returned ones)
        category_counts = {}
        for cat in note_categories.values():
            category_counts[cat] = category_counts.get(cat, 0) + 1

        return {
            "words": words,
            "word_data": word_data,
            "total": len(note_ids),
            "field_used": field_used,
            "available_fields": available_fields,
            "categories": word_categories,
            "category_counts": category_counts,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Sync endpoints
def _sync_error(e: Exception) -> HTTPException:
    if "auth not configured" in str(e):
        return HTTPException(status_code=503, detail="AnkiWeb sync not configured. Please configure AnkiWeb login first.")
    if isinstance(e, AnkiError) and e.code == "authenticationRequired":
        return HTTPException(status_code=401, detail="AnkiWeb didn't accept the saved login. Log in to AnkiWeb again.")
    return HTTPException(status_code=500, detail=str(e))


@app.post("/api/sync")
async def sync_anki(client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)):
    try:
        result = await client.sync()
    except Exception as e:
        raise _sync_error(e)
    if result.get("outcome") == "fullSyncRequired":
        # Both sides changed: the user has to pick which copy wins.
        raise HTTPException(status_code=409, detail="Full sync required:choose")
    return {"success": True, "message": "Sync completed", "outcome": result.get("outcome")}


@app.post("/api/sync/full-upload")
async def full_upload_anki(client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)):
    """Force upload entire local collection to AnkiWeb, overwriting remote data."""
    try:
        await client.full_upload()
    except Exception as e:
        raise _sync_error(e)
    return {"success": True, "message": "Full upload completed - AnkiWeb overwritten with local data"}


@app.post("/api/sync/full-download")
async def full_download_anki(client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)):
    """Force download entire collection from AnkiWeb, overwriting local data."""
    try:
        await client.full_download()
    except Exception as e:
        raise _sync_error(e)
    return {"success": True, "message": "Full download completed - local data overwritten with AnkiWeb"}


# ── Updates (updater.py) ─────────────────────────────────────────────────────

@app.get("/api/update/check")
async def update_check(_: dict = Depends(require_admin)):
    import asyncio
    return await asyncio.to_thread(updater.check)


@app.post("/api/update/apply")
async def update_apply(_: dict = Depends(require_admin)):
    """Update to the newest version, streaming progress (server-sent events)."""
    async def generate():
        async for event in updater.apply():
            yield updater.json_event(event)
    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# Account management endpoints
container_manager = AnkiAccountManager()

# Profiles (each is its own Anki collection; the API still calls them "accounts"). Every
# login session has its own active profile, among the ones the user may use.

def _accessible(user: dict, account_id: int) -> dict:
    account = next((a for a in security.accessible_profiles(user) if a["id"] == account_id), None)
    if account is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    return account


@app.get("/api/accounts")
async def list_accounts(user: dict = Depends(require_auth)):
    """The profiles this user may use, and the one they're on."""
    active = get_active_account()
    return {"accounts": security.accessible_profiles(user), "active_account_id": active["id"] if active else None}


@app.post("/api/accounts")
async def create_account(request: CreateAccountRequest, user: dict = Depends(require("manage_profiles"))):
    """Create a profile: its own collection on the Anki engine. Its creator may use it."""
    import asyncio
    from database import get_user_container_permissions, set_user_container_permissions
    try:
        account = await asyncio.to_thread(container_manager.create_account, request.container_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not user["is_admin"]:
        set_user_container_permissions(user["user_id"], get_user_container_permissions(user["user_id"]) + [account["id"]])
    return {"success": True, "account": account, "message": f"Profile '{account['container_name']}' created"}


@app.post("/api/accounts/switch")
async def switch_account(request: SwitchAccountRequest, user: dict = Depends(require_auth)):
    """Switch this login to another of the user's profiles (other users aren't affected)."""
    _accessible(user, request.account_id)
    sessions.update(user["session_id"], profile_id=request.account_id)
    return {"success": True, "message": "Profile switched"}


@app.delete("/api/accounts/{account_id}")
async def delete_account_endpoint(account_id: int, remove_data: bool = False,
                                  user: dict = Depends(require("manage_profiles"))):
    """Delete a profile, and with remove_data its collection too."""
    import asyncio
    _accessible(user, account_id)
    if not await asyncio.to_thread(container_manager.delete_account, account_id, remove_data):
        raise HTTPException(status_code=404, detail="Profile not found")
    return {"success": True, "message": "Profile deleted"}


class RenameAccountRequest(BaseModel):
    name: str


@app.post("/api/accounts/{account_id}/rename")
async def rename_account_endpoint(account_id: int, request: RenameAccountRequest,
                                  user: dict = Depends(require("manage_profiles"))):
    """Rename a profile (its collection and its stories move with it)."""
    import asyncio
    _accessible(user, account_id)
    try:
        account = await asyncio.to_thread(container_manager.rename_account, account_id, request.name)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"success": True, "account": account}


@app.post("/api/accounts/{account_id}/restart")
async def restart_account_endpoint(account_id: int, user: dict = Depends(require_auth)):
    """Reload a profile's collection from disk."""
    import asyncio
    _accessible(user, account_id)
    if not await asyncio.to_thread(container_manager.restart_container, account_id):
        raise HTTPException(status_code=503, detail="Anki didn't come back after a restart. "
                                                    "Check: journalctl -u ankibase-anki -n 50")
    return {"success": True, "message": "Collection reloaded"}


# Anki's own pages (Statistics, Deck Options, Card Info), served by anki-cli for the active
# account. Same origin as the app, so they load in an iframe with the normal login cookie.
@app.api_route(anki_server.PAGES_PREFIX + "/{path:path}", methods=["GET", "POST"])
async def anki_pages(path: str, request: Request, client: AnkiConnectClient = Depends(get_anki_client),
                     _: dict = Depends(require_auth)):
    import httpx
    target = client.url.rstrip("/") + "/pages/" + path
    headers = {"Authorization": f"Bearer {anki_server.api_key()}", "X-Forwarded-Prefix": anki_server.PAGES_PREFIX}
    if request.headers.get("content-type"):
        headers["Content-Type"] = request.headers["content-type"]
    try:
        # Optimizing FSRS parameters on a big collection takes minutes.
        async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=5)) as http:
            reply = await http.request(request.method, target, params=request.query_params, headers=headers,
                                       content=await request.body() if request.method == "POST" else None)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"The Anki engine didn't answer: {e}")
    passed = {k: v for k, v in reply.headers.items() if k.lower() in ("content-type", "cache-control")}
    return Response(content=reply.content, status_code=reply.status_code, headers=passed)


# AnkiWeb login endpoints (the sync key is kept by anki-cli, per account)
def _own_sync_endpoint(endpoint: Optional[str], req: Request) -> Optional[str]:
    """This AnkiBase's own sync server is reached directly, not through its public address."""
    if endpoint and endpoint.rstrip("/") == (_public_base(req) + sync_server.PREFIX):
        return sync_server.URL + "/"
    return endpoint


@app.post("/api/ankiweb/login")
async def ankiweb_login(request: AnkiWebLoginRequest, req: Request, client: AnkiConnectClient = Depends(get_anki_client),
                        _: str = Depends(require_auth)):
    endpoint = _own_sync_endpoint(_sync_endpoint(request.endpoint), req)
    try:
        params = {"endpoint": endpoint} if endpoint else {}
        await client.rpc("sync.login", timeout=60.0, username=request.email.strip(), password=request.password,
                         **params)
    except AnkiError as e:
        raise HTTPException(status_code=401 if e.code == "authenticationRequired" else 500,
                            detail=str(e) or "Failed to log in to AnkiWeb. Check your email and password.")
    active_account = get_active_account()
    if active_account:
        set_ankiweb_email(active_account["id"], request.email.strip())
    return {"success": True, "message": "Logged in to AnkiWeb"}


@app.get("/api/ankiweb/status")
async def ankiweb_status(req: Request, client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)):
    """Whether this account is logged in to AnkiWeb"""
    try:
        account = await client.rpc("sync.account")
    except Exception as e:
        return {"has_credentials": False, "configured": False, "error": str(e)}
    endpoint = account.get("endpoint") if account["loggedIn"] else None
    if endpoint and endpoint.rstrip("/") == sync_server.URL:
        endpoint = _public_base(req) + sync_server.PREFIX + "/"  # this AnkiBase's own
    return {"has_credentials": account["loggedIn"], "configured": account["loggedIn"],
            "email": account.get("username") if account["loggedIn"] else None,
            "last_sync": account.get("lastSync"),
            # Set when syncing with a self-hosted server (AnkiWeb hands out its own addresses).
            "endpoint": None if _is_ankiweb(endpoint) else endpoint}


@app.delete("/api/ankiweb/credentials")
async def delete_ankiweb_credentials(client: AnkiConnectClient = Depends(get_anki_client),
                                     _: str = Depends(require_auth)):
    """Log this account out of AnkiWeb"""
    try:
        await client.rpc("sync.logout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    active_account = get_active_account()
    if active_account:
        set_ankiweb_email(active_account["id"], None)
    return {"success": True, "message": "AnkiWeb credentials deleted"}


# --- Your own sync server (Anki's, run next to the engine; see sync_server.py) --------------

def _public_base(request: Request) -> str:
    """This AnkiBase's address as the browser sees it (behind a reverse proxy too)."""
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto.split(',')[0].strip()}://{host.split(',')[0].strip()}"


class SyncAccountRequest(BaseModel):
    name: str
    password: str


@app.get("/api/syncserver")
async def syncserver_status(request: Request, user: dict = Depends(require_auth)):
    """Whether this AnkiBase runs a sync server, and the address to enter in Anki."""
    import asyncio
    info = await asyncio.to_thread(sync_server.status)
    info["url"] = _public_base(request) + sync_server.PREFIX + "/"
    if not user.get("is_admin"):
        info.pop("accounts", None)
    return info


@app.post("/api/syncserver/start")
async def syncserver_start(_: dict = Depends(require_admin)):
    import asyncio
    try:
        ok = await asyncio.to_thread(sync_server.start)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"The sync server didn't start: {e}")
    if not ok:
        raise HTTPException(status_code=500, detail="The sync server didn't start (journalctl -u ankibase-sync)")
    return await asyncio.to_thread(sync_server.status)


@app.post("/api/syncserver/stop")
async def syncserver_stop(_: dict = Depends(require_admin)):
    import asyncio
    await asyncio.to_thread(sync_server.stop)
    return await asyncio.to_thread(sync_server.status)


@app.post("/api/syncserver/accounts")
async def syncserver_add_account(request: SyncAccountRequest, _: dict = Depends(require_admin)):
    """Add (or change the password of) a sync account; the server restarts to pick it up."""
    import asyncio
    try:
        sync_server.add_account(request.name, request.password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if sync_server.enabled():
        await asyncio.to_thread(sync_server.start)
    return await asyncio.to_thread(sync_server.status)


@app.delete("/api/syncserver/accounts/{name}")
async def syncserver_remove_account(name: str, delete_data: bool = False, _: dict = Depends(require_admin)):
    import asyncio
    sync_server.remove_account(name, delete_data)
    if sync_server.enabled():
        if sync_server.accounts():
            await asyncio.to_thread(sync_server.start)
        else:
            await asyncio.to_thread(sync_server.stop)
    return await asyncio.to_thread(sync_server.status)


@app.api_route(sync_server.PREFIX + "/{path:path}", methods=["GET", "POST"])
async def syncserver_proxy(path: str, request: Request):
    """Anki clients sync here; Anki's server does the authentication (no AnkiBase login)."""
    import httpx
    from starlette.background import BackgroundTask
    headers = {k: v for k, v in request.headers.items()
               if k.lower() not in ("host", "content-length", "connection", "transfer-encoding")}
    client = httpx.AsyncClient(timeout=httpx.Timeout(300, connect=5))
    try:
        upstream = await client.send(
            client.build_request(request.method, f"{sync_server.URL}/{path}", params=request.query_params,
                                 headers=headers, content=request.stream()),
            stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(status_code=502, detail="The sync server isn't running")
    passed = {k: v for k, v in upstream.headers.items()
              if k.lower() not in ("content-length", "transfer-encoding", "connection")}
    return StreamingResponse(upstream.aiter_raw(), status_code=upstream.status_code, headers=passed,
                             background=BackgroundTask(_close_both, upstream, client))


async def _close_both(upstream, client) -> None:
    await upstream.aclose()
    await client.aclose()


# Quizlet endpoints
class QuizletScrapeRequest(BaseModel):
    url: str


class QuizletSaveRequest(BaseModel):
    title: str
    url: str
    cards: list[dict]  # [{front, back}]


class QuizletReviewRequest(BaseModel):
    card_id: int
    ease: int  # 1=Again, 2=Got it


def _scrape_quizlet_sync(url: str) -> dict:
    import time, re
    from invisible_playwright import InvisiblePlaywright
    from invisible_playwright import download as ip_download
    from xvfbwrapper import Xvfb
    ip_download.ensure_binary()

    CLICK_SEE_MORE_JS = """() => {
        const b = Array.from(document.querySelectorAll("button"))
                    .find(b => b.textContent.trim() === "See more");
        if (b) { b.scrollIntoView(); b.click(); return true; }
        return false;
    }"""

    EXTRACT_JS = """() => {
        const terms = Array.from(document.querySelectorAll(".TermText"));
        const cards = [];
        for (let i = 0; i + 1 < terms.length; i += 2) {
            let image = null;
            let node = terms[i].parentElement;
            for (let lvl = 0; lvl < 5 && node; lvl++) {
                const img = node.querySelector("img");
                if (img && img.src && !img.src.startsWith("data:")) {
                    image = img.src;
                    break;
                }
                node = node.parentElement;
            }
            cards.push({
                front: terms[i].textContent.trim(),
                back: terms[i+1].textContent.trim(),
                image: image
            });
        }
        return cards;
    }"""

    def _unwrap_cdn_image(img_url):
        if not img_url:
            return img_url
        m = re.search(r'cdn-cgi/image/[^/]+/(https?://.+)$', img_url)
        return m.group(1) if m else img_url

    with Xvfb():
        with InvisiblePlaywright(headless=False) as browser:
            page = browser.new_page()
            page.goto(url, timeout=45000)
            time.sleep(5)

            title = page.evaluate("""() => {
                const h1 = document.querySelector("h1");
                return h1 ? h1.textContent.trim() : document.title.replace(" | Quizlet", "").trim();
            }""")

            # Click "See more" until all cards are loaded
            for _ in range(60):
                page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
                time.sleep(0.8)
                clicked = page.evaluate(CLICK_SEE_MORE_JS)
                if not clicked:
                    break
                time.sleep(1.5)

            cards_raw = page.evaluate(EXTRACT_JS)

    if not cards_raw:
        raise Exception("No flashcard terms found. The deck may be private or the URL is invalid.")

    cards = [
        {"front": c["front"], "back": c["back"], "image": _unwrap_cdn_image(c["image"])}
        for c in cards_raw
    ]
    return {"title": title or "Quizlet Import", "cards": cards}


class ImageFetchRequest(BaseModel):
    url: str


@app.post("/api/quizlet/scrape")
async def quizlet_scrape(request: QuizletScrapeRequest, _: str = Depends(require("import"))):
    import asyncio, re
    url = request.url.strip()
    if not re.match(r"https?://(www\.)?quizlet\.com/\d+/", url):
        raise HTTPException(status_code=400, detail="Invalid Quizlet URL. Expected: https://quizlet.com/<id>/...")
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _scrape_quizlet_sync, url)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/quizlet/fetch-image")
async def quizlet_fetch_image(request: ImageFetchRequest, _: str = Depends(require("import"))):
    """A card image from the web, as a data URL (public addresses only, up to 5 MB)."""
    data, content_type = await security.fetch_public(request.url.strip(), max_bytes=5 * 1024 * 1024)
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="That address isn't an image")
    return {"data": f"data:{content_type};base64,{security.b64(data)}"}


@app.post("/api/quizlet/decks")
async def quizlet_save_deck(request: QuizletSaveRequest, _: str = Depends(require("import"))):
    try:
        deck_id = create_quizlet_deck(request.title, request.url, request.cards)
        return {"success": True, "deck_id": deck_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/quizlet/decks")
async def quizlet_list_decks(_: str = Depends(require_auth)):
    return {"decks": get_quizlet_decks()}


@app.get("/api/quizlet/decks/{deck_id}")
async def quizlet_get_deck(deck_id: int, _: str = Depends(require_auth)):
    deck = get_quizlet_deck(deck_id)
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")
    return deck


@app.delete("/api/quizlet/decks/{deck_id}")
async def quizlet_delete_deck(deck_id: int, _: str = Depends(require_auth)):
    if not delete_quizlet_deck(deck_id):
        raise HTTPException(status_code=404, detail="Deck not found")
    return {"success": True}


class QuizletRenameRequest(BaseModel):
    title: str

@app.patch("/api/quizlet/decks/{deck_id}")
async def quizlet_rename_deck(deck_id: int, request: QuizletRenameRequest, _: str = Depends(require_auth)):
    if not rename_quizlet_deck(deck_id, request.title.strip()):
        raise HTTPException(status_code=404, detail="Deck not found")
    return {"success": True}


@app.get("/api/quizlet/decks/{deck_id}/stats")
async def quizlet_get_deck_stats(deck_id: int, _: str = Depends(require_auth)):
    return get_quizlet_deck_stats(deck_id)


@app.get("/api/quizlet/decks/{deck_id}/favorites")
async def quizlet_get_favorites(deck_id: int, _: str = Depends(require_auth)):
    return {"card_ids": get_quizlet_favorites(deck_id)}


@app.post("/api/quizlet/decks/{deck_id}/favorites/{card_id}")
async def quizlet_toggle_favorite(deck_id: int, card_id: int, _: str = Depends(require_auth)):
    favorited = toggle_quizlet_favorite(card_id, deck_id)
    return {"favorited": favorited}


class QuizletCardUpdateRequest(BaseModel):
    front: str
    back: str
    image: Optional[str] = None


@app.patch("/api/quizlet/decks/{deck_id}/cards/{card_id}")
async def quizlet_update_card(deck_id: int, card_id: int, request: QuizletCardUpdateRequest, _: str = Depends(require_auth)):
    if not update_quizlet_card(card_id, deck_id, request.front, request.back, request.image):
        raise HTTPException(status_code=404, detail="Card not found")
    return {"success": True}


@app.post("/api/quizlet/decks/{deck_id}/review")
async def quizlet_record_review(deck_id: int, request: QuizletReviewRequest, _: str = Depends(require_auth)):
    try:
        record_quizlet_review(request.card_id, deck_id, request.ease)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


QUIZLET_STATE_MODES = {"match", "blast", "blocks"}


class QuizletStateRequest(BaseModel):
    state: dict


def _check_state_mode(mode: str):
    if mode not in QUIZLET_STATE_MODES:
        raise HTTPException(status_code=400, detail="Unknown study mode")


@app.get("/api/quizlet/decks/{deck_id}/state/{mode}")
async def quizlet_get_state(deck_id: int, mode: str, _: str = Depends(require_auth)):
    import json
    _check_state_mode(mode)
    raw = get_quizlet_study_state(deck_id, mode)
    return {"state": json.loads(raw) if raw else None}


@app.put("/api/quizlet/decks/{deck_id}/state/{mode}")
async def quizlet_put_state(deck_id: int, mode: str, request: QuizletStateRequest, _: str = Depends(require_auth)):
    import json
    _check_state_mode(mode)
    raw = json.dumps(request.state)
    if len(raw) > 1_000_000:
        raise HTTPException(status_code=413, detail="State too large")
    if not get_quizlet_deck(deck_id):
        raise HTTPException(status_code=404, detail="Deck not found")
    set_quizlet_study_state(deck_id, mode, raw)
    return {"success": True}


@app.delete("/api/quizlet/decks/{deck_id}/state/{mode}")
async def quizlet_delete_state(deck_id: int, mode: str, _: str = Depends(require_auth)):
    _check_state_mode(mode)
    delete_quizlet_study_state(deck_id, mode)
    return {"success": True}


# --- Study sessions (resumable activities shown in the Study hub) ---

SESSION_KINDS = {"quizlet-learn", "quizlet-flashcards", "quizlet-test", "anki", "reading"}
SESSION_STATUSES = {"active", "completed"}


class StudySessionRequest(BaseModel):
    title: str
    detail: Optional[str] = None
    progress_done: int = 0
    progress_total: int = 0
    status: str = "active"
    state: Optional[dict] = None


def _check_session(kind: str, ref_id: str):
    if kind not in SESSION_KINDS:
        raise HTTPException(status_code=400, detail="Unknown session kind")
    if not ref_id or len(ref_id) > 64:
        raise HTTPException(status_code=400, detail="Invalid reference")


@app.get("/api/sessions")
async def sessions_list(user: dict = Depends(require_auth)):
    return {"sessions": list_study_sessions(user["user_id"])}


@app.get("/api/sessions/{kind}/{ref_id}")
async def sessions_get(kind: str, ref_id: str, user: dict = Depends(require_auth)):
    import json
    _check_session(kind, ref_id)
    session = get_study_session(user["user_id"], kind, ref_id)
    if session is None and kind == "quizlet-learn" and ref_id.isdigit():
        # One-time move of Learn progress saved per deck (before sessions existed) to this user.
        legacy = get_quizlet_study_state(int(ref_id), "learn")
        if legacy:
            deck = get_quizlet_deck(int(ref_id))
            upsert_study_session(user["user_id"], kind, ref_id, deck["title"] if deck else "", None, 0, 0, "active", legacy)
            delete_quizlet_study_state(int(ref_id), "learn")
            session = get_study_session(user["user_id"], kind, ref_id)
    if session is None:
        return {"session": None}
    raw = session.pop("state", None)
    session["state"] = json.loads(raw) if raw else None
    return {"session": session}


@app.put("/api/sessions/{kind}/{ref_id}")
async def sessions_put(kind: str, ref_id: str, request: StudySessionRequest, user: dict = Depends(require_auth)):
    import json
    _check_session(kind, ref_id)
    if request.status not in SESSION_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid status")
    raw = json.dumps(request.state) if request.state is not None else None
    if raw and len(raw) > 2_000_000:
        raise HTTPException(status_code=413, detail="State too large")
    upsert_study_session(
        user["user_id"], kind, ref_id, request.title[:200], (request.detail or None) and request.detail[:200],
        max(0, request.progress_done), max(0, request.progress_total), request.status, raw,
    )
    return {"success": True}


@app.delete("/api/sessions/{kind}/{ref_id}")
async def sessions_delete(kind: str, ref_id: str, user: dict = Depends(require_auth)):
    _check_session(kind, ref_id)
    delete_study_session(user["user_id"], kind, ref_id)
    return {"success": True}


# Models endpoint
def _scrape_ankiweb_download_url(deck_url: str) -> tuple:
    """Open the AnkiWeb shared deck page, click Download, return (signed_url, deck_title, cookies).

    The browser's own request to the download endpoint is aborted so the JWT token
    remains unconsumed and can be used by the subsequent httpx download.
    """
    import time
    from invisible_playwright import InvisiblePlaywright
    from invisible_playwright import download as ip_download
    from xvfbwrapper import Xvfb
    ip_download.ensure_binary()

    state = {'dl_url': None, 'title': None}

    with Xvfb():
        with InvisiblePlaywright(headless=False) as browser:
            ctx = browser.new_context()
            page = ctx.new_page()

            def handle_route(route):
                state['dl_url'] = route.request.url
                route.abort()  # prevent browser from consuming the token

            page.route('**/svc/shared/download-deck/**', handle_route)
            page.goto(deck_url, timeout=30000)
            time.sleep(4)

            state['title'] = page.evaluate("""() => {
                const h1 = document.querySelector('h1');
                return h1 ? h1.textContent.trim() : document.title.replace(' - AnkiWeb', '').trim();
            }""")

            page.evaluate("""() => {
                const btn = Array.from(document.querySelectorAll('button')).find(b => /download/i.test(b.textContent));
                if (btn) btn.click();
            }""")
            time.sleep(2)

            cookies = {c['name']: c['value'] for c in ctx.cookies()}
            ctx.close()

    if not state['dl_url']:
        raise Exception("Could not find download link. The deck may require login or be unavailable.")

    return state['dl_url'], state['title'] or 'AnkiWeb Deck', cookies


class AnkiWebUrlImportRequest(BaseModel):
    url: str


async def _download_shared_deck(url: str) -> tuple[str, str, bytes]:
    """A shared deck from AnkiWeb: (title, file name, .apkg contents)."""
    import re as _re, asyncio
    url = url.strip()
    if not _re.match(r'https?://(www\.)?ankiweb\.net/shared/info/\d+', url):
        raise HTTPException(status_code=400, detail="Invalid URL. Expected: https://ankiweb.net/shared/info/<id>")

    loop = asyncio.get_event_loop()
    try:
        dl_url, deck_title, cookies = await loop.run_in_executor(None, _scrape_ankiweb_download_url, url)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    import httpx as _httpx
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Accept': '*/*',
        'Referer': url,
    }
    async with _httpx.AsyncClient(follow_redirects=True, timeout=300) as http:
        resp = await http.get(dl_url, headers=headers, cookies=cookies)
        if resp.status_code != 200:
            raise HTTPException(status_code=500, detail=f"Download failed (HTTP {resp.status_code})")

    cd = resp.headers.get('content-disposition', '')
    m = _re.search(r'filename="?([^";\n]+)', cd)
    filename = m.group(1).strip() if m else f"ankiweb_{url.rstrip('/').split('/')[-1]}.apkg"
    if not filename.endswith('.apkg'):
        filename += '.apkg'
    return deck_title, filename, resp.content


@app.post("/api/import/ankiweb-url")
async def import_ankiweb_url(
    request: AnkiWebUrlImportRequest,
    client: AnkiConnectClient = Depends(get_anki_client),
    _: str = Depends(require("import")),
):
    deck_title, filename, content = await _download_shared_deck(request.url)
    active_account = get_active_account()
    if not active_account:
        raise HTTPException(status_code=400, detail="No active account")

    export_dir = tempfile.mkdtemp(dir=_import_dir())
    file_path = os.path.join(export_dir, os.path.basename(filename))
    try:
        with open(file_path, 'wb') as f:
            f.write(content)
        await client.import_package(file_path)
        return {"success": True, "message": f'Successfully imported "{deck_title}"', "deck_title": deck_title}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        shutil.rmtree(export_dir, ignore_errors=True)


@app.post("/api/import/ankiweb-url/package")
async def download_ankiweb_package(request: AnkiWebUrlImportRequest, _: str = Depends(require("import"))):
    """The shared deck's .apkg itself, for the phone app to import into its own collection
    (AnkiWeb only hands it out to a real browser, which runs here)."""
    from urllib.parse import quote
    deck_title, filename, content = await _download_shared_deck(request.url)
    return Response(content=content, media_type="application/octet-stream", headers={
        "X-Title": quote(deck_title),
        "Content-Disposition": f'attachment; filename="{quote(filename)}"',
    })


# Import deck endpoint
@app.post("/api/import")
async def import_deck(
    file: UploadFile = File(...),
    client: AnkiConnectClient = Depends(get_anki_client),
    _: str = Depends(require("import")),
):
    if not file.filename or not file.filename.endswith(".apkg"):
        raise HTTPException(status_code=400, detail="Only .apkg files are supported")

    temp_dir = tempfile.mkdtemp(dir=_import_dir())
    try:
        # The engine runs on this machine, so it imports straight from the uploaded file.
        temp_path = os.path.join(temp_dir, os.path.basename(file.filename))
        with open(temp_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        await client.import_package(temp_path)
        return {"success": True, "message": f"Successfully imported {file.filename}"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def _import_dir() -> str:
    path = anki_server.DATA_DIR / ".imports"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


# Deck management endpoints
class DeleteDeckRequest(BaseModel):
    deck_name: str


class RenameDeckRequest(BaseModel):
    old_name: str
    new_name: str


@app.post("/api/decks/delete")
async def delete_deck(
    request: DeleteDeckRequest,
    client: AnkiConnectClient = Depends(get_anki_client),
    _: str = Depends(require_auth),
):
    try:
        await client.delete_decks([request.deck_name])
        return {"success": True, "message": f"Deleted deck: {request.deck_name}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/decks/rename")
async def rename_deck(
    request: RenameDeckRequest,
    client: AnkiConnectClient = Depends(get_anki_client),
    _: str = Depends(require_auth),
):
    try:
        # Find all cards in the old deck
        card_ids = await client.find_cards(f'"deck:{request.old_name}"')
        if card_ids:
            # Create new deck and move cards
            await client.create_deck(request.new_name)
            await client.change_deck(card_ids, request.new_name)
        # Delete the old deck
        await client.delete_decks([request.old_name])
        return {"success": True, "message": f"Renamed deck to: {request.new_name}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Stats HTML endpoint
# Full statistics (Anki's stats screen + Quizlet) for the Stats tab
@app.get("/api/stats/overview")
async def stats_overview(
    deck: str = "",              # Anki deck (includes subdecks); empty = whole collection
    anki: bool = True,           # include Anki data
    quizlet: str = "all",        # "all" | "none" | a Quizlet set id
    period: str = "1m",          # 1m | 3m | 1y | all
    tz: str = "UTC",             # viewer's IANA timezone, so days match their clock
    refresh: bool = False,
    client: AnkiConnectClient = Depends(get_anki_client),
    user: dict = Depends(require_auth),
):
    import stats_engine as se

    if period not in se.PERIODS:
        raise HTTPException(status_code=400, detail="Invalid period")
    period_days = se.PERIODS[period]
    clock = se.DayClock(tz)
    quizlet_set = int(quizlet) if quizlet.isdigit() else None
    use_anki = anki and quizlet_set is None
    use_quizlet = quizlet != "none" and not deck

    result: dict = {
        "today": clock.today.isoformat(),
        "period": period,
        "rollover_hours": se.ROLLOVER_HOURS,
        "anki": None,
        "anki_error": None,
        "quizlet": None,
    }
    if use_anki:
        try:
            cache = await se.refresh(client, force=refresh)
            result["anki"] = se.compute_anki(cache, clock, deck or None, period_days)
        except Exception as e:
            result["anki_error"] = f"Couldn't reach Anki: {e}"
    if use_quizlet:
        rows, cards, levels = get_quizlet_stats_data(user["user_id"], quizlet_set)
        result["quizlet"] = se.compute_quizlet(rows, cards, levels, clock, period_days)
    return result


# Review history endpoint for heatmap
@app.get("/api/stats/reviews")
async def get_review_history(
    deck: str = "",  # Empty string means all decks
    source: str = "all",  # all | anki | quizlet
    client: AnkiConnectClient = Depends(get_anki_client),
    _: str = Depends(require_auth),
):
    try:
        from collections import defaultdict
        from datetime import datetime

        daily_counts: dict[str, int] = defaultdict(int)
        daily_time: dict[str, float] = defaultdict(float)
        hourly_counts: dict[int, int] = defaultdict(int)
        button_counts: dict[int, int] = defaultdict(int)
        interval_ranges: dict[str, int] = defaultdict(int)
        today_reviews = 0
        today_time_ms = 0
        today = datetime.now().strftime("%Y-%m-%d")
        api_today_count = 0

        if source in ("all", "anki"):
            deck_names = await client.get_deck_names()
            if deck and deck != "All Decks":
                decks_to_query = [deck] if deck in deck_names else []
            else:
                decks_to_query = deck_names

            all_reviews = []
            for deck_name in decks_to_query:
                try:
                    reviews = await client.get_card_reviews(deck_name, 0)
                    if reviews:
                        all_reviews.extend(reviews)
                except Exception:
                    continue

            for review in all_reviews:
                timestamp_ms, card_id, usn, button_pressed, new_interval, prev_interval, new_factor, review_duration, review_type = review
                dt = datetime.fromtimestamp(timestamp_ms / 1000)
                date_str = dt.strftime("%Y-%m-%d")
                daily_counts[date_str] += 1
                daily_time[date_str] += review_duration / 1000.0
                hourly_counts[dt.hour] += 1
                button_counts[button_pressed] += 1
                if new_interval < 1:
                    interval_ranges["< 1 day"] += 1
                elif new_interval < 7:
                    interval_ranges["1-6 days"] += 1
                elif new_interval < 30:
                    interval_ranges["1-4 weeks"] += 1
                elif new_interval < 180:
                    interval_ranges["1-6 months"] += 1
                else:
                    interval_ranges["6+ months"] += 1
                if date_str == today:
                    today_reviews += 1
                    today_time_ms += review_duration

            api_today_count = await client.get_num_cards_reviewed_today()

        if source in ("all", "quizlet"):
            quizlet_counts = get_quizlet_daily_counts()
            for date_str, count in quizlet_counts.items():
                daily_counts[date_str] += count
                if date_str == today:
                    today_reviews += count

        return {
            "daily_counts": dict(daily_counts),
            "daily_time": dict(daily_time),
            "hourly_counts": dict(hourly_counts),
            "button_counts": dict(button_counts),
            "interval_ranges": dict(interval_ranges),
            "today": max(today_reviews, api_today_count),
            "today_time_seconds": today_time_ms / 1000.0,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Serve static files (frontend) in production
static_path = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_path):
    app.mount("/assets", StaticFiles(directory=os.path.join(static_path, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        # Unknown API paths are errors, not the app.
        if full_path.startswith("api/") or full_path == "api":
            raise HTTPException(status_code=404, detail="Not found")
        # Serve index.html for SPA routing
        root = os.path.realpath(static_path)
        file_path = os.path.realpath(os.path.join(root, full_path))
        if file_path.startswith(root + os.sep) and os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(static_path, "index.html"))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
