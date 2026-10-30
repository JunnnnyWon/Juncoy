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

## 지식(RAG) 스택 운영

QA 10-12 이후 추가된 절차입니다. 지식 스택은 `infra/compose.knowledge.yml`에 있고 회의 스택과 다른 컨테이너·DB를 씁니다.

### Discord 대화 수집 활성화

Discord 채팅 기록이 답변에 빠지는 가장 흔한 원인은 `discord-context` 컨테이너가 꺼져 있는 것입니다. 유일한 스위치는 `DISCORD_CONTEXT_ENABLED`입니다 — 꺼져 있으면 프로세스가 즉시 종료하고 컨테이너는 `Exited (0)`으로 남습니다.

1. Discord Developer Portal → 봇 애플리케이션 → **Message Content Intent**를 켭니다. 꺼져 있으면 Gateway가 연결돼도 메시지 본문을 받지 못해 수집이 진행되지 않습니다.
2. `.env.knowledge`에 `DISCORD_CONTEXT_ENABLED=true`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`를 설정합니다. 수집 채널을 제한하려면 `DISCORD_CONTEXT_CHANNELS`에 채널 ID를 csv로 적습니다.
3. 스코프 시드(멱등): `pnpm tsx scripts/seed-knowledge.ts` — 지정·열거 채널과 `guild:<id>` 스코프를 등록합니다.
4. 기동/재기동:

```bash
docker compose -f infra/compose.knowledge.yml \
  --env-file .env.production --env-file .env.knowledge up -d
docker logs -f --tail 50 discord-knowledge-discord
```

`discord-context`는 별도 프로파일 없이 스택에 포함됩니다. `DISCORD_CONTEXT_ENABLED`가 `true`가 아니거나 봇 토큰이 없으면 프로세스가 즉시 종료(exit 0)하고 `restart: on-failure`라 재시작 루프는 없습니다. `docker ps -a`에서 `Exited (0)`이면 플래그가 꺼진 상태입니다.

로그에 `reconcile`/`backfill` 진행이 보이고 `pnpm status:knowledge`의 discord 소스 `last_reconciled_at`이 갱신되면 정상입니다.

### 지식 워커 상태 점검

```bash
pnpm status:knowledge
```

출력 항목:

- `sources`: 소스별 ACTIVE 상태·문서 수·마지막 대조 시각
- `scopes`: `ref:*`/`channel:*`/`guild:*` 스코프와 각 `last_reconciled_at` — 오래 멈춘 스코프는 워커 중단이나 권한 상실 신호입니다.
- `jobs`: `RETRYABLE`/`DEAD_LETTER` 잡이 누적되면 `knowledge_jobs`에서 error를 확인합니다.
- `freshness`: 소스별 가장 최근 `source_occurred_at`(원본 발생 시각). 회의가 이 값에서 멈췄으면 회의 수집이 중단된 것입니다.
- `answers`: 최근 7일 답변 상태 분포 — `FAILED`가 늘면 모델/커넥터 설정을 봅니다.

컨테이너 생존 확인: `docker ps | grep discord-knowledge`로 `discord-knowledge-worker`가 떠 있는지 확인합니다. CI는 `api`만 재배포하므로 지식 스택은 별도로 `up -d`해야 새 코드가 반영됩니다.

### 지식 스택 재배포

```bash
cd /home/junnnnyserver/services/discord-meeting-bot
MEETING_IMAGE="<검증된 이미지 태그>" docker compose -f infra/compose.knowledge.yml \
  --env-file .env.production --env-file .env.knowledge \
  up -d --build --force-recreate knowledge-worker discord-context
# 스키마 변경이 있으면 migrate 서비스가 선행된다 (service_completed_successfully 조건).
```

> 주의: `knowledge-worker`/`discord-context`의 이미지는 `MEETING_IMAGE`에서 오고,
> `api`는 `MEETING_API_IMAGE`에서 온다. `.env.production`에 같은 키가 중복되면
> **마지막 값이 유효**하다. 지식 스택만 `up -d`하고 `MEETING_IMAGE`를 안 바꾸면
> 구 이미지로 컨테이너가 재생성돼 소스 코드가 최신인데도 구 동작을 한다 —
> 배포 후 `docker inspect <컨테이너> --format '{{.Config.Image}}'`로 확인한다.

### GitHub 수집 범위

- `ref:*` 스코프만 수집합니다. seed 기본값은 `main,SideView,Stairs`입니다.
- 10-12 QA 이후 워커가 10분 주기로 최근 30일 내 커밋이 있는 브랜치를 자동 등록합니다(`GITHUB_DISCOVERY_*` 상수). push webhook도 미등록 ref를 자동 등록합니다(소스당 100개 상한).
- 근거 링크는 이제 `blob/<head_sha>/` permalink라 브랜치 삭제·개명 후에도 열립니다. 이미 인덱싱된 문서는 `source_revision`의 head에서 permalink를 복원합니다.
- 수집이 안 되는 브랜치는 `status:knowledge`의 `scopes`에서 `ref:<브랜치>` 존재와 `allowed`를 확인합니다. 수동 추가는 SQL `INSERT INTO source_scopes ... scope_key='ref:<이름>'` 또는 seed 스크립트 재실행으로 가능합니다.

### 답변 신선도

문서 시각은 `source_occurred_at`(원본 발생), `source_modified_at`(원본 수정), `indexed_at`(지식 등록)으로 분리됩니다. 답변 근거 카드에 원본 날짜가 표시되고, 모델은 "최신/마지막" 질문에 이 값들을 비교해 날짜를 명시합니다. 특정 소스의 `newest_source_occurred`가 오래됐으면 수집 문제이고, `last_indexed`만 오래됐으면 인덱서 문제입니다.

### 어시스턴트 스트림

`/api/assistant/runs/:id/stream`은 `Last-Event-ID`를 받아 끊긴 지점부터 재생합니다. 클라이언트가 자동 재연결하며, 재연결이 안 되면 4초 폴링으로 run 종결을 잡습니다. run이 끝났는데도 화면이 '작업을 실행하는 중'이면 브라우저 네트워크 탭에서 스트림 상태를 확인하고 `GET /api/assistant/runs/:id`로 실제 상태를 봅니다.
