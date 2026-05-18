# AnkiBase

Self-hosted web interface for Anki with AI-powered vocabulary story generation. Runs your Anki collection in a Docker container and exposes a clean web UI accessible from any browser.

## Features

- **Study** — review cards with ease ratings, undo support
- **Decks** — browse your full deck collection with stats
- **AI Stories** — generate vocabulary stories using words from your decks (OpenAI, Anthropic, Gemini)
- **Reading** — interactive reading mode with word lookup and AI translations
- **Search** — full-text search across all notes
- **Stats** — review heatmap and deck statistics
- **Import** — upload `.apkg` files directly from the browser
- **AnkiWeb Sync** — sync to/from AnkiWeb (normal, full upload, full download)
- **Multi-user** — admin panel, per-user container access control
- **Multi-account** — each user gets their own isolated Anki container

## Quick Install

Requires a Debian-based server (Debian 12/13, Ubuntu 22.04+) with root access.

```bash
git clone https://github.com/Macro002/AnkiBase.git && bash AnkiBase/install.sh
```

The installer will:
1. Install Docker, Node.js, and Python if not present
2. Build the frontend
3. Find an available port (starting at 8000)
4. Generate a secret key and config
5. Set up a systemd service
6. Optionally configure nginx + SSL (certbot)

On first visit, a setup wizard walks you through creating your admin account and initializing your Anki container.

## Manual Install

```bash
git clone https://github.com/Macro002/AnkiBase.git
cd AnkiBase
sudo bash install.sh
```

## Stack

| Layer | Tech |
|---|---|
| Backend | FastAPI + Uvicorn |
| Frontend | React 19, TypeScript, TailwindCSS v4 |
| Anki runtime | [thisisnttheway/headless-anki](https://github.com/nicholaswilde/headless-anki) (Docker) |
| Database | SQLite |
| AI providers | OpenAI, Anthropic, Google Gemini |

## Configuration

The installer generates `/opt/ankibase/backend/.env`. You can edit it to add API keys for AI story generation:

```env
# Add at least one to use AI features
GEMINI_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
```

Restart the service after editing: `systemctl restart ankibase`

## Updating

```bash
cd AnkiBase
git pull
sudo bash install.sh
```

## Useful Commands

```bash
# View logs
journalctl -u ankibase -f

# Restart
systemctl restart ankibase

# Status
systemctl status ankibase
```

## License

MIT
