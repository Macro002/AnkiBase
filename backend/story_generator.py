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


class AnthropicProvider(AIProvider):
    """Anthropic Claude provider."""

    def __init__(self, api_key: str, model: str = "claude-3-5-sonnet-20241022"):
        self.client = anthropic.AsyncAnthropic(api_key=api_key)
        self.model = model

    async def generate(self, prompt: str) -> str:
        response = await self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text


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
            {"id": "claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet (best)"},
            {"id": "claude-3-5-haiku-20241022", "name": "Claude 3.5 Haiku (fast)"},
            {"id": "claude-3-opus-20240229", "name": "Claude 3 Opus (most capable)"},
        ],
        "default_model": "claude-3-5-sonnet-20241022",
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

        word_list = ", ".join(words)

        # Build language instruction
        if language == "auto":
            lang_instruction = "Detect the language of the vocabulary words and write the story in that same language."
        else:
            lang_instruction = f"Write the story in {language}."

        # Build style instruction
        if style == "custom" and custom_instructions:
            style_instruction = f"Follow these custom instructions: {custom_instructions}"
        else:
            style_instruction = f"Style: {style}"

        # Build category context if available
        category_context = ""
        if word_categories:
            learning_words = [w for w, c in word_categories.items() if c in ("learning", "relearning")]
            if learning_words:
                category_context = f"\nPriority words (currently learning, use these more prominently): {', '.join(learning_words[:10])}"

        if target_language:
            prompt = f"""Create a bilingual story for language learning.

Target language: {target_language}
Native language: {language if language != "auto" else "English"}
Story length: {length_instruction}
{style_instruction}
{category_context}

CRITICAL: You MUST use EVERY SINGLE ONE of these exact vocabulary words in your story (copy them exactly as written):
{word_list}

Format your response EXACTLY like this:
TITLE: [A creative, memorable title for the story]

STORY:
[The story content with each paragraph in {target_language}, followed immediately by the translation]

Use the vocabulary words MULTIPLE TIMES throughout the story when natural. Make the story engaging and memorable."""
        else:
            prompt = f"""Create an engaging story for vocabulary learning.

{lang_instruction}
Story length: {length_instruction}
{style_instruction}
{category_context}

CRITICAL REQUIREMENT - READ CAREFULLY:
You MUST include EVERY SINGLE vocabulary word from this list in your story. Copy them EXACTLY as written.
Do NOT paraphrase or use similar words - use the EXACT words provided.
Use each vocabulary word MULTIPLE TIMES if it fits naturally - repetition helps learning.

VOCABULARY WORDS TO USE (all {word_count} words MUST appear in the story):
{word_list}

Format your response EXACTLY like this:
TITLE: [A creative, memorable title for the story in the same language as the story]

STORY:
[The story content - must contain ALL vocabulary words listed above]

Requirements:
- EVERY word from the vocabulary list MUST appear at least once (this is mandatory)
- Use the exact form of each word as provided
- The story should be coherent and enjoyable to read
- The words should fit naturally into the narrative
- Do NOT add furigana or pronunciation guides - write words as-is

Double-check before responding: Have you included ALL {word_count} vocabulary words?"""

        response, provider_used, model_used = await self.generate_with_provider(
            prompt, provider, model
        )

        # Parse title and story from response
        title = None
        story = response

        # Try to extract TITLE
        if "TITLE:" in response:
            title_start = response.find("TITLE:") + 6
            title_end = response.find("\n", title_start)
            if title_end > title_start:
                title = response[title_start:title_end].strip().strip('"\'').strip()
                if len(title) > 100:
                    title = title[:97] + "..."

        # Extract STORY
        if "STORY:" in response:
            story_start = response.find("STORY:") + 6
            story = response[story_start:].strip()

        return {
            "story": story,
            "title": title,
            "provider_used": provider_used,
            "model_used": model_used,
        }

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
