import sqlite3
import json
import os
import time
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

        # Migrate users columns
        cursor.execute("PRAGMA table_info(users)")
        columns = [column[1] for column in cursor.fetchall()]
        if 'language' not in columns:
            cursor.execute("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'en'")
        if 'accent_color' not in columns:
            cursor.execute("ALTER TABLE users ADD COLUMN accent_color TEXT")
        if 'accent_hover' not in columns:
            cursor.execute("ALTER TABLE users ADD COLUMN accent_hover TEXT")
        if 'can_edit_server_accent' not in columns:
            cursor.execute("ALTER TABLE users ADD COLUMN can_edit_server_accent INTEGER DEFAULT 0")
        if 'base_colors' not in columns:
            cursor.execute("ALTER TABLE users ADD COLUMN base_colors TEXT")
        # Finer permissions (security.PERMISSIONS); existing users keep what they could do.
        for column, default in (("can_use_ai", 1), ("can_manage_ai_keys", 0), ("can_import", 1)):
            if column not in columns:
                cursor.execute(f"ALTER TABLE users ADD COLUMN {column} INTEGER DEFAULT {default}")
                if column == "can_manage_ai_keys":
                    # Until now every user could change the keys; keep that for existing users.
                    cursor.execute("UPDATE users SET can_manage_ai_keys = 1")

        # App-wide settings table (key-value)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)

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

        # Migration: add container_id to quizlet_decks
        try:
            cursor.execute("ALTER TABLE quizlet_decks ADD COLUMN container_id INTEGER REFERENCES anki_accounts(id) ON DELETE CASCADE")
        except Exception:
            pass
        # Backfill existing unscoped decks to whichever container is currently active
        cursor.execute("""
            UPDATE quizlet_decks
            SET container_id = (SELECT id FROM anki_accounts WHERE is_active = 1 LIMIT 1)
            WHERE container_id IS NULL
        """)

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

        # Quizlet favorites table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS quizlet_favorites (
                card_id INTEGER NOT NULL,
                deck_id INTEGER NOT NULL REFERENCES quizlet_decks(id) ON DELETE CASCADE,
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(card_id, deck_id)
            )
        """)

        # Quizlet per-deck study state (Learn progress, Match best times, ...)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS quizlet_study_state (
                deck_id INTEGER NOT NULL REFERENCES quizlet_decks(id) ON DELETE CASCADE,
                mode TEXT NOT NULL,
                state TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (deck_id, mode)
            )
        """)

        # Resumable study sessions (per user, per Anki account) for the Study hub
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS study_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                container_id INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL,
                ref_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                detail TEXT,
                progress_done INTEGER NOT NULL DEFAULT 0,
                progress_total INTEGER NOT NULL DEFAULT 0,
                state TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                UNIQUE(user_id, container_id, kind, ref_id)
            )
        """)

        # Login attempts for persistent, server-side rate limiting
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS login_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                identifier TEXT NOT NULL,
                attempt_time REAL NOT NULL
            )
        """)
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_login_attempts_id_time ON login_attempts(identifier, attempt_time)"
        )

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
        # Story tab redesign: CEFR level and the inflected forms the AI used for each word
        for col in ("level TEXT", "word_forms TEXT", "annotations TEXT"):
            try:
                cursor.execute(f"ALTER TABLE stories ADD COLUMN {col}")
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

                    print("Successfully migrated API keys")

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
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS login_sessions (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            )
        """)
        conn.execute("DELETE FROM login_sessions WHERE expires_at < ?", (int(time.time()),))
        conn.commit()


class LoginSessions:
    """Logged-in sessions (session id -> user info), kept in the database so a restart or an
    update doesn't log everyone out (the phone app stays logged in for its 7 days)."""

    LIFETIME = 7 * 24 * 3600

    def __init__(self):
        self._cache: dict[str, tuple[dict, int]] = {}  # id -> (data, expires_at)

    def _load(self, session_id: str) -> Optional[dict]:
        now = int(time.time())
        cached = self._cache.get(session_id)
        if cached:
            if cached[1] >= now:
                return cached[0]
            self._cache.pop(session_id, None)
        with get_db() as conn:
            row = conn.execute("SELECT data, expires_at FROM login_sessions WHERE id = ? AND expires_at >= ?",
                               (session_id, now)).fetchone()
        if row is None:
            return None
        data = json.loads(row["data"])
        self._cache[session_id] = (data, row["expires_at"])
        return data

    def __contains__(self, session_id: object) -> bool:
        return isinstance(session_id, str) and self._load(session_id) is not None

    def __getitem__(self, session_id: str) -> dict:
        data = self._load(session_id)
        if data is None:
            raise KeyError(session_id)
        return data

    def get(self, session_id: Optional[str], default=None):
        data = self._load(session_id) if session_id else None
        return default if data is None else data

    def __setitem__(self, session_id: str, data: dict) -> None:
        expires = int(time.time()) + self.LIFETIME
        self._cache[session_id] = (data, expires)
        with get_db() as conn:
            conn.execute("INSERT OR REPLACE INTO login_sessions (id, data, expires_at) VALUES (?, ?, ?)",
                         (session_id, json.dumps(data), expires))
            conn.commit()

    def update(self, session_id: str, **changes) -> None:
        """Change a session's user info (e.g. its language), keeping its expiry."""
        data = self._load(session_id)
        if data is None:
            return
        data.update(changes)
        with get_db() as conn:
            conn.execute("UPDATE login_sessions SET data = ? WHERE id = ?", (json.dumps(data), session_id))
            conn.commit()

    def __delitem__(self, session_id: str) -> None:
        self._cache.pop(session_id, None)
        with get_db() as conn:
            conn.execute("DELETE FROM login_sessions WHERE id = ?", (session_id,))
            conn.commit()

    def drop_user(self, user_id: int, keep: Optional[str] = None) -> None:
        """Log a user out everywhere (deleted users, changed passwords), except session `keep`."""
        self._cache = {k: v for k, v in self._cache.items() if v[0].get("user_id") != user_id or k == keep}
        with get_db() as conn:
            for row in conn.execute("SELECT id, data FROM login_sessions").fetchall():
                if json.loads(row["data"]).get("user_id") == user_id and row["id"] != keep:
                    conn.execute("DELETE FROM login_sessions WHERE id = ?", (row["id"],))
            conn.commit()


