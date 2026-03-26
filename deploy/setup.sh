#!/bin/bash
set -e

INSTALL_DIR=/opt/hive-memory
SERVICE_NAME=cortex

echo "[setup] Installing hive-memory..."

# Create install directory
mkdir -p "$INSTALL_DIR/data"

# Copy or clone project files
if [ -d ".git" ]; then
  echo "[setup] Copying project files..."
  cp -r . "$INSTALL_DIR"
else
  echo "[setup] Run this script from within the hive-memory project directory."
  exit 1
fi

# Install dependencies and build
cd "$INSTALL_DIR"
npm ci --omit=dev
npm run build

# Create .env from template if it does not exist
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/deploy/.env.example" "$INSTALL_DIR/.env"
  # Generate a random auth token
  AUTH_TOKEN=$(node -e "require('crypto').randomBytes(32).toString('hex').then ? '' : process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  sed -i "s/generate-a-random-token-here/$AUTH_TOKEN/" "$INSTALL_DIR/.env"
  echo "[setup] Generated auth token. Edit $INSTALL_DIR/.env to configure."
fi

# Create deploy user if it does not exist
if ! id deploy &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin deploy
fi

# Set ownership
chown -R deploy:deploy "$INSTALL_DIR"

# Install systemd service
cp "$INSTALL_DIR/deploy/cortex.service" /etc/systemd/system/${SERVICE_NAME}.service
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "[setup] Service status:"
systemctl status "$SERVICE_NAME" --no-pager

# Install cron job (every 30 min)
CRON_LINE="*/30 * * * * bash $INSTALL_DIR/deploy/cron.sh"
(crontab -l 2>/dev/null | grep -v "cortex"; echo "$CRON_LINE") | crontab -

echo "[setup] Done. hive-memory is running on port 3179."
echo "[setup] Edit $INSTALL_DIR/.env and restart: systemctl restart $SERVICE_NAME"
