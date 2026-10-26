"""
Statistics engine for the Stats tab — a re-creation of Anki's statistics screen
(Today, Future due, Calendar, Reviews, Card counts, Review time, Intervals, Ease,
Hourly breakdown, Answer buttons, True retention, Added) plus Quizlet data.

Data comes from AnkiConnect and is cached per Anki account:
  * card info (type/queue/due/interval/ease/deck) — refreshed incrementally using
    card modification times, so only changed cards are re-fetched;
  * the review log — fetched incrementally by review id.

Aggregation is pure Python over those caches, bucketed into days in the viewer's
timezone with Anki's default 4am day rollover.
"""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

ROLLOVER_HOURS = 4          # Anki's default "next day starts at"
MATURE_IVL = 21             # days; Anki's young/mature threshold
INFO_BATCH = 500
CARD_FIELDS = ("deckName", "type", "queue", "due", "interval", "factor", "reps", "lapses", "mod")

# revlog types
R_LEARN, R_REVIEW, R_RELEARN, R_FILTERED = 0, 1, 2, 3


@dataclass
class Review:
    id: int          # epoch ms
    cid: int
    ease: int        # 1 again .. 4 easy (0 = manual)
    ivl: int         # new interval (days, negative = seconds)
    last_ivl: int
    factor: int
    time_ms: int
    type: int


@dataclass
class CollectionCache:
    cards: dict[int, dict] = field(default_factory=dict)
    reviews: dict[int, Review] = field(default_factory=dict)
    max_review_id: int = 0
    today_due_number: Optional[int] = None   # card.due value meaning "due today"
    refreshed_at: float = 0.0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_caches: dict[str, CollectionCache] = {}
MIN_REFRESH_SECONDS = 15


def _cache_for(key: str) -> CollectionCache:
    if key not in _caches:
        _caches[key] = CollectionCache()
    return _caches[key]


async def refresh(client, force: bool = False) -> CollectionCache:
    """Bring the cache for this Anki account up to date (incremental)."""
    cache = _cache_for(client.url)
    async with cache.lock:
        if not force and time.time() - cache.refreshed_at < MIN_REFRESH_SECONDS:
            return cache
        await _refresh_cards(client, cache)
        await _refresh_reviews(client, cache)
        await _refresh_today_due(client, cache)
        cache.refreshed_at = time.time()
    return cache


async def _refresh_cards(client, cache: CollectionCache):
    ids = await client.request("findCards", timeout=120, query="deck:*")
    ids_set = set(ids)
    for gone in [c for c in cache.cards if c not in ids_set]:
        del cache.cards[gone]

    # Only fetch cards that are new or modified since we last saw them.
    to_fetch: list[int]
    try:
        mods: list[dict] = []
        for i in range(0, len(ids), 5000):
            mods += await client.request("cardsModTime", timeout=120, cards=ids[i:i + 5000])
        to_fetch = [m["cardId"] for m in mods
                    if m["cardId"] not in cache.cards or cache.cards[m["cardId"]].get("mod") != m["mod"]]
    except Exception:
        # Older AnkiConnect without cardsModTime: refetch everything.
        to_fetch = ids

    for i in range(0, len(to_fetch), INFO_BATCH):
        infos = await client.request("cardsInfo", timeout=180, cards=to_fetch[i:i + INFO_BATCH])
        for info in infos:
            if not info:
                continue
            cache.cards[info["cardId"]] = {k: info.get(k) for k in CARD_FIELDS}


async def _refresh_reviews(client, cache: CollectionCache):
    decks = await client.request("deckNames")
    start = cache.max_review_id
    for deck in decks:
        try:
            rows = await client.request("cardReviews", timeout=180, deck=deck, startID=start)
        except Exception:
            continue
        for r in rows or []:
            rid, cid, _usn, ease, ivl, last_ivl, factor, dur, rtype = r
            cache.reviews[rid] = Review(rid, cid, ease, ivl, last_ivl, factor, dur, rtype)
            if rid > cache.max_review_id:
                cache.max_review_id = rid


async def _refresh_today_due(client, cache: CollectionCache):
    """
    Review-card `due` values are day numbers counted from the collection's creation,
    which AnkiConnect doesn't expose. Find the number meaning "today" by binary-searching
    one review card's relative due date with `prop:due<=N` searches.
    """
    probe = next((cid for cid, c in cache.cards.items() if c.get("queue") == 2 and isinstance(c.get("due"), int)), None)
    if probe is None:
        cache.today_due_number = None
        return
    lo, hi = -100_000, 100_000          # relative due day is in [lo, hi]
    while lo < hi:
        mid = (lo + hi) // 2
        found = await client.request("findCards", query=f"cid:{probe} prop:due<={mid}")
        if found:
            hi = mid
        else:
            lo = mid + 1
    cache.today_due_number = cache.cards[probe]["due"] - lo


# --------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------

PERIODS = {"1m": 30, "3m": 91, "1y": 365, "all": None}


