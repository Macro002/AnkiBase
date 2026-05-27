from fastapi import FastAPI, HTTPException, Depends, Request, Response, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional
import secrets
import os
import json
import tempfile
import shutil
import time
from collections import defaultdict

from config import get_settings, Settings, get_api_keys, get_api_key_info, save_api_key, delete_api_key, change_password, get_account_api_keys_file
from anki_client import AnkiConnectClient
from story_generator import StoryGenerator, PROVIDERS, NoValidKeysError
from database import (
    save_story, get_story, get_all_stories, delete_story, update_story_name,
    get_active_account, get_all_accounts, get_account, set_ankiweb_email,
    migrate_to_user_system,
    create_quizlet_deck, get_quizlet_decks, get_quizlet_deck, delete_quizlet_deck,
    rename_quizlet_deck, record_quizlet_review, get_quizlet_daily_counts,
    get_quizlet_deck_stats, get_quizlet_favorites, toggle_quizlet_favorite,
    update_quizlet_card,
    get_setting, set_setting, get_user_accent, set_user_accent, clear_user_accent,
    get_server_base_colors, set_server_base_colors,
    get_user_base_colors, set_user_base_colors, clear_user_base_colors,
    get_user,
)
from ankiweb_credentials import AnkiWebCredentials
from anki_config import AnkiConfigurator
from anki_container_manager import AnkiContainerManager

app = FastAPI(title="AnkiBase", version="1.0.0")

# CORS for development
_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _settings.cors_origins.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Simple session store (in production, use Redis or similar)
# session_id -> user info
sessions: dict[str, dict] = {}

# Login rate limiting constants (DB-backed, persistent)
_LOGIN_WINDOW      = 900   # 15-minute sliding window
_USERNAME_MAX_FAIL = 5     # per username
_IP_MAX_FAIL       = 20    # per IP (allows multiple users on same network)


# Startup event - auto-configure AnkiWeb if credentials exist
@app.on_event("startup")
async def startup_event():
    """Auto-configure AnkiWeb login on startup if credentials exist"""
    try:
        # Migration: Add existing headless-anki container to database if not present
        from database import add_account, get_all_accounts, get_account_by_email
        import subprocess

        accounts = get_all_accounts()
        if len(accounts) == 0:
            # Check if the default container exists (upgrading from pre-multi-account version)
            result = subprocess.run(
                ["docker", "inspect", "headless-anki"],
                capture_output=True,
                text=True
            )
            if result.returncode == 0:
                # Container exists, add it to database
                print("Migrating existing headless-anki container to multi-account system...")
                try:
                    add_account(
                        email="default@ankibase.local",  # Placeholder email
                        container_name="headless-anki",
                        container_port=8765,
                        volume_name="ankibase_anki-data"
                    )
                    # Set it as active
                    from database import set_active_account, get_account_by_email
                    account = get_account_by_email("default@ankibase.local")
                    if account:
                        set_active_account(account["id"])
                    print("✓ Default container migrated successfully")
                    accounts = get_all_accounts()
                except Exception as e:
                    print(f"✗ Failed to migrate default container: {e}")

        # Migration: Create root user only when upgrading (containers already exist)
        # Fresh installs use the setup wizard to create their first user
        if len(accounts) > 0:
            settings = get_settings()
            migrate_to_user_system(settings.app_password)

        active_account = get_active_account()
        if active_account:
            creds = AnkiWebCredentials(container_name=active_account["container_name"])
            # One-time migration: move old global .credentials into the active container's dir
            if not creds.has_credentials():
                legacy = AnkiWebCredentials()
                if legacy.has_credentials():
                    old_data = legacy.load_credentials()
                    if old_data:
                        creds.save_credentials(old_data["email"], old_data["password"])
                        legacy.delete_credentials()
                        print(f"✓ Migrated AnkiWeb credentials to container '{active_account['container_name']}'")
            if creds.has_credentials():
                print("Found stored AnkiWeb credentials, auto-configuring...")
                credentials = creds.load_credentials()
                if credentials:
                    configurator = AnkiConfigurator()
                    success = configurator.configure_ankiweb_login(
                        credentials["email"],
                        credentials["password"]
                    )
                    if success:
                        print(f"✓ AnkiWeb auto-configured for {credentials['email']}")
                    else:
                        print("✗ Failed to auto-configure AnkiWeb")
    except Exception as e:
        print(f"Error during AnkiWeb auto-configuration: {e}")


# Auth models
class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ChangeLanguageRequest(BaseModel):
    language: str


class CreateUserRequest(BaseModel):
    username: str
    password: str
    is_admin: bool = False
    can_add_containers: bool = False
    can_edit_server_accent: bool = False


