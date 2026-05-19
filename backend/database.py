import sqlite3
import json
import os
from datetime import datetime
from typing import Optional
from contextlib import contextmanager
import bcrypt

# Global database for account management, discovered keys, and scan status
BASE_DIR = os.path.dirname(__file__)
GLOBAL_DB_PATH = os.path.join(BASE_DIR, "ankibase.db")
DATA_DIR = os.path.join(BASE_DIR, "data")

def get_account_data_dir(container_name: str) -> str:
    """Get data directory for an account."""
    account_dir = os.path.join(DATA_DIR, container_name)
    os.makedirs(account_dir, exist_ok=True)
    return account_dir

def get_account_db_path(container_name: str) -> str:
    """Get database path for an account's stories."""
    data_dir = get_account_data_dir(container_name)
    return os.path.join(data_dir, "stories.db")


@contextmanager
def get_db(db_path: str = None):
    """Get database connection with context manager."""
    if db_path is None:
        db_path = GLOBAL_DB_PATH
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

@contextmanager
def get_account_db(container_name: str):
    """Get account-specific database connection."""
    db_path = get_account_db_path(container_name)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_global_db():
    """Initialize global database tables (accounts, discovered keys, scan status)."""
    with get_db(GLOBAL_DB_PATH) as conn:
        cursor = conn.cursor()

        # Anki accounts table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS anki_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                container_name TEXT UNIQUE NOT NULL,
                container_port INTEGER UNIQUE NOT NULL,
                volume_name TEXT UNIQUE NOT NULL,
                ankiweb_email TEXT,
                is_active INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Add ankiweb_email column to existing databases that predate it
        try:
            cursor.execute("ALTER TABLE anki_accounts ADD COLUMN ankiweb_email TEXT")
        except Exception:
            pass

        # Users table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                is_admin INTEGER DEFAULT 0,
                can_add_containers INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Add language column if it doesn't exist
        cursor.execute("PRAGMA table_info(users)")
        columns = [column[1] for column in cursor.fetchall()]
        if 'language' not in columns:
            cursor.execute("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'en'")

        # User container permissions table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_container_permissions (
                user_id INTEGER NOT NULL,
                container_id INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (container_id) REFERENCES anki_accounts(id) ON DELETE CASCADE,
                UNIQUE(user_id, container_id)
            )
        """)

        # Quizlet decks table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS quizlet_decks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                url TEXT,
                card_count INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)

        # Quizlet cards table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS quizlet_cards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                deck_id INTEGER NOT NULL REFERENCES quizlet_decks(id) ON DELETE CASCADE,
                front TEXT NOT NULL,
                back TEXT NOT NULL,
                image TEXT,
                position INTEGER DEFAULT 0
            )
        """)

        # Migration: add image column to existing quizlet_cards tables
        try:
            cursor.execute("ALTER TABLE quizlet_cards ADD COLUMN image TEXT")
        except Exception:
            pass

        # Quizlet reviews table (for heatmap)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS quizlet_reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id INTEGER NOT NULL,
                deck_id INTEGER NOT NULL,
                ease INTEGER NOT NULL,
                reviewed_at TEXT DEFAULT (datetime('now'))
            )
        """)

        conn.commit()

def init_account_db(container_name: str):
    """Initialize account-specific database tables (stories)."""
    db_path = get_account_db_path(container_name)
    with get_db(db_path) as conn:
        cursor = conn.cursor()

        # Stories table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS stories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                content TEXT NOT NULL,
                words TEXT NOT NULL,
                translations TEXT,
                word_categories TEXT,
                style TEXT,
                length TEXT,
                language TEXT,
                target_language TEXT,
                translation_language TEXT,
                provider TEXT,
                model TEXT,
                deck_name TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Add new columns if they don't exist (migration for existing DBs)
        try:
            cursor.execute("ALTER TABLE stories ADD COLUMN translations TEXT")
        except sqlite3.OperationalError:
            pass  # Column exists
        try:
            cursor.execute("ALTER TABLE stories ADD COLUMN word_categories TEXT")
        except sqlite3.OperationalError:
            pass
        try:
            cursor.execute("ALTER TABLE stories ADD COLUMN translation_language TEXT")
        except sqlite3.OperationalError:
            pass
        try:
            cursor.execute("ALTER TABLE stories ADD COLUMN word_data TEXT")
        except sqlite3.OperationalError:
            pass
        try:
            cursor.execute("ALTER TABLE stories ADD COLUMN lookup_fields TEXT")
        except sqlite3.OperationalError:
            pass
        try:
            cursor.execute("ALTER TABLE stories ADD COLUMN lookup_language TEXT")
        except sqlite3.OperationalError:
            pass

        conn.commit()

def migrate_to_per_account_data():
    """Migrate existing data to per-account structure."""
    import shutil
    from config import get_account_api_keys_file

    old_api_keys_path = os.path.join(BASE_DIR, ".api_keys.json")

    # First ensure global DB exists
    init_global_db()

    # Check if global DB has stories table (old structure)
    has_stories_in_global = False
    try:
        with get_db(GLOBAL_DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='stories'")
            has_stories_in_global = cursor.fetchone() is not None
    except:
        pass

    if not has_stories_in_global and not os.path.exists(old_api_keys_path):
        # Nothing to migrate
        return

    # Ensure we have an active account for migration
    active_account = get_active_account()
    if not active_account:
        all_accounts = get_all_accounts()
        if not all_accounts:
            # Create a default account
            print("Creating default account for migration...")
            account_id = add_account(
                email="default@local",
                container_name="default",
                container_port=8765,
                volume_name="anki-data"
            )
            set_active_account(account_id)
            active_account = get_account(account_id)
        else:
            # Use the first account as default
            set_active_account(all_accounts[0]["id"])
            active_account = all_accounts[0]

    container_name = active_account["container_name"]

    # Migrate stories from global DB to account-specific DB
    if has_stories_in_global:
        try:
            with get_db(GLOBAL_DB_PATH) as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT COUNT(*) FROM stories")
                count = cursor.fetchone()[0]

                if count > 0:
                    print(f"Migrating {count} stories to account '{container_name}'...")

                    # Ensure account database exists
                    init_account_db(container_name)
                    account_db_path = get_account_db_path(container_name)

                    # Copy all stories to account database
                    cursor.execute("SELECT * FROM stories")
                    stories = cursor.fetchall()

                    with get_db(account_db_path) as account_conn:
                        account_cursor = account_conn.cursor()
                        for story in stories:
                            try:
                                account_cursor.execute("""
                                    INSERT INTO stories (name, content, words, translations, word_categories,
                                                        style, length, language, target_language, translation_language,
                                                        provider, model, deck_name, word_data, lookup_fields,
                                                        lookup_language, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                """, (
                                    story["name"], story["content"], story["words"],
                                    story.get("translations"), story.get("word_categories"),
                                    story["style"], story["length"], story["language"],
                                    story.get("target_language"), story.get("translation_language"),
                                    story["provider"], story["model"], story.get("deck_name"),
                                    story.get("word_data"), story.get("lookup_fields"),
                                    story.get("lookup_language"), story.get("created_at")
                                ))
                            except Exception as e:
                                print(f"Error migrating story {story['id']}: {e}")
                        account_conn.commit()

                    print(f"Successfully migrated {count} stories")

                # Drop stories table from global DB
                cursor.execute("DROP TABLE IF EXISTS stories")
                conn.commit()
                print("Removed stories table from global database")

        except Exception as e:
            print(f"Error migrating stories: {e}")

    # Migrate API keys
    if os.path.exists(old_api_keys_path):
        try:
            with open(old_api_keys_path, 'r') as f:
                old_keys = json.load(f)

            if old_keys:
                print(f"Migrating API keys to account '{container_name}'...")

                # Get account data directory and create new API keys file
                account_api_keys_path = get_account_api_keys_file(container_name)

                # Only migrate if account-specific file doesn't exist yet
                if not os.path.exists(account_api_keys_path):
                    # Convert old format (string) to new format (object with key and is_admin)
                    new_keys = {}
                    for provider, key in old_keys.items():
                        if key:
                            if isinstance(key, dict):
                                new_keys[provider] = key
                            else:
                                new_keys[provider] = {"key": key, "is_admin": False}

                    with open(account_api_keys_path, 'w') as f:
                        json.dump(new_keys, f, indent=2)

                    print(f"Successfully migrated API keys")

                # Backup old API keys file
                backup_path = old_api_keys_path + ".backup"
                if os.path.exists(backup_path):
                    os.remove(backup_path)
                shutil.move(old_api_keys_path, backup_path)
                print(f"Old API keys backed up to {backup_path}")
            else:
                # Empty file, just remove it
                os.remove(old_api_keys_path)
        except Exception as e:
            print(f"Error migrating API keys: {e}")

    if has_stories_in_global or os.path.exists(old_api_keys_path + ".backup"):
        print("Migration complete!")


def init_db():
    """Initialize all database tables and migrate existing data."""
    init_global_db()
    migrate_to_per_account_data()


# Story functions
def save_story(
    name: str,
    content: str,
    words: list[str],
    style: str,
    length: str,
    language: str,
    target_language: Optional[str],
    word_data: Optional[dict],
    lookup_fields: Optional[list[str]],
    lookup_language: str,
    provider: Optional[str],
    model: Optional[str],
    deck_name: Optional[str] = None,
    container_name: Optional[str] = None,
) -> int:
    """Save a generated story to the database."""
    # Use active account if not specified
    if container_name is None:
        account = get_active_account()
        if not account:
            raise ValueError("No active account found")
        container_name = account["container_name"]

    # Ensure account database exists
    init_account_db(container_name)

    db_path = get_account_db_path(container_name)
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO stories (name, content, words, word_data, lookup_fields, lookup_language,
                                style, length, language, target_language,
                                provider, model, deck_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (name, content, json.dumps(words),
             json.dumps(word_data) if word_data else None,
             json.dumps(lookup_fields) if lookup_fields else None,
             lookup_language,
             style, length, language, target_language,
             provider, model, deck_name)
        )
        conn.commit()
        return cursor.lastrowid


def get_story(story_id: int, container_name: Optional[str] = None) -> Optional[dict]:
    """Get a story by ID."""
    # Use active account if not specified
    if container_name is None:
        account = get_active_account()
        if not account:
            return None
        container_name = account["container_name"]

    db_path = get_account_db_path(container_name)
    if not os.path.exists(db_path):
        return None

    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM stories WHERE id = ?", (story_id,))
        row = cursor.fetchone()
        if row:
            result = dict(row)
            result["words"] = json.loads(row["words"]) if row["words"] else []
            # Support both old (translations) and new (word_data) format
            if row["word_data"]:
                result["word_data"] = json.loads(row["word_data"])
            elif row["translations"]:
                # Convert old format: translations -> word_data
                translations = json.loads(row["translations"])
                word_categories = json.loads(row["word_categories"]) if row["word_categories"] else {}
                result["word_data"] = {
                    word: {"fields": {"Meaning": trans}, "category": word_categories.get(word, "unknown")}
                    for word, trans in translations.items()
                }
            else:
                result["word_data"] = {}
            result["lookup_fields"] = json.loads(row["lookup_fields"]) if row["lookup_fields"] else ["Meaning"]
            return result
        return None


def get_all_stories(limit: int = 100, offset: int = 0, container_name: Optional[str] = None) -> list[dict]:
    """Get all stories with pagination."""
    # Use active account if not specified
    if container_name is None:
        account = get_active_account()
        if not account:
            return []
        container_name = account["container_name"]

    db_path = get_account_db_path(container_name)
    if not os.path.exists(db_path):
        return []

    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, name, style, length, language, target_language,
                   provider, model, deck_name, created_at,
                   LENGTH(content) as content_length
            FROM stories
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset)
        )
        return [dict(row) for row in cursor.fetchall()]


def delete_story(story_id: int, container_name: Optional[str] = None) -> bool:
    """Delete a story by ID."""
    # Use active account if not specified
    if container_name is None:
        account = get_active_account()
        if not account:
            return False
        container_name = account["container_name"]

    db_path = get_account_db_path(container_name)
    if not os.path.exists(db_path):
        return False

    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM stories WHERE id = ?", (story_id,))
        conn.commit()
        return cursor.rowcount > 0


def update_story_name(story_id: int, name: str, container_name: Optional[str] = None) -> bool:
    """Update a story's name."""
    # Use active account if not specified
    if container_name is None:
        account = get_active_account()
        if not account:
            return False
        container_name = account["container_name"]

    db_path = get_account_db_path(container_name)
    if not os.path.exists(db_path):
        return False

    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE stories SET name = ? WHERE id = ?", (name, story_id))
        conn.commit()
        return cursor.rowcount > 0


def update_story(story_id: int, name: Optional[str] = None, lookup_fields: Optional[list[str]] = None, container_name: Optional[str] = None) -> bool:
    """Update a story's name and/or lookup fields."""
    # Use active account if not specified
    if container_name is None:
        account = get_active_account()
        if not account:
            return False
        container_name = account["container_name"]

    db_path = get_account_db_path(container_name)
    if not os.path.exists(db_path):
        return False

    updates = []
    params = []

    if name is not None:
        updates.append("name = ?")
        params.append(name)

    if lookup_fields is not None:
        updates.append("lookup_fields = ?")
        params.append(json.dumps(lookup_fields))

    if not updates:
        return True  # Nothing to update

    params.append(story_id)

    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(f"UPDATE stories SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
        return cursor.rowcount > 0


# Anki account functions
def add_account(email: str, container_name: str, container_port: int, volume_name: str) -> int:
    """Add a new Anki account."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO anki_accounts (email, container_name, container_port, volume_name, is_active)
            VALUES (?, ?, ?, ?, 0)
            """,
            (email, container_name, container_port, volume_name)
        )
        conn.commit()
        return cursor.lastrowid


def get_account(account_id: int) -> Optional[dict]:
    """Get an account by ID."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM anki_accounts WHERE id = ?", (account_id,))
        row = cursor.fetchone()
        return dict(row) if row else None


def get_account_by_email(email: str) -> Optional[dict]:
    """Get an account by email."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM anki_accounts WHERE email = ?", (email,))
        row = cursor.fetchone()
        return dict(row) if row else None


