#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

VERBOSE=0
UPDATE=0
for arg in "$@"; do
  [ "$arg" = "-v" ] || [ "$arg" = "--verbose" ] && VERBOSE=1
  [ "$arg" = "--update" ] && UPDATE=1
done

# Auto-enable update mode when piped from curl (no local source files present)
SCRIPT_DIR_CHECK="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /tmp)"
if [ ! -d "$SCRIPT_DIR_CHECK/frontend" ] || [ ! -d "$SCRIPT_DIR_CHECK/backend" ]; then
  UPDATE=1
fi

step()    { echo -e "${CYAN}  →${NC} $1"; }
success() { echo -e "${GREEN}  ✓${NC} $1"; }
warn()    { echo -e "${YELLOW}  !${NC} $1"; }
error()   { echo -e "${RED}  ✗${NC} $1"; exit 1; }
verbose() { [ "$VERBOSE" -eq 1 ] && echo -e "    ${NC}$1" || true; }

# Redirect noisy commands based on verbosity
if [ "$VERBOSE" -eq 1 ]; then
    Q=""
    exec 3>&1         # fd 3 = the terminal in verbose mode
else
    Q=">/dev/null 2>&1"
    exec 3>/dev/null  # fd 3 = /dev/null in quiet mode
fi
run() { [ "$VERBOSE" -eq 1 ] && eval "$*" || eval "$* >/dev/null 2>&1"; }

# ── Root check ───────────────────────────────────────────────────────────────
[ "$EUID" -ne 0 ] && error "Please run as root (sudo ./install.sh)"

INSTALL_DIR="/opt/ankibase"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="https://github.com/Macro002/AnkiBase.git"
VERSION=""
# An existing install is updated; a fresh one also gets the optional nginx setup.
EXISTING=0
[ -f "$INSTALL_DIR/backend/.env" ] && EXISTING=1

