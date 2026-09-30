#!/bin/bash
# Vegan Grove data refresh: every seed and ingest script in order, detached
# from the caller so an SSM Run Command timeout cannot kill it between
# Overpass tiles. Run as the vg user:
#   sudo -u vg bash /srv/vegan-grove/api/deploy/refresh-data.sh              # start everything
#   sudo -u vg bash /srv/vegan-grove/api/deploy/refresh-data.sh events       # only steps matching a word
#   sudo -u vg bash /srv/vegan-grove/api/deploy/refresh-data.sh --status     # state + tail of the latest log
# A failed step is logged and the next one still runs, so one dead feed does
# not block the rest. OSM places land approved because the importer already
# filters to diet:vegan; everything else posts to the ingest endpoint, where
# TRUSTED_SOURCES decides between pending and published.
set -uo pipefail
APP=/srv/vegan-grove/api
LOGS=/srv/vegan-grove/data-refresh
STEPS=(
  "seed:places:osm --approve"
  "seed:places:gardens --approve"
  "seed:sanctuaries"
  "seed:gardens:curated"
  "seed:groves"
  "ingest:organizations"
  "ingest:events:ics"
  "ingest:events:jsonld"
  "ingest:media:seed"
  "ingest:media:wikidata"
  "ingest:media:tmdb"
  "seed:media:collections --prune-duplicates"
  "ingest:guides"
)

mkdir -p "$LOGS"

if [ "${1:-}" = "--status" ]; then
  latest=$(ls -t "$LOGS"/*.log 2>/dev/null | head -n 1)
  [ -n "$latest" ] || { echo "no runs yet"; exit 0; }
  if pgrep -f "refresh-data.sh --run" >/dev/null; then echo "RUNNING $latest"; else echo "FINISHED $latest"; fi
  tail -n "${2:-40}" "$latest"
  exit 0
fi

if [ "${1:-}" != "--run" ]; then
  if pgrep -f "refresh-data.sh --run" >/dev/null; then
    echo "a refresh is already running; use --status"
    exit 1
  fi
  log="$LOGS/$(date -u +%Y%m%dT%H%M%SZ).log"
  nohup bash "$0" --run "$@" >"$log" 2>&1 < /dev/null &
  disown
  echo "started, log: $log"
  exit 0
fi
shift

cd "$APP"
filters=("$@")
wanted() {
  [ ${#filters[@]} -eq 0 ] && return 0
  for f in "${filters[@]}"; do case "$1" in *"$f"*) return 0 ;; esac; done
  return 1
}

echo "refresh start $(date -u +%Y-%m-%dT%H:%M:%SZ) commit $(git rev-parse --short HEAD)"
for spec in "${STEPS[@]}"; do
  read -r name args <<<"$spec"
  wanted "$name" || continue
  echo "== $name $(date -u +%H:%M:%SZ)"
  # shellcheck disable=SC2086
  if npm run --silent "$name" -- $args 2>&1 | tail -n 4; then
    echo "ok $name"
  else
    echo "FAILED $name"
  fi
done
echo "== stats"
curl -s http://127.0.0.1:4000/api/stats || true
echo
echo "REFRESH_DONE $(date -u +%Y-%m-%dT%H:%M:%SZ)"
