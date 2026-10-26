"""
Anki accounts: each one is an anki-cli profile (its own collection, media and AnkiWeb login)
served by the shared engine in anki_server.
"""
from __future__ import annotations

import os
import re
from typing import Optional

import anki_server
from anki_migration import MIGRATED_PREFIX
from database import DATA_DIR as ACCOUNT_DATA_DIR
from database import (
    add_account,
    delete_account,
    get_account,
    get_active_account,
    get_all_accounts,
    get_next_available_port,
    rename_account,
    set_active_account,
)

INVALID_NAME = re.compile(r'[\\/:*?"<>|\0]|^\.')


class AnkiAccountManager:
    def create_account(self, name: str) -> dict:
        name = name.strip()
        if not name or INVALID_NAME.search(name) or len(name) > 64:
            raise ValueError("Invalid account name")
        if any(account["container_name"] == name for account in get_all_accounts()):
            raise ValueError(f"An account named '{name}' already exists")
        try:
            anki_server.call("profiles.create", name=name)
        except anki_server.EngineError as error:
            if error.code != "conflict":  # a profile left from a deleted account is reused
                raise
        first = not get_all_accounts()
        # container_port and volume_name are legacy columns (unique, not null).
        account_id = add_account(f"{name.replace(' ', '-').lower()}@ankibase.local", name,
                                 get_next_available_port(), MIGRATED_PREFIX + name)
        if first:
            set_active_account(account_id)
        return get_account(account_id)

    def delete_account(self, account_id: int, remove_data: bool = False) -> bool:
        account = get_account(account_id)
        if not account:
            return False
        if remove_data:
            try:
                anki_server.call("profiles.delete", name=account["container_name"], confirm=True)
            except anki_server.EngineError as error:
                if error.code != "notFound":
                    raise
        delete_account(account_id)
        if account["is_active"]:
            remaining = get_all_accounts()
            if remaining:
                set_active_account(remaining[0]["id"])
        return True

    def rename_account(self, account_id: int, name: str) -> dict:
        """Rename an account: its Anki profile and its AnkiBase data (stories, API keys)."""
        account = get_account(account_id)
        if not account:
            raise LookupError("Account not found")
        name = name.strip()
        old = account["container_name"]
        if name == old:
            return account
        if not name or INVALID_NAME.search(name) or len(name) > 64:
            raise ValueError("Invalid account name")
        if any(other["container_name"] == name for other in get_all_accounts()):
            raise ValueError(f"An account named '{name}' already exists")
        anki_server.call("profiles.rename", name=old, newName=name)
        old_dir, new_dir = os.path.join(ACCOUNT_DATA_DIR, old), os.path.join(ACCOUNT_DATA_DIR, name)
        if os.path.isdir(old_dir) and not os.path.exists(new_dir):
            os.rename(old_dir, new_dir)
        rename_account(account_id, name)
        return get_account(account_id)

    def switch_account(self, account_id: int) -> bool:
        if not get_account(account_id):
            return False
        set_active_account(account_id)
        return True

    def restart_container(self, account_id: int) -> bool:
        """Reload the account's collection from disk (the old "restart container")."""
        account = get_account(account_id)
        if not account:
            return False
        try:
            anki_server.call("collection.refresh", profile=account["container_name"])
        except anki_server.EngineError:
            return anki_server.restart()
        return True

    def get_active_account(self) -> Optional[dict]:
        return get_active_account()

    def list_accounts(self) -> list[dict]:
        return get_all_accounts()