def get_all_accounts() -> list[dict]:
    """Get all accounts."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM anki_accounts ORDER BY created_at ASC")
        return [dict(row) for row in cursor.fetchall()]


def get_active_account() -> Optional[dict]:
    """Get the currently active account."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM anki_accounts WHERE is_active = 1 LIMIT 1")
        row = cursor.fetchone()
        return dict(row) if row else None


def set_active_account(account_id: int) -> bool:
    """Set an account as active (deactivates all others)."""
    with get_db() as conn:
        cursor = conn.cursor()
        # Deactivate all
        cursor.execute("UPDATE anki_accounts SET is_active = 0")
        # Activate the specified one
        cursor.execute("UPDATE anki_accounts SET is_active = 1 WHERE id = ?", (account_id,))
        conn.commit()
        return cursor.rowcount > 0


def delete_account(account_id: int) -> bool:
    """Delete an account."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM anki_accounts WHERE id = ?", (account_id,))
        conn.commit()
        return cursor.rowcount > 0


def get_next_available_port() -> int:
    """Get the next available AnkiConnect port."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT MAX(container_port) FROM anki_accounts")
        result = cursor.fetchone()
        max_port = result[0] if result[0] else 8764  # Start from 8764, first will be 8765
        return max_port + 1


def set_ankiweb_email(account_id: int, email: Optional[str]) -> bool:
    """Set the AnkiWeb email for an account."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE anki_accounts SET ankiweb_email = ? WHERE id = ?", (email, account_id))
        conn.commit()
        return cursor.rowcount > 0


# ============================================================================
# User Management
# ============================================================================

def get_user_count() -> int:
    """Return number of users in the database."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM users")
        return cursor.fetchone()[0]