class UpdateUserRequest(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None
    is_admin: Optional[bool] = None
    can_add_containers: Optional[bool] = None
    can_edit_server_accent: Optional[bool] = None


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


class CreateAccountRequest(BaseModel):
    container_name: str


class SwitchAccountRequest(BaseModel):
    account_id: int


class DeleteAccountRequest(BaseModel):
    account_id: int
    remove_data: bool = False


class LoginResponse(BaseModel):
    success: bool
    message: str
    user: Optional[dict] = None


# Dependency to check authentication
async def require_auth(request: Request) -> dict:
    """Require authentication. Returns user session info."""
    session_id = request.cookies.get("session_id")
    if not session_id or session_id not in sessions:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return sessions[session_id]


async def require_admin(user: dict = Depends(require_auth)) -> dict:
    """Require admin privileges."""
    if not user.get('is_admin'):
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


async def require_can_add_containers(user: dict = Depends(require_auth)) -> dict:
    """Require can_add_containers permission."""
    if not user.get('can_add_containers') and not user.get('is_admin'):
        raise HTTPException(status_code=403, detail="Permission to add containers required")
    return user


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


@app.get("/api/setup/status")
async def setup_status():
    from database import get_user_count, get_all_accounts
    return {
        "needs_setup": get_user_count() == 0,
        "has_admin": get_user_count() > 0,
        "has_container": len(get_all_accounts()) > 0,
    }


@app.post("/api/setup/admin")
async def setup_create_admin(request: SetupAdminRequest, response: Response):
    from database import get_user_count, create_user, get_user_by_username
    if get_user_count() > 0:
        raise HTTPException(status_code=400, detail="Admin already exists")
    if len(request.username.strip()) < 2:
        raise HTTPException(status_code=400, detail="Username must be at least 2 characters")
    if len(request.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    user_id = create_user(request.username.strip(), request.password, is_admin=True, can_add_containers=True)
    user = get_user_by_username(request.username.strip())
    session_id = secrets.token_urlsafe(32)
    sessions[session_id] = {
        "user_id": user_id,
        "username": user["username"],
        "is_admin": True,
        "can_add_containers": True,
    }
    response.set_cookie("session_id", session_id, httponly=True, samesite="lax", max_age=7 * 24 * 3600)
    return {"success": True, "username": user["username"]}


@app.get("/api/setup/container/stream")
async def setup_container_stream(name: str, request: Request):
    import asyncio, json, httpx

    # Require auth
    session_id = request.cookies.get("session_id")
    if not session_id or session_id not in sessions:
        raise HTTPException(status_code=401, detail="Not authenticated")

    container_name = name.strip().lower().replace(" ", "-") or "default"

    async def generate():
        def event(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        try:
            # Step 1: Pull image
            yield event({"type": "step", "message": "Pulling Docker image...", "progress": 5})

            pull_proc = await asyncio.create_subprocess_exec(
                "docker", "pull", "thisisnttheway/headless-anki:latest",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            async for line in pull_proc.stdout:
                msg = line.decode().strip()
                if msg:
                    yield event({"type": "log", "message": msg, "progress": 30})

            await pull_proc.wait()
            if pull_proc.returncode != 0:
                yield event({"type": "error", "message": "Failed to pull Docker image"})
                return

            yield event({"type": "step", "message": "Image ready.", "progress": 55})

            # Step 2: Create container
            yield event({"type": "step", "message": f"Creating container '{container_name}'...", "progress": 60})
            try:
                account = container_manager.create_account(container_name)
            except Exception as e:
                yield event({"type": "error", "message": str(e)})
                return

            yield event({"type": "step", "message": "Container started.", "progress": 75})

            # Step 3: Wait for AnkiConnect
            yield event({"type": "step", "message": "Waiting for AnkiConnect to initialize...", "progress": 80})
            port = account["container_port"]
            ready = False
            async with httpx.AsyncClient() as client:
                for _ in range(30):
                    await asyncio.sleep(2)
                    try:
                        r = await client.get(f"http://localhost:{port}", timeout=3.0)
                        if r.status_code < 500:
                            ready = True
                            break
                    except Exception:
                        pass
                    yield event({"type": "log", "message": "Still initializing...", "progress": 85})

            if not ready:
                yield event({"type": "error", "message": "AnkiConnect did not respond in time. You can continue anyway."})
                yield event({"type": "done", "message": "Container created (AnkiConnect may still be starting)", "progress": 100})
                return

            # Patch AnkiConnect to add fullUpload/fullDownload
            import subprocess as _sp
            yield event({"type": "log", "message": "Applying AnkiConnect patches...", "progress": 95})
            from anki_container_manager import patch_ankiconnect
            patch_ankiconnect(container_name)
            _sp.run(["docker", "restart", container_name], capture_output=True)
            await asyncio.sleep(8)

            yield event({"type": "done", "message": "AnkiConnect is ready!", "progress": 100})

        except Exception as e:
            yield event({"type": "error", "message": str(e)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Auth endpoints
@app.post("/api/auth/login", response_model=LoginResponse)
async def login(request: LoginRequest, response: Response, req: Request):
    from database import (
        verify_user_credentials, get_user_accessible_containers, set_active_account,
        record_login_attempt, count_recent_attempts, clear_login_attempts, get_lockout_wait,
    )

    ip_key   = f"ip:{req.client.host if req.client else 'unknown'}"
    user_key = f"user:{request.username.lower()}"

    ip_wait = get_lockout_wait(ip_key, _LOGIN_WINDOW, _IP_MAX_FAIL)
    if ip_wait > 0:
        raise HTTPException(
            status_code=429,
            detail={"message": "Too many failed login attempts.", "wait_seconds": ip_wait},
        )
    user_wait = get_lockout_wait(user_key, _LOGIN_WINDOW, _USERNAME_MAX_FAIL)
    if user_wait > 0:
        raise HTTPException(
            status_code=429,
            detail={"message": "Too many failed login attempts.", "wait_seconds": user_wait},
        )

    user = verify_user_credentials(request.username, request.password)
    if user:
        clear_login_attempts(ip_key, user_key)
        # Auto-switch to first accessible container for this user
        accounts = get_user_accessible_containers(user['id'])
        if accounts:
            # Get current active account
            active_account = container_manager.get_active_account()

            # Check if user has access to current active account
            if active_account:
                has_access = any(acc['id'] == active_account['id'] for acc in accounts)
                if not has_access:
                    # Switch to first accessible container
                    set_active_account(accounts[0]['id'])
            else:
                # No active account, set first accessible
                set_active_account(accounts[0]['id'])

        session_id = secrets.token_urlsafe(32)
        # Store user info in session
        sessions[session_id] = {
            'user_id': user['id'],
            'username': user['username'],
            'is_admin': bool(user['is_admin']),
            'can_add_containers': bool(user['can_add_containers']),
            'can_edit_server_accent': bool(user.get('can_edit_server_accent', 0)),
            'language': user.get('language', 'en')
        }
        response.set_cookie(
            key="session_id",
            value=session_id,
            httponly=True,
            secure=True,
            samesite="strict",
            max_age=86400 * 7,  # 7 days
        )
        return LoginResponse(
            success=True,
            message="Login successful",
            user={
                'username': user['username'],
                'is_admin': bool(user['is_admin']),
                'can_add_containers': bool(user['can_add_containers']),
                'language': user.get('language', 'en')
            }
        )
    record_login_attempt(ip_key)
    record_login_attempt(user_key)

    user_count = count_recent_attempts(user_key, _LOGIN_WINDOW)
    remaining = max(_USERNAME_MAX_FAIL - user_count, 0)
    if remaining == 0:
        wait = get_lockout_wait(user_key, _LOGIN_WINDOW, _USERNAME_MAX_FAIL)
        raise HTTPException(
            status_code=429,
            detail={"message": "Too many failed login attempts.", "wait_seconds": wait},
        )
    raise HTTPException(
        status_code=401,
        detail={"message": "Invalid username or password", "remaining": remaining},
    )


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    session_id = request.cookies.get("session_id")
    if session_id and session_id in sessions:
        del sessions[session_id]
    response.delete_cookie("session_id")
    return {"success": True}


@app.get("/api/auth/check")
async def check_auth(request: Request):
    session_id = request.cookies.get("session_id")
    authenticated = session_id is not None and session_id in sessions
    user = sessions.get(session_id) if authenticated else None
    if user:
        db_user = get_user(user['user_id']) or {}
    return {
        "authenticated": authenticated,
        "user": {
            'username': user['username'],
            'is_admin': user['is_admin'],
            'can_add_containers': user['can_add_containers'],
            'can_edit_server_accent': bool(db_user.get('can_edit_server_accent', 0)),
            'language': user.get('language', 'en'),
            **_resolve_user_accent(user['user_id']),
            **_resolve_user_base_colors(user['user_id']),
        } if user else None
    }


@app.get("/api/auth/me")
async def get_current_user(user: dict = Depends(require_auth)):
    """Get current user info."""
    db_user = get_user(user['user_id']) or {}
    return {
        'username': user['username'],
        'is_admin': user['is_admin'],
        'can_add_containers': user['can_add_containers'],
        'can_edit_server_accent': bool(db_user.get('can_edit_server_accent', 0)),
        'language': user.get('language', 'en'),
        **_resolve_user_accent(user['user_id']),
        **_resolve_user_base_colors(user['user_id']),
    }


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

    # Verify current password
    if not verify_password(request.current_password, full_user['password_hash']):
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    # Validate new password
    if len(request.new_password) < 6:
        raise HTTPException(status_code=400, detail="New password must be at least 6 characters")

    try:
        update_user_password(user['user_id'], request.new_password)
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
    if request.language not in ['en', 'de']:
        raise HTTPException(status_code=400, detail="Invalid language. Supported: en, de")

    try:
        update_user_language(user['user_id'], request.language)
        # Update session
        session_id = req.cookies.get("session_id")
        if session_id and session_id in sessions:
            sessions[session_id]['language'] = request.language
        return {"success": True, "message": "Language changed successfully", "language": request.language}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to change language: {str(e)}")


# User management endpoints (admin only)
@app.get("/api/users")
async def list_users(_: dict = Depends(require_admin)):
    """List all users (admin only)"""
    from database import get_all_users
    return {"users": get_all_users()}


@app.post("/api/users")
async def create_user_endpoint(request: CreateUserRequest, _: dict = Depends(require_admin)):
    """Create a new user (admin only)"""
    from database import create_user, get_user_by_username

    # Check if username already exists
    if get_user_by_username(request.username):
        raise HTTPException(status_code=400, detail="Username already exists")

    # Validate password
    if len(request.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    # Validate username
    if len(request.username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters")

    try:
        user_id = create_user(
            request.username,
            request.password,
            request.is_admin,
            request.can_add_containers,
            request.can_edit_server_accent,
        )
        return {"success": True, "user_id": user_id, "message": "User created successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create user: {str(e)}")


@app.put("/api/users/{user_id}")
async def update_user_endpoint(user_id: int, request: UpdateUserRequest, _: dict = Depends(require_admin)):
    """Update user settings (admin only)"""
    from database import get_user, update_user, update_user_username, update_user_password

    # Check if user exists
    if not get_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")

    # Don't allow modifying root user
    if user_id == 1:
        raise HTTPException(status_code=403, detail="Cannot modify root user")

    try:
        # Update username if provided
        if request.username:
            update_user_username(user_id, request.username)

        # Update password if provided
        if request.password:
            if len(request.password) < 6:
                raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
            update_user_password(user_id, request.password)

        # Update permissions
        if any(v is not None for v in [request.is_admin, request.can_add_containers, request.can_edit_server_accent]):
            update_user(user_id, request.is_admin, request.can_add_containers, request.can_edit_server_accent)

        return {"success": True, "message": "User updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update user: {str(e)}")


@app.delete("/api/users/{user_id}")
async def delete_user_endpoint(user_id: int, _: dict = Depends(require_admin)):
    """Delete a user (admin only)"""
    from database import delete_user

    try:
        success = delete_user(user_id)
        if success:
            return {"success": True, "message": "User deleted successfully"}
        raise HTTPException(status_code=404, detail="User not found or cannot be deleted (root user)")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete user: {str(e)}")


@app.get("/api/users/{user_id}/containers")
async def get_user_containers(user_id: int, _: dict = Depends(require_admin)):
    """Get user's container permissions (admin only)"""
    from database import get_user_container_permissions, get_user

    if not get_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")

    container_ids = get_user_container_permissions(user_id)
    return {"container_ids": container_ids}


@app.put("/api/users/{user_id}/containers")
async def set_user_containers(user_id: int, request: SetUserContainersRequest, _: dict = Depends(require_admin)):
    """Set user's container permissions (admin only)"""
    from database import set_user_container_permissions, get_user

    if not get_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")

    try:
        set_user_container_permissions(user_id, request.container_ids)
        return {"success": True, "message": "Container permissions updated successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update permissions: {str(e)}")


# Anki client factory
def get_anki_client(settings: Settings = Depends(get_settings)) -> AnkiConnectClient:
    # Check if there's an active account with a specific port
    active_account = get_active_account()
    if active_account:
        url = f"http://localhost:{active_account['container_port']}"
    else:
        # Fallback to default URL from settings
        url = settings.ankiconnect_url
    return AnkiConnectClient(url)


# Deck endpoints
@app.get("/api/decks")
async def get_decks(client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)):
    try:
        decks = await client.get_deck_names_and_ids()
        stats = await client.get_deck_stats(list(decks.keys()))
        return {"decks": decks, "stats": stats}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/decks/{deck_name}/due")
async def get_due_cards(
    deck_name: str, client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)
):
    try:
        card_ids = await client.get_due_cards(deck_name)
        if not card_ids:
            return {"cards": []}
        cards = await client.get_cards_info(card_ids[:50])  # Limit to 50
        return {"cards": cards}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/decks/{deck_name}/next")
async def get_next_card(
    deck_name: str, client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)
):
    """Get the next card due for review in this deck."""
    try:
        card_id = await client.get_next_due_card(deck_name)
        if not card_id:
            return {"card": None, "remaining": 0}

        cards = await client.get_cards_info([card_id])
        if not cards:
            return {"card": None, "remaining": 0}

        # Get total remaining cards
        all_due = await client.get_due_cards(deck_name)
        remaining = len(all_due)

        return {"card": cards[0], "remaining": remaining}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Card endpoints
class AnswerCardRequest(BaseModel):
    card_id: int
    ease: int  # 1=Again, 2=Hard, 3=Good, 4=Easy


@app.post("/api/cards/answer")
async def answer_card(
    request: AnswerCardRequest, client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)
):
    try:
        result = await client.answer_card(request.card_id, request.ease)
        return {"success": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/cards/undo")
async def undo_card(
    client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)
):
    try:
        result = await client.gui_undo()
        return {"success": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/cards/{card_id}")
async def get_card(
    card_id: int, client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)
):
    try:
        cards = await client.get_cards_info([card_id])
        if not cards:
            raise HTTPException(status_code=404, detail="Card not found")
        return cards[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/media/{filename}")
async def get_media_file(
    filename: str, client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)
):
    """Get a media file (audio, image) from Anki as base64."""
    try:
        import base64
        data = await client.retrieve_media_file(filename)
        if not data:
            raise HTTPException(status_code=404, detail="Media file not found")
        return {"filename": filename, "data": data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Search endpoint
class SearchRequest(BaseModel):
    query: str
    limit: int = 50


@app.post("/api/search")
async def search_cards(
    request: SearchRequest, client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)
):
    try:
        note_ids = await client.find_notes(request.query)
        if not note_ids:
            return {"notes": []}
        notes = await client.get_notes_info(note_ids[: request.limit])
        return {"notes": notes, "total": len(note_ids)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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


class LookupRequest(BaseModel):
    word: str
    language: str = "auto"
    provider: Optional[str] = None
    model: Optional[str] = None
    lookup_fields: Optional[list[str]] = None
    force_ai: bool = False


@app.post("/api/story/generate")
async def generate_story_endpoint(
    request: StoryRequest, _: str = Depends(require_auth)
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

        generator = StoryGenerator(api_keys)
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
        )

        story_name = request.name or result.get("title") or f"Story with {len(request.words)} words"
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
        )

        return {
            "story": result["story"],
            "story_id": story_id,
            "provider_used": result.get("provider_used"),
            "model_used": result.get("model_used"),
        }
    except NoValidKeysError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/lookup")
async def lookup_word_endpoint(
    request: LookupRequest, _: str = Depends(require_auth)
):
    """AI-powered word lookup for words not in vocabulary list."""
    api_keys = get_api_keys()
    if not any(api_keys.values()):
        raise HTTPException(status_code=500, detail="No AI provider API keys configured")

    try:
        generator = StoryGenerator(api_keys)
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


@app.get("/api/jisho/{word}")
async def jisho_lookup(word: str, _: str = Depends(require_auth)):
    """Proxy to Jisho API for dictionary lookup."""
    import httpx
    from urllib.parse import quote

    try:
        encoded_word = quote(word)
        url = f"https://jisho.org/api/v1/search/words?keyword={encoded_word}"

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url)
            response.raise_for_status()
            return response.json()
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


@app.get("/api/settings/api-keys")
async def get_api_keys_endpoint(_: str = Depends(require_auth)):
    """Get all API keys (masked for security)."""
    from database import get_active_account

    keys = get_api_keys()
    settings = get_settings()

    # Check which keys are from env vs manual config
    account = get_active_account()
    is_env_key = {}

    if account:
        api_keys_file = get_account_api_keys_file(account["container_name"])
        has_manual_config = os.path.exists(api_keys_file)

        if has_manual_config:
            try:
                with open(api_keys_file, "r") as f:
                    stored = json.load(f)
                    # If provider has manual config with a non-empty api_key, it's not from env
                    for provider in keys.keys():
                        stored_value = stored.get(provider)
                        has_manual_key = False
                        if isinstance(stored_value, dict):
                            has_manual_key = bool(stored_value.get("api_key") or stored_value.get("key"))
                        elif stored_value:
                            has_manual_key = True
                        is_env_key[provider] = not has_manual_key
            except (json.JSONDecodeError, IOError):
                # If file can't be read, assume all configured keys are from env
                is_env_key = {k: bool(v) for k, v in keys.items()}
        else:
            # No manual config file, all keys are from env
            is_env_key = {k: bool(v) for k, v in keys.items()}
    else:
        # No active account, all keys are from env
        is_env_key = {k: bool(v) for k, v in keys.items()}

    # Mask keys for display (show only first 8 and last 4 chars)
    masked = {}
    masked_admin = {}
    for provider, key in keys.items():
        if key and len(key) > 12:
            masked[provider] = key[:8] + "..." + key[-4:]
        elif key:
            masked[provider] = "***configured***"
        else:
            masked[provider] = ""

        # Get admin key info for this provider
        key_info = get_api_key_info(provider)
        admin_key = key_info.get("admin_key", "")
        if admin_key and len(admin_key) > 12:
            masked_admin[provider] = admin_key[:8] + "..." + admin_key[-4:]
        elif admin_key:
            masked_admin[provider] = "***configured***"
        else:
            masked_admin[provider] = ""

    return {
        "keys": masked,
        "admin_keys": masked_admin,
        "configured": {k: bool(v) for k, v in keys.items()},
        "has_admin_key": {k: bool(v) for k, v in masked_admin.items()},
        "is_env_key": is_env_key
    }


@app.post("/api/settings/api-keys")
async def set_api_key_endpoint(request: ApiKeyRequest, _: str = Depends(require_auth)):
    """Set API key(s) for a provider."""
    if request.provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {request.provider}")

    if not request.api_key and not request.admin_key:
        raise HTTPException(status_code=400, detail="At least one key (api_key or admin_key) must be provided")

    save_api_key(request.provider, api_key=request.api_key, admin_key=request.admin_key)
    return {"success": True, "message": f"API key(s) saved for {request.provider}"}


@app.delete("/api/settings/api-keys/{provider}")
async def delete_api_key_endpoint(provider: str, _: str = Depends(require_auth)):
    """Delete an API key for a provider."""
    from database import get_active_account

    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")

    # Check if this is an env-configured key
    account = get_active_account()
    if account:
        api_keys_file = get_account_api_keys_file(account["container_name"])
        if os.path.exists(api_keys_file):
            try:
                with open(api_keys_file, "r") as f:
                    stored = json.load(f)
                    stored_value = stored.get(provider)
                    has_manual_key = False
                    if isinstance(stored_value, dict):
                        has_manual_key = bool(stored_value.get("api_key") or stored_value.get("key"))
                    elif stored_value:
                        has_manual_key = True

                    if not has_manual_key:
                        # This is an env key, can't delete
                        raise HTTPException(
                            status_code=400,
                            detail=f"Cannot delete environment-configured key. Remove it from .env file instead."
                        )
            except json.JSONDecodeError:
                pass

    delete_api_key(provider)
    return {"success": True, "message": f"API key deleted for {provider}"}


@app.get("/api/settings/api-keys/{provider}/full")
async def get_full_api_key_endpoint(provider: str, _: str = Depends(require_auth)):
    """Get the full unmasked API keys for a provider."""
    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")

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
async def get_provider_usage_endpoint(provider: str, _: str = Depends(require_auth)):
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
            if provider == "openai":
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
                return {"models": models, "default_model": models[0]["id"] if models else "claude-3-5-sonnet-20241022"}

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

    except httpx.HTTPError as e:
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


# Sync endpoint
@app.post("/api/sync")
async def sync_anki(client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)):
    try:
        await client.sync()
        return {"success": True, "message": "Sync completed"}
    except Exception as e:
        error_msg = str(e)
        if "auth not configured" in error_msg:
            raise HTTPException(
                status_code=503,
                detail="AnkiWeb sync not configured. Please configure AnkiWeb login first."
            )
        # Detect AnkiConnect's "Sync status N not one of [0, 1]" errors.
        # Status 2=FULL_SYNC (choose), 3=FULL_DOWNLOAD (server wins), 4=FULL_UPLOAD (local wins)
        import re
        m = re.search(r"Sync status (\d+) not one of", error_msg)
        if m:
            status = int(m.group(1))
            recommended = {2: "choose", 3: "download", 4: "upload"}.get(status, "choose")
            raise HTTPException(
                status_code=409,
                detail=f"Full sync required:{recommended}"
            )
        raise HTTPException(status_code=500, detail=error_msg)


@app.post("/api/sync/full-upload")
async def full_upload_anki(client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)):
    """Force upload entire local collection to AnkiWeb, overwriting remote data."""
    try:
        await client.full_upload()
        return {"success": True, "message": "Full upload completed - AnkiWeb overwritten with local data"}
    except Exception as e:
        error_msg = str(e)
        if "auth not configured" in error_msg:
            raise HTTPException(
                status_code=503,
                detail="AnkiWeb sync not configured. Please configure AnkiWeb login first."
            )
        raise HTTPException(status_code=500, detail=error_msg)


@app.post("/api/sync/full-download")
async def full_download_anki(client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)):
    """Force download entire collection from AnkiWeb, overwriting local data."""
    try:
        await client.full_download()
        return {"success": True, "message": "Full download completed - local data overwritten with AnkiWeb"}
    except Exception as e:
        error_msg = str(e)
        if "auth not configured" in error_msg:
            raise HTTPException(
                status_code=503,
                detail="AnkiWeb sync not configured. Please configure AnkiWeb login first."
            )
        raise HTTPException(status_code=500, detail=error_msg)


