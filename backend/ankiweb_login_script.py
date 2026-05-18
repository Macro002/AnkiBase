#!/usr/bin/env python3
"""
Script to authenticate with AnkiWeb and store credentials in Anki
This script runs inside the Anki container
"""
import sys
import sqlite3
import json

def login_to_ankiweb(email, password):
    """
    Login to AnkiWeb and get the hkey (auth token)
    """
    try:
        # Try different import paths for different Anki versions
        print(f"Importing Anki modules...", file=sys.stderr)

        try:
            # Modern Anki (2.1.50+)
            from aqt import mw
            print(f"✓ Imported aqt.mw", file=sys.stderr)
        except ImportError as e:
            print(f"✗ Failed to import aqt.mw: {e}", file=sys.stderr)
            # Try without GUI
            from anki.collection import Collection
            print(f"✓ Imported anki.collection", file=sys.stderr)

        # Try to get the collection
        print(f"Opening collection...", file=sys.stderr)
        try:
            # First try via mw if available
            if 'mw' in locals() and mw and mw.col:
                col = mw.col
                print(f"✓ Using mw.col", file=sys.stderr)
            else:
                col = Collection("/data/collection.anki2")
                print(f"✓ Opened collection directly", file=sys.stderr)
        except Exception as e:
            print(f"✗ Failed to open collection: {e}", file=sys.stderr)
            return {
                "success": False,
                "error": f"Failed to open collection: {str(e)}"
            }

        # Perform the login
        print(f"Attempting to log in to AnkiWeb as {email}...", file=sys.stderr)

        try:
            # Try the sync_login method
            auth = col.sync_login(
                username=email,
                password=password
            )
            print(f"✓ sync_login returned: {auth}", file=sys.stderr)
        except AttributeError:
            print(f"✗ col.sync_login not available, trying backend...", file=sys.stderr)
            # Try through backend
            auth = col.backend.sync_login(
                username=email,
                password=password,
                endpoint=""
            )
            print(f"✓ backend.sync_login returned: {auth}", file=sys.stderr)

        # Close the collection if we opened it
        if 'mw' not in locals() or not mw:
            col.close()

        if auth and hasattr(auth, 'hkey'):
            print(f"✓ Login successful! Got hkey: {auth.hkey[:10]}...", file=sys.stderr)
            return {
                "success": True,
                "hkey": auth.hkey
            }
        else:
            print(f"✗ Login failed - no hkey in response: {auth}", file=sys.stderr)
            return {
                "success": False,
                "error": "Login failed - no hkey returned"
            }

    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"✗ Exception during login: {error_trace}", file=sys.stderr)
        return {
            "success": False,
            "error": str(e),
            "traceback": error_trace
        }

def store_credentials(email, hkey):
    """
    Store the credentials in Anki's prefs database
    """
    try:
        conn = sqlite3.connect("/data/prefs21.db")
        cursor = conn.cursor()

        # Create table if it doesn't exist
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS prefs (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)

        # Store the username and hkey
        cursor.execute("INSERT OR REPLACE INTO prefs (key, value) VALUES ('syncUser', ?)", (email,))
        cursor.execute("INSERT OR REPLACE INTO prefs (key, value) VALUES ('syncKey', ?)", (hkey,))

        conn.commit()
        conn.close()

        print(f"✓ Stored credentials in prefs.db", file=sys.stderr)
        return True

    except Exception as e:
        print(f"✗ Failed to store credentials: {e}", file=sys.stderr)
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(json.dumps({"success": False, "error": "Usage: script.py <email> <password>"}))
        sys.exit(1)

    email = sys.argv[1]
    password = sys.argv[2]

    # Attempt login
    result = login_to_ankiweb(email, password)

    if result["success"]:
        # Store credentials
        if store_credentials(email, result["hkey"]):
            print(json.dumps({"success": True, "message": "AnkiWeb authentication successful"}))
        else:
            print(json.dumps({"success": False, "error": "Failed to store credentials"}))
    else:
        print(json.dumps(result))