def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a password against its hash."""
    return bcrypt.checkpw(password.encode('utf-8'), password_hash.encode('utf-8'))


def create_user(username: str, password: str, is_admin: bool = False, can_add_containers: bool = False) -> int:
    """Create a new user."""
    password_hash = hash_password(password)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (username, password_hash, is_admin, can_add_containers) VALUES (?, ?, ?, ?)",
            (username, password_hash, 1 if is_admin else 0, 1 if can_add_containers else 0)
        )
        conn.commit()
        return cursor.lastrowid


def get_user(user_id: int) -> Optional[dict]:
    """Get a user by ID."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        return dict(row) if row else None


def get_user_by_username(username: str) -> Optional[dict]:
    """Get a user by username."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE username = ?", (username,))
        row = cursor.fetchone()
        return dict(row) if row else None


def get_all_users() -> list[dict]:
    """Get all users."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, is_admin, can_add_containers, created_at FROM users ORDER BY username")
        return [dict(row) for row in cursor.fetchall()]


def update_user(user_id: int, is_admin: Optional[bool] = None, can_add_containers: Optional[bool] = None) -> bool:
    """Update user settings."""
    updates = []
    params = []

    if is_admin is not None:
        updates.append("is_admin = ?")
        params.append(1 if is_admin else 0)

    if can_add_containers is not None:
        updates.append("can_add_containers = ?")
        params.append(1 if can_add_containers else 0)

    if not updates:
        return False

    params.append(user_id)

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
        return cursor.rowcount > 0


