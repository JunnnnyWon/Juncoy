#!/usr/bin/env bash
set -euo pipefail
cd /home/junnnnyserver/services/discord-meeting-bot
grep -qE "^SONIOX_API_KEY=.+" .env.production || { echo "SONIOX_API_KEY is missing; deployment refused"; exit 1; }
docker exec discord-meeting-api-1 node --import tsx scripts/assert-idle.ts
pending=$(docker exec discord-meeting-db psql -U meeting -d meeting -Atc "SELECT count(*) FROM jobs WHERE status IN ('PENDING','RUNNING') AND kind IN ('FINALIZE','RETRANSCRIBE');")
[[ "$pending" == 0 ]] || { echo "Transcription jobs still exist; deployment refused"; exit 1; }
bash infra/backup.sh
echo "Build and transfer the verified release image before invoking this script with its tag."
image="${1:?Provide verified image tag}"
previous_api=$(docker inspect discord-meeting-api-1 --format '{{.Config.Image}}')
previous_bot=$(docker inspect discord-meeting-bot-1 --format '{{.Config.Image}}')
previous_worker=$(docker inspect discord-meeting-worker-1 --format '{{.Config.Image}}')
cp -p .env.production .env.production.pre-soniox
rollback() {
  echo "Soniox transition failed. Keep data and jobs; stop voice services instead of reactivating ReturnZero."
  docker compose --env-file .env.production -f infra/compose.yml stop bot worker || true
}
trap rollback ERR
for entry in STT_PROVIDER=soniox TRANSCRIPTION_MODE=after_meeting AUDIO_RETENTION=forever; do
  key="${entry%%=*}"
  if grep -q "^$key=" .env.production; then sed -i "s|^$key=.*|$entry|" .env.production; else printf "\n%s\n" "$entry" >> .env.production; fi
done
printf "\nMEETING_IMAGE=%s\nMEETING_API_IMAGE=%s\n" "$image" "$image" >> .env.production
docker run --rm --network discord-meeting_default --env-file .env.production "$image" node --import tsx scripts/migrate.ts
docker exec discord-meeting-db psql -U meeting -d meeting -c "UPDATE audio_chunks SET expires_at='infinity';"
MEETING_IMAGE="$image" MEETING_API_IMAGE="$image" docker compose --env-file .env.production --env-file .env.knowledge -f infra/compose.yml -f infra/compose.knowledge-attach.yml up -d --no-deps --no-build --wait api bot worker
curl -f http://127.0.0.1:8790/healthz
trap - ERR
