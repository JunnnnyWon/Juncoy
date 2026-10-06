# RAG 파일럿 실행 플랜 (Devin 기준)

기준 문서: `docs/RAG_DEVELOPMENT_SPEC.md` v1.0, `docs/RAG_DEVELOPMENT_PLAN.md` (W01~W12).
이 문서는 명세를 실제 커밋/배포 단위로 분해한 실행 순서다. 2026-10-06 확인 완료 사실을 반영한다.

## 0. 이번 세션에서 확인한 전제 (spec §2.3 C01~C09 대조)

| ID | 상태 | 확인 결과 |
|---|---|---|
| C01 Notion 운영 인증 | ❌ 필요 | 서버 `.env.production`에 NOTION 키 없음. `notion-second` MCP는 조사용 로컬 로그인이라 운영 불가 → **Notion 읽기 전용 integration 토큰 + 루트 공유 필요 (사용자 작업)** |
| C02 GitHub 인증 | ⚠️ 선택지 | Devin GitHub App으로 Team_23 읽기 가능(개발용 fixture 확보 가능). 운영 수집기는 **GitHub App 생성(권장) 또는 기존 PAT로 polling-only** 중 결정 필요 |
| C03 Discord intents | ⚠️ 부분 | 현재 bot은 `Guilds + GuildVoiceStates`만 사용. 실시간 수집은 `GuildMessages + MessageContent`(privileged) 필요 → **Discord 개발자 포털에서 MessageContent intent 토글 (사용자 작업)**. REST 과거 수집은 지금 가능(명세상 확인됨) |
| C04 공유/ACL 정책 | ✅ 기본안 채택 가능 | 명세 §5의 지정 루트/채널/브랜치 allowlist 그대로 구현. restricted는 차단 기본 |
| C05 임베딩 | ✅ **검증 완료** | 운영 UPSTAGE_API_KEY로 실측: `embedding-query` / `embedding-passage` 모두 동작, **차원 4096**, 한국어 입력 정상 |
| C06 이미지 공급자 | ❌ 미정 | 파일럿은 프롬프트 지원(prompt-only)까지만. 생성 기능 분리 (spec §15) |
| C07 아트 프로필 | 후속 | style_profile 승인 UI가 W11A에 포함, 초기엔 사람 승인 플로우만 |
| C08 브랜치 정책 | ✅ | main / SideView / Stairs 분리 수집 명세 확인 |
| C09 리소스/예산 | 설계로 해결 | 별도 DB·큐·프로세스, 동일 Discord token limiter 공유 |

사용자에게 필요한 것 3개: **Notion integration 토큰**, **Discord MessageContent intent 활성**, **GitHub App 자격증명** (App 채택 확정 — App ID/private key/installation ID/webhook secret). 이 3개 없이도 W01/W02 기반 + Discord REST 백필 + Juncoy 수집기 + 추출/인덱스/검색/문답 골격은 진행 가능(Notion/GitHub는 fixture 어댑터로 개발, 토큰 도착 즉시 실연결).

## 0. 진행 상태 (2026-10-06)

| 단계 | 상태 | 비고 |
|---|---|---|
| P1 | ✅ PR #4 | contracts + knowledge-db(전체 테이블, 큐/fencing/tombstone) |
| P2 | ✅ PR #5 | Discord REST 백필/head 대조/스레드 탐색 + discord-context 폴러 |
| P4 | ✅ PR #5 | Juncoy 수집기 — canonical/정정/삭제/공유취소 5초 동기화 |
| P6 | ✅ PR #5 | GitHub App JWT+webhook 서명+tree diff (push/rename/force-push/revert) |
| P7 | ✅ PR #5 | 출처별 청커 + extract/index 잡 + 활성 chunk_set 원자 교체 |
| P8 | ✅ PR #5 | trgm+식별자 키워드, pgvector, RRF, ACTIVE set/READY 문서만 |
| P9 | ✅ PR #5 | answer 파이프라인(라이브 읽기→검색→Solar→근거 재검증), /api/knowledge/* + /ask UI |
| P10 | ✅ PR #5 | 근거 기반 프롬프트 합성 API (생성은 provider 미설정) |
| P11 | ✅ PR #5 | `infra/compose.knowledge.yml` + `.env.knowledge.example` — **미배포** |
| P3 | ✅ PR #5 | Gateway 클라이언트(heartbeat zombie/resume/seq gap → 재대조), discord-context 내 단일 작성자 — 실연결은 intent 확인 후 |
| P5 | ✅ PR #5 | Notion 수집기(증분 2분/구조 15분/댓글/archive tombstone/webhook) — 토큰 확보, 실연결 시험 남음 |