def update_user_password(user_id: int, new_password: str) -> bool:
    """Update a user's password."""
    password_hash = hash_password(new_password)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))
        conn.commit()
        return cursor.rowcount > 0


def update_user_username(user_id: int, new_username: str) -> bool:
    """Update a user's username."""
    with get_db() as conn:
        cursor = conn.cursor()
        # Check if username already exists
        cursor.execute("SELECT id FROM users WHERE username = ? AND id != ?", (new_username, user_id))
        if cursor.fetchone():
            raise ValueError("Username already exists")

        cursor.execute("UPDATE users SET username = ? WHERE id = ?", (new_username, user_id))
        conn.commit()
        return cursor.rowcount > 0


def update_user_language(user_id: int, language: str) -> bool:
    """Update a user's language preference."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET language = ? WHERE id = ?", (language, user_id))
        conn.commit()
        return cursor.rowcount > 0


def delete_user(user_id: int) -> bool:
    """Delete a user (except root)."""
    with get_db() as conn:
        cursor = conn.cursor()
        # Don't allow deleting root user (id = 1)
        cursor.execute("DELETE FROM users WHERE id = ? AND id != 1", (user_id,))
        conn.commit()
        return cursor.rowcount > 0


def verify_user_credentials(username: str, password: str) -> Optional[dict]:
    """Verify user credentials and return user info if valid."""
    user = get_user_by_username(username)
    if user and verify_password(password, user['password_hash']):
        # Don't include password hash in returned user
        user_info = dict(user)
        user_info.pop('password_hash', None)
        return user_info
    return None


# ============================================================================
# Container Permissions
# ============================================================================

def set_user_container_permissions(user_id: int, container_ids: list[int]) -> bool:
    """Set container permissions for a user (replaces existing permissions)."""
    with get_db() as conn:
        cursor = conn.cursor()

        # Delete existing permissions
        cursor.execute("DELETE FROM user_container_permissions WHERE user_id = ?", (user_id,))

        # Add new permissions
        for container_id in container_ids:
            cursor.execute(
                "INSERT OR IGNORE INTO user_container_permissions (user_id, container_id) VALUES (?, ?)",
                (user_id, container_id)
            )

        conn.commit()
        return True


def get_user_container_permissions(user_id: int) -> list[int]:
    """Get list of container IDs a user has access to."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT container_id FROM user_container_permissions WHERE user_id = ?", (user_id,))
        return [row[0] for row in cursor.fetchall()]


