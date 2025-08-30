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

usage() {
  cat <<EOF
Usage: $0 -d /dev/sdX [options]

Required:
  -d, --device DEV        Target block device (e.g., /dev/sdX, /dev/mmcblk0)

Image source (choose one):
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
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1;;
  esac
done

# Validate
if [[ -z "$DEST" ]]; then echo "--device is required" >&2; usage; exit 1; fi
if [[ -z "$IMAGE_FILE" && -z "$IMAGE_URL" ]]; then
  echo "Provide an image with --file or --image-url" >&2; usage; exit 1
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

# Optional tools
XZ=$(command -v xz || true)
UNZIP=$(command -v unzip || true)
CURL=$(command -v curl || true)
PV=$(command -v pv || true)
OPENSSL=$(command -v openssl || true)

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
  OUT="$TMPDIR/image"
  curl -L "$IMAGE_URL" -o "$OUT"
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

# Determine boot partition name
PART_SUFFIX="1"
if [[ "$DEST" =~ [0-9]$ ]]; then PART_SUFFIX="p1"; fi
BOOT_PART="${DEST}${PART_SUFFIX}"

# Mount boot partition
BOOT_MNT="$TMPDIR/boot"
mkdir -p "$BOOT_MNT"
sudo mount "$BOOT_PART" "$BOOT_MNT"

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

# Done
sudo sync
sudo umount "$BOOT_MNT"
echo "SD card is ready. Insert into Raspberry Pi and power on."
