# Deploying the API host

The API runs on one small EC2 instance (Ubuntu 24.04 arm64) in `us-east-1` behind nginx, managed by PM2. There is no SSH: the instance has no inbound port 22, and every operation goes through AWS Systems Manager Run Command. Hostnames, addresses, and account ids are deliberately absent from this repository, per the docs' disclosure policy.

## First boot

`api-host-user-data.sh` is the EC2 user-data. It installs nginx, certbot, Node 24, PM2, and the AWS CLI, creates the unprivileged `vg` user, clones this repository to `/srv/vegan-grove/api`, writes `deploy.sh`, configures nginx as a reverse proxy to port 4000, turns on unattended security upgrades and fail2ban, and attempts a first deploy (which defers until configuration exists).

## Configuration

Runtime configuration lives in SSM Parameter Store under `/vegan-grove/api/` (plain `String` for settings, `SecureString` for secrets). The instance role can read that path and nothing else. `deploy.sh` renders the parameters into `.env` on every deploy, so a config change is: update the parameter, run the deploy. The names match `.env.example`.

## Deploy

```bash
aws ssm send-command --region us-east-1 --document-name AWS-RunShellScript \
  --targets Key=tag:Name,Values=vegan-grove-api \
  --parameters commands="sudo -u vg /srv/vegan-grove/deploy.sh"
```

`deploy.sh` resets the checkout to `origin/main`, runs `npm ci` and the build, renders `.env`, and does `pm2 startOrReload` so the reload is zero-downtime for a single process. Roll back by checking out the previous commit and running the same script.

## Data refresh

`refresh-data.sh` runs every ingest script in order (OSM places, OSM gardens, curated places, groves, organizations, event feeds, media, guides) and posts through the ingest endpoint. Trust is determined server-side by `TRUSTED_SOURCES`. It detaches itself with `nohup` and writes to `/srv/vegan-grove/data-refresh/<timestamp>.log`, because the tiled Overpass import alone can outlive a Run Command timeout and a killed command would leave the later steps unrun. A failed step is logged and the next one still runs.

```bash
# start (optionally limit to steps whose name contains a word, e.g. events)
aws ssm send-command --region us-east-1 --document-name AWS-RunShellScript   --targets Key=tag:Name,Values=vegan-grove-api   --parameters commands="sudo -u vg bash /srv/vegan-grove/api/deploy/refresh-data.sh"

# check on it: RUNNING or FINISHED, then the tail of the latest log
aws ssm send-command --region us-east-1 --document-name AWS-RunShellScript   --targets Key=tag:Name,Values=vegan-grove-api   --parameters commands="sudo -u vg bash /srv/vegan-grove/api/deploy/refresh-data.sh --status"
```

The log ends with the `/api/stats` counts and `REFRESH_DONE`. Run a deploy first when the scripts changed; the refresh uses whatever is checked out.

## TLS

Once `api.vegangrove.org` resolves to the instance, one command through Run Command issues and installs the certificate and enables renewal:

```bash
certbot --nginx -d api.vegangrove.org --non-interactive --agree-tos --redirect -m <contact address>
```

## Health

`GET /healthz` returns `{ "ok": true }` after a database ping. nginx serves it over HTTPS; PM2 restarts the process on crash and the `pm2 startup` unit restores it on reboot.