login_sessions = LoginSessions()


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
    level: Optional[str] = None,
    word_forms: Optional[dict] = None,
    annotations: Optional[dict] = None,
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
                                provider, model, deck_name, level, word_forms, annotations)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (name, content, json.dumps(words),
             json.dumps(word_data) if word_data else None,
             json.dumps(lookup_fields) if lookup_fields else None,
             lookup_language,
             style, length, language, target_language,
             provider, model, deck_name, level,
             json.dumps(word_forms) if word_forms else None,
             json.dumps(annotations) if annotations else None)
        )
        conn.commit()
        return cursor.lastrowid


def set_story_annotations(story_id: int, annotations: dict, language: Optional[str] = None,
                          container_name: Optional[str] = None) -> bool:
    """Store a story's reading annotations; also fills in its language if it was 'auto'."""
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
        cursor.execute("UPDATE stories SET annotations = ? WHERE id = ?", (json.dumps(annotations), story_id))
        if language:
            cursor.execute("UPDATE stories SET language = ? WHERE id = ? AND (language IS NULL OR language = '' OR language = 'auto') "
                           "AND (target_language IS NULL OR target_language = '')", (language, story_id))
        conn.commit()
        return cursor.rowcount >= 0


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
            result["word_forms"] = json.loads(row["word_forms"]) if "word_forms" in row.keys() and row["word_forms"] else {}
            result["annotations"] = json.loads(row["annotations"]) if "annotations" in row.keys() and row["annotations"] else None
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
                   provider, model, deck_name, created_at, level, words,
                   LENGTH(content) as content_length,
                   SUBSTR(content, 1, 400) as preview
            FROM stories
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset)
        )
        out = []
        for row in cursor.fetchall():
            d = dict(row)
            try:
                d["word_count"] = len(json.loads(d.pop("words") or "[]"))
            except ValueError:
                d["word_count"] = 0
            out.append(d)
        return out


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
    """The profile the current request is about (the logged-in user's own choice, see
    security.py); outside requests (startup, background work) the server's default one."""
    from security import UNSET, request_profile
    profile = request_profile()
    if profile is not UNSET:
        return profile
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