class DayClock:
    """Maps timestamps to Anki 'days' in the viewer's timezone (4am rollover)."""

    def __init__(self, tz_name: str):
        try:
            self.tz = ZoneInfo(tz_name)
        except Exception:
            self.tz = timezone.utc
        now = datetime.now(self.tz)
        self.today = (now - timedelta(hours=ROLLOVER_HOURS)).date()
        # Seconds until the next rollover — used for intraday learning cards.
        nxt = datetime.combine(self.today + timedelta(days=1), datetime.min.time(), self.tz) + timedelta(hours=ROLLOVER_HOURS)
        self.next_rollover = nxt.timestamp()

    def day(self, epoch_s: float):
        return (datetime.fromtimestamp(epoch_s, self.tz) - timedelta(hours=ROLLOVER_HOURS)).date()

    def hour(self, epoch_s: float) -> int:
        return datetime.fromtimestamp(epoch_s, self.tz).hour

    def ago(self, d) -> int:
        return (self.today - d).days


def _in_deck(deck_name: Optional[str], scope: Optional[str]) -> bool:
    if not scope:
        return True
    return deck_name == scope or (deck_name or "").startswith(scope + "::")


def review_category(r: Review) -> Optional[str]:
    if r.ease == 0 or r.type > R_FILTERED:
        return None              # manual reschedules aren't reviews
    if r.type == R_LEARN:
        return "learn"
    if r.type == R_RELEARN:
        return "relearn"
    if r.type == R_FILTERED:
        return "filtered"
    return "mature" if r.last_ivl >= MATURE_IVL else "young"


def card_state(c: dict) -> str:
    q, t = c.get("queue"), c.get("type")
    if q == -1:
        return "suspended"
    if q in (-2, -3):
        return "buried"
    if t == 0:
        return "new"
    if t == 1:
        return "learning"
    if t == 3:
        return "relearning"
    return "mature" if (c.get("interval") or 0) >= MATURE_IVL else "young"


def compute_anki(cache: CollectionCache, clock: DayClock, deck: Optional[str], period_days: Optional[int]) -> dict:
    cards = {cid: c for cid, c in cache.cards.items() if _in_deck(c.get("deckName"), deck)}
    # Deck stats only include reviews of cards still in the deck (as in Anki).
    reviews = [r for r in cache.reviews.values() if (r.cid in cards) or (deck is None)]
    reviews.sort(key=lambda r: r.id)

    in_period = (lambda d: True) if period_days is None else (lambda d: clock.ago(d) < period_days)

    today = {"reviews": 0, "seconds": 0.0, "again": 0, "learn": 0, "review": 0, "relearn": 0, "filtered": 0,
             "mature_correct": 0, "mature_total": 0}
    daily: dict[str, dict] = defaultdict(lambda: defaultdict(float))
    calendar: dict[str, int] = defaultdict(int)
    hourly = [{"total": 0, "correct": 0} for _ in range(24)]
    buttons = {k: [0, 0, 0, 0] for k in ("learning", "young", "mature")}
    # True retention: first review of a review card per day.
    seen_day: set[tuple[int, Any]] = set()
    retention_windows = {"today": 1, "yesterday": (1, 2), "week": 7, "month": 30, "year": 365, "all": None}
    retention = {k: {"young_pass": 0, "young_fail": 0, "mature_pass": 0, "mature_fail": 0} for k in retention_windows}

    for r in reviews:
        cat = review_category(r)
        if cat is None:
            continue
        ts = r.id / 1000
        d = clock.day(ts)
        ds = d.isoformat()
        ago = clock.ago(d)
        calendar[ds] += 1
        passed = r.ease > 1

        if ago == 0:
            today["reviews"] += 1
            today["seconds"] += r.time_ms / 1000
            today["again"] += 0 if passed else 1
            today[{"learn": "learn", "relearn": "relearn", "filtered": "filtered"}.get(cat, "review")] += 1
            if cat == "mature":
                today["mature_total"] += 1
                today["mature_correct"] += 1 if passed else 0

        if in_period(d):
            daily[ds][cat] += 1
            daily[ds][cat + "_s"] += r.time_ms / 1000
            h = hourly[clock.hour(ts)]
            h["total"] += 1
            h["correct"] += 1 if passed else 0
            group = "learning" if cat in ("learn", "relearn") else ("mature" if r.last_ivl >= MATURE_IVL else "young")
            if 1 <= r.ease <= 4:
                buttons[group][r.ease - 1] += 1

        if r.type == R_REVIEW and (r.cid, d) not in seen_day:
            seen_day.add((r.cid, d))
            kind = "mature" if r.last_ivl >= MATURE_IVL else "young"
            for name, win in retention_windows.items():
                hit = (win is None or (ago < win if isinstance(win, int) else win[0] <= ago < win[1]))
                if hit:
                    retention[name][f"{kind}_{'pass' if passed else 'fail'}"] += 1

    # Card counts, intervals, ease, future due, added.
    counts = defaultdict(int)
    intervals: dict[int, int] = defaultdict(int)
    ease: dict[int, int] = defaultdict(int)
    future: dict[int, int] = defaultdict(int)
    overdue = 0
    learning_today = 0
    daily_load = 0.0
    added: dict[str, int] = defaultdict(int)
    T = cache.today_due_number
    for cid, c in cards.items():
        st = card_state(c)
        counts[st] += 1
        q, t = c.get("queue"), c.get("type")
        ivl = c.get("interval") or 0
        if t in (2, 3) and ivl > 0:
            intervals[ivl] += 1
        if t in (2, 3) and (c.get("factor") or 0) > 0:
            ease[round(c["factor"] / 50) * 5] += 1     # 5% buckets
        if t != 0 and q not in (-1, -2, -3):
            daily_load += 1 / max(1, ivl)
        if q == 1:                                      # intraday learning: due is an epoch time
            if (c.get("due") or 0) < clock.next_rollover:
                learning_today += 1
            else:
                future[1] += 1
        elif q in (2, 3) and T is not None and isinstance(c.get("due"), int):
            rel = c["due"] - T
            if rel < 0:
                overdue += 1
            else:
                future[rel] += 1
        created = clock.day(cid / 1000)
        if in_period(created):
            added[created.isoformat()] += 1

    total_cards = sum(counts.values())
    ease_n = sum(ease.values())
    return {
        "today": today,
        "calendar": dict(calendar),
        "daily": {k: dict(v) for k, v in daily.items()},
        "hourly": hourly,
        "buttons": buttons,
        "retention": retention,
        "card_counts": {**{k: counts.get(k, 0) for k in ("new", "learning", "relearning", "young", "mature", "suspended", "buried")}, "total": total_cards},
        "intervals": {str(k): v for k, v in sorted(intervals.items())},
        "ease": {str(k): v for k, v in sorted(ease.items())},
        "ease_avg": (sum(k * v for k, v in ease.items()) / ease_n) if ease_n else None,
        "future_due": {
            "days": {str(k): v for k, v in sorted(future.items())},
            "overdue": overdue,
            "learning_today": learning_today,
            "daily_load": round(daily_load),
            "known": T is not None,
        },
        "added": dict(added),
    }


