"""
Anki configuration management
Handles writing AnkiWeb credentials to Anki's prefs database
"""
import sqlite3
import json
import subprocess
from pathlib import Path
from typing import Optional
from database import get_active_account


class AnkiConfigurator:
    def __init__(self, container_name: str = None, volume_name: str = None):
        # If not specified, use the active account's container
        if container_name is None or volume_name is None:
            active_account = get_active_account()
            if active_account:
                self.container_name = active_account["container_name"]
                self.volume_name = active_account["volume_name"]
            else:
                # Fallback to default (for backwards compatibility)
                self.container_name = "headless-anki"
                self.volume_name = "ankibase_anki-data"
        else:
            self.container_name = container_name
            self.volume_name = volume_name

    def configure_ankiweb_login(self, email: str, password: str, restart: bool = True) -> tuple[bool, str]:
        """
        Configure AnkiWeb login by authenticating and storing the hkey

        Args:
            email: AnkiWeb email/username
            password: AnkiWeb password
            restart: Whether to restart the container after storing credentials (default: True)

        Returns:
            Tuple of (success, error_message). error_message is empty string if successful.
        """
        try:
            import json
            import os
            import sys

            # Run authentication on the host (where Python is available)
            script_path = os.path.join(os.path.dirname(__file__), "ankiweb_auth_direct.py")

            print(f"Authenticating with AnkiWeb as {email}...")
            exec_result = subprocess.run(
                [sys.executable, script_path, email, password, "host"],
                capture_output=True,
                text=True,
                timeout=30
            )

            # Parse the JSON response
            print(f"Script stdout: {exec_result.stdout}")
            print(f"Script stderr: {exec_result.stderr}")
            print(f"Script return code: {exec_result.returncode}")

            try:
                result = json.loads(exec_result.stdout)

                if result.get("success"):
                    hkey = result.get("hkey")
                    print(f"✓ AnkiWeb authentication successful, got hkey")

                    # Store credentials directly in the database from host
                    if self.store_credentials_in_prefs_db(email, hkey):
                        print(f"✓ Stored credentials in database")

                        if restart:
                            # Restart Anki container to reload credentials
                            print(f"Restarting Anki container to load credentials...")
                            if self.restart_anki_container():
                                print(f"✓ Anki container restarted successfully")
                                return True, ""
                            else:
                                print(f"✗ Failed to restart Anki container")
                                return False, "Failed to restart Anki container"
                        else:
                            # Skip restart, credentials will be loaded on next restart
                            print(f"✓ Credentials saved, skipping container restart")
                            return True, ""
                    else:
                        print(f"✗ Failed to store credentials in database")
                        return False, "Failed to store credentials in database"
                else:
                    error_msg = result.get("error", "Unknown error")
                    traceback_msg = result.get("traceback", "")
                    print(f"✗ AnkiWeb authentication failed: {error_msg}")
                    if traceback_msg:
                        print(f"Traceback: {traceback_msg}")
                    print(f"stderr: {exec_result.stderr}")
                    return False, error_msg

            except json.JSONDecodeError:
                print(f"✗ Failed to parse response from login script")
                print(f"stdout: {exec_result.stdout}")
                print(f"stderr: {exec_result.stderr}")
                return False, "Failed to parse response from login script"

        except subprocess.TimeoutExpired:
            print("AnkiWeb login timed out after 30 seconds")
            return False, "AnkiWeb login timed out after 30 seconds"
        except Exception as e:
            print(f"Error configuring AnkiWeb: {e}")
            import traceback
            traceback.print_exc()
            return False, f"Error configuring AnkiWeb: {str(e)}"

    def store_credentials_in_prefs_db(self, email: str, hkey: str) -> bool:
        """
        Store credentials in Anki's prefs21.db (profiles table)
        Access database directly from host via Docker volume
        """
        try:
            import sqlite3
            import pickle

            # Access database directly from Docker volume
            db_path = f"/var/lib/docker/volumes/{self.volume_name}/_data/prefs21.db"

            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()

            # Get the current profile data for "User 1"
            cursor.execute("SELECT data FROM profiles WHERE name = ?", ("User 1",))
            row = cursor.fetchone()

            if not row:
                print(f"✗ Profile 'User 1' not found")
                conn.close()
                return False

            # Unpickle the profile data
            profile_data = pickle.loads(row[0])
            print(f"Profile data before: {list(profile_data.keys())}")

            # Update sync credentials
            profile_data['syncKey'] = hkey
            profile_data['syncUser'] = email

            print(f"Profile data after: syncKey={profile_data.get('syncKey', 'NOT SET')[:10]}..., syncUser={profile_data.get('syncUser')}")

            # Pickle and save back
            updated_blob = pickle.dumps(profile_data, protocol=pickle.HIGHEST_PROTOCOL)
            cursor.execute("UPDATE profiles SET data = ? WHERE name = ?", (updated_blob, "User 1"))

            conn.commit()
            conn.close()

            print(f"✓ Stored credentials in profile database")
            return True

        except Exception as e:
            import traceback
            print(f"✗ Failed to store credentials: {e}")
            print(f"Traceback: {traceback.format_exc()}")
            return False

    def restart_anki_container(self) -> bool:
        """
        Restart the Anki container to reload credentials

        Returns:
            True if successful, False otherwise
        """
        try:
            import time

            print(f"Restarting container {self.container_name}...")

            # Restart the container
            restart_result = subprocess.run(
                ["docker", "restart", self.container_name],
                capture_output=True,
                text=True,
                timeout=30
            )

            if restart_result.returncode != 0:
                print(f"Failed to restart container: {restart_result.stderr}")
                return False

            # Wait for AnkiConnect to be ready
            print(f"Waiting for AnkiConnect to be ready...")
            for i in range(30):  # Wait up to 30 seconds
                time.sleep(1)
                try:
                    check_result = subprocess.run(
                        ["curl", "-s", "http://localhost:8765", "-d", '{"action": "version", "version": 6}'],
                        capture_output=True,
                        text=True,
                        timeout=2
                    )
                    if check_result.returncode == 0 and "result" in check_result.stdout:
                        print(f"✓ AnkiConnect is ready after {i+1} seconds")
                        return True
                except:
                    pass

            print(f"✗ AnkiConnect did not become ready in time")
            return False

        except Exception as e:
            print(f"Error restarting Anki container: {e}")
            return False

    def delete_ankiweb_credentials(self) -> bool:
        """
        Delete AnkiWeb credentials from the profiles database

        Returns:
            True if successful, False otherwise
        """
        try:
            import sqlite3
            import pickle

            # Access database directly from Docker volume on host
            db_path = f"/var/lib/docker/volumes/{self.volume_name}/_data/prefs21.db"

            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()

            # Get profile data for "User 1"
            cursor.execute('SELECT data FROM profiles WHERE name = ?', ('User 1',))
            row = cursor.fetchone()

            if row:
                profile_data = pickle.loads(row[0])

                # Remove sync credentials
                profile_data.pop('syncKey', None)
                profile_data.pop('syncUser', None)

                # Save back
                updated_blob = pickle.dumps(profile_data, protocol=pickle.HIGHEST_PROTOCOL)
                cursor.execute('UPDATE profiles SET data = ? WHERE name = ?', (updated_blob, 'User 1'))

                conn.commit()
                conn.close()
                print("✓ Deleted AnkiWeb credentials from profile database")
                return True
            else:
                conn.close()
                print("✗ Profile 'User 1' not found")
                return False

        except Exception as e:
            import traceback
            print(f"✗ Error deleting AnkiWeb credentials: {e}")
            print(f"Traceback: {traceback.format_exc()}")
            return False

    def check_ankiweb_status(self) -> dict:
        """
        Check if AnkiWeb sync is configured by reading from profiles table

        Returns:
            dict with status info
        """
        try:
            import sqlite3
            import pickle

            # Access database directly from Docker volume on host
            db_path = f"/var/lib/docker/volumes/{self.volume_name}/_data/prefs21.db"

            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()

            # Get profile data for "User 1"
            cursor.execute('SELECT data FROM profiles WHERE name = ?', ('User 1',))
            row = cursor.fetchone()

            if row:
                profile_data = pickle.loads(row[0])
                sync_key = profile_data.get('syncKey')
                sync_user = profile_data.get('syncUser')

                if sync_key:
                    conn.close()
                    return {'configured': True, 'email': sync_user or ''}
                else:
                    conn.close()
                    return {'configured': False}
            else:
                conn.close()
                return {'configured': False}

        except Exception as e:
            print(f"Error checking AnkiWeb status: {e}")
            return {"configured": False, "error": str(e)}
