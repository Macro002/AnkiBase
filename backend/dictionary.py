"""
Dictionary lookups for the Search tab, from English Wiktionary (all languages, free,
no key) with Jisho on top for Japanese.

Wiktionary's rendered page HTML is parsed into a compact structure: per language —
pronunciation (IPA + audio), etymology, and entries (part of speech, headword,
gender, inflected forms, senses with examples, synonyms/related words). Sense text is
returned as segments (plain text or a link to another headword) so the UI can make
linked words clickable without ever rendering Wiktionary HTML.
"""

from __future__ import annotations

import asyncio
import re
import time
import unicodedata
from typing import Optional
from urllib.parse import quote, unquote

import httpx
from bs4 import BeautifulSoup, NavigableString, Tag

UA = "AnkiBase/1.0 (self-hosted study app; https://github.com/Macro002/AnkiBase)"
WIKT = "https://en.wiktionary.org"
CACHE_TTL = 24 * 3600
_cache: dict[str, tuple[float, object]] = {}

POS = {
    "Noun", "Verb", "Adjective", "Adverb", "Pronoun", "Preposition", "Conjunction", "Interjection",
    "Participle", "Article", "Determiner", "Numeral", "Proper noun", "Phrase", "Prepositional phrase",
    "Suffix", "Prefix", "Particle", "Counter", "Contraction", "Abbreviation", "Idiom", "Proverb",
    "Adnominal", "Auxiliary", "Classifier", "Postposition", "Interrogative pronoun", "Personal pronoun",
}
RELATED = {"Synonyms": "synonyms", "Antonyms": "antonyms", "Derived terms": "derived", "Related terms": "related"}


def fold(s: str) -> str:
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.replace("œ", "oe").replace("æ", "ae").replace("’", "'")


def _cached(key: str):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    return None


def _store(key: str, value):
    if len(_cache) > 1000:
        for k in sorted(_cache, key=lambda k: _cache[k][0])[:200]:
            _cache.pop(k, None)
    _cache[key] = (time.time(), value)
    return value


# --- HTML -> data -----------------------------------------------------------

def _heading_text(sec: Tag) -> str:
    h = sec.find(["h2", "h3", "h4", "h5", "h6"], recursive=False)
    return h.get_text(" ", strip=True) if h else ""


def _link_target(a: Tag, foreign_only: bool = False) -> Optional[str]:
    """Headword a wiki link points at. With foreign_only, only links into a non-English
    entry (./manger#French) count — English glosses like "cat" aren't worth following."""
    href = a.get("href") or ""
    if not href.startswith("./") or ":" in href.split("#")[0][2:]:
        return None   # external links, categories, templates, files
    if "new" in (a.get("class") or []) or "redlink=1" in href or "?" in href:
        return None   # "redlinks" to pages that don't exist yet
    page, _, anchor = href[2:].partition("#")
    if foreign_only and (not anchor or anchor == "English"):
        return None
    return unquote(page).replace("_", " ")


def _segments(node: Tag) -> list[dict]:
    """Flatten a definition into [{'t': text}|{'t': text, 'w': linked word}], dropping nested examples/lists."""
    out: list[dict] = []

    def walk(n):
        for ch in n.children:
            if isinstance(ch, NavigableString):
                if str(ch).strip() or str(ch) == " ":
                    out.append({"t": str(ch)})
            elif isinstance(ch, Tag):
                if ch.name in ("dl", "ul", "ol", "sup", "style", "link", "meta") or "reference" in (ch.get("class") or []):
                    continue
                if ch.name == "a":
                    word = _link_target(ch, foreign_only=True)
                    text = ch.get_text()
                    if text:
                        out.append({"t": text, "w": word} if word else {"t": text})
                else:
                    walk(ch)

    walk(node)
    # merge adjacent text and tidy whitespace
    merged: list[dict] = []
    for s in out:
        if merged and "w" not in s and "w" not in merged[-1]:
            merged[-1]["t"] += s["t"]
        else:
            merged.append(dict(s))
    for s in merged:
        s["t"] = re.sub(r"\s+", " ", s["t"])
    while merged and not merged[0]["t"].strip():
        merged.pop(0)
    if merged:
        merged[0]["t"] = merged[0]["t"].lstrip()
        merged[-1]["t"] = merged[-1]["t"].rstrip()
    return [s for s in merged if s["t"]]