def get_user_accessible_containers(user_id: int) -> list[dict]:
    """Get all containers a user has access to (admin sees all)."""
    user = get_user(user_id)
    if not user:
        return []

    # Admin users see all containers
    if user['is_admin']:
        return get_all_accounts()

    # Regular users see only their assigned containers
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT a.* FROM anki_accounts a
            INNER JOIN user_container_permissions p ON a.id = p.container_id
            WHERE p.user_id = ?
            ORDER BY a.created_at ASC
        """, (user_id,))
        return [dict(row) for row in cursor.fetchall()]


def migrate_to_user_system(existing_password: str) -> bool:
    """Migrate from password-only auth to user system. Creates root user with existing password."""
    try:
        # Check if root user already exists
        if get_user_by_username('root'):
            print("Root user already exists, skipping migration")
            return True

        # Create root user with existing password
        user_id = create_user('root', existing_password, is_admin=True, can_add_containers=True)

        # Give root access to all containers
        all_containers = get_all_accounts()
        if all_containers:
            container_ids = [c['id'] for c in all_containers]
            set_user_container_permissions(user_id, container_ids)

        print(f"✓ Migrated to user system: created root user (id={user_id}) with admin privileges")
        return True
    except Exception as e:
        print(f"✗ Failed to migrate to user system: {e}")
        return False


# ============================================================================
# Quizlet
# ============================================================================

def create_quizlet_deck(title: str, url: str, cards: list[dict]) -> int:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO quizlet_decks (title, url, card_count) VALUES (?, ?, ?)",
            (title, url, len(cards))
        )
        deck_id = cursor.lastrowid
        for i, card in enumerate(cards):
            cursor.execute(
                "INSERT INTO quizlet_cards (deck_id, front, back, image, position) VALUES (?, ?, ?, ?, ?)",
                (deck_id, card["front"], card["back"], card.get("image"), i)
            )
        conn.commit()
        return deck_id

def get_quizlet_decks() -> list[dict]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, title, url, card_count, created_at FROM quizlet_decks ORDER BY created_at DESC")
        return [dict(zip([d[0] for d in cursor.description], row)) for row in cursor.fetchall()]

def get_quizlet_deck(deck_id: int) -> Optional[dict]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, title, url, card_count, created_at FROM quizlet_decks WHERE id = ?", (deck_id,))
        row = cursor.fetchone()
        if not row:
            return None
        deck = dict(zip([d[0] for d in cursor.description], row))
        cursor.execute("SELECT id, front, back, image, position FROM quizlet_cards WHERE deck_id = ? ORDER BY position", (deck_id,))
        deck["cards"] = [dict(zip([d[0] for d in cursor.description], r)) for r in cursor.fetchall()]
        return deck

def rename_quizlet_deck(deck_id: int, title: str) -> bool:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE quizlet_decks SET title = ? WHERE id = ?", (title, deck_id))
        conn.commit()
        return cursor.rowcount > 0

def delete_quizlet_deck(deck_id: int) -> bool:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM quizlet_decks WHERE id = ?", (deck_id,))
        conn.commit()
        return cursor.rowcount > 0

def record_quizlet_review(card_id: int, deck_id: int, ease: int):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO quizlet_reviews (card_id, deck_id, ease) VALUES (?, ?, ?)",
            (card_id, deck_id, ease)
        )
        conn.commit()

def get_quizlet_deck_stats(deck_id: int) -> dict:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT COUNT(*) FROM quizlet_reviews
            WHERE deck_id = ? AND date(reviewed_at) = date('now')
        """, (deck_id,))
        return {"studied_today": cursor.fetchone()[0]}

def get_quizlet_daily_counts() -> dict[str, int]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT date(reviewed_at) as day, COUNT(*) as cnt
            FROM quizlet_reviews
            GROUP BY day
        """)
        return {row[0]: row[1] for row in cursor.fetchall()}


# Initialize database on import
init_db()
