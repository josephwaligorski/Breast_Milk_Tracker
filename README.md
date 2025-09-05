# Breast Milk Tracker — Raspberry Pi setup and operations

A touch-friendly React + Node/Express app for logging pumped milk, printing labels, and tracking totals. Designed to run on a Raspberry Pi, print directly to a label printer without dialogs, and update remotely via Docker.

- Label size: 2 5/8" × 1" (Avery 5160 width; 1" height)
- Printer: Polono PL420 (TSPL-compatible)
- Printing modes: TSPL raw (recommended for PL420) or PDF via CUPS

## Quick start (TL;DR)

1. On the Pi, install Docker, docker compose, and CUPS. Add your Polono PL420 in CUPS and note its queue name.

1. Clone this repo and set `.env`:

```bash
cp .env .env.local 2>/dev/null || true
# Edit .env and set PRINTER to your CUPS queue, PRINT_MODE=tspl for PL420
```

1. Start with Docker Compose:

```bash
docker compose up -d --build
```

1. Open the app at `http://<pi-ip>:5000` and save a session; it should print immediately.

---

## Full setup guide

### 1) Flash Raspberry Pi OS to SD

- Use Raspberry Pi Imager:
  - Choose OS: Raspberry Pi OS (64-bit recommended)
  - Choose Storage: your SD card
  - Advanced options: set hostname, enable SSH, set username/password, and Wi‑Fi if needed
  - Write and insert in your Pi

### 2) First boot and SSH

- Boot the Pi, find its IP from your router/DHCP
- SSH in: `ssh <user>@<pi-ip>`

### 3) Install Docker and Compose plugin

```bash
sudo apt-get update -y
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
newgrp docker <<'EOF'
docker --version
EOF
sudo apt-get install -y docker-compose-plugin
docker compose version
```

### 4) Install and configure CUPS

```bash
sudo apt-get install -y cups
sudo usermod -aG lpadmin $USER
sudo systemctl enable --now cups
```

- Open CUPS: `http://<pi-ip>:631`
- Add Printer (Administration → Add Printer), select Polono PL420 (USB)
- Use a Raw/Generic driver if available (for TSPL), or vendor driver if installed
- Set it as Default and note the Queue Name (e.g., `Polono_PL420`)
- Test: `echo test | lp -d Polono_PL420 -o raw` (should print a small line)

### 5) Get the app on the Pi

```bash
git clone https://github.com/your-org/breast-milk-tracker.git
cd breast-milk-tracker
```

### 6) Configure environment

Edit `.env` (already present in repo). Important keys:

- `PORT=5000` — host port to expose
- `PRINTER=Polono_PL420` — your CUPS queue name
- `PRINT_MODE=tspl` — use raw TSPL (best for PL420); leave empty for PDF mode
- `LABEL_MEDIA=Custom.189x72` — 2.625" × 1" when using PDF mode
- `ORIENTATION=` and `PRINT_FIT=1` — PDF mode tuning

You can also create `.env.local` or keep editing `.env` directly.

### 7) Connect the container to CUPS

Choose one of the following:

- Option A — Host networking (simpler on Pi):
  - In `docker-compose.yml`, uncomment `network_mode: host`
  - Remove the `ports:` section (host networking exposes the app directly)

- Option B — Mount CUPS client config:
  - Create `/etc/cups/client.conf` on the host with one line:

  ```text
    ServerName <pi-ip>:631
    ```

  - In `docker-compose.yml`, uncomment the mount:

    ```yaml
    volumes:
      - /etc/cups/client.conf:/etc/cups/client.conf:ro
    ```

Either option makes `lp` inside the container talk to the host CUPS.

### 8) Build and run

```bash
docker compose up -d --build
```

Open the app: `http://<pi-ip>:5000`

### 9) Test printing

- In the app, save a session — it will POST to the backend and print a label without a dialog.
- For Polono PL420, `PRINT_MODE=tspl` is recommended and enabled by default in `.env`.

---

## Updating the app

```bash
git pull
docker compose up -d --build
```

Data persistence: session history lives in `backend/data.json`, which is bind‑mounted into the container by `docker-compose.yml`.

Backup/restore:

```bash
cp backend/data.json backup-data.json
cp backup-data.json backend/data.json
```

---

## Printing modes and tuning

### TSPL mode (recommended for Polono PL420)

- Set `PRINT_MODE=tspl` and `PRINTER` to your queue name
- The backend writes a TSPL program to `lp -o raw` (no driver scaling)
- If the layout needs tweaks, we can adjust coordinates/sizes in the TSPL block in `backend/server.js`

### PDF via CUPS

- Clear `PRINT_MODE` to use PDF mode
- Variables:
  - `LABEL_MEDIA=Custom.189x72` (2.625" × 1" at 72dpi points)
  - `ORIENTATION=landscape` if your driver rotates the page
  - `PRINT_FIT=1` to fit-to-page, `0` for 100% scaling

If output is clipped/small, experiment with `LABEL_MEDIA`, `PRINT_FIT`, and `ORIENTATION` depending on your driver.

---

## Troubleshooting

- Can’t reach app: ensure the container is running and port is exposed (`docker ps`), then open `http://<pi-ip>:5000`
- Printing fails:
  - Verify CUPS sees your printer: `lpstat -p`
  - Ensure the container can reach host CUPS (use host networking or mount `client.conf`)
  - Check logs: `docker logs bmt`
  - Try a raw test: `echo TEST | lp -d <PRINTER> -o raw`
- Wrong queue name: set `PRINTER` in `.env`, then `docker compose up -d`
- Labels misaligned:
  - TSPL mode: I can adjust TSPL coordinates/fonts in `server.js`
  - PDF mode: tune `LABEL_MEDIA`, `PRINT_FIT`, `ORIENTATION`

---

## Project notes

- Multi-stage Docker build compiles the React frontend and serves static files from Express
- Backend persists data in `backend/data.json` (bind‑mounted)
- API: `GET /api/sessions`, `POST /api/sessions`, `PATCH/DELETE /api/sessions/:id`, `POST /api/print`

---

## Uninstall/cleanup

```bash
docker compose down
docker rmi breast-milk-tracker:latest
```

---

## Automated Kiosk Setup

For a one-time automated setup on Raspberry Pi OS (with Desktop) that installs the app, configures full-screen kiosk, and disables screen blanking:

1. Clone or copy this repo onto the Pi and enter the folder:

- git clone <https://github.com/josephwaligorski/Breast_Milk_Tracker.git>
- cd Breast_Milk_Tracker

1. Run the orchestrated setup (it will prompt for sudo or elevate automatically):

- sudo bash scripts/setup-system.sh

What it does:

- scripts/bmt-firstboot.sh: installs Docker + compose plugin, clones/builds if required, and starts the containers.
- scripts/setup-kiosk.sh: sets desktop autologin, installs Chromium, creates an autostart desktop entry to launch Chromium in kiosk to <http://localhost:5000> (after a brief delay), and appends xset settings to keep the display awake.
- scripts/setup-printer.sh: detects and configures the printer for use with the app.

After completion, reboot the Pi. On boot, it should log into the desktop automatically and open the Breast Milk Tracker in full-screen.

### Optional: One-step SD flashing with kiosk + first-boot installer

The helper script `scripts/create-sd.sh` can now flash Raspberry Pi OS to an SD card and pre-wire:

- SSH + hostname + Wi‑Fi credentials
- Desktop autologin and Chromium kiosk (to <http://localhost:5000> by default)
- A first-boot installer service that installs Docker + Compose + Chromium and launches the app

Highlights:

- If you don’t pass an image, it will auto-pick the latest official Desktop image (arm64). Add `--lite` to choose the Lite image.
- Use `--no-kiosk` to skip kiosk/first-boot wiring (just headless basics).
- Use `--kiosk-url <URL>` to customize the page Chromium opens on login.

Flags reference (subset):

- `-d, --device /dev/sdX` target device (required)
- `-f, --file <path>` or `-i, --image-url <url>` (optional; otherwise auto-downloads)
- `-H/--hostname`, `-u/--user`, `-p/--pass`, `-S/--wifi-ssid`, `-P/--wifi-pass`, `-C/--wifi-country`
- `--no-kiosk`, `--kiosk-url <url>`, `--lite`, `-y/--yes`

Result: Insert the SD in the Pi, power on, wait a few minutes for the first-boot installer to complete, and the kiosk should appear automatically.

---

## Central server + Pi print agent

You can host the app anywhere and keep the Pi as a dedicated print station.

Server mode:

- Run the standard `docker compose up -d --build` on the central host.
- Set `CENTRAL_MODE=1` in the server environment to enqueue print jobs instead of printing locally.

Agent mode (on the Pi):

- Start the agent with the provided compose file:
  - `docker compose -f docker-compose.agent.yml up -d --build`
- Environment variables:
  - `CENTRAL_URL` — base URL of the central server (e.g., `http://server:5000`)
  - `PRINTER_ID` — unique ID for this Pi (e.g., `nursery-pi`)
  - `INTERVAL_MS` — polling interval in ms (default `2000`)
  - `DEVICE` — printer device path (default `/dev/usb/lp0`)

Flow:

- UI calls `POST /api/print` on the server. In central mode, server stores a job in `data.json`.
- Agent sends heartbeats and polls `POST /api/agents/next-job` for jobs matching its `PRINTER_ID`.
- Agent writes a TSPL program directly to `/dev/usb/lp0` and reports completion via `POST /api/print/:jobId/complete`.

Tip: You can also pass `{ printerId }` in the body to `POST /api/print` to target a specific agent even if `CENTRAL_MODE` is off; the server will enqueue the job when `printerId` is provided.
