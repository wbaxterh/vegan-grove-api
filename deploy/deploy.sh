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