def rename_account(account_id: int, name: str) -> bool:
    """Rename an account (its Anki profile is renamed by the caller)."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE anki_accounts SET container_name = ?, volume_name = ? WHERE id = ?",
                       (name, "anki-cli:" + name, account_id))
        conn.commit()
        return cursor.rowcount > 0


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


USER_FLAGS = ("is_admin", "can_add_containers", "can_edit_server_accent", "can_use_ai", "can_manage_ai_keys", "can_import")


def create_user(username: str, password: str, is_admin: bool = False, can_add_containers: bool = False,
                can_edit_server_accent: bool = False, **permissions: bool) -> int:
    """Create a user. `permissions`: other USER_FLAGS (defaults: AI and imports on)."""
    flags = {"is_admin": is_admin, "can_add_containers": can_add_containers,
             "can_edit_server_accent": can_edit_server_accent, "can_use_ai": True, "can_import": True,
             "can_manage_ai_keys": False}
    flags.update({k: v for k, v in permissions.items() if k in USER_FLAGS})
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"INSERT INTO users (username, password_hash, {', '.join(USER_FLAGS)}) VALUES (?, ?{', ?' * len(USER_FLAGS)})",
            (username, hash_password(password), *[1 if flags[k] else 0 for k in USER_FLAGS])
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
        cursor.execute(f"SELECT id, username, {', '.join(USER_FLAGS)}, created_at FROM users ORDER BY id")
        return [dict(row) for row in cursor.fetchall()]


def update_user(user_id: int, **flags: Optional[bool]) -> bool:
    """Change some of a user's USER_FLAGS (None leaves one as it is)."""
    changes = {k: v for k, v in flags.items() if k in USER_FLAGS and v is not None}
    if not changes:
        return False
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(f"UPDATE users SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?",
                       [1 if v else 0 for v in changes.values()] + [user_id])
        conn.commit()
        return cursor.rowcount > 0


def count_admins() -> int:
    with get_db() as conn:
        return conn.execute("SELECT COUNT(*) FROM users WHERE is_admin = 1").fetchone()[0]


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
    """Delete a user, with their profile permissions and study sessions."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM user_container_permissions WHERE user_id = ?", (user_id,))
        cursor.execute("DELETE FROM study_sessions WHERE user_id = ?", (user_id,))
        cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
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
    """Upgrading from the single-password versions (no users yet, but profiles and an
    APP_PASSWORD in .env): that password becomes the `root` admin's. Never otherwise: a fresh
    install creates its admin in the setup wizard."""
    try:
        if get_user_count() > 0 or not existing_password or existing_password in ("admin", "your_password_here"):
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
    active = get_active_account()
    container_id = active["id"] if active else None
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO quizlet_decks (title, url, card_count, container_id) VALUES (?, ?, ?, ?)",
            (title, url, len(cards), container_id)
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
    active = get_active_account()
    container_id = active["id"] if active else None
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT qd.id, qd.title, qd.url, qd.card_count, qd.created_at,
                   COUNT(qf.card_id) as favorites_count
            FROM quizlet_decks qd
            LEFT JOIN quizlet_favorites qf ON qf.deck_id = qd.id
            WHERE qd.container_id = ?
            GROUP BY qd.id
            ORDER BY qd.created_at DESC
        """, (container_id,))
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
        deleted = cursor.rowcount > 0
        cursor.execute("DELETE FROM study_sessions WHERE kind LIKE 'quizlet-%' AND ref_id = ?", (str(deck_id),))
        conn.commit()
        return deleted

