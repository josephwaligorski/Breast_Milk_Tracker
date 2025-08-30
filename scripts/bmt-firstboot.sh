#!/usr/bin/env bash
set -euo pipefail

# Log everything to a file when run under systemd or manually
exec 1>>/var/log/bmt-firstboot.log 2>&1 || true

STAMP=/var/lib/bmt-firstboot.done
if [[ -f "$STAMP" ]]; then
  echo "[bmt] already-done $(date -Is)"
  exit 0
fi

echo "[bmt] starting $(date -Is)"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-plugin git
systemctl enable --now docker || true

mkdir -p /opt/bmt
cd /opt/bmt
if [[ ! -d Breast_Milk_Tracker ]]; then
  git clone https://github.com/josephwaligorski/Breast_Milk_Tracker.git
fi
cd Breast_Milk_Tracker

# Prefer docker compose plugin, fallback to docker-compose
/usr/bin/docker compose up -d || /usr/bin/docker-compose up -d || true

mkdir -p "$(dirname "$STAMP")"
touch "$STAMP"
echo "[bmt] finished $(date -Is)"
