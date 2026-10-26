"""
Studying an Anki deck through Anki's own reviewer (AnkiConnect's gui* actions), so card
order, daily limits, learning steps and burying are exactly Anki's — and each step is one
cheap call instead of rendering every due card.

If the reviewer isn't available (no GUI), `legacy_next` picks the next card with a few
targeted searches instead.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from typing import Optional

_css_cache: dict[tuple[str, str], str] = {}


async def model_css(client, model: str) -> str:
    key = (client.url, model)
    if key not in _css_cache:
        try:
            r = await client.request("modelStyling", modelName=model)
            _css_cache[key] = (r or {}).get("css", "")
        except Exception:
            _css_cache[key] = ""
    return _css_cache[key]


async def counts(client, deck: str) -> dict:
    """New / learning / review counts as Anki shows them for the deck (daily limits applied)."""
    try:
        stats = await client.request("getDeckStats", decks=[deck])
        s = next(iter(stats.values()), {}) if stats else {}
        return {"new": s.get("new_count", 0), "learn": s.get("learn_count", 0), "review": s.get("review_count", 0)}
    except Exception:
        return {"new": 0, "learn": 0, "review": 0}


async def _payload(client, cur: dict, deck: str) -> dict:
    return {
        "card_id": cur.get("cardId"),
        "question": cur.get("question", ""),
        "answer": cur.get("answer", ""),
        "css": cur.get("css") or await model_css(client, cur.get("modelName", "")),
        "model": cur.get("modelName"),
        "deck": cur.get("deckName") or deck,
        "buttons": cur.get("buttons") or [1, 2, 3, 4],
        # Anki wraps interval numbers in invisible bidi marks ("<⁨10⁩m"); drop them.
        "next_reviews": [str(x).replace("\u2068", "").replace("\u2069", "") for x in (cur.get("nextReviews") or [])],
        "fields": _ordered_fields(cur.get("fields")),
    }


def _ordered_fields(fields: Optional[dict]) -> list[dict]:
    items = sorted((fields or {}).items(), key=lambda kv: kv[1].get("order", 0))
    return [{"name": k, "value": v.get("value", "")} for k, v in items]


def _in_deck(card_deck: Optional[str], deck: str) -> bool:
    return bool(card_deck) and (card_deck == deck or card_deck.startswith(deck + "::"))


async def current(client, deck: str, restart: bool = False) -> dict:
    """
    The reviewer's current card for `deck` (opening the deck in the reviewer when needed).
    Returns {"card": payload | None, "counts": {...}, "mode": "reviewer"}.
    """
    cur = None if restart else await client.request("guiCurrentCard")
    if not cur or not _in_deck(cur.get("deckName"), deck):
        await client.request("guiDeckReview", name=deck)
        cur = await client.request("guiCurrentCard")
    c = await counts(client, deck)
    return {"card": await _payload(client, cur, deck) if cur and _in_deck(cur.get("deckName"), deck) else None,
            "counts": c, "mode": "reviewer"}


async def answer(client, deck: str, card_id: int, ease: int) -> dict:
    """Answer the reviewer's current card (it must be `card_id`) and return the next one."""
    cur = await client.request("guiCurrentCard")
    if not cur or cur.get("cardId") != card_id:
        # The reviewer moved on (another tab, a restart…) — don't answer the wrong card.
        return await current(client, deck, restart=not cur)
    await client.request("guiShowAnswer")
    ok = await client.request("guiAnswerCard", ease=ease)
    if not ok:
        raise RuntimeError("Anki didn't accept the answer")
    return await current(client, deck)


async def undo(client, deck: str) -> dict:
    await client.request("guiUndo")
    return await current(client, deck)


# --- fallback without the reviewer ---------------------------------------------------

async def legacy_next(client, deck: str) -> dict:
    """Next card by priority (learning due → reviews due → new), touching only a few cards."""
    q = f'deck:"{deck}" -is:suspended -is:buried'
    for query, key in ((f"{q} is:learn is:due", "due"), (f"{q} is:review is:due", "due"), (f"{q} is:new", "due")):
        ids = await client.request("findCards", query=query)
        if not ids:
            continue
        infos = await client.request("cardsInfo", cards=ids[:50])
        infos.sort(key=lambda c: (c.get(key, 0), c.get("cardId", 0)))
        c = infos[0]
        return {"card": {
            "card_id": c["cardId"], "question": c.get("question", ""), "answer": c.get("answer", ""),
            "css": c.get("css", ""), "model": c.get("modelName"), "deck": c.get("deckName"),
            "buttons": [1, 2, 3, 4], "next_reviews": [],
            "fields": _ordered_fields(c.get("fields")),
        }, "counts": await counts(client, deck), "mode": "legacy"}
    return {"card": None, "counts": await counts(client, deck), "mode": "legacy"}


# --- signed media URLs ------------------------------------------------------------------

MEDIA_TTL = 12 * 3600


def media_token(secret: str, user_id: int) -> str:
    """Token for <img src> inside the sandboxed card frame, which can't send the session cookie."""
    exp = int(time.time()) + MEDIA_TTL
    sig = hmac.new(secret.encode(), f"{user_id}:{exp}".encode(), hashlib.sha256).hexdigest()[:32]
    return f"{user_id}.{exp}.{sig}"


def check_media_token(secret: str, token: str) -> bool:
    try:
        uid, exp, sig = token.split(".")
        if int(exp) < time.time():
            return False
        good = hmac.new(secret.encode(), f"{uid}:{exp}".encode(), hashlib.sha256).hexdigest()[:32]
        return hmac.compare_digest(good, sig)
    except (ValueError, AttributeError):
        return False


def decode_media(data_b64: str) -> bytes:
    return base64.b64decode(data_b64)
