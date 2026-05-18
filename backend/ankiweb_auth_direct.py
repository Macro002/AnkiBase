#!/usr/bin/env python3
"""
Direct AnkiWeb authentication using HTTP API
Implements the Anki sync protocol correctly
"""
import sys
import json
import requests
import zstandard as zstd
import uuid

def authenticate_ankiweb(email: str, password: str) -> dict:
    """
    Authenticate with AnkiWeb directly via HTTP API using Anki's protocol

    Args:
        email: AnkiWeb email/username
        password: AnkiWeb password

    Returns:
        dict with success status and hkey if successful
    """
    try:
        # AnkiWeb sync server endpoint
        url = "https://sync.ankiweb.net/sync/hostKey"

        # Prepare the SyncHeader (anki-sync header)
        # Field names are shortened: v=version, k=key, c=client, s=session
        sync_header = {
            "v": 11,  # sync_version - Latest sync version
            "k": "",  # sync_key - Empty for initial login
            "c": "25.01",  # client_ver - Recent Anki version
            "s": str(uuid.uuid4())  # session_key - Random session ID
        }

        # Prepare the request payload
        payload = {"u": email, "p": password}
        payload_json = json.dumps(payload).encode('utf-8')

        # Compress the payload with zstandard
        compressor = zstd.ZstdCompressor()
        compressed_payload = compressor.compress(payload_json)

        # Send the request
        print(f"Authenticating with AnkiWeb...", file=sys.stderr)
        print(f"Sync header: {json.dumps(sync_header)}", file=sys.stderr)
        print(f"Payload size (compressed): {len(compressed_payload)} bytes", file=sys.stderr)

        response = requests.post(
            url,
            data=compressed_payload,
            headers={
                "Content-Type": "application/octet-stream",
                "anki-sync": json.dumps(sync_header),
                "User-Agent": "Anki"
            },
            timeout=30
        )

        print(f"Response status: {response.status_code}", file=sys.stderr)
        print(f"Response headers: {dict(response.headers)}", file=sys.stderr)
        print(f"Response body: {response.text}", file=sys.stderr)

        if response.status_code == 200:
            # Decompress the response
            try:
                # Try to decompress with zstd
                decompressor = zstd.ZstdDecompressor()
                decompressed = decompressor.decompress(response.content)
                result = json.loads(decompressed.decode('utf-8'))

                print(f"Response: {result}", file=sys.stderr)

                if "key" in result:
                    print(f"✓ Authentication successful!", file=sys.stderr)
                    return {
                        "success": True,
                        "hkey": result["key"]
                    }
            except Exception as e:
                # Maybe it's not compressed or partially compressed
                # Try to extract JSON directly from the response
                try:
                    # Look for JSON in the raw bytes
                    response_text = response.content.decode('utf-8', errors='ignore')
                    # Find the JSON part
                    start = response_text.find('{')
                    end = response_text.rfind('}') + 1
                    if start >= 0 and end > start:
                        json_str = response_text[start:end]
                        result = json.loads(json_str)

                        print(f"Response (extracted): {result}", file=sys.stderr)

                        if "key" in result:
                            print(f"✓ Authentication successful!", file=sys.stderr)
                            return {
                                "success": True,
                                "hkey": result["key"]
                            }
                except Exception as e2:
                    print(f"Failed to extract JSON: {e2}", file=sys.stderr)

                print(f"Failed to parse response: {e}", file=sys.stderr)
                print(f"Raw response: {response.content}", file=sys.stderr)

        # Provide helpful error messages
        if response.status_code == 429:
            return {
                "success": False,
                "error": "Rate limited by AnkiWeb. Please wait 15-30 minutes before trying again."
            }
        elif response.status_code == 403:
            return {
                "success": False,
                "error": "Invalid email or password. Please check your credentials."
            }
        else:
            return {
                "success": False,
                "error": f"Authentication failed with status {response.status_code}: {response.text}"
            }

    except Exception as e:
        import traceback
        return {
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        }

def store_credentials_in_db(email: str, hkey: str) -> bool:
    """
    Store credentials in Anki's profile database (pickled blob)
    """
    try:
        import sqlite3
        import pickle

        conn = sqlite3.connect("/data/prefs21.db")
        cursor = conn.cursor()

        # Get the current profile data for "User 1"
        cursor.execute("SELECT data FROM profiles WHERE name = ?", ("User 1",))
        row = cursor.fetchone()

        if not row:
            print(f"✗ Profile 'User 1' not found", file=sys.stderr)
            return False

        # Unpickle the profile data
        profile_data = pickle.loads(row[0])
        print(f"Profile data before: {list(profile_data.keys())}", file=sys.stderr)

        # Update sync credentials
        profile_data['syncKey'] = hkey
        profile_data['syncUser'] = email

        print(f"Profile data after: syncKey={profile_data.get('syncKey', 'NOT SET')[:10]}..., syncUser={profile_data.get('syncUser')}", file=sys.stderr)

        # Pickle and save back
        updated_blob = pickle.dumps(profile_data, protocol=pickle.HIGHEST_PROTOCOL)
        cursor.execute("UPDATE profiles SET data = ? WHERE name = ?", (updated_blob, "User 1"))

        conn.commit()
        conn.close()

        print(f"✓ Stored credentials in profile database", file=sys.stderr)
        return True

    except Exception as e:
        import traceback
        print(f"✗ Failed to store credentials: {e}", file=sys.stderr)
        print(f"Traceback: {traceback.format_exc()}", file=sys.stderr)
        return False

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Usage: script.py <email> <password> [host]"}))
        sys.exit(1)

    email = sys.argv[1]
    password = sys.argv[2]
    run_from_host = len(sys.argv) > 3 and sys.argv[3] == "host"

    # Authenticate
    result = authenticate_ankiweb(email, password)

    if result["success"]:
        if run_from_host:
            # When run from host, just return the hkey - caller will store it
            print(json.dumps({"success": True, "hkey": result["hkey"], "message": "AnkiWeb authentication successful"}))
        else:
            # When run in container, store in database
            if store_credentials_in_db(email, result["hkey"]):
                print(json.dumps({"success": True, "message": "AnkiWeb authentication successful"}))
            else:
                print(json.dumps({"success": False, "error": "Failed to store credentials"}))
    else:
        print(json.dumps(result))