def compute_quizlet(rows: list[tuple], cards: list[dict], levels: dict[int, int], clock: DayClock,
                    period_days: Optional[int]) -> dict:
    """
    rows:   (card_id, deck_id, ease, reviewed_at 'YYYY-MM-DD HH:MM:SS' UTC) — ease 2 = correct, 1 = missed
    cards:  [{id, deck_id, front, back}] in scope
    levels: card_id -> Learn level (0 new, 1 learning, 2 familiar, 3 mastered)
    """
    in_period = (lambda d: True) if period_days is None else (lambda d: clock.ago(d) < period_days)
    card_ids = {c["id"] for c in cards}
    calendar: dict[str, int] = defaultdict(int)
    daily: dict[str, int] = defaultdict(int)
    hourly = [{"total": 0, "correct": 0} for _ in range(24)]
    today = {"answers": 0, "correct": 0}
    per_card: dict[int, list[int]] = defaultdict(lambda: [0, 0])  # attempts, misses
    period_total = period_correct = 0
    for cid, _did, ease, at in rows:
        if cid not in card_ids:
            continue
        try:
            ts = datetime.strptime(at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
        except (TypeError, ValueError):
            continue
        d = clock.day(ts)
        ds = d.isoformat()
        ok = ease >= 2
        calendar[ds] += 1
        if clock.ago(d) == 0:
            today["answers"] += 1
            today["correct"] += 1 if ok else 0
        if in_period(d):
            daily[ds] += 1
            h = hourly[clock.hour(ts)]
            h["total"] += 1
            h["correct"] += 1 if ok else 0
            period_total += 1
            period_correct += 1 if ok else 0
            pc = per_card[cid]
            pc[0] += 1
            pc[1] += 0 if ok else 1

    mastery = {"not_studied": 0, "learning": 0, "familiar": 0, "mastered": 0}
    for c in cards:
        lvl = levels.get(c["id"], 0)
        mastery[["not_studied", "learning", "familiar", "mastered"][max(0, min(3, lvl))]] += 1

    by_id = {c["id"]: c for c in cards}
    hardest = sorted(((cid, a, m) for cid, (a, m) in per_card.items() if m > 0),
                     key=lambda x: (-x[2] / x[1], -x[2]))[:10]
    return {
        "today": today,
        "calendar": dict(calendar),
        "daily": dict(daily),
        "hourly": hourly,
        "accuracy": {"total": period_total, "correct": period_correct},
        "mastery": {**mastery, "total": len(cards)},
        "hardest": [{"id": cid, "front": by_id[cid]["front"], "back": by_id[cid]["back"], "attempts": a, "misses": m}
                    for cid, a, m in hardest],
    }
