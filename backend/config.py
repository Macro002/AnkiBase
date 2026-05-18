from pydantic_settings import BaseSettings
from pydantic import Field
from functools import lru_cache
import json
import os

BASE_DIR = os.path.dirname(__file__)
DATA_DIR = os.path.join(BASE_DIR, "data")

def get_account_api_keys_file(container_name: str) -> str:
    """Get API keys file path for an account."""
    account_dir = os.path.join(DATA_DIR, container_name)
    os.makedirs(account_dir, exist_ok=True)
    return os.path.join(account_dir, ".api_keys.json")


class Settings(BaseSettings):
    ankiconnect_url: str = "http://localhost:8765"
    gemini_api_key: str = ""
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    openrouter_api_key: str = ""
    groq_api_key: str = ""
    mistral_api_key: str = ""
    app_secret_key: str = "change-me-in-production"
    app_password: str = "admin"
    cors_origins: str = "http://localhost:5173"
    app_port: int = 8000
    ankiweb_encryption_key: str = ""

    class Config:
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    return Settings()


def get_api_keys() -> dict[str, str]:
    """Get all API keys, merging env vars with stored keys (stored keys take precedence).
    Returns just the api_key strings (not admin keys)."""
    from database import get_active_account  # Import here to avoid circular dependency

    settings = get_settings()

    # Start with env vars
    keys = {
        "gemini": settings.gemini_api_key,
        "openai": settings.openai_api_key,
        "anthropic": settings.anthropic_api_key,
        "openrouter": settings.openrouter_api_key,
        "groq": settings.groq_api_key,
        "mistral": settings.mistral_api_key,
    }

    # Get active account and use its API keys file
    account = get_active_account()
    if account:
        api_keys_file = get_account_api_keys_file(account["container_name"])
        if os.path.exists(api_keys_file):
            try:
                with open(api_keys_file, "r") as f:
                    stored = json.load(f)
                    for provider, value in stored.items():
                        # Support multiple formats:
                        # - Old: string (just the key)
                        # - Old with flag: {"key": "...", "is_admin": bool}
                        # - New: {"api_key": "...", "admin_key": "..."}
                        if isinstance(value, dict):
                            key_str = value.get("api_key") or value.get("key", "")
                        else:
                            key_str = value

                        if key_str:  # Only override if stored key is not empty
                            keys[provider] = key_str
            except (json.JSONDecodeError, IOError):
                pass

    return keys


def get_api_key_info(provider: str) -> dict:
    """Get full API key info including both api_key and admin_key."""
    from database import get_active_account  # Import here to avoid circular dependency

    account = get_active_account()
    if not account:
        return {"api_key": "", "admin_key": ""}

    api_keys_file = get_account_api_keys_file(account["container_name"])
    if not os.path.exists(api_keys_file):
        return {"api_key": "", "admin_key": ""}

    try:
        with open(api_keys_file, "r") as f:
            stored = json.load(f)
            value = stored.get(provider)

            # Support multiple formats for backward compatibility
            if isinstance(value, dict):
                # New format: {"api_key": "...", "admin_key": "..."}
                if "api_key" in value or "admin_key" in value:
                    return {
                        "api_key": value.get("api_key", ""),
                        "admin_key": value.get("admin_key", "")
                    }
                # Old format with flag: {"key": "...", "is_admin": bool}
                else:
                    return {
                        "api_key": value.get("key", ""),
                        "admin_key": ""
                    }
            elif value:
                # Very old format: just a string
                return {"api_key": value, "admin_key": ""}
            else:
                return {"api_key": "", "admin_key": ""}
    except (json.JSONDecodeError, IOError):
        return {"api_key": "", "admin_key": ""}


def save_api_key(provider: str, api_key: str = "", admin_key: str = "") -> None:
    """Save API keys for a provider (regular and/or admin)."""
    from database import get_active_account  # Import here to avoid circular dependency

    account = get_active_account()
    if not account:
        raise ValueError("No active account found")

    api_keys_file = get_account_api_keys_file(account["container_name"])

    # Load existing keys
    stored = {}
    if os.path.exists(api_keys_file):
        try:
            with open(api_keys_file, "r") as f:
                stored = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass

    # Get existing value or create new
    current = stored.get(provider, {})
    if not isinstance(current, dict):
        current = {}

    # Update only provided keys, keep existing ones
    if api_key:
        current["api_key"] = api_key
    if admin_key:
        current["admin_key"] = admin_key

    # Remove old format keys if present
    current.pop("key", None)
    current.pop("is_admin", None)

    stored[provider] = current

    # Save
    with open(api_keys_file, "w") as f:
        json.dump(stored, f, indent=2)


def delete_api_key(provider: str) -> None:
    """Delete an API key for a provider."""
    from database import get_active_account  # Import here to avoid circular dependency

    account = get_active_account()
    if not account:
        return

    api_keys_file = get_account_api_keys_file(account["container_name"])
    if not os.path.exists(api_keys_file):
        return

    try:
        with open(api_keys_file, "r") as f:
            stored = json.load(f)

        if provider in stored:
            del stored[provider]

            with open(api_keys_file, "w") as f:
                json.dump(stored, f, indent=2)
    except (json.JSONDecodeError, IOError):
        pass


def change_password(new_password: str) -> None:
    """Change the app password by updating the .env file."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")

    # Read existing .env file
    env_vars = {}
    if os.path.exists(env_path):
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    env_vars[key.strip()] = value.strip()

    # Update password
    env_vars["APP_PASSWORD"] = new_password

    # Write back to .env file
    with open(env_path, "w") as f:
        for key, value in env_vars.items():
            f.write(f"{key}={value}\n")

    # Clear the settings cache to reload with new password
    get_settings.cache_clear()