def _examples(li: Tag) -> list[dict]:
    out = []
    for dd in li.find_all("dd", recursive=True):
        if dd.find_parent("li") is not li:
            continue
        ex = dd.find(class_="e-example")
        if not ex:
            continue
        tr = dd.find(class_="e-translation")
        clean = lambda el: re.sub(r"\s+", " ", el.get_text("")).strip()
        out.append({"text": clean(ex), "translation": clean(tr) if tr else None})
        if len(out) >= 3:
            break
    return out


def _parse_entry(sec: Tag, pos: str) -> Optional[dict]:
    head = sec.find(class_="headword-line") or sec.find("strong", class_="headword")
    headword = None
    gender = None
    forms: list[dict] = []
    if head:
        hw = head.find("strong", class_=re.compile("headword")) if head.name != "strong" else head
        headword = hw.get_text(strip=True) if hw else None
        g = head.find(class_="gender")
        gender = g.get_text(" ", strip=True) if g else None
        # "(plural étés)" / "(feminine X, masculine plural Y)": label in <i>, form in <b>
        label = None
        for el in head.descendants:
            if isinstance(el, Tag) and el.name == "i":
                label = el.get_text(" ", strip=True)
            elif isinstance(el, Tag) and el.name == "b" and "form-of" in " ".join(el.get("class") or []):
                forms.append({"label": label or "", "form": el.get_text(strip=True)})
        forms = forms[:6]
    ol = sec.find("ol", recursive=False) or sec.find("ol")
    senses = []
    if ol:
        for li in ol.find_all("li", recursive=False):
            segs = _segments(li)
            if not segs:
                continue
            # "inflection of manger:" — the actual forms live in a nested list.
            if segs[-1]["t"].rstrip().endswith(":"):
                sub = li.find(["ol", "ul"])
                if sub:
                    parts = [re.sub(r"\s+", " ", x.get_text(" ", strip=True)) for x in sub.find_all("li", recursive=False)][:4]
                    if parts:
                        segs.append({"t": " " + "; ".join(parts)})
            senses.append({"segments": segs, "examples": _examples(li)})
            if len(senses) >= 12:
                break
    if not senses:
        return None
    related: dict[str, list[str]] = {}
    for sub in sec.find_all("section", recursive=False):
        key = RELATED.get(_heading_text(sub))
        if key:
            words = []
            for a in sub.find_all("a"):
                w = _link_target(a)
                if w and w not in words:
                    words.append(w)
            if words:
                related[key] = words[:12]
    return {"pos": pos, "headword": headword, "gender": gender, "forms": forms, "senses": senses, "related": related}


def _parse_language(sec: Tag, language: str) -> Optional[dict]:
    ipa: list[str] = []
    audio: list[str] = []
    etymology = None
    entries = []

    def visit(s: Tag):
        nonlocal etymology
        for sub in s.find_all("section", recursive=False):
            title = _heading_text(sub)
            if title.startswith("Pronunciation"):
                for el in sub.find_all(class_=re.compile(r"\bIPA\b")):
                    t = el.get_text(strip=True)
                    if t.startswith(("/", "[")) and t not in ipa:
                        ipa.append(t)
                for src in sub.find_all("source"):
                    url = src.get("src") or ""
                    if url.endswith(".mp3") and url not in audio:
                        audio.append(("https:" + url) if url.startswith("//") else url)
            elif title.startswith("Etymology"):
                p = sub.find("p", recursive=False)
                if p and not etymology:
                    etymology = re.sub(r"\s+", " ", p.get_text(" ", strip=True))[:400]
                visit(sub)
            elif title in POS:
                e = _parse_entry(sub, title)
                if e:
                    entries.append(e)
            else:
                visit(sub)

    visit(sec)
    if not entries:
        return None
    return {"language": language, "ipa": ipa[:3], "audio": audio[:2], "etymology": etymology, "entries": entries}


