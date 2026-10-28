# AnkiBase in one container: the web UI, the backend, and Anki's engine (anki-cli) with
# Anki's own sync server, which the backend starts itself. Everything it keeps is in /data.
#
#   docker compose up -d        (see docker-compose.yml)

FROM node:20-bookworm-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.11-slim-bookworm
ARG VERSION=unknown
LABEL org.opencontainers.image.source=https://github.com/Macro002/AnkiBase
ENV PYTHONUNBUFFERED=1 \
    ANKIBASE_DOCKER=1 \
    ANKIBASE_DB=/data/ankibase.db \
    ANKI_DATA_DIR=/data/anki \
    ANKICLI_PYTHON=/opt/engine/bin/python \
    APP_PORT=8000

# git for pip's git requirements; Xvfb and Firefox's libraries for reading Quizlet sets.
RUN apt-get update -q && apt-get install -y -q --no-install-recommends git curl xvfb \
        libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 libx11-xcb1 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# The backend's packages, and the browser invisible_playwright drives.
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN python -m venv /opt/backend \
    && /opt/backend/bin/pip install -q --no-cache-dir -r requirements.txt \
    && /opt/backend/bin/python -c "from invisible_playwright import download; download.ensure_binary()"

# Anki's engine in its own environment, as anki_server.py expects.
COPY backend/engine-requirements.txt ./
RUN python -m venv /opt/engine \
    && /opt/engine/bin/pip install -q --no-cache-dir -r engine-requirements.txt

COPY backend/ ./
COPY --from=web /src/frontend/dist ./static
# The profiles' own data (stories, keys, AnkiWeb logins, the generated secrets) lives in
# backend/data; here that's in the volume.
RUN rm -rf data venv .env ankibase.db && ln -s /data/app data && echo "$VERSION" > .version

ENV PATH=/opt/backend/bin:$PATH
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
    CMD curl -fsS "http://127.0.0.1:${APP_PORT}/api/setup/status" >/dev/null || exit 1
CMD ["sh", "-c", "mkdir -p /data/app /data/anki && exec uvicorn main:app --host 0.0.0.0 --port ${APP_PORT}"]
