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

step()    { echo -e "${CYAN}  →${NC} $1"; }
success() { echo -e "${GREEN}  ✓${NC} $1"; }
warn()    { echo -e "${YELLOW}  !${NC} $1"; }
error()   { echo -e "${RED}  ✗${NC} $1"; exit 1; }
verbose() { [ "$VERBOSE" -eq 1 ] && echo -e "    ${NC}$1" || true; }

# Redirect noisy commands based on verbosity
if [ "$VERBOSE" -eq 1 ]; then
    Q=""
else
    Q=">/dev/null 2>&1"
    exec 3>/dev/null  # fd 3 = /dev/null in quiet mode
fi
run() { [ "$VERBOSE" -eq 1 ] && eval "$*" || eval "$* >/dev/null 2>&1"; }

# ── Root check ───────────────────────────────────────────────────────────────
[ "$EUID" -ne 0 ] && error "Please run as root (sudo ./install.sh)"

INSTALL_DIR="/opt/ankibase"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Update mode: pull latest code into a temp dir then continue ───────────────
if [ "$UPDATE" -eq 1 ]; then
    step "Downloading latest AnkiBase..."
    TMP_DIR=$(mktemp -d)
    trap "rm -rf $TMP_DIR" EXIT
    run git clone --depth 1 https://github.com/Macro002/AnkiBase.git "$TMP_DIR"
    SCRIPT_DIR="$TMP_DIR"
    success "Latest code fetched"
fi

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
    gnupg lsb-release iproute2
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

# ── Docker ────────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    step "Installing Docker..."
    run curl -fsSL https://get.docker.com | sh
    run systemctl enable docker
    systemctl start docker
    success "Docker installed"
else
    verbose "Docker already present"
fi

# ── Find available port ───────────────────────────────────────────────────────
find_port() {
    local port=8000
    while ss -tlnp 2>/dev/null | grep -q ":${port} "; do
        port=$((port + 1))
    done
    echo "$port"
}
APP_PORT=$(find_port)
verbose "Using port $APP_PORT"

# ── Build frontend ────────────────────────────────────────────────────────────
step "Building frontend..."
cd "$SCRIPT_DIR/frontend"
run npm install
run npm run build
success "Frontend built"
cd "$SCRIPT_DIR"

# ── Deploy files ──────────────────────────────────────────────────────────────
step "Installing files..."
mkdir -p "$INSTALL_DIR/backend"

rsync -a \
    --exclude='__pycache__' --exclude='*.pyc' \
    --exclude='venv' --exclude='.env' --exclude='*.db' \
    --exclude='.credentials' --exclude='.api_keys.json' \
    "$SCRIPT_DIR/backend/" "$INSTALL_DIR/backend/"

rsync -a "$SCRIPT_DIR/frontend/dist/" "$INSTALL_DIR/backend/static/"

# ── Python virtualenv ─────────────────────────────────────────────────────────
step "Setting up Python environment..."
if [ ! -d "$INSTALL_DIR/backend/venv" ]; then
    python3 -m venv "$INSTALL_DIR/backend/venv"
fi
run "$INSTALL_DIR/backend/venv/bin/pip" install -q -r "$INSTALL_DIR/backend/requirements.txt"
success "Backend ready"

# ── Generate .env ─────────────────────────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/backend/.env" ]; then
    SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
    ENCRYPTION_KEY=$("$INSTALL_DIR/backend/venv/bin/python3" -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")

    cat > "$INSTALL_DIR/backend/.env" <<EOF
APP_SECRET_KEY=${SECRET_KEY}
ANKIWEB_ENCRYPTION_KEY=${ENCRYPTION_KEY}
APP_PORT=${APP_PORT}
CORS_ORIGINS=http://localhost:${APP_PORT}
ANKICONNECT_URL=http://localhost:8765
EOF
    verbose "Config generated (.env)"
else
    if ! grep -q "APP_PORT=${APP_PORT}" "$INSTALL_DIR/backend/.env" 2>/dev/null; then
        sed -i "s/^APP_PORT=.*/APP_PORT=${APP_PORT}/" "$INSTALL_DIR/backend/.env" 2>/dev/null || \
            echo "APP_PORT=${APP_PORT}" >> "$INSTALL_DIR/backend/.env"
    fi
    warn "Existing .env kept (secrets preserved)"
fi

# ── Systemd service ───────────────────────────────────────────────────────────
step "Configuring service..."
cat > /etc/systemd/system/ankibase.service <<EOF
[Unit]
Description=AnkiBase Backend
After=network.target docker.service
Requires=docker.service

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

# Kill any stale process on the port before starting
STALE_PID=$(ss -tlnp 2>/dev/null | grep ":${APP_PORT} " | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$STALE_PID" ] && kill "$STALE_PID" 2>/dev/null && sleep 1

systemctl restart ankibase
sleep 2

if systemctl is-active --quiet ankibase; then
    success "AnkiBase started"
else
    warn "Service may have failed — check: journalctl -u ankibase -n 30"
fi

# Write version (git commit SHA) for in-app update checks
git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null > "$INSTALL_DIR/backend/.version" || true

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
read -r SETUP_NGINX
echo ""

if [[ "$SETUP_NGINX" =~ ^[Yy]$ ]]; then
    step "Installing nginx..."
    run apt-get install -y -q nginx

    echo -n "  Domain name (leave empty to skip): "
    read -r DOMAIN
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
        read -r SETUP_SSL
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
