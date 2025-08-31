#!/usr/bin/env bash
# Configure Raspberry Pi OS to boot into desktop with autologin and launch Chromium in kiosk mode
set -euo pipefail

# Re-run as root if needed
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

echo "[kiosk] Ensuring GUI autologin via raspi-config..."
if command -v raspi-config >/dev/null 2>&1; then
  # B4 = Desktop autologin
  raspi-config nonint do_boot_behaviour B4 || true
else
  echo "[kiosk] raspi-config not found; continuing with autostart + LightDM defaults"
fi

echo "[kiosk] Installing Chromium and X11 utilities..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
# Try chromium-browser first (Bullseye), then chromium (Bookworm)
apt-get install -y chromium-browser || apt-get install -y chromium || true
apt-get install -y x11-xserver-utils || true

# Determine Chromium binary path
CHROME_BIN="/usr/bin/chromium-browser"
[[ -x "$CHROME_BIN" ]] || CHROME_BIN="/usr/bin/chromium"

PI_HOME="/home/pi"
AUTOSTART_DIR="$PI_HOME/.config/autostart"
DESKTOP_FILE="$AUTOSTART_DIR/bmt-kiosk.desktop"

echo "[kiosk] Creating autostart .desktop entry at $DESKTOP_FILE..."
mkdir -p "$AUTOSTART_DIR"
cat > "$DESKTOP_FILE" <<'DESK'
[Desktop Entry]
Type=Application
Name=Breast Milk Tracker Kiosk
Comment=Launch Chromium in kiosk mode for BMT
Exec=sh -c 'sleep 15; B=/usr/bin/chromium-browser; [ -x "$B" ] || B=/usr/bin/chromium; exec "$B" --noerrdialogs --disable-infobars --kiosk --incognito --start-fullscreen --disable-translate --overscroll-history-navigation=0 http://localhost:5000'
X-GNOME-Autostart-enabled=true
Terminal=false
Categories=Utility;
DESK
chown -R pi:pi "$PI_HOME/.config"

# Disable screensaver/DPMS at LXDE session level
LXDE_AUTOSTART="/etc/xdg/lxsession/LXDE-pi/autostart"
echo "[kiosk] Appending xset power-saving disables to $LXDE_AUTOSTART..."
mkdir -p "$(dirname "$LXDE_AUTOSTART")"
touch "$LXDE_AUTOSTART"
grep -q '^@xset s off$' "$LXDE_AUTOSTART" || echo '@xset s off' >> "$LXDE_AUTOSTART"
grep -q '^@xset -dpms$' "$LXDE_AUTOSTART" || echo '@xset -dpms' >> "$LXDE_AUTOSTART"
grep -q '^@xset s noblank$' "$LXDE_AUTOSTART" || echo '@xset s noblank' >> "$LXDE_AUTOSTART"

echo "[kiosk] Kiosk setup complete. Reboot to apply (sudo reboot)."
