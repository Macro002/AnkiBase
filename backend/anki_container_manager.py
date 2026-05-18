"""
Anki Container Manager
Handles Docker container lifecycle for multiple Anki accounts
"""
import subprocess
import os
from typing import Optional
from database import (
    add_account,
    get_account,
    get_all_accounts,
    get_active_account,
    set_active_account,
    delete_account,
    get_next_available_port,
    get_account_by_email
)


class AnkiContainerManager:
    def __init__(self):
        self.base_image = "thisisnttheway/headless-anki:latest"

    def create_account(self, container_name: str) -> dict:
        """
        Create a new Anki account with its own container

        Args:
            container_name: Name for the container

        Returns:
            Account dict with container info
        """
        # Get next available resources
        port = get_next_available_port()
        account_id = len(get_all_accounts()) + 1

        # Use provided name as container name
        # Generate unique volume name based on container name
        volume_name = f"ankibase_{container_name.replace(' ', '-').lower()}"

        # Create Docker volume
        result = subprocess.run(
            ["docker", "volume", "create", volume_name],
            capture_output=True,
            text=True
        )
        if result.returncode != 0:
            raise Exception(f"Failed to create volume: {result.stderr}")

        # Create export directory for this container
        export_dir = f"/opt/ankibase/containers/{container_name}/export"
        os.makedirs(export_dir, exist_ok=True)

        # Start container
        result = subprocess.run([
            "docker", "run", "-d",
            "--name", container_name,
            "-p", f"{port}:8765",
            "-v", f"{volume_name}:/data",
            "-v", f"{export_dir}:/export",
            "--restart", "unless-stopped",
            self.base_image
        ], capture_output=True, text=True)

        if result.returncode != 0:
            # Cleanup volume on failure
            subprocess.run(["docker", "volume", "rm", volume_name], capture_output=True)
            raise Exception(f"Failed to start container: {result.stderr}")

        # Add to database with placeholder email
        placeholder_email = f"{container_name.replace(' ', '-').lower()}@ankibase.local"
        account_db_id = add_account(placeholder_email, container_name, port, volume_name)

        # If this is the first account, make it active
        if account_id == 1:
            set_active_account(account_db_id)

        return get_account(account_db_id)

    def delete_account(self, account_id: int, remove_data: bool = False) -> bool:
        """
        Delete an account and optionally its data

        Args:
            account_id: Account ID to delete
            remove_data: If True, also removes the Docker volume with all data

        Returns:
            True if successful
        """
        account = get_account(account_id)
        if not account:
            return False

        # Stop and remove container
        subprocess.run(["docker", "stop", account["container_name"]], capture_output=True)
        subprocess.run(["docker", "rm", account["container_name"]], capture_output=True)

        # Optionally remove volume
        if remove_data:
            subprocess.run(["docker", "volume", "rm", account["volume_name"]], capture_output=True)

        # Remove from database
        delete_account(account_id)

        # If this was the active account, activate the first remaining one
        if account["is_active"]:
            remaining = get_all_accounts()
            if remaining:
                set_active_account(remaining[0]["id"])

        return True

    def switch_account(self, account_id: int) -> bool:
        """
        Switch to a different account

        Args:
            account_id: Account ID to switch to

        Returns:
            True if successful
        """
        account = get_account(account_id)
        if not account:
            return False

        # Make sure container is running
        result = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", account["container_name"]],
            capture_output=True,
            text=True
        )

        if result.returncode != 0 or result.stdout.strip() != "true":
            # Container not running, start it
            subprocess.run(
                ["docker", "start", account["container_name"]],
                capture_output=True
            )

        # Set as active
        set_active_account(account_id)
        return True

    def restart_container(self, account_id: int) -> bool:
        """
        Restart a container

        Args:
            account_id: Account ID to restart

        Returns:
            True if successful
        """
        account = get_account(account_id)
        if not account:
            return False

        # Restart the container
        result = subprocess.run(
            ["docker", "restart", account["container_name"]],
            capture_output=True,
            text=True
        )

        return result.returncode == 0

    def get_active_account(self) -> Optional[dict]:
        """Get the currently active account"""
        return get_active_account()

    def list_accounts(self) -> list[dict]:
        """List all accounts"""
        return get_all_accounts()

    def get_account_info(self, account_id: int) -> Optional[dict]:
        """Get account info including container status"""
        account = get_account(account_id)
        if not account:
            return None

        # Check container status
        result = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", account["container_name"]],
            capture_output=True,
            text=True
        )

        account["container_running"] = result.returncode == 0 and result.stdout.strip() == "true"
        return account
