import google.generativeai as genai
from openai import AsyncOpenAI
import anthropic
import httpx
from typing import Optional
from abc import ABC, abstractmethod


class NoValidKeysError(Exception):
    """Exception raised when all API keys fail."""
    pass


class AIProvider(ABC):
    """Base class for AI providers."""

    @abstractmethod
    async def generate(self, prompt: str) -> str:
        pass


class GeminiProvider(AIProvider):
    """Google Gemini provider."""

    def __init__(self, api_key: str, model: str = "gemini-2.0-flash"):
        genai.configure(api_key=api_key)
        self.model = genai.GenerativeModel(model)

    async def generate(self, prompt: str) -> str:
        response = await self.model.generate_content_async(prompt)
        return response.text


class OpenAIProvider(AIProvider):
    """OpenAI ChatGPT provider."""

    def __init__(self, api_key: str, model: str = "gpt-4o-mini"):
        self.client = AsyncOpenAI(api_key=api_key)
        self.model = model

    async def generate(self, prompt: str) -> str:
        response = await self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.choices[0].message.content or ""


# Current Claude models that accept server-side refusal fallbacks ("default" routing).
CLAUDE_FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}


class AnthropicProvider(AIProvider):
    """Anthropic Claude provider."""

    def __init__(self, api_key: str, model: str = "claude-opus-5-5"):
        self.client = anthropic.AsyncAnthropic(api_key=api_key)
        self.model = model

    async def generate(self, prompt: str) -> str:
        params = dict(
            model=self.model,
            # Current models think before answering; leave room for that plus a long story.
            max_tokens=16000,
            messages=[{"role": "user", "content": prompt}],
        )
        if self.model in CLAUDE_FALLBACK_MODELS:
            # If a safety classifier declines, the API retries on a suitable model in the same call.
            response = await self.client.beta.messages.create(
                **params, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            )
        else:
            response = await self.client.messages.create(**params)
        if response.stop_reason == "refusal":
            raise RuntimeError("Claude declined to write this story — try different words or instructions.")
        # Responses can start with thinking blocks; only the text blocks are the story.
        return "".join(b.text for b in response.content if b.type == "text")


# Provider registry with available models
PROVIDERS = {
    "openai": {
        "name": "ChatGPT",
        "class": OpenAIProvider,
        "models": [
            {"id": "gpt-4o-mini", "name": "GPT-4o Mini (fast, cheap)"},
            {"id": "gpt-4o", "name": "GPT-4o (best quality)"},
            {"id": "gpt-4-turbo", "name": "GPT-4 Turbo"},
            {"id": "gpt-3.5-turbo", "name": "GPT-3.5 Turbo (cheapest)"},
        ],
        "default_model": "gpt-4o-mini",
    },
    "anthropic": {
        "name": "Claude",
        "class": AnthropicProvider,
        "models": [
            {"id": "claude-opus-5-5", "name": "Claude Opus 5.5 (best)"},
            {"id": "claude-sonnet-5-5", "name": "Claude Sonnet 5.5 (fast)"},
            {"id": "claude-haiku-5-5", "name": "Claude Haiku 5.5 (fastest, cheapest)"},
        ],
        "default_model": "claude-opus-5-5",
    },
    "gemini": {
        "name": "Gemini",
        "class": GeminiProvider,
        "models": [
            {"id": "gemini-2.0-flash", "name": "Gemini 2.0 Flash (fast, recommended)"},
            {"id": "gemini-2.0-flash-lite", "name": "Gemini 2.0 Flash Lite (fastest)"},
            {"id": "gemini-1.5-flash-8b", "name": "Gemini 1.5 Flash 8B (lightweight)"},
            {"id": "gemini-1.5-pro", "name": "Gemini 1.5 Pro (best quality)"},
        ],
        "default_model": "gemini-2.0-flash",
    },
}


def get_provider(provider_name: str, api_key: str, model: str | None = None) -> AIProvider:
    """Get an AI provider instance."""
    if provider_name not in PROVIDERS:
        raise ValueError(f"Unknown provider: {provider_name}")

    provider_info = PROVIDERS[provider_name]
    provider_class = provider_info["class"]
    model_to_use = model or provider_info["default_model"]

    return provider_class(api_key, model_to_use)


