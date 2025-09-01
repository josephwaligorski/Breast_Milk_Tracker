#!/usr/bin/env bash
set -euo pipefail

# Create a Raspberry Pi OS SD card with headless setup (SSH/Wi‑Fi/user)
# - Writes a Raspberry Pi OS image to the target device (DEST)
# - Enables SSH, sets hostname, creates Wi‑Fi config, and sets default user
#
# Usage examples:
#   ./scripts/create-sd.sh -d /dev/sdX -f /path/to/raspios.img.xz -H pi-kiosk \
#       -u pi -p 'changeme' -S 'MyWifi' -P 'wifi-pass' -C US -y
#   ./scripts/create-sd.sh -d /dev/sdX -i https://.../raspios-bookworm-arm64-lite.img.xz -y
#
# Notes:
# - This will ERASE the target device. Double-check the -d argument.
# - You can download images from https://www.raspberrypi.com/software/operating-systems/
# - Supported image formats: .img, .img.xz, .img.zip

DEST=""
IMAGE_FILE=""
IMAGE_URL=""
HOSTNAME="raspberrypi"
USERNAME="pi"
PASSWORD="raspberry"
WIFI_SSID=""
WIFI_PASS=""
WIFI_COUNTRY="US"
YES=0
# Kiosk and image selection options
KIOSK=1
KIOSK_URL="http://localhost:5000"
DESKTOP_IMAGE=1  # Prefer Desktop image when auto-downloading for kiosk
# Preload options
PRELOAD_REPO=1
PREBUILD_IMAGE=1
REPO_SRC_DIR="$(pwd)"
IMAGE_TAG="breast-milk-tracker:latest"

usage() {
  cat <<EOF
Usage: $0 -d /dev/sdX [options]

Required:
  -d, --device DEV        Target block device (e.g., /dev/sdX, /dev/mmcblk0)

Image source (choose one; if omitted, the script will try to auto-pick a local image from PWD or ~/Downloads):
  -f, --file PATH         Local image file (.img, .img.xz, .zip)
  -i, --image-url URL     Direct URL to image (.img.xz or .zip)

Headless config (optional):
  -H, --hostname NAME     Hostname (default: raspberrypi)
  -u, --user NAME         Default username (default: pi)
  -p, --pass PASS         Default password (default: raspberry)
  -S, --wifi-ssid SSID    Wi‑Fi SSID (optional)
  -P, --wifi-pass PASS    Wi‑Fi password (optional)
  -C, --wifi-country CC   Wi‑Fi country code (default: US)

Other:
  -y, --yes               Do not prompt for destructive confirmation
  --no-kiosk              Skip kiosk/autologin/app setup; only flash + basic headless config
  --kiosk-url URL         URL for Chromium kiosk (default: http://localhost:5000)
  --lite                  Prefer Lite image when auto-downloading (no desktop)
  --no-preload-repo       Do not copy this repo to the SD card (default: copy into /opt/bmt/Breast_Milk_Tracker)
  --no-prebuild-image     Do not prebuild Docker image (default: try to build linux/arm64 and bundle as tar)
  --repo-dir PATH         Source repo to preload (default: current directory)
  --image-tag TAG         Docker image tag to use (default: breast-milk-tracker:latest)
  -h, --help              Show this help
EOF
}

require() { command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1" >&2; exit 1; }; }

# Parse args
while [[ ${1-} ]]; do
  case "$1" in
    -d|--device) DEST="$2"; shift 2;;
    -f|--file) IMAGE_FILE="$2"; shift 2;;
    -i|--image-url) IMAGE_URL="$2"; shift 2;;
    -H|--hostname) HOSTNAME="$2"; shift 2;;
    -u|--user) USERNAME="$2"; shift 2;;
    -p|--pass) PASSWORD="$2"; shift 2;;
    -S|--wifi-ssid) WIFI_SSID="$2"; shift 2;;
    -P|--wifi-pass) WIFI_PASS="$2"; shift 2;;
    -C|--wifi-country) WIFI_COUNTRY="$2"; shift 2;;
    -y|--yes) YES=1; shift;;
  --no-kiosk) KIOSK=0; shift;;
  --kiosk-url) KIOSK_URL="$2"; shift 2;;
  --lite) DESKTOP_IMAGE=0; shift;;
  --no-preload-repo) PRELOAD_REPO=0; shift;;
  --no-prebuild-image) PREBUILD_IMAGE=0; shift;;
  --repo-dir) REPO_SRC_DIR="$2"; shift 2;;
  --image-tag) IMAGE_TAG="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1;;
  esac
