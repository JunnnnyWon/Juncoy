#!/usr/bin/env bash
set -euo pipefail
deploy_root=/home/junnnnyserver/services/discord-meeting-bot
deploy_revision="${GITHUB_SHA:-$(git rev-parse HEAD)}"
[[ "$deploy_revision" =~ ^[0-9a-f]{40}$ ]] || exit 1
deploy_image="juncoy-meeting:release-$deploy_revision"
exec 9>"$deploy_root/.data/deploy-api.lock"
flock -n 9 || { echo "Another deployment is running"; exit 1; }
previous_image=$(docker inspect discord-meeting-api-1 --format '{{.Config.Image}}')
bot_id=$(docker inspect discord-meeting-bot-1 --format '{{.Id}}')
worker_id=$(docker inspect discord-meeting-worker-1 --format '{{.Id}}')
docker build --label "org.opencontainers.image.revision=$deploy_revision" -t "$deploy_image" -f infra/Dockerfile .
cd "$deploy_root"
docker exec discord-meeting-api-1 node --import tsx scripts/assert-idle.ts
MEETING_IMAGE="$previous_image" bash infra/backup.sh
cp -p .env.production ".env.production.pre-$deploy_revision"
compose=(docker compose --env-file .env.production --env-file .env.knowledge -f infra/compose.yml -f infra/compose.knowledge-attach.yml)
set_api_image() {
  if grep -q '^MEETING_API_IMAGE=' .env.production; then
    sed -i "s|^MEETING_API_IMAGE=.*|MEETING_API_IMAGE=$1|" .env.production
  else
    printf '\nMEETING_API_IMAGE=%s\n' "$1" >> .env.production
  fi
}
rollback() {
  echo "Deployment failed; restoring previous API image"
  set_api_image "$previous_image"
  "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 90 api || true
}
trap rollback ERR
set_api_image "$deploy_image"
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 90 api
curl --retry 3 --retry-delay 2 --fail --silent --show-error http://127.0.0.1:8790/healthz
curl --retry 3 --retry-delay 2 --fail --silent --show-error https://juncoystt.junnnny.kr/healthz
[[ "$(docker inspect discord-meeting-bot-1 --format '{{.Id}}')" == "$bot_id" ]]
[[ "$(docker inspect discord-meeting-worker-1 --format '{{.Id}}')" == "$worker_id" ]]
trap - ERR
echo "Deployed API revision $deploy_revision; bot and worker unchanged"
