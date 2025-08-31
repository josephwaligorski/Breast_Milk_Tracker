#!/usr/bin/env bash
# One-shot system setup for Raspberry Pi: server, kiosk, and printer
set -euo pipefail

# Re-run as root if needed
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"

echo "[system] Running Breast Milk Tracker server setup..."
bash "$ROOT_DIR/scripts/bmt-firstboot.sh" || true

echo "[system] Running kiosk GUI setup..."
bash "$ROOT_DIR/scripts/setup-kiosk.sh"

echo "[system] Running printer setup..."
if [[ -x "$ROOT_DIR/scripts/setup-printer.sh" ]]; then
  bash "$ROOT_DIR/scripts/setup-printer.sh" || true
else
  echo "[system] setup-printer.sh not found or not executable; skipping"
fi

echo "[system] Setup complete. Recommend reboot: sudo reboot"
