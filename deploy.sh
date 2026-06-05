#!/usr/bin/env bash
set -euo pipefail

APP_NAME="munay-agenda-pro"
APP_DIR="/var/www/${APP_NAME}"
NGINX_SITE="/etc/nginx/sites-available/${APP_NAME}"
NGINX_ENABLED="/etc/nginx/sites-enabled/${APP_NAME}"
DOMAIN="${1:-example.com}"
EMAIL="${2:-admin@example.com}"
NODE_MAJOR="20"
APP_PORT="${PORT:-3000}"
APP_USER="${SUDO_USER:-$(whoami)}"

if [[ $EUID -ne 0 ]]; then
  echo "Execute como root: sudo bash deploy.sh seu-dominio.com seu-email@dominio.com"
  exit 1
fi

apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx ufw unzip build-essential

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

npm install -g pm2
mkdir -p "${APP_DIR}"
rsync -av --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude .env.runtime \
  ./ "${APP_DIR}/"

cd "${APP_DIR}"
npm install --omit=dev

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Arquivo .env criado. Edite antes de subir em produção."
fi

chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
chmod +x deploy.sh

cat > "${NGINX_SITE}" <<EOF
server {
  listen 80;
  server_name ${DOMAIN};

  access_log /var/log/nginx/${APP_NAME}.access.log;
  error_log /var/log/nginx/${APP_NAME}.error.log;

  location / {
    proxy_pass http://127.0.0.1:${APP_PORT};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_cache_bypass \$http_upgrade;
  }
}
EOF

ln -sf "${NGINX_SITE}" "${NGINX_ENABLED}"
nginx -t
systemctl restart nginx
systemctl enable nginx

sudo -u "${APP_USER}" pm2 start ecosystem.config.js --env production
sudo -u "${APP_USER}" pm2 save
env PATH=$PATH:/usr/bin pm2 startup systemd -u "${APP_USER}" --hp "/home/${APP_USER}" | bash

mkdir -p /var/backups/${APP_NAME}
cat > /usr/local/bin/${APP_NAME}-backup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date +%F-%H%M%S)
DEST="/var/backups/munay-agenda-pro/${STAMP}"
mkdir -p "$DEST"
cp -a /var/www/munay-agenda-pro/.env "$DEST/.env" 2>/dev/null || true
cp -a /var/www/munay-agenda-pro/.env.runtime "$DEST/.env.runtime" 2>/dev/null || true
if command -v pg_dump >/dev/null 2>&1 && grep -q '^DATABASE_URL=' /var/www/munay-agenda-pro/.env 2>/dev/null; then
  source /var/www/munay-agenda-pro/.env
  pg_dump "$DATABASE_URL" > "$DEST/database.sql" || true
fi
find /var/backups/munay-agenda-pro -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
EOF
chmod +x /usr/local/bin/${APP_NAME}-backup.sh
(crontab -l 2>/dev/null; echo "0 3 * * * /usr/local/bin/${APP_NAME}-backup.sh >> /var/log/${APP_NAME}-backup.log 2>&1") | crontab -

ufw allow OpenSSH || true
ufw allow 'Nginx Full' || true
ufw --force enable || true

certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}" --redirect || true

echo "Deploy base concluído."
echo "1) Edite ${APP_DIR}/.env"
echo "2) Reinicie com: pm2 restart ${APP_NAME}"
echo "3) Verifique logs: pm2 logs ${APP_NAME} e tail -f /var/log/nginx/${APP_NAME}.error.log"
