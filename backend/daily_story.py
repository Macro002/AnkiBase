"""The daily story (Story → New story every day): a new story each day, written from the
words and settings the Story tab was set to when it was turned on, but only once the
newest story has been read (Reading → Mark as read).

Each profile keeps its settings in its stories database ("daily": enabled, the user who
turned it on, their timezone and the recipe). A loop checks every few minutes; marking a
story read checks right away.
"""
import asyncio
import os
import random
import time
from datetime import date, datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from database import (
    get_account_db_path, get_all_accounts, get_story_setting, get_user,
    get_user_accessible_containers, latest_story,
)
from security import can, current_profile

CHECK_EVERY = 10 * 60
# After a try that failed (Anki starting, the AI down…), wait before the next one.
RETRY_AFTER = 30 * 60

_last_try: dict[str, float] = {}
_running: set[str] = set()


def pick_weighted(data: dict, weights: dict, count: int) -> list[str]:
    """`count` words with each card category's share proportional to its weight (as the
    Story tab's smart pick, Story.tsx pickWeighted)."""
    by: dict[str, list[str]] = {}
    for word in data.get("words", []):
        by.setdefault(data.get("categories", {}).get(word) or "new", []).append(word)
    cats = sorted((c for c, w in weights.items() if w > 0), key=lambda c: -weights[c])
    total = sum(weights[c] for c in cats)
    if not total:
        return []
    take: dict[str, int] = {}
    left = count
    for c in cats:
        take[c] = min(-(-weights[c] * count // total), len(by.get(c, [])), left)
        left -= take[c]
    for c in cats:
        more = min(len(by.get(c, [])) - take[c], left)
        if more > 0:
            take[c] += more
            left -= more
    return [w for c in cats for w in random.sample(by.get(c, []), take[c])]


def pick_quizlet(data: dict, starred_first: bool, missed_first: bool, count: int) -> list[str]:
    """Starred terms first, then the most missed, then random (Story.tsx pickQuizlet)."""
    out: list[str] = []

    def add(words):
        for w in words:
            if len(out) < count and w not in out:
                out.append(w)

    if starred_first:
        add(random.sample(data.get("starred") or [], len(data.get("starred") or [])))
    if missed_first:
        add(w for w, _ in sorted((data.get("missed") or {}).items(), key=lambda kv: -kv[1]))
    add(random.sample(data.get("words", []), len(data.get("words", []))))
    return out


def _today(tz: str) -> date:
    try:
        zone = ZoneInfo(tz)
    except Exception:
        zone = timezone.utc
    return datetime.now(zone).date()


def _day_of(created_at: str, tz: str) -> Optional[date]:
    """The local day of a stored UTC timestamp ("YYYY-MM-DD HH:MM:SS")."""
    try:
        when = datetime.fromisoformat(str(created_at)).replace(tzinfo=timezone.utc)
        return when.astimezone(ZoneInfo(tz)).date()
    except Exception:
        return None


def _due(container: str) -> Optional[dict]:
    """The daily settings if a story should be written now: it's on, nothing was written
    today, and the newest story has been read (or there's none)."""
    if not os.path.exists(get_account_db_path(container)):
        return None
    config = get_story_setting("daily", container)
    if not config or not config.get("enabled") or not config.get("recipe"):
        return None
    tz = config.get("tz") or "UTC"
    newest = latest_story(container)
    if newest:
        if _day_of(newest["created_at"], tz) == _today(tz):
            return None
        if not newest["read_at"]:
            return None
    return config


async def _request_for(config: dict, user: dict):
    """The Story tab's request, with today's words picked from the recipe's source."""
    from main import StoryRequest, get_anki_client, get_deck_words
    from database import get_quizlet_set_words
    recipe = config["recipe"]
    source = recipe.get("source")
    count = int(recipe.get("count") or 15)
    words: list[str] = []
    word_data: dict = {}
    if source == "anki" and recipe.get("deck"):
        data = await get_deck_words(deck_name=recipe["deck"], limit=500, field=recipe.get("field") or "",
                                    client=get_anki_client(), _=user)
        words = pick_weighted(data, recipe.get("weights") or {}, count)
        word_data = data.get("word_data") or {}
    elif source == "quizlet" and recipe.get("set"):
        data = get_quizlet_set_words(user["id"], int(recipe["set"]),
                                     "definition" if recipe.get("side") == "definition" else "term")
        if data:
            words = pick_quizlet(data, recipe.get("q_starred", True), recipe.get("q_missed", True), count)
            word_data = data.get("word_data") or {}
    # The words typed in yourself ("My words", or added to the picked ones).
    words = list(dict.fromkeys(words + [w for w in recipe.get("words") or [] if w]))
    if not words:
        return None
    return StoryRequest(
        words=words,
        word_data={w: word_data[w] for w in words if w in word_data} or None,
        style=recipe.get("style") or "casual",
        custom_instructions=recipe.get("custom_instructions"),
        length=recipe.get("length") or "auto",
        language=recipe.get("language") or "auto",
        target_language=recipe.get("target_language"),
        level=recipe.get("level"),
        provider=recipe.get("provider"),
        model=recipe.get("model"),
        deck_name=recipe.get("deck_name"),
        lookup_fields=recipe.get("lookup_fields"),
    )


async def run(account: dict, force: bool = False) -> None:
    """Write the profile's daily story if one is due. `force`: don't wait out a failed try
    (a story was just marked read, or the setting was just turned on)."""
    container = account["container_name"]
    if container in _running or (not force and time.time() - _last_try.get(container, 0) < RETRY_AFTER):
        return
    token = current_profile.set(account)
    _running.add(container)
    try:
        config = _due(container)
        if not config:
            return
        _last_try[container] = time.time()
        # Whoever turned it on must still be allowed to use the AI on this profile.
        user = get_user(config.get("user_id"))
        if not user or not can(user, "use_ai"):
            return
        if account["id"] not in {p["id"] for p in get_user_accessible_containers(user["id"])}:
            return
        request = await _request_for(config, user)
        if request is None:
            print(f"Daily story ({container}): no words to write with")
            return
        from main import write_story
        result = await write_story(request)
        print(f"Daily story ({container}): wrote \"{result['title']}\"")
    except Exception as e:
        print(f"Daily story ({container}) failed: {e}")
    finally:
        _running.discard(container)
        current_profile.reset(token)


_tasks: set[asyncio.Task] = set()


def kick(account: Optional[dict]) -> None:
    """Check this profile now, in the background (a story was marked read, or the setting
    was turned on)."""
    if not account:
        return
    task = asyncio.create_task(run(account, force=True))
    _tasks.add(task)  # asyncio only keeps a weak reference
    task.add_done_callback(_tasks.discard)


async def loop() -> None:
    """Check every profile every few minutes (started with the server)."""
    await asyncio.sleep(60)  # let the Anki engine start
    while True:
        try:
            for account in get_all_accounts():
                await run(account)
        except Exception as e:
            print(f"Daily story check failed: {e}")
        await asyncio.sleep(CHECK_EVERY)