## 1. PR 단위 실행 순서

각 단계는 독립 PR. 기존 음성 서비스 코드 변경은 최소화하고 플래그로 격리한다.

| PR | 범위 (W 매핑) | 주요 산출 | 완료 확인 |
|---|---|---|---|
| P1 | **계약+DB 골격** (W01/W02) | `packages/contracts/src/knowledge.ts` (§13.1 enum·응답 스키마), `packages/knowledge-db` Kysely 스토어, §10 테이블 migration, 큐/lease/generation fencing, tombstone | `pnpm check`+단위테스트: 중복/역순 이벤트, lease 상실, tombstone 재도착 |
| P2 | **Discord 수집기** (W03) | `apps/discord-context`: REST 백필(8채널+활성/보관 스레드, before cursor, snowflake BigInt), reply/attachment 문서화, high-watermark 겹침 처리 | 실제 길드 과거 수집 + 편집/삭제 반영 시험 |
| P3 | **Discord 실시간** (W03) | Gateway 접속(별도 chat-only 세션), CREATE/UPDATE/DELETE/THREAD 이벤트, resume 실패 시 REST 보완+gap 기록, same-token limiter 공유 | intent 활성 후 live 수신·uncached update hydrate·sequence gap 시험 |
| P4 | **Juncoy 수집기** (W06) | meeting DB read-only role, `meeting_id+event_seq` cursor 5초 polling, canonical/정정/삭제/공유 취소 반영 | 정정·대체·workspace 공유 해제가 인덱스에 반영 |
| P5 | **Notion 수집기** (W04) | 공식 API page/data source/재귀 block/속성/댓글, webhook 서명(HMAC-SHA256)+dedupe, 증분 2분/구조 15분 대조 | 토큰 도착 후 A01~A03 fixture→sandbox 시험 |
| P6 | **GitHub 수집기** (W05) | ref별 HEAD/tree/blob, push/rename/delete/force-push/revert, PR/issue/discussion 메타데이터, webhook 수신 엔드포인트 | A04/A05. PAT면 webhook 없이 60초 HEAD 대조로 시작 |
| P7 | **정규화·청크·추출** (W07) | §9.3 청크 규칙(문서 500~900tok/Discord 10분창/회의 60~120초/코드 AST), PDF 텍스트+표, 이미지 메타데이터, active chunk_set 단일 트랜잭션 전환 | dirty/삭제 문서가 current에서 제외됨, citation span 보존 |
| P8 | **검색** (W08) | pgvector 4096, embedding_profiles(구/신 모델 분리), structured+trigram+vector RRF, ACL-first 필터 | 골드 Recall@20 측정 harness + 한국어/코드 식별자 평가 |
| P9 | **문답 API+UI** (W09/W10) | `apps/knowledge-api`: 매 질문 Discord live read(12초 budget), 출처별 커버리지/충돌 판단, Solar Pro 4 citation 검증, SSE, 공개 직전 재검증. `apps/web/src/knowledge/` UI | A11~A17: 실패 시 COMPLETE 금지, PARTIAL 표시 |
| P10 | **이미지 프롬프트** (W11A) | style_profile 승인/버전, 근거 기반 prompt composer, 생성 직전 재확인, STALE_CANDIDATE | prompt-only 화면, 근거 버전 추적 (R16) |
| P11 | **배포** (W12) | `infra/compose.knowledge.yml`: knowledge-postgres(pgvector)/api/worker/discord-context, 볼륨·리소스 제한·플래그 3개, cloudflared webhook 라우트 | staging→prod 순서(§16), 롤백=flag off+서비스 중지 |

의존: P1 → {P2,P4,P5,P6 병행} → P7 → P8 → P9 → P10 → P11. P3는 intent 활성 전까지 gateway 부분만 대기 가능(REST 백필은 선행).

## 2. 작업 방식

- 각 PR은 스펙이 요구한 fake provider 테스트를 먼저 넣고, 실연결은 인증 확보 시점에 전환.
- 서버 배포는 기존 절차(assert-idle→백업→build→migrate→up)를 그대로 쓰되, knowledge 스택은 별도 compose라 회의 서비스와 배포 시점 분리 가능.
- spec 일정(10/11 파일럿)은 인증 3개가 이번 주 초 확보된다는 가정의 공격적 목표. C01/C03가 늦어지면 P5/P3만 미뤄지고 나머지는 진행됨 — **게이트를 일정보다 우선**하는 명세 원칙 그대로 적용.

## 3. 첫 착수 (승인 후 즉시)

P1 브랜치 착수 + 사용자에게 Notion 토큰·Discord intent·GitHub 인증 방식 요청을 병행.