def parse_page(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for h2 in soup.find_all("h2"):
        sec = h2.find_parent("section")
        if not sec:
            continue
        lang = _parse_language(sec, h2.get_text(" ", strip=True))
        if lang:
            out.append(lang)
    return out


# --- network ----------------------------------------------------------------

async def _get(client: httpx.AsyncClient, url: str, **params):
    r = await client.get(url, params=params or None, headers={"User-Agent": UA, "Accept": "text/html,application/json"})
    return r


async def wiktionary_page(client: httpx.AsyncClient, title: str) -> list[dict] | None:
    key = f"page:{title}"
    hit = _cached(key)
    if hit is not None:
        return hit or None
    r = await _get(client, f"{WIKT}/api/rest_v1/page/html/{quote(title.replace(' ', '_'), safe='')}")
    if r.status_code == 404:
        _store(key, [])
        return None
    r.raise_for_status()
    return _store(key, parse_page(r.text)) or None


async def accent_variants(client: httpx.AsyncClient, query: str) -> list[str]:
    """Titles that are the same word up to accents/ligatures/case ('foret' -> 'forêt')."""
    key = f"variants:{fold(query)}"
    hit = _cached(key)
    if hit is not None:
        return hit
    r = await _get(client, f"{WIKT}/w/api.php", action="query", format="json", list="search",
                   srnamespace="0", srlimit="50", srprop="", srsearch=f"intitle:{query}")
    titles = [x["title"] for x in r.json().get("query", {}).get("search", [])] if r.status_code == 200 else []
    target = fold(query)
    return _store(key, [t for t in titles if fold(t) == target and t != query][:12])


async def lookup(query: str, language: Optional[str]) -> dict:
    """
    Dictionary entry for `query`, preferring `language` (e.g. "French").
    If the exact page lacks that language, try accent variants (foret -> forêt).
    """
    q = query.strip()
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        langs = await wiktionary_page(client, q) or []
        shown = q
        variants = await accent_variants(client, q) if len(q) <= 40 else []

        def has_lang(ls):
            return any(l["language"] == language for l in ls)

        if (not langs or (language and not has_lang(langs))) and variants:
            # Fetch the accent variants together, then take the first (in search order)
            # that has an entry in the wanted language.
            pages = await asyncio.gather(*(wiktionary_page(client, v) for v in variants), return_exceptions=True)
            for v, vl in zip(variants, pages):
                if isinstance(vl, list) and vl and (not language or has_lang(vl)):
                    langs, shown = vl, v
                    break
        if language:
            langs.sort(key=lambda l: 0 if l["language"] == language else 1)

        # Suggestions: other accent spellings that actually have an entry in the wanted
        # language — not capitalisation-only variants or look-alikes from other scripts.
        suggest = [v for v in variants if v != shown and v.lower() != shown.lower() and v.lower() != q.lower()
                   and all(ord(c) <= 0x17F for c in v)]
        if language and suggest:
            pages = await asyncio.gather(*(wiktionary_page(client, v) for v in suggest), return_exceptions=True)
            suggest = [v for v, vl in zip(suggest, pages) if isinstance(vl, list) and has_lang(vl)]
        return {
            "query": q,
            "word": shown if langs else q,
            "corrected": shown != q,
            "languages": langs,
            "variants": suggest[:6],
            "source_url": f"{WIKT}/wiki/{quote(shown.replace(' ', '_'))}",
        }


async def jisho(query: str) -> list[dict]:
    key = f"jisho:{query}"
    hit = _cached(key)
    if hit is not None:
        return hit
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get("https://jisho.org/api/v1/search/words", params={"keyword": query}, headers={"User-Agent": UA})
        r.raise_for_status()
        data = r.json().get("data", [])[:6]
    out = []
    for d in data:
        jp = d.get("japanese") or [{}]
        out.append({
            "word": jp[0].get("word") or jp[0].get("reading"),
            "reading": jp[0].get("reading"),
            "other_forms": [f"{x.get('word') or ''}【{x.get('reading') or ''}】".replace("【】", "") for x in jp[1:4]],
            "common": bool(d.get("is_common")),
            "jlpt": [j.replace("jlpt-", "").upper() for j in d.get("jlpt", [])],
            "senses": [{"pos": s.get("parts_of_speech", []), "glosses": s.get("english_definitions", []), "info": s.get("info", [])}
                       for s in d.get("senses", [])[:5]],
        })
    return _store(key, out)


def has_japanese(s: str) -> bool:
    return any("぀" <= c <= "ヿ" or "一" <= c <= "鿿" for c in s)
