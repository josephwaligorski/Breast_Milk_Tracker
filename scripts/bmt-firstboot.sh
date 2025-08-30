#!/usr/bin/env bash
set -euo pipefail

# Log to file and stdout
exec > >(tee -a /var/log/bmt-firstboot.log) 2>&1

STAMP=/var/lib/bmt-firstboot.done
if [[ -f "$STAMP" ]]; then echo "[bmt] already-done $(date -Is)"; exit 0; fi

echo "[bmt] starting $(date -Is)"
export DEBIAN_FRONTEND=noninteractive

# Install Docker Engine using the convenience script
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker || true

# Install Docker Compose v2 CLI plugin (static binary)
if ! docker compose version >/dev/null 2>&1; then
  ARCH=$(uname -m)
  case "$ARCH" in
    aarch64|arm64) COMPOSE_ARCH=linux-aarch64;;
    armv7l) COMPOSE_ARCH=linux-armv7;;
    x86_64|amd64) COMPOSE_ARCH=linux-x86_64;;
    *) COMPOSE_ARCH=linux-aarch64;;
  esac
  COMPOSE_VERSION="v2.29.6"
  install -d -m 0755 /usr/local/lib/docker/cli-plugins
  curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-${COMPOSE_ARCH}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  docker compose version || true
fi

# Deploy app
apt-get update
apt-get install -y git
mkdir -p /opt/bmt
cd /opt/bmt
if [[ ! -d Breast_Milk_Tracker ]]; then
  git clone https://github.com/josephwaligorski/Breast_Milk_Tracker.git
fi
cd Breast_Milk_Tracker
docker compose up -d || true

mkdir -p "$(dirname "$STAMP")" && touch "$STAMP"
echo "[bmt] finished $(date -Is)"
