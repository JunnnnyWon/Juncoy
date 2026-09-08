#!/usr/bin/env bash
set -euo pipefail
MEETING_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$MEETING_ROOT/.data/logs"
chmod 700 "$MEETING_ROOT/.data/logs"
bash "$MEETING_ROOT/infra/backup.sh" >> "$MEETING_ROOT/.data/logs/backup-$(date -u +%F).log" 2>&1
