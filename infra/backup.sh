#!/usr/bin/env bash
set -euo pipefail
MEETING_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MEETING_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$MEETING_ROOT/.data/backups"
chmod 700 "$MEETING_ROOT/.data/backups"
docker exec discord-meeting-db pg_dump -U meeting -Fc --schema=public meeting | docker run --rm -i --user "$(id -u):$(id -g)" --env-file "$MEETING_ROOT/.env.production" -v "$MEETING_ROOT/.data/backups:/backups" "${MEETING_IMAGE:-juncoy-meeting:0.1.0}" node --import tsx scripts/backup-crypto.ts encrypt "/backups/$MEETING_STAMP.dump.enc"
find "$MEETING_ROOT/.data/backups" -type f -name '*.dump.enc' -mtime +29 -delete
