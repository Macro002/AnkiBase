#!/usr/bin/env python3
"""
Trigger a full sync download from AnkiWeb
This is needed when the local collection is empty and needs to download from AnkiWeb
"""
import sys
import os

# Add Anki to path
anki_path = "/usr/share/anki"
if os.path.exists(anki_path):
    sys.path.insert(0, anki_path)

from anki import Collection
from anki.sync import SyncAuth


def full_download(col_path: str, hkey: str) -> bool:
    """
    Perform a full download from AnkiWeb

    Args:
        col_path: Path to collection.anki2
        hkey: AnkiWeb host key

    Returns:
        True if successful
    """
    try:
        print(f"Opening collection: {col_path}")
        col = Collection(col_path)

        # Create sync auth
        auth = SyncAuth(hkey=hkey)

        print("Starting full download from AnkiWeb...")

        # Close collection for full sync
        col.close(downgrade=False)

        # Reopen and do full download
        col = Collection(col_path)
        result = col.full_upload_or_download(auth=auth, upload=False)

        col.close(save=True)

        print(f"✓ Full download completed")
        return True

    except Exception as e:
        import traceback
        print(f"✗ Full download failed: {e}")
        print(traceback.format_exc())
        return False


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: script.py <collection_path> <hkey>")
        sys.exit(1)

    col_path = sys.argv[1]
    hkey = sys.argv[2]

    success = full_download(col_path, hkey)
    sys.exit(0 if success else 1)
