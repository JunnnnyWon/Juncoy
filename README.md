# Juncoy · Discord 회의기록

Discord 사용자별 음성을 ReturnZero로 전사하고 Solar Pro 3로 회의록을 만드는 팀 전용 서비스입니다. 웹에서 전사·근거·요약을 열람하고 Markdown/TXT로 내려받습니다.

배포 주소: **https://juncoystt.junnnny.kr**

2026-09-07 실제 64분 녹음 QA에서 요약의 근거 의미 불일치와 후반 논의 누락을 확인했습니다. **실사용 인수 판정은 보류**입니다. 로컬의 요약 최적화 변경은 운영에 배포하지 않았습니다. 이후 [실제 Discord 무음 QA](docs/qa-discord-muted-2026-09-07.md)를 수행해 종료·연장 경합, 중복 연결 해제, 권한 조회 제한, 재연결, 내보내기 문제를 수정·배포했습니다. 오프라인 요약의 재현 결과는 [녹음 QA 보고서](docs/qa-2026-09-07.md)에 기록했습니다.

현재 기준은 단일 길드, 최대 12인 회의, **실시간 스트리밍 동시 10개 + FIFO 대기열**입니다. 실제 계정 시험에서 11·12번째 연결은 429로 거절되었고, 사용자 요청에 따라 10개를 계속 활용하는 방식으로 변경했습니다. 대기 중 원음은 암호화 저장하고 파일 재전사로 복구합니다. 실제 사람 12명의 DAVE·겹친 발화·장시간 품질 인수 시험은 아직 수행하지 않았습니다. 자세한 완료 범위는 [검증 보고서](docs/verification-report.md)를 보세요.

## 팀에서 사용하기

1. 관리자가 참가자에게 **회의 팀원** 역할을 부여합니다. 서버 관리자는 별도 역할 없이 제어할 수 있습니다.
2. 참가자 각자가 `/회의 동의`를 실행하고 정책 확인 버튼을 누릅니다. 동의는 본인만 할 수 있습니다.
3. `tesitng` 음성방에 모이면 45초 뒤 `#test`에 안내가 표시됩니다. 직접 `/회의 시작`을 실행할 수도 있습니다.
4. 공개 고지가 전달되고 5초가 지난 뒤 동의한 사용자의 수집을 시작합니다. 웹 버튼에서 Discord 로그인 후 전사를 봅니다.
5. `/회의 종료` 또는 종료 버튼을 누르면 남은 전사를 마감하고 `#회의기록`과 같은 웹 주소에 요약을 반영합니다.

`/회의 일시정지`, `/회의 재개`, `/회의 표시`, `/회의 정정`, `/회의 재전사`, `/회의 재요약`, `/회의 목록`, `/회의 보기`, `/회의 철회`, `/회의 삭제`를 지원합니다. 시작·동의·정정·삭제는 웹에서 수행하지 않습니다. 브라우저 마이크 권한을 요청하지 않습니다.

`/회의 재전사`에는 회의 링크, 화자, 시작초·종료초를 입력합니다. 저장된 원음이 있어야 하며 현재 수집 중인 마지막 15초는 제외합니다. 현재 용어 사전을 요청에 고정하고, 동일 범위·사전의 처리 결과를 재사용합니다. 사람의 정정과 충돌하면 자동 덮어쓰기를 중단합니다.

초기 월간 API 예산은 **5만원**입니다. `/회의 설정 월예산:...`으로 변경할 수 있습니다. 80% 알림, 100% 신규 시작 제한을 적용하며 진행 중 회의는 마감합니다. 원화 환산은 설정된 환율에 따른 추정치이며 공급사 청구액과 차이가 있을 수 있습니다.

## 로컬 데모

Node.js 24와 pnpm 10.33.0, PostgreSQL 17, FFmpeg가 필요합니다.

```bash
pnpm install --ignore-scripts
pnpm init:env
# .env의 DATABASE_URL을 접근 가능한 개발 DB로 지정합니다.
pnpm db:migrate
pnpm dev
```

`http://127.0.0.1:3000`에서 데모를 엽니다. `pnpm dev`는 **명시적인 mock 모드**를 강제하고 별도 데모 guild_id를 사용합니다. Discord 버튼처럼 보이는 로그인은 이 모드에서만 모의 세션을 만듭니다. 화면 상단에 데모 표시가 있으며 유료 API와 Discord Gateway를 호출하지 않습니다.

개발용 PostgreSQL을 새로 시작하는 예:

