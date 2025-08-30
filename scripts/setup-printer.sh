#!/usr/bin/env bash
set -euo pipefail

# Breast Milk Tracker: printer setup helper for Raspberry Pi
# - Detect CUPS printers and set PRINTER in .env
# - Choose TSPL raw mode for Polono PL420 (recommended)
# - Optionally set PDF options (LABEL_MEDIA, ORIENTATION, PRINT_FIT)
# - Optional: restart docker compose after changes

ENV_FILE=".env"
PRINTER_NAME=""
PRINT_MODE=""
LABEL_MEDIA=""
ORIENTATION=""
PRINT_FIT=""
RESTART=0
NON_INTERACTIVE=0

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  -e, --env FILE           Path to .env file (default: .env)
  -p, --printer NAME       CUPS queue name to set as PRINTER
  -m, --mode MODE          Print mode: tspl | pdf (default: auto-detect Polono => tspl)
  -l, --label-media MEDIA  LABEL_MEDIA value for PDF mode (e.g., Custom.189x72)
  -o, --orientation ORIENT ORIENTATION for PDF mode (e.g., landscape)
  -f, --fit 0|1            PRINT_FIT for PDF mode (1 fit-to-page, 0 scaling=100)
  -r, --restart            Run 'docker compose up -d' after updating .env
  -n, --non-interactive    Fail if multiple printers; do not prompt
  -h, --help               Show this help
EOF
}

# Parse args
while [[ ${1-} ]]; do
  case "$1" in
    -e|--env) ENV_FILE="$2"; shift 2;;
    -p|--printer) PRINTER_NAME="$2"; shift 2;;
    -m|--mode) PRINT_MODE="$2"; shift 2;;
    -l|--label-media) LABEL_MEDIA="$2"; shift 2;;
    -o|--orientation) ORIENTATION="$2"; shift 2;;
    -f|--fit) PRINT_FIT="$2"; shift 2;;
    -r|--restart) RESTART=1; shift;;
    -n|--non-interactive) NON_INTERACTIVE=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1;;
  esac
done

require() { command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1" >&2; exit 1; }; }
require lpstat
require sed

# Ensure env file exists
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Creating $ENV_FILE"
  touch "$ENV_FILE"
fi

get_env() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | sed -E "s/^$1=//" || true; }
set_env() {
  local key="$1"; shift
  local val="$*"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i -E "s#^${key}=.*#${key}=${val//#/\\#}#" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

# Detect printers if not provided
if [[ -z "$PRINTER_NAME" ]]; then
  mapfile -t PRINTERS < <(lpstat -p 2>/dev/null | awk '/^printer/{print $2}')
  DEFAULT_PR=$(lpstat -d 2>/dev/null | awk -F': ' '/system default destination/{print $2}')
  if [[ ${#PRINTERS[@]} -eq 0 ]]; then
    echo "No CUPS printers found. Add your printer in CUPS first." >&2
    exit 1
  elif [[ ${#PRINTERS[@]} -eq 1 ]]; then
    PRINTER_NAME="${PRINTERS[0]}"
  else
    if [[ -n "$DEFAULT_PR" ]]; then
      PRINTER_NAME="$DEFAULT_PR"
    elif [[ $NON_INTERACTIVE -eq 1 ]]; then
      echo "Multiple printers found; please specify with --printer" >&2
      printf 'Found: %s\n' "${PRINTERS[@]}" >&2
      exit 1
    else
      echo "Multiple printers detected:"
      i=1
      for p in "${PRINTERS[@]}"; do
        echo "  $i) $p"
        ((i++))
      done
      read -rp "Select printer [1-${#PRINTERS[@]}]: " idx
      if [[ -z "$idx" || "$idx" -lt 1 || "$idx" -gt ${#PRINTERS[@]} ]]; then
        echo "Invalid selection" >&2; exit 1
      fi
      PRINTER_NAME="${PRINTERS[$((idx-1))]}"
    fi
  fi
fi

# Auto-detect mode: Polono/PL420 => tspl
if [[ -z "$PRINT_MODE" ]]; then
  shopt -s nocasematch
  if [[ "$PRINTER_NAME" =~ polono|pl420 ]]; then
    PRINT_MODE="tspl"
  else
    PRINT_MODE="pdf"
  fi
  shopt -u nocasematch
fi

# Set defaults for PDF if user passed values or using pdf mode
if [[ "$PRINT_MODE" == "pdf" ]]; then
  LABEL_MEDIA="${LABEL_MEDIA:-Custom.189x72}"
  PRINT_FIT="${PRINT_FIT:-1}"
fi

# Update env file
set_env PRINTER "$PRINTER_NAME"
set_env PRINT_MODE "$PRINT_MODE"
if [[ -n "$LABEL_MEDIA" ]]; then set_env LABEL_MEDIA "$LABEL_MEDIA"; fi
if [[ -n "$ORIENTATION" ]]; then set_env ORIENTATION "$ORIENTATION"; fi
if [[ -n "$PRINT_FIT" ]]; then set_env PRINT_FIT "$PRINT_FIT"; fi

echo "Updated $ENV_FILE:" >&2
grep -E '^(PRINTER|PRINT_MODE|LABEL_MEDIA|ORIENTATION|PRINT_FIT)=' "$ENV_FILE" || true

# Optional restart
if [[ $RESTART -eq 1 ]]; then
  if command -v docker >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
    if command -v docker compose >/dev/null 2>&1; then
      docker compose up -d
    else
      echo "docker compose not found; skipping restart" >&2
    fi
  else
    echo "docker not found; skipping restart" >&2
  fi
fi

echo "Done"
