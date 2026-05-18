#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${CYAN}[ankibase]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
error()   { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ── Root check ──────────────────────────────────────────────────────────────
[ "$EUID" -ne 0 ] && error "Please run as root (sudo ./install.sh)"

INSTALL_DIR="/opt/ankibase"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  ╔══════════════════════════════╗"
echo "  ║     AnkiBase Installer       ║"
echo "  ╚══════════════════════════════╝"
echo ""

# ── System packages ──────────────────────────────────────────────────────────
info "Updating package list..."
apt-get update -q

info "Installing system dependencies..."
apt-get install -y -q \
    python3 python3-venv python3-pip \
    curl wget git rsync ca-certificates \
    gnupg lsb-release iproute2

# ── Node.js (for frontend build) ─────────────────────────────────────────────
if ! command -v node &>/dev/null || [ "$(node -e 'process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)' 2>/dev/null; echo $?)" = "1" ]; then
    info "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -q nodejs
    success "Node.js $(node --version) installed"
else
    success "Node.js $(node --version) already installed"
fi

# ── Docker ───────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    info "Installing Docker..."
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
    systemctl enable docker >/dev/null 2>&1
    systemctl start docker
    success "Docker installed"
else
    success "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') already installed"
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
info "Using port $APP_PORT for AnkiBase"

# ── Build frontend ────────────────────────────────────────────────────────────
info "Building frontend..."
cd "$SCRIPT_DIR/frontend"
npm install --silent
npm run build --silent
success "Frontend built"
cd "$SCRIPT_DIR"

# ── Deploy files ──────────────────────────────────────────────────────────────
info "Installing to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/backend"

rsync -a \
    --exclude='__pycache__' --exclude='*.pyc' \
    --exclude='venv' --exclude='.env' --exclude='*.db' \
    --exclude='.credentials' --exclude='.api_keys.json' \
    "$SCRIPT_DIR/backend/" "$INSTALL_DIR/backend/"

rsync -a "$SCRIPT_DIR/frontend/dist/" "$INSTALL_DIR/backend/static/"

success "Files copied"

# ── Python virtualenv ─────────────────────────────────────────────────────────
info "Setting up Python environment..."
if [ ! -d "$INSTALL_DIR/backend/venv" ]; then
    python3 -m venv "$INSTALL_DIR/backend/venv"
fi
"$INSTALL_DIR/backend/venv/bin/pip" install -q -r "$INSTALL_DIR/backend/requirements.txt"
success "Python dependencies installed"

# ── Generate .env ─────────────────────────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/backend/.env" ]; then
    info "Generating configuration..."
    SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
    ENCRYPTION_KEY=$("$INSTALL_DIR/backend/venv/bin/python3" -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")

    cat > "$INSTALL_DIR/backend/.env" <<EOF
APP_SECRET_KEY=${SECRET_KEY}
ANKIWEB_ENCRYPTION_KEY=${ENCRYPTION_KEY}
APP_PORT=${APP_PORT}
CORS_ORIGINS=http://localhost:${APP_PORT}
ANKICONNECT_URL=http://localhost:8765
EOF
    success "Configuration generated"
else
    # Update port in existing .env if different
    if ! grep -q "APP_PORT=${APP_PORT}" "$INSTALL_DIR/backend/.env" 2>/dev/null; then
        sed -i "s/^APP_PORT=.*/APP_PORT=${APP_PORT}/" "$INSTALL_DIR/backend/.env" 2>/dev/null || \
            echo "APP_PORT=${APP_PORT}" >> "$INSTALL_DIR/backend/.env"
    fi
    warn "Existing .env kept (secrets preserved)"
fi

# ── Systemd service ───────────────────────────────────────────────────────────
info "Creating systemd service..."
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

systemctl daemon-reload
systemctl enable ankibase >/dev/null 2>&1

# Kill any stale process on the port before starting
STALE_PID=$(ss -tlnp 2>/dev/null | grep ":${APP_PORT} " | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$STALE_PID" ] && kill "$STALE_PID" 2>/dev/null && sleep 1

systemctl restart ankibase
sleep 2

if systemctl is-active --quiet ankibase; then
    success "AnkiBase service started"
else
    warn "Service may have failed. Check: journalctl -u ankibase -n 30"
fi

# ── Get server IP ─────────────────────────────────────────────────────────────
SERVER_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "  ──────────────────────────────────"
success "AnkiBase is running!"
echo "  Access: http://${SERVER_IP}:${APP_PORT}"
echo "  ──────────────────────────────────"
echo ""

# ── Nginx (optional) ──────────────────────────────────────────────────────────
echo -n "  Set up nginx reverse proxy? [y/N] "
read -r SETUP_NGINX
echo ""

if [[ "$SETUP_NGINX" =~ ^[Yy]$ ]]; then
    info "Installing nginx..."
    apt-get install -y -q nginx

    echo -n "  Domain name (leave empty to use IP only): "
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
    nginx -t && systemctl restart nginx
    success "nginx configured"

    # Update CORS
    sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=http://localhost:${APP_PORT},http://${NGINX_SERVER}|" \
        "$INSTALL_DIR/backend/.env"
    systemctl restart ankibase

    if [ -n "$DOMAIN" ]; then
        echo -n "  Set up SSL with Certbot? [y/N] "
        read -r SETUP_SSL
        echo ""

        if [[ "$SETUP_SSL" =~ ^[Yy]$ ]]; then
            info "Installing Certbot..."
            apt-get install -y -q certbot python3-certbot-nginx
            certbot --nginx -d "$DOMAIN"

            # Update CORS for HTTPS
            sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=http://localhost:${APP_PORT},https://${DOMAIN}|" \
                "$INSTALL_DIR/backend/.env"
            systemctl restart ankibase
            success "SSL configured"
        fi
    fi

    echo ""
    echo "  ──────────────────────────────────"
    success "Done! Access AnkiBase at:"
    if [ -n "$DOMAIN" ]; then
        echo "  → http://${DOMAIN} (or https:// if SSL was set up)"
    else
        echo "  → http://${SERVER_IP}"
    fi
    echo "  ──────────────────────────────────"
else
    echo "  Skipping nginx. You can run this script again to set it up."
fi

echo ""
info "To view logs: journalctl -u ankibase -f"
info "To restart:   systemctl restart ankibase"
echo ""