def record_quizlet_review(card_id: int, deck_id: int, ease: int):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO quizlet_reviews (card_id, deck_id, ease) VALUES (?, ?, ?)",
            (card_id, deck_id, ease)
        )
        conn.commit()

def get_quizlet_favorites(deck_id: int) -> list[int]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT card_id FROM quizlet_favorites WHERE deck_id = ?", (deck_id,))
        return [row[0] for row in cursor.fetchall()]

def toggle_quizlet_favorite(card_id: int, deck_id: int) -> bool:
    """Returns True if now favorited, False if unfavorited."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM quizlet_favorites WHERE card_id = ? AND deck_id = ?", (card_id, deck_id))
        if cursor.fetchone():
            cursor.execute("DELETE FROM quizlet_favorites WHERE card_id = ? AND deck_id = ?", (card_id, deck_id))
            conn.commit()
            return False
        cursor.execute("INSERT INTO quizlet_favorites (card_id, deck_id) VALUES (?, ?)", (card_id, deck_id))
        conn.commit()
        return True

def get_quizlet_deck_stats(deck_id: int) -> dict:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT COUNT(*) FROM quizlet_reviews
            WHERE deck_id = ? AND date(reviewed_at) = date('now')
        """, (deck_id,))
        return {"studied_today": cursor.fetchone()[0]}

def update_quizlet_card(card_id: int, deck_id: int, front: str, back: str, image) -> bool:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE quizlet_cards SET front = ?, back = ?, image = ? WHERE id = ? AND deck_id = ?",
            (front, back, image, card_id, deck_id)
        )
        conn.commit()
        return cursor.rowcount > 0


def get_quizlet_study_state(deck_id: int, mode: str) -> Optional[str]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT state FROM quizlet_study_state WHERE deck_id = ? AND mode = ?", (deck_id, mode))
        row = cursor.fetchone()
        return row[0] if row else None


