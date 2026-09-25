#!/bin/bash
# Vegan Grove API host bootstrap (Ubuntu 24.04 arm64, t4g.micro, us-east-1).
# Runs once from EC2 user-data as root. Everything after first boot happens
# through SSM Run Command (no SSH): sudo -u vg /srv/vegan-grove/deploy.sh
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get upgrade -y

# 2 GB swap: npm ci gets OOM-killed on 1 GB without it.
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/90-swap.conf
sysctl -q -p /etc/sysctl.d/90-swap.conf
apt-get install -y nginx certbot python3-certbot-nginx git unzip unattended-upgrades fail2ban ca-certificates curl

# Node 24 from NodeSource, PM2 global.
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
npm install -g pm2

# AWS CLI v2 for arm64 (Parameter Store reads on deploy).
cd /tmp
curl -s "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o awscliv2.zip
unzip -q awscliv2.zip
./aws/install
rm -rf /tmp/aws /tmp/awscliv2.zip

# Unprivileged app user and layout.
id -u vg >/dev/null 2>&1 || useradd -r -m -d /srv/vegan-grove -s /bin/bash vg
mkdir -p /srv/vegan-grove
chown vg:vg /srv/vegan-grove
sudo -u vg git clone https://github.com/wbaxterh/vegan-grove-api.git /srv/vegan-grove/api

# Parameter Store renderer used by deploy.sh.
cat > /srv/vegan-grove/render-env.py <<'EOS'
#!/usr/bin/env python3
"""Render /vegan-grove/api/* from SSM Parameter Store into KEY=VALUE lines."""
import json, subprocess, sys
out = subprocess.run(["aws", "ssm", "get-parameters-by-path", "--region", "us-east-1", "--path", "/vegan-grove/api",
                      "--with-decryption", "--output", "json"], check=True, capture_output=True, text=True).stdout
params = json.loads(out)["Parameters"]
for p in sorted(params, key=lambda p: p["Name"]):
    name = p["Name"].rsplit("/", 1)[-1]
    value = p["Value"].replace("
", "\n")
    print(f"{name}={value}")
EOS
chmod 750 /srv/vegan-grove/render-env.py
chown vg:vg /srv/vegan-grove/render-env.py

# Deploy script: pull main, build, render .env from Parameter Store, reload PM2.
cat > /srv/vegan-grove/deploy.sh <<'EOS'
#!/bin/bash
# Vegan Grove API deploy, run as the vg user through SSM Run Command:
#   sudo -u vg /srv/vegan-grove/deploy.sh
set -euo pipefail
cd /srv/vegan-grove/api
git fetch --quiet origin main
git reset --quiet --hard origin/main
npm ci --no-audit --no-fund
npm run build
python3 /srv/vegan-grove/render-env.py > /srv/vegan-grove/api/.env
chmod 600 /srv/vegan-grove/api/.env
if ! grep -q '^MONGODB_URI=' /srv/vegan-grove/api/.env; then
  echo 'MONGODB_URI not in Parameter Store yet: built, not started'
  exit 0
fi
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
EOS
chmod 750 /srv/vegan-grove/deploy.sh
chown vg:vg /srv/vegan-grove/deploy.sh

# nginx: HTTP now, certbot adds HTTPS once DNS for api.vegangrove.org resolves here.
cat > /etc/nginx/sites-available/api <<'EOS'
server {
  listen 80;
  listen [::]:80;
  server_name api.vegangrove.org;
  server_tokens off;
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300;
    client_max_body_size 2m;
  }
}
EOS
ln -sf /etc/nginx/sites-available/api /etc/nginx/sites-enabled/api
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

# PM2 resurrects the vg user's processes on boot.
env PATH="$PATH:/usr/bin" pm2 startup systemd -u vg --hp /srv/vegan-grove

# Security updates apply themselves.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOS'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOS
systemctl enable --now fail2ban

# First deploy attempt; fails harmlessly until MONGODB_URI exists in Parameter Store.
sudo -u vg /srv/vegan-grove/deploy.sh || echo "first deploy deferred: parameters not set yet"
echo "BOOTSTRAP_DONE"
