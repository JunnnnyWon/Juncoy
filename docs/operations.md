# 운영 가이드

## 현재 구성

- 서버: 저장된 SSH 별칭 `junnnnyserver`, 사용자 `junnnnyserver` (초기 대문자 별칭으로 잘못 선택된 사용자와 다름).
- 프로젝트: `/home/junnnnyserver/services/discord-meeting-bot`.
- 웹: `https://juncoystt.junnnny.kr`.
- Compose: `infra/compose.yml`, 비밀 설정 `.env.production` (0600).
- DB: `discord-meeting-db`, 전용 `discord-meeting-pgdata` 볼륨. 호스트에는 127.0.0.1:15439로만 노출.
- API: 127.0.0.1:8790. Cloudflare Tunnel은 Docker 내부 api:3000에 연결.
- bot/worker/api는 서버 UID/GID 설정으로 실행. 원음은 `.data/audio`.
- `tesitng` 감지, `#test` 알림, `#회의기록` 제한 열람, `회의 팀원` 역할을 생성·설정함.

## 확인·업데이트

```bash
cd /home/junnnnyserver/services/discord-meeting-bot
docker compose --env-file .env.production -f infra/compose.yml ps
tail -n 50 .data/logs/bot-*.log .data/logs/worker-*.log
docker compose --env-file .env.production -f infra/compose.yml exec api \
  node --import tsx scripts/status.ts
```

API/DB health와 Discord Gateway, 음성 패킷, STT, worker를 따로 확인합니다. 침묵만으로 장애를 판정하지 않습니다. `health_records.metrics`에는 스트리밍 활성/대기 수, 디코딩 카운터와 저장 장애가 기록됩니다. 본문·키·토큰은 일반 로그에 남기지 않습니다. 서비스 출력은 날짜별 `.data/logs` 파일로 기록하고 30일 지난 파일을 정리합니다. 비밀 환경변수 값도 로그에서 치환합니다. 별도 Docker 로그 복사본은 비활성화했습니다.

업데이트 전에 실제 길드의 STARTING/RECORDING/PAUSED/DEGRADED/STOPPING 회의가 없는지 확인합니다. 이미지 태그를 새 버전으로 바꾸고 백업 → 빌드 → 마이그레이션 → 서비스 교체 → health/OAuth/SSE 확인 순서로 진행합니다. 실제 진행 중 회의를 임의로 끊어 업데이트하지 않습니다.

롤백은 이전 이미지로 교체합니다. DB를 함께 되돌려야 하면 API·봇·worker를 먼저 중단하고 별도 DB에 복원하여 검증한 후 연결합니다. 현재 삭제 ledger를 적용하기 전에는 복원 데이터를 서비스하지 않습니다. 이 프로젝트의 마이그레이션은 기존 데이터 삭제를 포함하지 않습니다.

## 오류 처리

- 음성 시작은 30초 안에서 연결을 재시도합니다. 실제 고지 게시 확인 후 5초가 지나기 전에는 구독하지 않습니다.
- 10개 스트리밍 슬롯은 CONNECTING/OPEN/CLOSING을 포함합니다. FIFO 대기열, 무발화 우선 반환, 장기 점유 교대가 적용됩니다.
- ReturnZero 장애·대기는 사용자별 원음을 남기고 재전사합니다. 파일 API 결과는 지연될 수 있습니다.
- 디스크·DB 문제가 감지되면 새 캡처를 중단합니다. 원음·SSE 큐를 무제한 적재하지 않습니다.
- 재시작 후 기존 회의 lease를 획득한 소유자만 복구합니다. 오래된 fencing/job generation은 쓰지 못합니다. PAUSED 상태는 자동 재개하지 않습니다.
- 요약은 제한된 재시도 후 실패로 남기고 전사 열람을 유지합니다. `/회의 재요약`은 같은 입력 결과를 재사용합니다.
- `NEEDS_RECONCILIATION`은 게시 성공 여부를 확인할 수 없는 상태입니다. `scripts/reconcile-outbox.ts`로 목록을 보고 해당 ID를 전달하면 이력 조회를 다시 예약합니다. 발견하지 못한 메시지를 무작정 재전송하지 않습니다.
- `/회의 재전사`는 저장된 음성이 있는 범위에 대해 명시적 재시도를 제공합니다. 실패 원인과 사람 정정 충돌을 먼저 확인합니다.

## 보관과 삭제

| 데이터              | 보관                                  |
| ------------------- | ------------------------------------- |
| 원음                | 성공 마감 후 24시간, 녹음 후 최대 7일 |
| 전사·요약·이력·근거 | 종료 후 180일                         |
| 웹 이벤트           | 24시간                                |
| 장애 draft          | 복구 상태로 정리 후 최대 24시간       |
| 백업                | 최대 30일                             |
| OAuth 세션          | 최대 12시간, 로그아웃 시 즉시 폐기    |

`/회의 삭제`는 관리자에게 범위를 보여주고 확인을 받습니다. 접근 차단·tombstone을 먼저 커밋한 뒤 작업 취소, 열린 SSE 종료, 원음·DB·게시물을 정리합니다. 삭제 ledger는 `.data/deletion-ledger.jsonl`에 별도로 남겨 과거 백업 복원 후 재노출을 막습니다. 공급사 보관·삭제는 해당 계약 조건에 따르며 자체 삭제만으로 외부 사본 삭제를 보장하지 않습니다.

