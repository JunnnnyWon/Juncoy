#!/usr/bin/env bash
set -euo pipefail
MEETING_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MEETING_BACKUP="${1:?Pass an encrypted backup filename from .data/backups}"
[[ "$MEETING_BACKUP" =~ ^[A-Za-z0-9_.-]+\.dump\.enc$ ]] || exit 2
MEETING_RESTORE_DB="meeting_restore_$(date -u +%Y%m%d%H%M%S)"
MEETING_TEMP="restore_${MEETING_RESTORE_DB}.dump"
cleanup() {
  rm -f "$MEETING_ROOT/.data/backups/$MEETING_TEMP"
  docker exec discord-meeting-db dropdb --if-exists -U meeting "$MEETING_RESTORE_DB" >/dev/null
}
trap cleanup EXIT
docker run --rm --user "$(id -u):$(id -g)" --env-file "$MEETING_ROOT/.env.production" -v "$MEETING_ROOT/.data/backups:/backups" "${MEETING_IMAGE:-juncoy-meeting:0.1.0}" node --import tsx scripts/backup-crypto.ts decrypt "/backups/$MEETING_BACKUP" "/backups/$MEETING_TEMP"
docker exec discord-meeting-db createdb -U meeting "$MEETING_RESTORE_DB"
docker exec -i discord-meeting-db pg_restore --clean --if-exists --exit-on-error -U meeting -d "$MEETING_RESTORE_DB" < "$MEETING_ROOT/.data/backups/$MEETING_TEMP"
if [[ "${MEETING_VERIFY_MIGRATIONS:-0}" == "1" ]]; then
  docker run --rm --user "$(id -u):$(id -g)" --network discord-meeting_default --env-file "$MEETING_ROOT/.env.production" "${MEETING_IMAGE:-juncoy-meeting:0.1.0}" node --import tsx scripts/verify-restored-migration.ts "$MEETING_RESTORE_DB"
fi
docker run --rm --user "$(id -u):$(id -g)" --network discord-meeting_default --env-file "$MEETING_ROOT/.env.production" -v "$MEETING_ROOT/.data:/data" "${MEETING_IMAGE:-juncoy-meeting:0.1.0}" node --import tsx scripts/restore-ledger.ts "$MEETING_RESTORE_DB" /data/deletion-ledger.jsonl
docker exec discord-meeting-db psql -U meeting -d "$MEETING_RESTORE_DB" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS restored_meetings FROM meetings;'