done

# Validate
if [[ -z "$DEST" ]]; then echo "--device is required" >&2; usage; exit 1; fi
# If neither a file nor a URL provided, try to auto-detect a local image
if [[ -z "$IMAGE_FILE" && -z "$IMAGE_URL" ]]; then
  CANDIDATES=()
  # Search current directory and Downloads for likely images
  for dir in "$PWD" "$HOME/Downloads"; do
    [[ -d "$dir" ]] || continue
    while IFS= read -r -d '' f; do CANDIDATES+=("$f"); done < <(find "$dir" -maxdepth 1 -type f \( -name "*.img" -o -name "*.img.xz" -o -name "*.zip" \) -print0)
  done
  # Prefer files with raspios/raspberry in the name
  PREF=()
  for f in "${CANDIDATES[@]}"; do
    if [[ "$f" =~ [Rr]aspios|[Rr]aspberry|[Pp]i ]]; then PREF+=("$f"); fi
  done
  if [[ ${#PREF[@]} -gt 0 ]]; then CANDIDATES=("${PREF[@]}"); fi

  if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
    # No local image found; fall back to official latest URLs
    if ! command -v curl >/dev/null 2>&1; then
      echo "No local image found and curl missing. Install curl or pass --file/--image-url." >&2; exit 1
    fi
    if [[ $DESKTOP_IMAGE -eq 1 ]]; then
      IMAGE_URL="https://downloads.raspberrypi.com/raspios_arm64_latest"
      echo "No local image found. Auto-selecting Desktop (arm64) image: $IMAGE_URL"
    else
      IMAGE_URL="https://downloads.raspberrypi.com/raspios_lite_arm64_latest"
      echo "No local image found. Auto-selecting Lite (arm64) image: $IMAGE_URL"
    fi
  # If exactly one candidate, or running with -y (non-interactive), pick newest automatically
  elif [[ ${#CANDIDATES[@]} -eq 1 || $YES -eq 1 ]]; then
    # Pick the most recent by mtime if multiple and non-interactive
    if [[ ${#CANDIDATES[@]} -gt 1 ]]; then
      IMAGE_FILE=$(ls -t -- "${CANDIDATES[@]}" | head -n1)
    else
      IMAGE_FILE="${CANDIDATES[0]}"
    fi
    echo "Using local image: $IMAGE_FILE"
  else
    echo "Found local images:"
    i=1
    for f in "${CANDIDATES[@]}"; do echo "  $i) $f"; ((i++)); done
    read -rp "Select image [1-${#CANDIDATES[@]}] or ENTER for newest: " idx
    if [[ -z "$idx" ]]; then
      IMAGE_FILE=$(ls -t -- "${CANDIDATES[@]}" | head -n1)
    else
      if [[ "$idx" -lt 1 || "$idx" -gt ${#CANDIDATES[@]} ]]; then echo "Invalid selection" >&2; exit 1; fi
      IMAGE_FILE="${CANDIDATES[$((idx-1))]}"
    fi
    echo "Using local image: $IMAGE_FILE"
  fi
fi

# If both a local file and a URL are provided, prefer the local file
if [[ -n "$IMAGE_FILE" && -n "$IMAGE_URL" ]]; then
  echo "Both --file and --image-url provided; preferring local file: $IMAGE_FILE" >&2
  IMAGE_URL=""
fi
if [[ ! -b "$DEST" ]]; then echo "$DEST is not a block device" >&2; exit 1; fi

# Dependencies
require lsblk
require sudo
require dd
require ls
require grep
require awk
require sed
require tr
require xargs
require file

# Optional tools
XZ=$(command -v xz || true)
UNZIP=$(command -v unzip || true)
CURL=$(command -v curl || true)
PV=$(command -v pv || true)
OPENSSL=$(command -v openssl || true)
DOCKER=$(command -v docker || true)

# Confirm destructive action
if [[ $YES -ne 1 ]]; then
  echo "About to ERASE and write image to $DEST"
  lsblk -o NAME,SIZE,MODEL,MOUNTPOINT "$DEST" | sed '1!b; s/.*/\0 (target)/'
  read -rp "Proceed? (yes/NO): " ans
  if [[ "$ans" != "yes" ]]; then echo "Aborted"; exit 1; fi
fi

TMPDIR=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR" || true; }
trap cleanup EXIT

IMG_PATH=""

# Fetch or use local image
if [[ -n "$IMAGE_FILE" ]]; then
  IMG_PATH="$IMAGE_FILE"
  if [[ ! -f "$IMG_PATH" ]]; then echo "Image file not found: $IMG_PATH" >&2; exit 1; fi
elif [[ -n "$IMAGE_URL" ]]; then
  if [[ -z "$CURL" ]]; then echo "curl required to download image" >&2; exit 1; fi
  echo "Downloading image..."
  # Try to learn the final filename/extension from the effective URL first
  EFFECTIVE_URL=$(curl -sSL -o /dev/null -w '%{url_effective}' "$IMAGE_URL" || true)
  BASENAME="$(basename -- "$EFFECTIVE_URL")"
  CAND_EXT=""
  if [[ "$BASENAME" =~ \.(img\.xz|img|zip|xz)$ ]]; then
    CAND_EXT=".${BASH_REMATCH[1]}"
  fi
  OUT_BASE="$TMPDIR/image"
  OUT="$OUT_BASE${CAND_EXT}"
  curl -L "$IMAGE_URL" -o "$OUT"
  # If the extension is still unknown, infer from MIME type
  if [[ "$OUT" == "$OUT_BASE" ]]; then
    MIME=$(file -b --mime-type "$OUT" || true)
    case "$MIME" in
      application/x-xz)
        mv "$OUT" "$OUT_BASE.xz"; OUT="$OUT_BASE.xz";;
      application/zip)
        mv "$OUT" "$OUT_BASE.zip"; OUT="$OUT_BASE.zip";;
      application/octet-stream)
        # Heuristic: raw disk image often detected as DOS/MBR boot sector
        if file -b "$OUT" | grep -qiE 'boot sector|MBR|partition table|DOS'; then
          mv "$OUT" "$OUT_BASE.img"; OUT="$OUT_BASE.img";
        fi;;
    esac
  fi
  IMG_PATH="$OUT"
fi

# Decompress if needed
RAW_IMG="$TMPDIR/rpi.img"
case "$IMG_PATH" in
  *.img) cp "$IMG_PATH" "$RAW_IMG";;
  *.img.xz|*.xz)
    if [[ -z "$XZ" ]]; then echo "xz not found (install xz-utils)" >&2; exit 1; fi
    echo "Decompressing XZ..."
    xz -dc "$IMG_PATH" > "$RAW_IMG";;
  *.zip)
    if [[ -z "$UNZIP" ]]; then echo "unzip not found" >&2; exit 1; fi
    echo "Unzipping..."
    unzip -p "$IMG_PATH" | dd of="$RAW_IMG" bs=4M status=none;;
  *) echo "Unsupported image format: $IMG_PATH" >&2; exit 1;;
 esac

sync

# Unmount any partitions on DEST
echo "Unmounting any mounted partitions on $DEST..."
for p in $(lsblk -lnpo NAME "$DEST" | tail -n +2); do
  if mount | grep -q "^$p "; then sudo umount "$p" || true; fi
done

# Write image to DEST
echo "Writing image to $DEST (this may take a while)..."
if [[ -n "$PV" ]]; then
  sudo bash -c "pv \"$RAW_IMG\" | dd of=\"$DEST\" bs=4M conv=fsync status=progress"
else
  sudo dd if="$RAW_IMG" of="$DEST" bs=4M conv=fsync status=progress
fi
sync

# Wait for partitions to appear
echo "Waiting for partitions..."
sleep 3
sudo partprobe "$DEST" || true
sleep 2

# Determine boot/root partition names (handle /dev/sda vs /dev/mmcblk0)
P1="1"; P2="2"
if [[ "$DEST" =~ [0-9]$ ]]; then P1="p1"; P2="p2"; fi
BOOT_PART="${DEST}${P1}"
ROOT_PART="${DEST}${P2}"

# Mount boot partition
BOOT_MNT="$TMPDIR/boot"
mkdir -p "$BOOT_MNT"
sudo mount "$BOOT_PART" "$BOOT_MNT"

# Mount root partition (for kiosk and first-boot wiring)
ROOT_MNT="$TMPDIR/root"
mkdir -p "$ROOT_MNT"
sudo mount "$ROOT_PART" "$ROOT_MNT"

# Enable SSH
sudo touch "$BOOT_MNT/ssh"

# Set hostname
echo "$HOSTNAME" | sudo tee "$BOOT_MNT/hostname" >/dev/null

# Wi‑Fi config (if provided)
if [[ -n "$WIFI_SSID" ]]; then
  cat <<WPA | sudo tee "$BOOT_MNT/wpa_supplicant.conf" >/dev/null
country=$WIFI_COUNTRY
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1

network={
    ssid="$WIFI_SSID"
    psk="$WIFI_PASS"
}
WPA
fi

# Default user/password
if [[ -n "$OPENSSL" ]]; then
  PASS_HASH=$(printf "%s" "$PASSWORD" | openssl passwd -6 -stdin)
  echo "$USERNAME:$PASS_HASH" | sudo tee "$BOOT_MNT/userconf.txt" >/dev/null
else
  echo "openssl not found; skipping userconf.txt (default OS user will be required)" >&2
fi

# Kiosk/autologin + first-boot installer wiring (optional)
if [[ $KIOSK -eq 1 ]]; then
  echo "Configuring desktop autologin, kiosk autostart, and first-boot installer..."

  # Ensure LightDM autologin for the specified user
  sudo mkdir -p "$ROOT_MNT/etc/lightdm/lightdm.conf.d"
  sudo tee "$ROOT_MNT/etc/lightdm/lightdm.conf.d/12-autologin.conf" >/dev/null <<CONF
[Seat:*]
autologin-user=$USERNAME
autologin-user-timeout=0
user-session=lightdm-autologin
CONF

  # Kiosk launcher script that waits for X and Chromium then opens URL
  sudo tee "$ROOT_MNT/usr/local/bin/kiosk.sh" >/dev/null <<'SH'
#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=:0
# Wait for X/Wayland
for i in $(seq 1 60); do
  pgrep -a Xorg >/dev/null 2>&1 || pgrep -a wayfire >/dev/null 2>&1 && break || true
  sleep 1
done
# Disable screen blanking
command -v xset >/dev/null 2>&1 && { xset s off || true; xset -dpms || true; xset s noblank || true; }
# Wait for chromium to be installed (first-boot may be installing it)
for i in $(seq 1 120); do
  B=/usr/bin/chromium-browser; [[ -x "$B" ]] || B=/usr/bin/chromium
  if [[ -x "$B" ]]; then
    break
  fi
  sleep 2
done
# Small grace to allow server start
sleep 10
exec "$B" --noerrdialogs --disable-infobars --kiosk --incognito --start-fullscreen --disable-translate --overscroll-history-navigation=0 KIOSK_URL_PLACEHOLDER
SH
  sudo chmod +x "$ROOT_MNT/usr/local/bin/kiosk.sh"
  sudo sed -i "s|KIOSK_URL_PLACEHOLDER|$KIOSK_URL|g" "$ROOT_MNT/usr/local/bin/kiosk.sh"

  # Autostart .desktop entry for user session
  sudo mkdir -p "$ROOT_MNT/home/$USERNAME/.config/autostart"
  sudo tee "$ROOT_MNT/home/$USERNAME/.config/autostart/bmt-kiosk.desktop" >/dev/null <<'DESK'
[Desktop Entry]
Type=Application
Name=Breast Milk Tracker Kiosk
Exec=/usr/local/bin/kiosk.sh
X-GNOME-Autostart-enabled=true
Terminal=false
Categories=Utility;
DESK
  sudo chown -R 1000:1000 "$ROOT_MNT/home/$USERNAME/.config" || true

  # LXDE session autostart to keep display awake
  sudo mkdir -p "$ROOT_MNT/etc/xdg/lxsession/LXDE-pi"
  AUTOSTART_FILE="$ROOT_MNT/etc/xdg/lxsession/LXDE-pi/autostart"
  sudo touch "$AUTOSTART_FILE"
  grep -q '^@xset s off$' "$AUTOSTART_FILE" || echo '@xset s off' | sudo tee -a "$AUTOSTART_FILE" >/dev/null
  grep -q '^@xset -dpms$' "$AUTOSTART_FILE" || echo '@xset -dpms' | sudo tee -a "$AUTOSTART_FILE" >/dev/null
  grep -q '^@xset s noblank$' "$AUTOSTART_FILE" || echo '@xset s noblank' | sudo tee -a "$AUTOSTART_FILE" >/dev/null

  # First-boot installer: installs Docker, compose plugin, git, and Chromium; then starts the app
  sudo tee "$ROOT_MNT/usr/local/sbin/bmt-firstboot.sh" >/dev/null <<'FB'
#!/usr/bin/env bash
set -euo pipefail
exec 1>>/var/log/bmt-firstboot.log 2>&1 || true
STAMP=/var/lib/bmt-firstboot.done
if [[ -f "$STAMP" ]]; then echo "[bmt] already-done $(date -Is)"; exit 0; fi
echo "[bmt] starting $(date -Is)"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-plugin git chromium-browser || apt-get install -y docker.io docker-compose-plugin git chromium || true
systemctl enable --now docker || true
mkdir -p /opt/bmt
cd /opt/bmt
if [[ -f bmt-image.tar ]]; then
  echo "[bmt] Loading prebuilt Docker image..."
  docker load -i bmt-image.tar || true
fi
if [[ ! -d Breast_Milk_Tracker ]]; then
  echo "[bmt] Preloaded repo not found; cloning..."
  git clone https://github.com/josephwaligorski/Breast_Milk_Tracker.git || true
fi
cd Breast_Milk_Tracker || exit 0
# Build if no image was preloaded
/usr/bin/docker compose up -d --build || /usr/bin/docker-compose up -d --build || true
mkdir -p "$(dirname "$STAMP")"; touch "$STAMP"
echo "[bmt] finished $(date -Is)"
FB
  sudo chmod +x "$ROOT_MNT/usr/local/sbin/bmt-firstboot.sh"

  sudo tee "$ROOT_MNT/etc/systemd/system/bmt-firstboot.service" >/dev/null <<'SVC'
[Unit]
Description=Breast Milk Tracker first-boot installer
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/bmt-firstboot.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
SVC
  sudo mkdir -p "$ROOT_MNT/etc/systemd/system/multi-user.target.wants"
  sudo ln -sf /etc/systemd/system/bmt-firstboot.service "$ROOT_MNT/etc/systemd/system/multi-user.target.wants/bmt-firstboot.service"
fi

# Preload repository into rootfs (optional)
if [[ $PRELOAD_REPO -eq 1 ]]; then
  echo "Preloading repository from $REPO_SRC_DIR into SD card..."
  if [[ ! -d "$REPO_SRC_DIR" ]]; then
    echo "Repo source dir not found: $REPO_SRC_DIR" >&2
  else
    sudo mkdir -p "$ROOT_MNT/opt/bmt"
    # Copy repo excluding typical junk
    rsync -a --delete --exclude .git/ --exclude node_modules/ --exclude .cache/ \
      --exclude dist/ --exclude buildx-cache/ --exclude '*.log' \
      "$REPO_SRC_DIR/" "$ROOT_MNT/opt/bmt/Breast_Milk_Tracker/"
    # Ensure permissions are accessible to default user (uid 1000 on Pi images)
    sudo chown -R 1000:1000 "$ROOT_MNT/opt/bmt/Breast_Milk_Tracker" || true
  fi
fi

# Optionally prebuild linux/arm64 Docker image and bundle as tar
if [[ $PREBUILD_IMAGE -eq 1 ]]; then
  if [[ -n "$DOCKER" ]]; then
    echo "Attempting to prebuild Docker image ($IMAGE_TAG) for linux/arm64..."
    # Ensure buildx exists and use docker-container driver for exporters
    if ! docker buildx ls >/dev/null 2>&1; then
      echo "Creating docker buildx builder (docker-container)..."
      docker buildx create --name bmtx --driver docker-container --use >/dev/null 2>&1 || true
    fi
    # Bootstrap QEMU emulation if needed
    docker buildx inspect --bootstrap >/dev/null 2>&1 || true
    TARBALL="$TMPDIR/bmt-image.tar"
    # Preferred: export directly to tar (no daemon load)
    if docker buildx build --platform linux/arm64 -t "$IMAGE_TAG" --output type=tar,dest="$TARBALL" "$REPO_SRC_DIR"; then
      echo "Copying prebuilt image tar to SD card..."
      sudo mkdir -p "$ROOT_MNT/opt/bmt"
      sudo cp "$TARBALL" "$ROOT_MNT/opt/bmt/bmt-image.tar"
    else
      echo "Direct tar export failed; trying load+save fallback..." >&2
      if docker buildx build --platform linux/arm64 -t "$IMAGE_TAG" --load "$REPO_SRC_DIR" && docker save -o "$TARBALL" "$IMAGE_TAG"; then
        echo "Copying prebuilt image tar to SD card..."
        sudo mkdir -p "$ROOT_MNT/opt/bmt"
        sudo cp "$TARBALL" "$ROOT_MNT/opt/bmt/bmt-image.tar"
      else
        echo "Warning: Failed to prebuild ARM64 image. The Pi will build on first boot." >&2
      fi
    fi
  else
    echo "Docker not found on host; skipping prebuild of image." >&2
  fi
fi

# Done
sudo sync
sudo umount "$ROOT_MNT" || true
sudo umount "$BOOT_MNT"
echo "SD card is ready. Insert into Raspberry Pi and power on."
