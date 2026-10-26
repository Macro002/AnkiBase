import httpx
from typing import Any


class AnkiError(Exception):
    """An error reported by Anki (anki-cli), with its v1 error type when known."""

    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.code = code


class AnkiConnectClient:
    """One account's collection on the anki-cli engine, through AnkiConnect's protocol
    (`request`) or anki-cli's v1 API (`rpc`)."""

    def __init__(self, url: str, key: str | None = None):
        self.url = url if url.endswith("/") else url + "/"
        self.key = key
        self.version = 6

    async def request(self, action: str, timeout: float = 30.0, **params) -> Any:
        """Make a request with AnkiConnect's protocol."""
        payload = {"action": action, "version": self.version}
        if params:
            payload["params"] = params
        if self.key:
            payload["key"] = self.key

        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(self.url, json=payload)
            response.raise_for_status()
            result = response.json()

            if result.get("error"):
                raise AnkiError(result["error"])

            return result.get("result")

    async def rpc(self, method: str, timeout: float = 30.0, **params) -> Any:
        """Call an anki-cli v1 method (sync.run, sync.login, …)."""
        headers = {"Authorization": f"Bearer {self.key}"} if self.key else {}
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(self.url + "api/v1", headers=headers,
                                         json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            response.raise_for_status()
            reply = response.json()
        if "error" in reply:
            error = reply["error"]
            raise AnkiError(error.get("message", "Anki error"), (error.get("data") or {}).get("type", ""))
        return reply["result"]

    # Deck operations
    async def get_deck_names(self) -> list[str]:
        return await self.request("deckNames")

    async def get_deck_names_and_ids(self) -> dict[str, int]:
        return await self.request("deckNamesAndIds")

    async def get_deck_stats(self, decks: list[str]) -> dict:
        return await self.request("getDeckStats", decks=decks)

    # Card operations
    async def find_cards(self, query: str) -> list[int]:
        return await self.request("findCards", query=query)

    async def get_cards_info(self, cards: list[int]) -> list[dict]:
        return await self.request("cardsInfo", cards=cards)

    async def answer_card(self, card_id: int, ease: int) -> bool:
        """Answer a card. ease: 1=Again, 2=Hard, 3=Good, 4=Easy"""
        return await self.request("answerCards", answers=[{"cardId": card_id, "ease": ease}])

    # Note operations
    async def find_notes(self, query: str) -> list[int]:
        return await self.request("findNotes", query=query)

    async def get_notes_info(self, notes: list[int]) -> list[dict]:
        return await self.request("notesInfo", notes=notes)

    async def add_note(self, deck_name: str, model_name: str, fields: dict, tags: list[str] = None) -> int:
        note = {
            "deckName": deck_name,
            "modelName": model_name,
            "fields": fields,
            "options": {"allowDuplicate": False},
            "tags": tags or [],
        }
        return await self.request("addNote", note=note)

    async def add_notes(self, notes: list[dict]) -> list[int | None]:
        return await self.request("addNotes", notes=notes)

    async def create_deck(self, deck_name: str) -> int:
        return await self.request("createDeck", deck=deck_name)

    # Study operations
    async def get_due_cards(self, deck: str, limit: int = 50) -> list[int]:
        """Get cards due for review in a deck, sorted by scheduler order.

        Includes both new cards and cards due for review (includes subdecks).
        """
        # Get all cards that should be studied (new + due)
        # Note: deck:X includes X and all subdecks like X::Y
        all_card_ids = await self.request("findCards", query=f'deck:"{deck}" (is:new OR is:due)')

        if not all_card_ids:
            return []

        # Get card info to sort by scheduler priority
        cards_info = await self.get_cards_info(all_card_ids)

        # Sort by scheduler priority:
        # 1. Learning cards (queue=1) - sorted by due (timestamp)
        # 2. Day learning cards (queue=3) - sorted by due
        # 3. Review cards (queue=2) - sorted by due (days)
        # 4. New cards (queue=0) - sorted by due (position)
        def sort_key(card):
            queue = card.get('queue', 0)
            due = card.get('due', 0)
            card_id = card.get('cardId', 0)

            # Priority order: learning (1), day learning (3), review (2), new (0)
            priority_map = {1: 0, 3: 1, 2: 2, 0: 3}
            priority = priority_map.get(queue, 4)

            return (priority, due, card_id)

        sorted_cards = sorted(cards_info, key=sort_key)
        sorted_ids = [card['cardId'] for card in sorted_cards]

        # Return limited subset
        return sorted_ids[:limit] if limit else sorted_ids

    async def get_next_due_card(self, deck: str) -> int | None:
        """Get the next card due for review in a deck."""
        cards = await self.get_due_cards(deck, limit=1)
        return cards[0] if cards else None

    async def get_new_cards(self, deck: str) -> list[int]:
        """Get new cards in a deck (includes subdecks).

        Note: deck:X includes X and all subdecks like X::Y
        """
        return await self.request("findCards", query=f'deck:"{deck}" is:new')

    # Sync (AnkiWeb or a self-hosted server, with the login stored by sync.login)
    async def sync(self) -> dict:
        """A normal sync. One-way full syncs (an empty side) happen automatically; when both
        sides changed, the result's outcome is "fullSyncRequired" and nothing is changed."""
        return await self.rpc("sync.run", timeout=600.0, mode="auto")

    async def full_upload(self) -> dict:
        """Replace the server's copy with this collection."""
        return await self.rpc("sync.run", timeout=600.0, mode="upload")

    async def full_download(self) -> dict:
        """Replace this collection with the server's copy."""
        return await self.rpc("sync.run", timeout=600.0, mode="download")

    # Media
    async def retrieve_media_file(self, filename: str) -> str | None:
        """Get a media file as base64. Returns None if not found."""
        try:
            return await self.request("retrieveMediaFile", filename=filename)
        except:
            return None

    # Models
    async def get_model_names(self) -> list[str]:
        return await self.request("modelNames")

    async def get_model_field_names(self, model_name: str) -> list[str]:
        return await self.request("modelFieldNames", modelName=model_name)

    # Import/Export
    async def import_package(self, path: str) -> None:
        """Import an .apkg file from a path on this server."""
        return await self.request("importPackage", timeout=600.0, path=path)

    # Deck management
    async def delete_decks(self, deck_names: list[str]) -> None:
        """Delete decks and their cards."""
        return await self.request("deleteDecks", decks=deck_names, cardsToo=True)

    async def create_deck(self, deck_name: str) -> int:
        """Create a new deck."""
        return await self.request("createDeck", deck=deck_name)

    async def change_deck(self, card_ids: list[int], deck_name: str) -> None:
        """Move cards to a different deck."""
        return await self.request("changeDeck", cards=card_ids, deck=deck_name)

    async def update_note_fields(self, note_id: int, fields: dict) -> None:
        """Update some fields of an existing note."""
        return await self.request("updateNoteFields", note={"id": note_id, "fields": fields})

    # Review history
    async def get_card_reviews(self, deck: str, start_id: int = 0) -> list:
        """Get review history for a deck."""
        return await self.request("cardReviews", deck=deck, startID=start_id)

    async def get_num_cards_reviewed_today(self) -> int:
        """Get number of cards reviewed today."""
        return await self.request("getNumCardsReviewedToday")

    async def get_collection_stats_html(self) -> str:
        """Get collection statistics as HTML."""
        return await self.request("getCollectionStatsHTML")

    # GUI operations
    async def gui_undo(self) -> bool:
        """Undo the last action."""
        return await self.request("guiUndo")

    async def gui_play_audio(self) -> bool:
        """Play audio for current card."""
        return await self.request("guiPlayAudio")