## 백업과 복원

```bash
bash infra/backup.sh
bash infra/restore-drill.sh YYYYMMDDTHHMMSSZ.dump.enc
systemctl --user status juncoy-backup.timer
```

백업은 pg_dump의 일관된 snapshot을 AES-256-GCM으로 암호화합니다. 복원 시험은 인증 태그를 검증한 뒤에만 별도 `meeting_restore_*` DB에 적용하고 현재 삭제 ledger를 반영합니다. 운영 DB를 덮어쓰지 않습니다. 임시 평문 dump와 검증 DB는 종료 시 제거합니다.

JunnnnyServer에는 사용자 systemd timer와 linger를 활성화했습니다. 매일 한국 시간 04:00 이후 최대 2분 지연으로 실행합니다. 백업 파일과 삭제 ledger·암호화 키는 별도로 보호하세요. 현재 백업은 같은 서버에 있으므로 서버 전체 손실에 대비한 외부 사본 경로는 운영자가 추가해야 합니다.

## 실제 음성 인수 시험

참가자에게 역할을 부여하고 각자 정책에 동의하게 합니다. 2인부터 시작해 12인으로 확대합니다. 사람마다 서로 다른 검증 문장을 읽고, 2~3명 동시 발화·동명이인·닉네임 변경·퇴장/재입장·DAVE 재협상·철회·일시정지를 확인합니다. 팀 대화 원문은 테스트 저장소에 커밋하지 않습니다.

`PROVIDER_MODE=real pnpm verify:dave -- --meeting UUID --expected .data/dave-expected.json`은 통계와 지정 문장의 계정 매핑을 점검합니다. expected 파일은 `[{"user_id":"...","phrase":"본인이 읽은 고유 문구"}]` 형식입니다. 이 검사는 실제 60분 음성 시험과 수동 음질·겹침·CER 평가를 대신하지 않습니다.

## 사실 원장 버전의 배포·보류·롤백

[사실 원장](fact-ledger.md), [평가 실행](evaluation.md)의 결과를 먼저 확인합니다. 운영 결과를 덮어쓰지 않는 shadow 실행에서 대본/실제 녹음 회귀/20회 cold 성능 검사를 마치고, 별도 QA 이미지로 통합·브라우저·음성 대기 시험을 수행합니다. 원장 마이그레이션은 추가형이며 중간 단계도 기존 삭제/보관 흐름에 포함됩니다.

운영 호스트에서 다음 순서로 진행합니다. `MEETING_IMAGE`에는 검사한 **정확한 이미지 태그**를 지정하고 `.env.production`의 같은 키에 반영합니다. 비밀 값 전체를 출력하지 않습니다.

```bash
cd /home/junnnnyserver/services/discord-meeting-bot
docker compose --env-file .env.production -f infra/compose.yml exec -T api node --import tsx scripts/assert-idle.ts
MEETING_IMAGE="$MEETING_IMAGE" bash infra/backup.sh
# 위에서 생성한 암호화 파일명을 전달한다.
MEETING_VERIFY_MIGRATIONS=1 MEETING_IMAGE="$MEETING_IMAGE" bash infra/restore-drill.sh "$MEETING_BACKUP_FILE"
docker compose --env-file .env.production -f infra/compose.yml exec -T api node --import tsx scripts/assert-idle.ts
docker compose --env-file .env.production -f infra/compose.yml stop bot worker
docker compose --env-file .env.production -f infra/compose.yml run --rm --no-deps api node --import tsx scripts/migrate.ts
docker compose --env-file .env.production -f infra/compose.yml up -d --no-deps api bot worker
```

배포 전후 활성 회의 0개, 마이그레이션 004, API health, Gateway/worker heartbeat, SSE/근거/다운로드, 외부 HTTPS를 확인합니다. 새 요약은 `SUMMARY_AUTOPUBLISH_ENABLED=true`에서 검증된 실행만 게시합니다. 실패하면 공개 응답은 `summary_status=FAILED`, 결과는 null이며 전사를 계속 제공합니다. 수동 승인 기능은 없습니다.

장애 시에는 `SUMMARY_AUTOPUBLISH_ENABLED=false`로 새 요약 게시를 보류한 채 전사·복구·기록 열람을 유지합니다. 이미 검증된 이전 **사실 원장 버전**이 있으면 그 이미지로 교체합니다. 검증 게이트가 없는 `0.1.0-qa-muted2` 등 구 요약 worker로 우회하지 않습니다. 최초 사실 원장 배포에서 이전 안전 버전이 없다면 보류 상태로 원인을 고칩니다. DB의 원장/전사 버전을 지우거나 이전 백업으로 운영 데이터를 덮어쓰는 방법으로 롤백하지 않습니다.

QA 원본·중간 사실·단계 파일의 보관 기한은 180일입니다. 검증 결과를 공유할 때는 익명화한 집계 보고서만 전달합니다. 원음은 성공 후 24시간·최대 7일이며, 사용자에게서 받은 원본 파일은 별도 사용자 소유 자료로 그대로 둡니다.

게시 결과가 불명확한 카드의 삭제는 먼저 봇 작성자 ID와 고유 footer로 이력을 확인합니다. 이력에서도 확인할 수 없으면 `MESSAGE_DELETION_UNCERTAIN`으로 남기고 접근 차단을 유지합니다. 게시 여부가 불명확한 상태를 삭제 완료로 표시하지 않습니다.
