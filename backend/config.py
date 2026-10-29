from pydantic_settings import BaseSettings
from functools import lru_cache
import json
import os

BASE_DIR = os.path.dirname(__file__)
DATA_DIR = os.path.join(BASE_DIR, "data")
PROVIDER_ENV = ("gemini", "openai", "anthropic", "openrouter", "groq", "mistral")


def get_account_api_keys_file(container_name: str) -> str:
    """API keys file of a profile (encrypted values, see security.encrypt)."""
    account_dir = os.path.join(DATA_DIR, container_name)
    os.makedirs(account_dir, exist_ok=True)
    return os.path.join(account_dir, ".api_keys.json")


class Settings(BaseSettings):
    gemini_api_key: str = ""
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    openrouter_api_key: str = ""
    groq_api_key: str = ""
    mistral_api_key: str = ""
    # A local or other OpenAI-compatible server (Ollama, Open WebUI, LM Studio…).
    custom_ai_base_url: str = ""
    custom_ai_api_key: str = ""
    # Only for upgrading from the single-password versions (see database.migrate_to_user_system).
    app_password: str = ""
    cors_origins: str = "http://localhost:5173"
    app_port: int = 8000
    # How the in-app updater finds new versions: "release" (tagged releases) or "main".
    update_channel: str = "release"

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()


def _stored_keys() -> tuple[str | None, dict]:
    """The active profile's keys file and its contents, as {provider: {api_key, admin_key, base_url}}."""
    from database import get_active_account
    from security import decrypt
    account = get_active_account()
    if not account:
        return None, {}
    path = get_account_api_keys_file(account["container_name"])
    try:
        with open(path) as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return path, {}
    stored = {}
    for provider, value in raw.items():
        # Formats over time: "key", {"key", "is_admin"}, {"api_key", "admin_key"}; "custom" also has "base_url".
        if isinstance(value, dict):
            api_key, admin_key = value.get("api_key") or value.get("key", ""), value.get("admin_key", "")
        else:
            api_key, admin_key = value or "", ""
        stored[provider] = {"api_key": decrypt(api_key), "admin_key": decrypt(admin_key),
                            "base_url": decrypt(value.get("base_url", "") if isinstance(value, dict) else "")}
    return path, stored


def _write_keys(path: str, stored: dict) -> None:
    from security import encrypt
    data = {provider: {k: encrypt(v) for k, v in keys.items() if v} for provider, keys in stored.items()}
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(path + ".tmp", path)


def get_api_keys() -> dict[str, str]:
    """Each provider's API key: the profile's own, else the server's from the environment.
    "custom" (an OpenAI-compatible server) maps to its URL instead, since its key is optional."""
    settings = get_settings()
    keys = {provider: getattr(settings, f"{provider}_api_key") for provider in PROVIDER_ENV}
    _, stored = _stored_keys()
    for provider, value in stored.items():
        if value["api_key"] and provider in PROVIDER_ENV:
            keys[provider] = value["api_key"]
    keys["custom"] = get_custom_endpoint()["base_url"]
    return keys


def get_custom_endpoint() -> dict[str, str]:
    """The OpenAI-compatible server's base_url and (optional) api_key: the profile's own, else the server's."""
    _, stored = _stored_keys()
    saved = stored.get("custom") or {}
    if saved.get("base_url"):
        return {"base_url": saved["base_url"], "api_key": saved["api_key"]}
    settings = get_settings()
    return {"base_url": settings.custom_ai_base_url.rstrip("/"), "api_key": settings.custom_ai_api_key}


def get_api_key_info(provider: str) -> dict:
    """A provider's stored api_key and admin_key (for usage statistics), and base_url for "custom"."""
    _, stored = _stored_keys()
    return stored.get(provider, {"api_key": "", "admin_key": "", "base_url": ""})


def save_api_key(provider: str, api_key: str = "", admin_key: str = "", base_url: str = "") -> None:
    """Save a provider's key(s); empty values keep what's stored. A new base_url replaces the
    custom server's key too, since that key belongs to the old server."""
    path, stored = _stored_keys()
    if not path:
        raise ValueError("No profile yet")
    current = stored.get(provider, {"api_key": "", "admin_key": "", "base_url": ""})
    if base_url:
        if base_url != current.get("base_url"):
            current["api_key"] = ""
        current["base_url"] = base_url
    if api_key:
        current["api_key"] = api_key
    if admin_key:
        current["admin_key"] = admin_key
    stored[provider] = current
    _write_keys(path, stored)


def delete_api_key(provider: str) -> None:
    path, stored = _stored_keys()
    if path and stored.pop(provider, None) is not None:
        _write_keys(path, stored)


def encrypt_stored_keys() -> None:
    """Startup: encrypt keys files written before keys were encrypted."""
    from security import encrypt
    if not os.path.isdir(DATA_DIR):
        return
    for name in os.listdir(DATA_DIR):
        path = os.path.join(DATA_DIR, name, ".api_keys.json")
        try:
            with open(path) as f:
                raw = json.load(f)
        except (OSError, ValueError):
            continue
        text = json.dumps(raw)
        if '"enc:' in text or not raw:
            continue
        converted = {}
        for provider, value in raw.items():
            if isinstance(value, dict):
                pair = {"api_key": value.get("api_key") or value.get("key", ""), "admin_key": value.get("admin_key", "")}
            else:
                pair = {"api_key": value or "", "admin_key": ""}
            converted[provider] = {k: encrypt(v) for k, v in pair.items() if v}
        fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(converted, f, indent=2)
        os.replace(path + ".tmp", path)