# ── Update mode: fetch the newest release (or main) into a temp dir, then continue ──
if [ "$UPDATE" -eq 1 ]; then
    command -v git >/dev/null || run apt-get install -y -q git
    CHANNEL=$(sed -n 's/^UPDATE_CHANNEL=//p' "$INSTALL_DIR/backend/.env" 2>/dev/null | tr -d '[:space:]')
    if [ "$CHANNEL" != "main" ]; then
        VERSION=$(git ls-remote --tags --refs "$REPO" 'v*' 2>/dev/null | sed 's|.*refs/tags/||' \
                  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
    fi
    step "Downloading AnkiBase ${VERSION:-(main)}..."
    TMP_DIR=$(mktemp -d)
    trap "rm -rf $TMP_DIR" EXIT
    run git clone --depth 1 ${VERSION:+--branch "$VERSION"} "$REPO" "$TMP_DIR"
    SCRIPT_DIR="$TMP_DIR"
    success "Downloaded"
fi
[ -n "$VERSION" ] || VERSION=$(git -C "$SCRIPT_DIR" describe --tags --exact-match 2>/dev/null || git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)

echo ""
echo "  ╔══════════════════════════════╗"
if [ "$UPDATE" -eq 1 ]; then
echo "  ║     AnkiBase Updater         ║"
else
echo "  ║     AnkiBase Installer       ║"
fi
echo "  ╚══════════════════════════════╝"
[ "$VERBOSE" -eq 1 ] && echo "  (verbose mode)" || true
echo ""

# ── System packages ───────────────────────────────────────────────────────────
step "Updating packages..."
run apt-get update -q

run apt-get install -y -q \
    python3 python3-venv python3-pip \
    curl wget git rsync ca-certificates \
    gnupg lsb-release iproute2 xvfb \
    libgtk-3-0 libdbus-glib-1-2 libxt6
success "System dependencies ready"

# ── Node.js ───────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || node -e 'process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)' 2>/dev/null; then
    step "Installing Node.js 20..."
    run curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    run apt-get install -y -q nodejs
    success "Node.js $(node --version) installed"
else
    verbose "Node.js $(node --version) already present"
fi

# ── Find available port ───────────────────────────────────────────────────────
find_port() {
    local port=8000
    while ss -tlnp 2>/dev/null | grep -q ":${port} "; do
        port=$((port + 1))
    done
    echo "$port"
}
# An update keeps the port it has (a reverse proxy points at it).
APP_PORT=$(sed -n 's/^APP_PORT=//p' "$INSTALL_DIR/backend/.env" 2>/dev/null | tr -d '[:space:]')
[ -n "$APP_PORT" ] || APP_PORT=$(find_port)
verbose "Using port $APP_PORT"

# ── Build frontend ────────────────────────────────────────────────────────────
step "Building frontend..."
cd "$SCRIPT_DIR/frontend"
if [ -f package-lock.json ]; then run npm ci; else run npm install; fi
run npm run build || error "The frontend didn't build (nothing was changed). Run with -v to see why."
success "Frontend built"
cd "$SCRIPT_DIR"

# ── Back up (updates) ─────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/backend" ] && [ -f "$INSTALL_DIR/backend/.env" ]; then
    BACKUP="$INSTALL_DIR/backups/$(date +%Y%m%d-%H%M%S)"
    step "Backing up to $BACKUP..."
    mkdir -p "$BACKUP"
    rsync -a --exclude='venv' --exclude='__pycache__' "$INSTALL_DIR/backend" "$BACKUP/"
    # Keep the last three backups.
    ls -1d "$INSTALL_DIR"/backups/*/ 2>/dev/null | sort | head -n -3 | xargs -r rm -rf
    success "Backed up"
fi

# ── Deploy files ──────────────────────────────────────────────────────────────
step "Installing files..."
mkdir -p "$INSTALL_DIR/backend"

# Your data stays: the database, settings, secrets, saved keys and stories (data/).
rsync -a \
    --exclude='__pycache__' --exclude='*.pyc' \
    --exclude='venv' --exclude='.env' --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
    --exclude='data' --exclude='.version' --exclude='static' \
    "$SCRIPT_DIR/backend/" "$INSTALL_DIR/backend/"

rsync -a --delete "$SCRIPT_DIR/frontend/dist/" "$INSTALL_DIR/backend/static/"

# ── Python virtualenv ─────────────────────────────────────────────────────────
step "Setting up Python environment..."
if [ ! -d "$INSTALL_DIR/backend/venv" ]; then
    python3 -m venv "$INSTALL_DIR/backend/venv"
fi
run "$INSTALL_DIR/backend/venv/bin/pip" install -q -r "$INSTALL_DIR/backend/requirements.txt"
# Install browser dependencies for invisible_playwright (Firefox needs GTK, ALSA, etc.)
run "$INSTALL_DIR/backend/venv/bin/python3" -m playwright install-deps firefox
success "Backend ready"

# ── Generate .env ─────────────────────────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/backend/.env" ]; then
    SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
    ENCRYPTION_KEY=$("$INSTALL_DIR/backend/venv/bin/python3" -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")

    (umask 077; cat > "$INSTALL_DIR/backend/.env" <<EOF
APP_SECRET_KEY=${SECRET_KEY}
ANKIWEB_ENCRYPTION_KEY=${ENCRYPTION_KEY}
APP_PORT=${APP_PORT}
CORS_ORIGINS=http://localhost:${APP_PORT}
UPDATE_CHANNEL=release
EOF
    )
    verbose "Config generated (.env)"
else
    chmod 600 "$INSTALL_DIR/backend/.env"
    verbose "Existing .env kept (secrets preserved)"
fi

# ── Systemd service ───────────────────────────────────────────────────────────
step "Configuring service..."
cat > /etc/systemd/system/ankibase.service <<EOF
[Unit]
Description=AnkiBase Backend
After=network.target ankibase-anki.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/backend
EnvironmentFile=${INSTALL_DIR}/backend/.env
ExecStart=${INSTALL_DIR}/backend/venv/bin/uvicorn main:app --host 0.0.0.0 --port \${APP_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

run systemctl daemon-reload
run systemctl enable ankibase

# ── Anki engine (anki-cli) ────────────────────────────────────────────────────
# Its own virtualenv and service (ankibase-anki); moves accounts off the old Docker
# containers first when upgrading.
step "Setting up the Anki engine (first time takes a minute)..."
if (cd "$INSTALL_DIR/backend" && "$INSTALL_DIR/backend/venv/bin/python3" -c "
import anki_server, anki_migration, sys
anki_server.install_engine()
if anki_migration.pending():
    if anki_server.healthy():
        anki_server.stop()
    anki_migration.migrate()
sys.exit(0 if anki_server.ensure_running() else 1)
") >&3 2>&1; then
    success "Anki engine running"
else
    warn "Anki engine didn't start — check: journalctl -u ankibase-anki -n 30"
fi

# The version, for the in-app update check.
echo "$VERSION" > "$INSTALL_DIR/backend/.version"

systemctl restart ankibase
STARTED=0
for _ in $(seq 1 30); do
    sleep 2
    if curl -fsS "http://127.0.0.1:${APP_PORT}/api/setup/status" >/dev/null 2>&1; then STARTED=1; break; fi
done
if [ "$STARTED" -eq 1 ]; then
    success "AnkiBase ${VERSION} is running"
elif [ -n "${BACKUP:-}" ]; then
    warn "The new version didn't start — restoring the backup (journalctl -u ankibase -n 50 shows why)"
    rsync -a --exclude='venv' "$BACKUP/backend/" "$INSTALL_DIR/backend/"
    systemctl restart ankibase
    exit 1
else
    warn "AnkiBase didn't start — check: journalctl -u ankibase -n 50"
fi

if [ "$EXISTING" -eq 1 ]; then
    echo ""
    success "Updated to ${VERSION}"
    exit 0
fi

# ── Summary ───────────────────────────────────────────────────────────────────
SERVER_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "  ──────────────────────────────────"
success "AnkiBase is running!"
echo "  http://${SERVER_IP}:${APP_PORT}"
echo "  ──────────────────────────────────"
echo ""

# ── Nginx (optional) ─────────────────────────────────────────────────────────
echo -n "  Set up nginx reverse proxy? [y/N] "
read -r SETUP_NGINX < /dev/tty 2>/dev/null || SETUP_NGINX=""
echo ""

if [[ "$SETUP_NGINX" =~ ^[Yy]$ ]]; then
    step "Installing nginx..."
    run apt-get install -y -q nginx

    echo -n "  Domain name (leave empty to skip): "
    read -r DOMAIN < /dev/tty 2>/dev/null || DOMAIN=""
    echo ""

    NGINX_SERVER="${DOMAIN:-$SERVER_IP}"

    cat > /etc/nginx/sites-available/ankibase <<EOF
server {
    listen 80;
    server_name ${NGINX_SERVER};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 600s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
        proxy_buffering off;
        client_max_body_size 500M;
    }
}
EOF

    ln -sf /etc/nginx/sites-available/ankibase /etc/nginx/sites-enabled/ankibase
    rm -f /etc/nginx/sites-enabled/default
    if [ "$VERBOSE" -eq 1 ]; then
        nginx -t && systemctl restart nginx
    else
        nginx -t >/dev/null 2>&1 && systemctl restart nginx >/dev/null 2>&1
    fi
    success "nginx configured"

    sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=http://localhost:${APP_PORT},http://${NGINX_SERVER}|" \
        "$INSTALL_DIR/backend/.env"
    run systemctl restart ankibase

    if [ -n "$DOMAIN" ]; then
        echo -n "  Set up SSL with Certbot? [y/N] "
        read -r SETUP_SSL < /dev/tty 2>/dev/null || SETUP_SSL=""
        echo ""

        if [[ "$SETUP_SSL" =~ ^[Yy]$ ]]; then
            step "Installing Certbot..."
            run apt-get install -y -q certbot python3-certbot-nginx
            certbot --nginx -d "$DOMAIN"

            sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=http://localhost:${APP_PORT},https://${DOMAIN}|" \
                "$INSTALL_DIR/backend/.env"
            run systemctl restart ankibase
            success "SSL configured"
        fi
    fi

    echo ""
    echo "  ──────────────────────────────────"
    success "Done!"
    if [ -n "$DOMAIN" ]; then
        echo "  http://${DOMAIN}  (or https:// if SSL)"
    else
        echo "  http://${SERVER_IP}"
    fi
    echo "  ──────────────────────────────────"
else
    echo "  Skipping nginx."
fi

echo ""
echo "  Logs:    journalctl -u ankibase -f"
echo "  Restart: systemctl restart ankibase"
echo ""