def set_quizlet_study_state(deck_id: int, mode: str, state: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO quizlet_study_state (deck_id, mode, state, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(deck_id, mode) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
        """, (deck_id, mode, state))
        conn.commit()


def delete_quizlet_study_state(deck_id: int, mode: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM quizlet_study_state WHERE deck_id = ? AND mode = ?", (deck_id, mode))
        conn.commit()


def _active_container_id() -> int:
    active = get_active_account()
    return active["id"] if active else 0


_SESSION_COLS = "kind, ref_id, title, detail, progress_done, progress_total, status, created_at, updated_at"


def list_study_sessions(user_id: int, status: str = "active", limit: int = 50) -> list[dict]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT {_SESSION_COLS} FROM study_sessions WHERE user_id = ? AND container_id = ? AND status = ? "
            "ORDER BY updated_at DESC LIMIT ?",
            (user_id, _active_container_id(), status, limit),
        )
        return [dict(r) for r in cursor.fetchall()]


def get_study_session(user_id: int, kind: str, ref_id: str) -> Optional[dict]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT {_SESSION_COLS}, state FROM study_sessions WHERE user_id = ? AND container_id = ? AND kind = ? AND ref_id = ?",
            (user_id, _active_container_id(), kind, ref_id),
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def upsert_study_session(user_id: int, kind: str, ref_id: str, title: str, detail: Optional[str],
                         progress_done: int, progress_total: int, status: str, state: Optional[str]):
    """Create or update a session. A None state keeps whatever state was saved before."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO study_sessions (user_id, container_id, kind, ref_id, title, detail, progress_done, progress_total, status, state)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, container_id, kind, ref_id) DO UPDATE SET
                title = excluded.title, detail = excluded.detail,
                progress_done = excluded.progress_done, progress_total = excluded.progress_total,
                status = excluded.status, state = COALESCE(excluded.state, study_sessions.state),
                updated_at = datetime('now')
        """, (user_id, _active_container_id(), kind, ref_id, title, detail, progress_done, progress_total, status, state))
        conn.commit()


def delete_study_session(user_id: int, kind: str, ref_id: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM study_sessions WHERE user_id = ? AND container_id = ? AND kind = ? AND ref_id = ?",
            (user_id, _active_container_id(), kind, ref_id),
        )
        conn.commit()


def get_quizlet_daily_counts() -> dict[str, int]:
    active = get_active_account()
    container_id = active["id"] if active else None
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT date(qr.reviewed_at) as day, COUNT(*) as cnt
            FROM quizlet_reviews qr
            JOIN quizlet_decks qd ON qr.deck_id = qd.id
            WHERE qd.container_id = ?
            GROUP BY day
        """, (container_id,))
        return {row[0]: row[1] for row in cursor.fetchall()}


def get_quizlet_set_words(user_id: int, deck_id: int, side: str = "term") -> Optional[dict]:
    """
    A Quizlet set as story vocabulary — same shape as the Anki deck words endpoint.
    Learn progress stands in for Anki's card states: not studied -> new,
    still learning -> learning, familiar -> young, mastered -> mature.
    """
    import json, re
    container_id = _active_container_id()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT title FROM quizlet_decks WHERE id = ? AND container_id = ?", (deck_id, container_id))
        deck = cursor.fetchone()
        if not deck:
            return None
        cursor.execute("SELECT id, front, back FROM quizlet_cards WHERE deck_id = ? ORDER BY position", (deck_id,))
        cards = cursor.fetchall()
        cursor.execute("SELECT state FROM study_sessions WHERE user_id = ? AND container_id = ? AND kind = 'quizlet-learn' AND ref_id = ?",
                       (user_id, container_id, str(deck_id)))
        row = cursor.fetchone()
        cursor.execute("SELECT card_id FROM quizlet_favorites WHERE deck_id = ?", (deck_id,))
        starred_ids = {r[0] for r in cursor.fetchall()}
        cursor.execute("SELECT card_id, COUNT(*) FROM quizlet_reviews WHERE deck_id = ? AND ease = 1 GROUP BY card_id", (deck_id,))
        missed_ids = {r[0]: r[1] for r in cursor.fetchall()}
    levels: dict[int, int] = {}
    if row and row[0]:
        try:
            for cid, t in ((json.loads(row[0]) or {}).get("terms") or {}).items():
                levels[int(cid)] = int(t.get("level", 0))
        except (ValueError, TypeError, AttributeError):
            pass
    clean = lambda s: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "").replace("&nbsp;", " ")).strip()
    cat_of = {0: "new", 1: "learning", 2: "young", 3: "mature"}
    words, word_data, categories, counts = [], {}, {}, {}
    starred: list[str] = []
    missed: dict[str, int] = {}
    for c in cards:
        term, definition = clean(c["front"]), clean(c["back"])
        word = definition if side == "definition" else term
        if not word or word in word_data:
            continue
        cat = cat_of.get(levels.get(c["id"], 0), "new")
        words.append(word)
        categories[word] = cat
        counts[cat] = counts.get(cat, 0) + 1
        word_data[word] = {"fields": {"Term": term, "Definition": definition}, "category": cat}
        if c["id"] in starred_ids:
            starred.append(word)
        if missed_ids.get(c["id"]):
            missed[word] = missed_ids[c["id"]]
    return {
        "words": words, "word_data": word_data, "categories": categories, "category_counts": counts,
        "field_used": "Definition" if side == "definition" else "Term",
        "available_fields": ["Term", "Definition"], "title": deck["title"],
        "starred": starred, "missed": missed,
    }


