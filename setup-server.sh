#!/usr/bin/env bash
# ============================================================
# Bosphor Server Setup Script
# Run this on Ubuntu 22.04 server (128GB RAM)
# Usage: curl -sSL https://your-repo/infra/setup-server.sh | bash
# Or: bash infra/setup-server.sh
# ============================================================

set -euo pipefail

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err() { echo -e "${RED}[error]${NC} $1"; exit 1; }

log "Starting Bosphor server setup..."

# ── 1. System Update ──────────────────────────────────────────────────────
log "Updating system packages..."
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

# ── 2. Essential Tools ────────────────────────────────────────────────────
log "Installing essential tools..."
sudo apt-get install -y -qq \
  curl wget git build-essential \
  ca-certificates gnupg lsb-release \
  htop tmux jq unzip

# ── 3. Docker ─────────────────────────────────────────────────────────────
if ! command -v docker &> /dev/null; then
  log "Installing Docker..."
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
    sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  log "Docker installed. You may need to log out and back in."
else
  log "Docker already installed: $(docker --version)"
fi

# ── 4. Node.js 20 ────────────────────────────────────────────────────────
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
  log "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  log "Node.js already installed: $(node --version)"
fi

# ── 5. pnpm ───────────────────────────────────────────────────────────────
if ! command -v pnpm &> /dev/null; then
  log "Installing pnpm..."
  npm install -g pnpm@9
else
  log "pnpm already installed: $(pnpm --version)"
fi

# ── 6. Foundry ────────────────────────────────────────────────────────────
if ! command -v forge &> /dev/null; then
  log "Installing Foundry..."
  curl -L https://foundry.paradigm.xyz | bash
  # shellcheck source=/dev/null
  source "$HOME/.bashrc" 2>/dev/null || true
  foundryup
else
  log "Foundry already installed: $(forge --version)"
fi

# ── 7. Rust ───────────────────────────────────────────────────────────────
if ! command -v cargo &> /dev/null; then
  log "Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck source=/dev/null
  source "$HOME/.cargo/env"
else
  log "Rust already installed: $(rustc --version)"
fi

# ── 8. Sui CLI ────────────────────────────────────────────────────────────
if ! command -v sui &> /dev/null; then
  log "Installing Sui CLI (this takes a while — building from source)..."
  cargo install --locked \
    --git https://github.com/MystenLabs/sui.git \
    --branch testnet sui
else
  log "Sui CLI already installed: $(sui --version)"
fi

# ── 9. GitHub Actions Self-Hosted Runner ─────────────────────────────────
log ""
log "========================================================"
log "GitHub Actions Self-Hosted Runner Setup"
log "========================================================"
log "Run the following steps manually:"
log ""
log "1. Go to: https://github.com/YOUR_ORG/bosphor/settings/actions/runners/new"
log "2. Select: Linux x64"
log "3. Follow the download + configure commands shown there"
log "4. Install as a service:"
log "   sudo ./svc.sh install"
log "   sudo ./svc.sh start"
log ""
warn "The runner token expires in 1 hour — do this now!"

# ── 10. Firewall ──────────────────────────────────────────────────────────
log "Configuring firewall (ufw)..."
sudo ufw --force enable
sudo ufw allow ssh
sudo ufw allow 3000   # Grafana
sudo ufw allow 9090   # Prometheus (restrict to your IP in production!)
# Relayer port 3001 is NOT exposed publicly — only internal + CI

log ""
log "========================================================"
log "Server setup complete!"
log "========================================================"
log ""
log "Next steps:"
log "  1. Clone repo: git clone https://github.com/YOUR_ORG/bosphor.git"
log "  2. Copy env:   cp .env.example .env && nano .env"
log "  3. Start infra: docker compose -f infra/docker/docker-compose.staging.yml up -d"
log "  4. Set up GitHub Actions runner (see above)"
log ""