# ── Update endpoints ──────────────────────────────────────────────────────────

VERSION_FILE = os.path.join(os.path.dirname(__file__), ".version")
GITHUB_REPO = "Macro002/AnkiBase"


def _read_local_version() -> str:
    try:
        return open(VERSION_FILE).read().strip()
    except Exception:
        return "unknown"


@app.get("/api/update/check")
async def update_check(_: dict = Depends(require_admin)):
    import asyncio
    local = _read_local_version()
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "ls-remote", f"https://github.com/{GITHUB_REPO}.git", "HEAD",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        line = stdout.decode().strip()
        latest = line.split()[0] if line else "unknown"
    except Exception:
        latest = "unknown"

    has_update = latest != "unknown" and latest != local
    return {"current": local, "latest": latest, "has_update": has_update}


@app.get("/api/update/apply")
async def update_apply(request: Request, _: dict = Depends(require_admin)):
    import asyncio, tempfile, shutil

    async def generate():
        def event(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        tmp = tempfile.mkdtemp(prefix="ankibase_update_")
        try:
            yield event({"type": "step", "message": "Fetching latest code from GitHub...", "progress": 5})
            proc = await asyncio.create_subprocess_exec(
                "git", "clone", "--depth", "1",
                f"https://github.com/{GITHUB_REPO}.git", tmp,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            async for line in proc.stdout:
                msg = line.decode().strip()
                if msg:
                    yield event({"type": "log", "message": msg, "progress": 15})
            await proc.wait()
            if proc.returncode != 0:
                yield event({"type": "error", "message": "Failed to clone repository"})
                return

            yield event({"type": "step", "message": "Building frontend...", "progress": 25})
            fe_dir = os.path.join(tmp, "frontend")
            proc = await asyncio.create_subprocess_exec(
                "npm", "install",
                cwd=fe_dir,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            await proc.wait()
            proc = await asyncio.create_subprocess_exec(
                "npm", "run", "build",
                cwd=fe_dir,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            async for line in proc.stdout:
                msg = line.decode().strip()
                if msg:
                    yield event({"type": "log", "message": msg, "progress": 55})
            await proc.wait()
            if proc.returncode != 0:
                yield event({"type": "error", "message": "Frontend build failed"})
                return

            yield event({"type": "step", "message": "Installing files...", "progress": 65})
            install_dir = os.path.dirname(__file__)
            static_dir = os.path.join(install_dir, "static")

            proc = await asyncio.create_subprocess_exec(
                "rsync", "-a",
                "--exclude=__pycache__", "--exclude=*.pyc",
                "--exclude=venv", "--exclude=.env", "--exclude=*.db",
                "--exclude=.credentials", "--exclude=.api_keys.json",
                os.path.join(tmp, "backend") + "/", install_dir + "/",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            await proc.wait()

            proc = await asyncio.create_subprocess_exec(
                "rsync", "-a",
                os.path.join(tmp, "frontend", "dist") + "/", static_dir + "/",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            await proc.wait()

            yield event({"type": "step", "message": "Installing Python dependencies...", "progress": 75})
            venv_pip = os.path.join(install_dir, "venv", "bin", "pip")
            proc = await asyncio.create_subprocess_exec(
                venv_pip, "install", "-q", "-r", os.path.join(install_dir, "requirements.txt"),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            await proc.wait()

            # Write new version hash
            new_sha_path = os.path.join(tmp, ".git", "refs", "heads", "main")
            try:
                import subprocess as _sp
                sha = _sp.check_output(["git", "-C", tmp, "rev-parse", "HEAD"]).decode().strip()
                with open(VERSION_FILE, "w") as f:
                    f.write(sha)
            except Exception:
                pass

            yield event({"type": "step", "message": "Restarting service...", "progress": 90})
            # Detach restart so the response finishes first
            await asyncio.create_subprocess_exec(
                "bash", "-c", "sleep 3 && systemctl restart ankibase",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )

            yield event({"type": "done", "message": "Update applied! Reloading...", "progress": 100})

        except Exception as e:
            yield event({"type": "error", "message": str(e)})
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Account management endpoints
container_manager = AnkiContainerManager()

@app.get("/api/accounts")
async def list_accounts(user: dict = Depends(require_auth)):
    """List Anki accounts accessible to the current user"""
    from database import get_user_accessible_containers, set_active_account
    try:
        # Get containers accessible to this user (admins see all, users see only their assigned ones)
        accounts = get_user_accessible_containers(user['user_id'])

        if not accounts:
            # User has no accessible containers
            return {
                "accounts": [],
                "active_account_id": None
            }

        active_account = container_manager.get_active_account()

        # Check if user has access to the current active account
        active_id = None
        if active_account:
            has_access = any(acc['id'] == active_account['id'] for acc in accounts)
            if has_access:
                active_id = active_account['id']
            else:
                # User doesn't have access to current active account
                # Auto-switch to first accessible container
                first_accessible = accounts[0]
                set_active_account(first_accessible['id'])
                active_id = first_accessible['id']
        else:
            # No active account set, switch to first accessible container
            first_accessible = accounts[0]
            set_active_account(first_accessible['id'])
            active_id = first_accessible['id']

        return {
            "accounts": accounts,
            "active_account_id": active_id
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/accounts")
async def create_account(request: CreateAccountRequest, user: dict = Depends(require_can_add_containers)):
    """Create a new Anki account with its own container (requires can_add_containers permission)"""
    try:
        account = container_manager.create_account(request.container_name)
        return {
            "success": True,
            "account": account,
            "message": f"Account created successfully. Container: {account['container_name']}"
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/accounts/switch")
async def switch_account(request: SwitchAccountRequest, _: str = Depends(require_auth)):
    """Switch to a different account"""
    try:
        success = container_manager.switch_account(request.account_id)
        if not success:
            raise HTTPException(status_code=404, detail="Account not found")
        return {"success": True, "message": "Account switched successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/accounts/{account_id}")
async def delete_account_endpoint(account_id: int, remove_data: bool = False, _: str = Depends(require_auth)):
    """Delete an account and optionally its data"""
    try:
        success = container_manager.delete_account(account_id, remove_data)
        if not success:
            raise HTTPException(status_code=404, detail="Account not found")
        return {"success": True, "message": "Account deleted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/accounts/{account_id}/restart")
async def restart_account_endpoint(account_id: int, _: str = Depends(require_auth)):
    """Restart a container"""
    try:
        success = container_manager.restart_container(account_id)
        if not success:
            raise HTTPException(status_code=404, detail="Account not found")
        return {"success": True, "message": "Container restarted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# AnkiWeb login endpoints
@app.post("/api/ankiweb/login")
async def ankiweb_login(request: AnkiWebLoginRequest, _: str = Depends(require_auth)):
    """Save AnkiWeb credentials and configure Anki"""
    try:
        import asyncio

        # Initialize credentials manager and configurator
        active_account = get_active_account()
        creds = AnkiWebCredentials(container_name=active_account["container_name"] if active_account else None)
        configurator = AnkiConfigurator()

        # Save encrypted credentials first
        creds.save_credentials(request.email, request.password)
        print(f"✓ Saved encrypted credentials for {request.email}")

        # Try to configure Anki with the credentials (without restart)
        print(f"→ Attempting to authenticate with AnkiWeb...")
        success, error_msg = configurator.configure_ankiweb_login(request.email, request.password, restart=False)

        if not success:
            # Authentication failed - credentials are saved but won't work
            print(f"✗ AnkiWeb authentication failed")
            raise HTTPException(
                status_code=500,
                detail=error_msg or "Failed to authenticate with AnkiWeb. Please check your email and password are correct."
            )

        print(f"✓ AnkiWeb authentication successful")

        # Save email to database for the active account
        active_account = get_active_account()
        if active_account:
            set_ankiweb_email(active_account["id"], request.email)
            print(f"✓ Saved AnkiWeb email to database for account {active_account['id']}")

        # Restart container in the background (non-blocking)
        async def restart_in_background():
            await asyncio.sleep(0.1)  # Small delay to let response return first
            print(f"🔄 Restarting Anki container in background...")
            configurator.restart_anki_container()

        asyncio.create_task(restart_in_background())

        return {
            "success": True,
            "message": "AnkiWeb credentials configured successfully. Container restarting in background..."
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error: {str(e)}")


@app.get("/api/ankiweb/status")
async def ankiweb_status(_: str = Depends(require_auth)):
    """Check if AnkiWeb credentials are configured"""
    try:
        active_account = get_active_account()
        creds = AnkiWebCredentials(container_name=active_account["container_name"] if active_account else None)
        configurator = AnkiConfigurator()

        has_credentials = creds.has_credentials()
        anki_status = configurator.check_ankiweb_status()
        is_configured = anki_status.get("configured", False)

        return {
            "has_credentials": has_credentials or is_configured,
            "configured": is_configured,
            "email": anki_status.get("email") if is_configured else None
        }

    except Exception as e:
        return {
            "has_credentials": False,
            "configured": False,
            "error": str(e)
        }


@app.get("/api/ankiweb/debug")
async def ankiweb_debug(_: str = Depends(require_auth)):
    """Debug endpoint to check Anki container and database"""
    try:
        import subprocess

        # Check if container is running
        container_check = subprocess.run(
            ["docker", "ps", "--filter", "name=headless-anki", "--format", "{{.Names}}"],
            capture_output=True,
            text=True
        )

        container_running = "headless-anki" in container_check.stdout

        # Check if sqlite3 is available in container
        sqlite_check = subprocess.run(
            ["docker", "exec", "headless-anki", "which", "sqlite3"],
            capture_output=True,
            text=True
        )

        # Check if database file exists
        db_check = subprocess.run(
            ["docker", "exec", "headless-anki", "ls", "-la", "/data/"],
            capture_output=True,
            text=True
        )

        return {
            "container_running": container_running,
            "container_output": container_check.stdout.strip(),
            "sqlite3_available": sqlite_check.returncode == 0,
            "sqlite3_path": sqlite_check.stdout.strip() if sqlite_check.returncode == 0 else None,
            "data_directory": db_check.stdout if db_check.returncode == 0 else "Cannot access /data"
        }
    except Exception as e:
        return {"error": str(e)}


@app.delete("/api/ankiweb/credentials")
async def delete_ankiweb_credentials(_: str = Depends(require_auth)):
    """Delete stored AnkiWeb credentials"""
    try:
        active_account = get_active_account()
        creds = AnkiWebCredentials(container_name=active_account["container_name"] if active_account else None)
        configurator = AnkiConfigurator()

        # Delete encrypted credentials file
        creds.delete_credentials()

        # Delete credentials from Anki profile
        configurator.delete_ankiweb_credentials()

        # Clear email from database for the active account
        active_account = get_active_account()
        if active_account:
            set_ankiweb_email(active_account["id"], None)
            print(f"✓ Cleared AnkiWeb email from database for account {active_account['id']}")

        # Restart container to reload profile
        configurator.restart_anki_container()

        return {
            "success": True,
            "message": "AnkiWeb credentials deleted"
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
    import time
    from invisible_playwright import InvisiblePlaywright
    from invisible_playwright import download as ip_download
    from xvfbwrapper import Xvfb
    ip_download.ensure_binary()

    with Xvfb():
        with InvisiblePlaywright(headless=False) as browser:
            page = browser.new_page()
            page.goto(url, timeout=45000)
            time.sleep(5)

            title = page.evaluate('''() => {
                const h1 = document.querySelector("h1");
                return h1 ? h1.textContent.trim() : document.title.replace(" | Quizlet", "").trim();
            }''')

            texts = page.evaluate('''() =>
                Array.from(document.querySelectorAll(".TermText")).map(e => e.textContent.trim())
            ''')

            images = page.evaluate('''() => {
                const terms = Array.from(document.querySelectorAll(".TermText"));
                const out = [];
                for (let i = 0; i < terms.length; i += 2) {
                    let found = null;
                    let node = terms[i].parentElement;
                    for (let lvl = 0; lvl < 5 && node; lvl++) {
                        const img = node.querySelector("img");
                        if (img && img.src && !img.src.startsWith("data:")) {
                            found = img.src;
                            break;
                        }
                        node = node.parentElement;
                    }
                    out.push(found);
                }
                return out;
            }''')

    if not texts:
        raise Exception("No flashcard terms found. The deck may be private or the URL is invalid.")

    def _unwrap_cdn_image(url):
        # Quizlet serves images through Cloudflare Image Resizing with baked-in h/w/fit params.
        # Strip the cdn-cgi wrapper to get the original full-resolution URL.
        if not url:
            return url
        import re
        m = re.search(r'cdn-cgi/image/[^/]+/(https?://.+)$', url)
        return m.group(1) if m else url

    cards = [
        {"front": texts[i], "back": texts[i + 1], "image": _unwrap_cdn_image(images[i // 2] if images and i // 2 < len(images) else None)}
        for i in range(0, len(texts) - 1, 2)
    ]
    return {"title": title or "Quizlet Import", "cards": cards}


@app.post("/api/quizlet/scrape")
async def quizlet_scrape(request: QuizletScrapeRequest, _: str = Depends(require_auth)):
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


@app.post("/api/quizlet/decks")
async def quizlet_save_deck(request: QuizletSaveRequest, _: str = Depends(require_auth)):
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


# Models endpoint
@app.get("/api/models")
async def get_models(client: AnkiConnectClient = Depends(get_anki_client), _: str = Depends(require_auth)):
    try:
        models = await client.get_model_names()
        return {"models": models}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Import deck endpoint
@app.post("/api/import")
async def import_deck(
    file: UploadFile = File(...),
    client: AnkiConnectClient = Depends(get_anki_client),
    _: str = Depends(require_auth),
):
    if not file.filename or not file.filename.endswith(".apkg"):
        raise HTTPException(status_code=400, detail="Only .apkg files are supported")

    temp_path = None
    try:
        # Get active account to determine export directory
        active_account = get_active_account()
        if not active_account:
            raise HTTPException(status_code=400, detail="No active account")

        # Each container has its own /export mount at /opt/ankibase/containers/{container_name}/export
        export_dir = f"/opt/ankibase/containers/{active_account['container_name']}/export"
        os.makedirs(export_dir, exist_ok=True)

        temp_path = os.path.join(export_dir, file.filename)
        with open(temp_path, "wb") as f:
            shutil.copyfileobj(file.file, f)

        # The path inside the container is /export/filename
        container_path = f"/export/{file.filename}"

        await client.import_package(container_path)

        # Clean up the temp file
        os.remove(temp_path)

        return {"success": True, "message": f"Successfully imported {file.filename}"}
    except HTTPException:
        raise
    except Exception as e:
        # Clean up on error
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        raise HTTPException(status_code=500, detail=str(e))


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
@app.get("/api/stats/html")
async def get_stats_html(
    client: AnkiConnectClient = Depends(get_anki_client),
    _: str = Depends(require_auth),
):
    try:
        html = await client.get_collection_stats_html()
        return {"html": html}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
        # Serve index.html for SPA routing
        file_path = os.path.join(static_path, full_path)
        if os.path.exists(file_path) and os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(static_path, "index.html"))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