class StoryGenerator:
    """Generate stories using vocabulary words via various AI providers."""

    def __init__(self, api_keys: dict[str, str]):
        self.api_keys = api_keys
        self._used_provider = None
        self._used_model = None

    def _get_key_for_provider(self, provider_name: str) -> str | None:
        return self.api_keys.get(provider_name) or None

    async def generate_with_provider(
        self,
        prompt: str,
        provider: str | None = None,
        model: str | None = None,
    ) -> tuple[str, str, str | None]:
        """Generate text using the specified provider (or first available).
        Returns (result, provider_used, model_used)."""
        priority = ["gemini", "groq", "openrouter", "openai", "anthropic", "mistral"]
        providers_to_try = [provider] if provider else priority

        last_error = None
        for p in providers_to_try:
            api_key = self._get_key_for_provider(p)
            if not api_key:
                continue
            try:
                provider_instance = get_provider(p, api_key, model)
                actual_model = model or PROVIDERS[p]["default_model"]
                result = await provider_instance.generate(prompt)
                self._used_provider = p
                self._used_model = actual_model
                return result, p, actual_model
            except Exception as e:
                last_error = e
                continue

        if last_error:
            raise NoValidKeysError(str(last_error))
        raise NoValidKeysError(f"No working API keys available for {provider or 'any provider'}")

    async def generate_story(
        self,
        words: list[str],
        style: str = "casual",
        length: str = "medium",
        language: str = "auto",
        target_language: Optional[str] = None,
        custom_instructions: Optional[str] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        word_categories: Optional[dict] = None,  # word -> category mapping
        level: Optional[str] = None,  # CEFR level of the learner (A1..C2)
    ) -> dict:
        """
        Generate a story incorporating the given vocabulary words.

        Args:
            words: List of vocabulary words to include
            style: Story style (casual, formal, funny, dramatic, educational, custom)
            length: short (~200 words), medium (~500 words), long (~1000 words)
            language: Language for the story (or "auto" to detect from words)
            target_language: If set, create a bilingual story for language learning
            custom_instructions: Custom style instructions (used when style="custom")
            provider: Specific AI provider to use
            model: Specific model to use
            word_categories: Optional dict mapping words to their Anki categories

        Returns:
            dict with story, title, provider_used, model_used, discovered_key_id
        """
        # Auto-calculate story length based on word count
        word_count = len(words)
        if length == "auto":
            if word_count <= 10:
                target_words = 150
            elif word_count <= 20:
                target_words = 300
            elif word_count <= 35:
                target_words = 500
            elif word_count <= 50:
                target_words = 700
            else:
                target_words = 1000
            length_instruction = f"about {target_words} words"
        else:
            length_guide = {"short": "about 200 words", "medium": "about 500 words", "long": "about 1000 words"}
            length_instruction = length_guide.get(length, 'about 500 words')

        word_list = "\n".join(f"- {w}" for w in words)

        # Story language: with a translation the story is in target_language and each
        # paragraph is followed by its translation into `language`.
        story_lang = target_language or (None if language == "auto" else language)
        lang_instruction = (f"Write the story in {story_lang}." if story_lang
                            else "Write the story in the language of the vocabulary words.")

        style_instruction = (f"Follow these instructions from the learner: {custom_instructions}"
                             if style == "custom" and custom_instructions else f"Tone: {style}.")

        level_instruction = ""
        if level:
            level_instruction = (f"The reader is a language learner at CEFR level {level}. Keep grammar, sentence length "
                                 f"and the other words in the story appropriate for {level}, so the vocabulary words "
                                 "are the main challenge.")

        priority = ""
        if word_categories:
            learning_words = [w for w, c in word_categories.items() if c in ("learning", "relearning")]
            if learning_words:
                priority = ("Give these words (still being learned) the most prominent, memorable roles: "
                            + ", ".join(learning_words[:12]) + ".")

        translation_instruction = ""
        if target_language:
            translation_instruction = (f"After every paragraph, add its translation into {language if language != 'auto' else 'English'} "
                                       "as a separate paragraph that starts with \">> \" (two greater-than signs and a space).")

        prompt = f"""Write a short story that helps a language learner practise vocabulary.

{lang_instruction}
Length: {length_instruction}.
{style_instruction}
{level_instruction}
{priority}
{translation_instruction}

Use every one of these vocabulary words at least once (more than once when it fits naturally):
{word_list}

Use the words the way a native speaker would: conjugate verbs, make adjectives and articles agree, and use
plural forms wherever the sentence calls for it. Make the story coherent and enjoyable, with the vocabulary
words carrying the meaning of the scenes. Don't add pronunciation guides or explanations inside the story.

Reply in exactly this format and nothing else:
TITLE: <a short title in the story's language>

STORY:
<the story, paragraphs separated by blank lines>

FORMS:
<one line per vocabulary word: the word exactly as listed, then " => ", then every form of it that appears in the story, comma-separated>"""

        response, provider_used, model_used = await self.generate_with_provider(prompt, provider, model)
        title, story, word_forms = self._parse_story(response, words)
        return {
            "story": story,
            "title": title,
            "word_forms": word_forms,
            "provider_used": provider_used,
            "model_used": model_used,
        }

    @staticmethod
    def _parse_story(response: str, words: list[str]) -> tuple[Optional[str], str, dict[str, list[str]]]:
        """Split the model's reply into title, story text and {vocab word: [forms used]}."""
        import re
        text = response.strip()
        title = None
        m = re.search(r"^\s*\**TITLE:\**\s*(.+)$", text, re.M)
        if m:
            title = m.group(1).strip().strip('"\'*').strip()[:100] or None
        story = text
        sm = re.search(r"^\s*\**STORY:\**\s*$", text, re.M)
        if sm:
            story = text[sm.end():]
        elif m:
            story = text[m.end():]
        word_forms: dict[str, list[str]] = {}
        fm = re.search(r"^\s*\**FORMS:\**\s*$", story, re.M)
        if fm:
            forms_block = story[fm.end():]
            story = story[:fm.start()]
            known = {w.lower(): w for w in words}
            for line in forms_block.splitlines():
                if "=>" not in line:
                    continue
                left, right = line.split("=>", 1)
                key = known.get(left.strip().lstrip("-*• ").strip().lower())
                if not key:
                    continue
                forms = [f.strip().strip(".;\"'") for f in right.split(",")]
                forms = [f for f in forms if f and f.lower() != key.lower()]
                if forms:
                    word_forms[key] = list(dict.fromkeys(forms))[:8]
        return title, story.strip(), word_forms

    async def lookup_word_jisho(self, word: str) -> dict | None:
        """
        Look up a Japanese word using Jisho API (free, no API key needed).
        Returns None if word not found or not Japanese.
        """
        import urllib.parse

        # Check if word contains Japanese characters
        has_japanese = any('\u3040' <= c <= '\u309f' or  # hiragana
                          '\u30a0' <= c <= '\u30ff' or  # katakana
                          '\u4e00' <= c <= '\u9fff'     # kanji
                          for c in word)

        if not has_japanese:
            return None

        try:
            encoded_word = urllib.parse.quote(word)
            url = f"https://jisho.org/api/v1/search/words?keyword={encoded_word}"

            async with httpx.AsyncClient() as client:
                response = await client.get(url, timeout=10.0)
                response.raise_for_status()
                data = response.json()

            if not data.get("data"):
                return None

            # Find best match (exact match preferred)
            best_match = None
            for entry in data["data"]:
                for jp in entry.get("japanese", []):
                    if jp.get("word") == word or jp.get("reading") == word:
                        best_match = entry
                        break
                if best_match:
                    break

            # If no exact match, use first result
            if not best_match:
                best_match = data["data"][0]

            # Extract info
            japanese = best_match.get("japanese", [{}])[0]
            senses = best_match.get("senses", [{}])[0]

            reading = japanese.get("reading", "")
            meanings = senses.get("english_definitions", [])
            pos = senses.get("parts_of_speech", [])

            return {
                "word": word,
                "meaning": ", ".join(meanings[:3]) if meanings else "",
                "reading": reading,
                "part_of_speech": pos[0] if pos else "",
                "provider_used": "jisho",
            }
        except Exception as e:
            print(f"Jisho lookup failed for '{word}': {e}")
            return None

    async def lookup_word(
        self,
        word: str,
        language: str = "auto",
        provider: Optional[str] = None,
        model: Optional[str] = None,
        lookup_fields: Optional[list[str]] = None,
        force_ai: bool = False,
    ) -> dict:
        """
        Look up a word - tries Jisho first for Japanese (unless force_ai=True), falls back to AI.

        Args:
            word: The word to look up
            language: Target language for the meaning (auto, English, etc.)
            provider: Specific AI provider to use
            model: Specific model to use
            lookup_fields: List of fields to return (e.g., ["Word Reading", "Word Meaning", "Word Furigana"])
            force_ai: If True, skip Jisho and use AI directly

        Returns:
            dict with meaning, reading (if applicable), and other requested fields
        """
        # Try Jisho first for Japanese words (unless force_ai is True)
        if not force_ai:
            jisho_result = await self.lookup_word_jisho(word)
            if jisho_result:
                return jisho_result

        # Use AI lookup
        lang_instruction = "Provide the meaning in English" if language == "auto" else f"Provide the meaning in {language}"

        # Build JSON format based on lookup_fields if provided
        if lookup_fields:
            # Map common field names to JSON keys
            field_map = {
                "Word Reading": "reading",
                "Word Meaning": "meaning",
                "Word Furigana": "furigana",
                "Part of Speech": "part_of_speech",
                "Example": "example",
                "Notes": "notes",
            }
            json_fields = []
            field_instructions = []
            for field in lookup_fields:
                if field == "Word Sound":
                    continue  # Skip sound field (can't generate audio)
                json_key = field_map.get(field, field.lower().replace(" ", "_"))
                json_fields.append(f'"{json_key}": "..."')

                # Add specific instructions for each field
                if field == "Word Reading":
                    field_instructions.append("- reading: the pronunciation or reading of the word")
                elif field == "Word Meaning":
                    field_instructions.append(f"- meaning: the definition/translation ({lang_instruction})")
                elif field == "Word Furigana":
                    field_instructions.append("- furigana: the word with furigana annotations if applicable (e.g., 今朝[けさ])")
                elif field == "Part of Speech":
                    field_instructions.append("- part_of_speech: noun/verb/adjective/etc.")
                elif field == "Example":
                    field_instructions.append("- example: a short example sentence using the word")
                elif field == "Notes":
                    field_instructions.append("- notes: any helpful notes, word associations, or etymology")

            json_format = "{" + ", ".join(json_fields) + "}"
            field_inst_text = "\n".join(field_instructions)

            prompt = f"""Look up this word and provide the requested information.

Word: {word}

Provide the following fields:
{field_inst_text}

Respond in this exact JSON format (nothing else):
{json_format}

Keep each field brief and concise."""
        else:
            # Default lookup (backwards compatible)
            prompt = f"""Look up this word and provide its meaning concisely.

Word: {word}

{lang_instruction}

Respond in this exact JSON format (nothing else):
{{"meaning": "the definition/translation", "reading": "pronunciation if applicable", "part_of_speech": "noun/verb/adjective/etc"}}

Keep the meaning brief (1-2 sentences max)."""

        response, provider_used, model_used = await self.generate_with_provider(
            prompt, provider, model
        )

        # Parse JSON response
        import json
        try:
            response = response.strip()
            if response.startswith("```"):
                response = response.split("```")[1]
                if response.startswith("json"):
                    response = response[4:]
                response = response.strip()
            data = json.loads(response)

            result = {"word": word, "provider_used": provider_used}
            for key, value in data.items():
                result[key] = value

            if "meaning" not in result:
                result["meaning"] = ""
            if "reading" not in result:
                result["reading"] = ""

            return result
        except:
            return {
                "word": word,
                "meaning": response,
                "reading": "",
                "part_of_speech": "",
                "provider_used": provider_used,
            }

    async def generate_mnemonics(
        self,
        words: list[dict],
        provider: Optional[str] = None,
        model: Optional[str] = None,
    ) -> list[dict]:
        """
        Generate memory aids for vocabulary words.

        Args:
            words: List of dicts with 'word' and 'definition' keys
            provider: Specific AI provider to use
            model: Specific model to use
        """
        ai_provider = self._get_provider(provider, model)

        word_info = "\n".join([f"- {w['word']}: {w.get('definition', 'no definition')}" for w in words])

        prompt = f"""Create memorable mnemonics for these vocabulary words:

{word_info}

For each word, provide:
1. A vivid mental image or scene
2. A memorable phrase or sentence
3. Any helpful word associations or etymology

Format as a list with clear separators between each word's mnemonic."""

        response = await ai_provider.generate(prompt)

        # Return as structured data
        return [{"word": w["word"], "mnemonic": response} for w in words]