def search_quizlet_cards(user_id: int, query: str, limit: int = 40) -> list[dict]:
    """Accent/case-insensitive search over Quizlet cards in the active account, best matches first."""
    import json, re, unicodedata

    def fold(s: str) -> str:
        s = re.sub(r"<[^>]+>", " ", s or "").replace("&nbsp;", " ")
        s = unicodedata.normalize("NFD", s.lower())
        s = "".join(c for c in s if unicodedata.category(c) != "Mn").replace("œ", "oe").replace("æ", "ae").replace("’", "'")
        return re.sub(r"\s+", " ", s).strip()

    q = fold(query)
    if not q:
        return []
    container_id = _active_container_id()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT qc.id, qc.deck_id, qc.front, qc.back, qc.image, qd.title
            FROM quizlet_cards qc JOIN quizlet_decks qd ON qc.deck_id = qd.id
            WHERE qd.container_id = ?
        """, (container_id,))
        rows = [dict(r) for r in cursor.fetchall()]
        cursor.execute("SELECT ref_id, state FROM study_sessions WHERE user_id = ? AND container_id = ? AND kind = 'quizlet-learn'",
                       (user_id, container_id))
        levels: dict[int, int] = {}
        for _ref, raw in cursor.fetchall():
            try:
                for cid, t in ((json.loads(raw) or {}).get("terms") or {}).items():
                    levels[int(cid)] = int(t.get("level", 0))
            except (ValueError, TypeError, AttributeError):
                continue

    def rank(r) -> int | None:
        f, b = fold(r["front"]), fold(r["back"])
        # strip leading articles so "le chat" counts as an exact hit for "chat"
        bare = re.sub(r"^(le |la |les |l'|un |une |des |the |a |an |to )", "", f)
        if q in (f, bare): return 0
        if f.startswith(q) or bare.startswith(q): return 1
        if q in f: return 2
        if q == b or b.startswith(q): return 3
        if q in b: return 4
        return None

    hits = []
    for r in rows:
        k = rank(r)
        if k is not None:
            hits.append((k, len(r["front"]), r))
    hits.sort(key=lambda x: (x[0], x[1]))
    return [{**r, "level": levels.get(r["id"], 0)} for _k, _l, r in hits[:limit]]


def add_quizlet_card(deck_id: int, front: str, back: str) -> Optional[int]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM quizlet_decks WHERE id = ? AND container_id = ?", (deck_id, _active_container_id()))
        if not cursor.fetchone():
            return None
        cursor.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM quizlet_cards WHERE deck_id = ?", (deck_id,))
        pos = cursor.fetchone()[0]
        cursor.execute("INSERT INTO quizlet_cards (deck_id, front, back, position) VALUES (?, ?, ?, ?)", (deck_id, front, back, pos))
        card_id = cursor.lastrowid
        cursor.execute("UPDATE quizlet_decks SET card_count = (SELECT COUNT(*) FROM quizlet_cards WHERE deck_id = ?) WHERE id = ?", (deck_id, deck_id))
        conn.commit()
        return card_id


def get_quizlet_stats_data(user_id: int, deck_id: Optional[int] = None) -> tuple[list[tuple], list[dict], dict[int, int]]:
    """Quizlet answers, cards and Learn levels for the active account (optionally one set) — for the Stats tab."""
    import json
    container_id = _active_container_id()
    deck_filter, args = ("AND qd.id = ?", (container_id, deck_id)) if deck_id is not None else ("", (container_id,))
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(f"""
            SELECT qr.card_id, qr.deck_id, qr.ease, qr.reviewed_at
            FROM quizlet_reviews qr JOIN quizlet_decks qd ON qr.deck_id = qd.id
            WHERE qd.container_id = ? {deck_filter}
        """, args)
        rows = [tuple(r) for r in cursor.fetchall()]
        cursor.execute(f"""
            SELECT qc.id, qc.deck_id, qc.front, qc.back
            FROM quizlet_cards qc JOIN quizlet_decks qd ON qc.deck_id = qd.id
            WHERE qd.container_id = ? {deck_filter}
        """, args)
        cards = [dict(r) for r in cursor.fetchall()]
        cursor.execute(
            "SELECT state FROM study_sessions WHERE user_id = ? AND container_id = ? AND kind = 'quizlet-learn'",
            (user_id, container_id),
        )
        levels: dict[int, int] = {}
        for (raw,) in cursor.fetchall():
            try:
                terms = (json.loads(raw) or {}).get("terms", {}) if raw else {}
            except ValueError:
                continue
            for cid, t in terms.items():
                levels[int(cid)] = int(t.get("level", 0))
    return rows, cards, levels


def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = cursor.fetchone()
        return row[0] if row else default

def set_setting(key: str, value: str) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
        conn.commit()

def get_user_accent(user_id: int) -> Optional[dict]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT accent_color, accent_hover FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        if row and row[0]:
            return {"accent": row[0], "hover": row[1]}
        return None

def set_user_accent(user_id: int, accent: str, hover: str) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET accent_color = ?, accent_hover = ? WHERE id = ?", (accent, hover, user_id))
        conn.commit()

def clear_user_accent(user_id: int) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET accent_color = NULL, accent_hover = NULL WHERE id = ?", (user_id,))
        conn.commit()


_BASE_COLORS_DEFAULT = {
    'bg_primary': '#1a1a2e',
    'bg_secondary': '#16213e',
    'bg_tertiary': '#0f3460',
    'text_primary': '#eeeeee',
    'text_secondary': '#aaaaaa',
}

def get_server_base_colors() -> dict:
    val = get_setting('server_base_colors')
    if val:
        try:
            return {**_BASE_COLORS_DEFAULT, **json.loads(val)}
        except Exception:
            pass
    return dict(_BASE_COLORS_DEFAULT)

def set_server_base_colors(colors: dict) -> None:
    merged = {**_BASE_COLORS_DEFAULT, **colors}
    set_setting('server_base_colors', json.dumps(merged))

def get_user_base_colors(user_id: int) -> Optional[dict]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT base_colors FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        if row and row[0]:
            try:
                return json.loads(row[0])
            except Exception:
                pass
    return None

def set_user_base_colors(user_id: int, colors: dict) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET base_colors = ? WHERE id = ?", (json.dumps(colors), user_id))
        conn.commit()

def clear_user_base_colors(user_id: int) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET base_colors = NULL WHERE id = ?", (user_id,))
        conn.commit()


# --- Login rate limiting (persistent, DB-backed) ---

def record_login_attempt(identifier: str) -> None:
    with get_db() as conn:
        conn.execute(
            "INSERT INTO login_attempts (identifier, attempt_time) VALUES (?, ?)",
            (identifier, time.time()),
        )
        conn.commit()

def count_recent_attempts(identifier: str, window: int) -> int:
    cutoff = time.time() - window
    with get_db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM login_attempts WHERE identifier = ? AND attempt_time > ?",
            (identifier, cutoff),
        ).fetchone()
        return row[0] if row else 0

def clear_login_attempts(*identifiers: str) -> None:
    with get_db() as conn:
        for ident in identifiers:
            conn.execute("DELETE FROM login_attempts WHERE identifier = ?", (ident,))
        conn.commit()

def get_lockout_wait(identifier: str, window: int, max_attempts: int) -> int:
    """Return seconds remaining in lockout (>0 = locked), 0 = not locked."""
    cutoff = time.time() - window
    with get_db() as conn:
        rows = conn.execute(
            "SELECT attempt_time FROM login_attempts WHERE identifier = ? AND attempt_time > ? ORDER BY attempt_time ASC",
            (identifier, cutoff),
        ).fetchall()
    if len(rows) >= max_attempts:
        oldest = rows[0][0]
        return max(int(window - (time.time() - oldest)), 1)
    return 0


# Initialize database on import
init_db()