```bash
docker run -d --name juncoy-local-pg \
  -e POSTGRES_USER=meeting -e POSTGRES_DB=meeting \
  -e POSTGRES_PASSWORD=meeting_local_only \
  -p 127.0.0.1:15439:5432 postgres:17-bookworm
```

이 비밀번호는 로컬 예시입니다. 운영 비밀번호·키는 `.env.production`에 별도로 저장합니다. 현재 작업 환경은 JunnnnyServer의 전용 DB를 SSH 포워딩으로 사용합니다. 연결 명령은 `ssh -N -L 127.0.0.1:15439:127.0.0.1:15439 junnnnyserver`입니다.

경로에 공백이 있는 macOS에서는 `@discordjs/opus` 네이티브 빌드가 실패할 수 있습니다. 개발 모드에서는 검증한 `opusscript` 디코더로 대체합니다. 서버 컨테이너에서는 네이티브 Opus가 빌드되는 것을 확인했습니다.

## 실제 연동 및 배포

`.env.example`을 참고해 Discord Bot Token·Client ID·OAuth Client Secret, ReturnZero 키, Upstage 키를 입력합니다. 각 암호화 키는 서로 다른 32바이트 hex 값이며 `pnpm init:env`가 비어 있는 키를 생성합니다. 비밀값은 Git에 추가하지 않습니다.

Discord OAuth scope는 `identify guilds.members.read`, callback은 `https://juncoystt.junnnny.kr/auth/discord/callback`입니다. 봇의 기본 intent는 Guilds와 GuildVoiceStates입니다. 일반 채팅 내용과 브라우저 음성을 수집하지 않습니다.

봇에 필요한 권한은 ViewChannel, Connect, SendMessages, EmbedLinks, ReadMessageHistory, AttachFiles입니다. 봇을 추가할 수 있는 음성방 정원을 확보하세요. 역할·전용 채널 생성은 관리자가 직접 하거나, 이미 부여된 관리 권한으로 초기 설정 스크립트를 실행합니다. Administrator 전체 권한이 런타임 필수 조건은 아닙니다.

```bash
PROVIDER_MODE=real pnpm discord:register
# 운영 .env.production과 전용 볼륨을 준비한 서버에서:
docker volume create discord-meeting-pgdata
docker compose --env-file .env.production -f infra/compose.yml build api
docker compose --env-file .env.production -f infra/compose.yml run --rm api \
  node --import tsx scripts/migrate.ts
docker compose --env-file .env.production -f infra/compose.yml --profile cloudflare up -d
```

현재 JunnnnyServer는 별도의 Cloudflare Tunnel로 HTTPS를 제공합니다. 다른 서비스의 프록시 설정은 수정하지 않았습니다. 신규 서버에서 직접 HTTPS를 제공하려면 `caddy` 프로필과 도메인 환경변수를 사용합니다. 두 프로필을 동시에 켤 필요는 없습니다. 마이그레이션은 앱 시작 전 실행합니다.

운영에서 mock 모드, 누락된 필수 키, 비 HTTPS URL 또는 잘못된 callback으로 실행하면 실패합니다. 상세 절차·롤백·삭제·백업은 [운영 문서](docs/operations.md)에 있습니다.

## 검증 명령

```bash
pnpm check
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
pnpm verify:load
pnpm verify:providers
PROVIDER_MODE=real pnpm verify:dave
pnpm schema
```

DB·브라우저 테스트는 무작위 별도 schema를 생성하고 종료 시 삭제합니다. 실제 API 검증 명령은 소액의 공급사 사용량이 발생할 수 있으며 합성 입력으로 실행합니다. `verify:load`는 **4시간 분량을 가속 재생하는 테스트**이며 실제 4시간 음성 수신 시험이 아닙니다.

- [아키텍처](docs/architecture.md)
- [API·SSE 계약](docs/api.md)
- [운영·보관·삭제](docs/operations.md)
- [요구사항·테스트 대응표](docs/requirements-traceability.md)
- [검증 결과와 남은 인수 시험](docs/verification-report.md)
- [원본 명세](docs/SPEC.md)

## 후속 품질 검증

[사실 원장](docs/fact-ledger.md)과 [평가 도구 실행](docs/evaluation.md)을 참고하세요. `pnpm qa:summary`, `pnpm qa:audio`, `pnpm qa:replay`로 고정 대본·실제 공급사 재생·격리 mock 장시간 시험을 실행합니다. 실행 결과에는 실제 Discord 인수와의 차이를 명시합니다.

최신 구현·배포 결과: [2026-09-07 후속 검증 보고서](docs/qa-followup-2026-09-07.md). 실제 Discord 다중 계정 인수와 사람 정답 검수는 별도 항목입니다.
