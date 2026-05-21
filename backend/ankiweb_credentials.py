"""
AnkiWeb credentials management with encryption
"""
import os
import json
from pathlib import Path
from cryptography.fernet import Fernet
from typing import Optional


class AnkiWebCredentials:
    def __init__(self, container_name: Optional[str] = None):
        base_dir = Path(__file__).parent
        if container_name:
            container_dir = base_dir / "data" / container_name
            container_dir.mkdir(parents=True, exist_ok=True)
            self.credentials_file = container_dir / ".credentials"
        else:
            # Legacy path — used only for migration
            self.credentials_file = base_dir / ".credentials"
        self.encryption_key = self._get_or_create_key()
        self.fernet = Fernet(self.encryption_key)

    def _get_or_create_key(self) -> bytes:
        """Get encryption key from environment or generate new one"""
        key_env = os.getenv("ANKIWEB_ENCRYPTION_KEY")
        if key_env:
            return key_env.encode()

        # Generate a new key
        key = Fernet.generate_key()
        print(f"WARNING: Generated new encryption key. Set ANKIWEB_ENCRYPTION_KEY={key.decode()} in .env")
        return key

    def save_credentials(self, email: str, password: str) -> None:
        """Encrypt and save AnkiWeb credentials"""
        data = json.dumps({"email": email, "password": password})
        encrypted = self.fernet.encrypt(data.encode())

        self.credentials_file.write_bytes(encrypted)
        print(f"Credentials saved to {self.credentials_file}")

    def load_credentials(self) -> Optional[dict]:
        """Load and decrypt AnkiWeb credentials"""
        if not self.credentials_file.exists():
            return None

        try:
            encrypted = self.credentials_file.read_bytes()
            decrypted = self.fernet.decrypt(encrypted)
            return json.loads(decrypted.decode())
        except Exception as e:
            print(f"Failed to load credentials: {e}")
            return None

    def has_credentials(self) -> bool:
        """Check if credentials are stored"""
        return self.credentials_file.exists()

    def delete_credentials(self) -> None:
        """Delete stored credentials"""
        if self.credentials_file.exists():
            self.credentials_file.unlink()
            print("Credentials deleted")
