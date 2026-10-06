# RAG 감사 결함 해결 보고

작성일: 2026-10-06 KST. 대상 저장소: `JunnnnyWon/Juncoy`.
기준 감사: [RAG_IMPLEMENTATION_AUDIT_2026-10-06.md](RAG_IMPLEMENTATION_AUDIT_2026-10-06.md) (기준 SHA `522daee`).
이 문서는 수정 에이전트가 **재현 → 수정 → 검증**한 결과다. 증거 수준을 표로 구분한다.

## 검증 환경

- 로컬: Node v22.23.2(엔진 경고만, 코드상 문제 없음), pnpm 10.33.0.
- 격리 테스트 DB: 로컬 Docker `pgvector/pgvector:pg17` 컨테이너(`127.0.0.1:55440`)에 knowledge 스키마 + meeting DB를 별도 생성. **운영 DB/운영 서비스에 테스트 데이터 없음, 재기동 없음.**
- 통합 테스트 env: `DATABASE_URL`(meeting test DB) + 더미 `SESSION_SECRET`/`TOKEN_ENCRYPTION_KEY`/`AUDIO_ENCRYPTION_KEY`(테스트용 난수, 실값 아님).

## 검증 명령 결과

| 명령 | 결과 |
|---|---|
| `pnpm check` | 통과 (tsc --noEmit) |
| `pnpm test:unit` | **80/80** 통과 (감사 시점 70 → +10) |
| `pnpm vitest run tests/integration/knowledge-db.test.ts` | 격리 DB에서 **6/6 pass** (감사 시점 4 skip). URL 없으면 이유를 표시하며 skip — skip/fail 구분됨 |
| `pnpm test:integration` (meeting DB 포함) | **10개 파일 / 51개 전부 통과** — 회의·인증·캡처 회귀 없음 |
| `pnpm build` | 통과 |
| `pnpm format:check`(수정 파일) | 통과. repo 전체로는 기존 미수정 파일에 기존 경고 다수 — 이번 작업과 무관 |
| `git diff --check` | 통과 |

## 항목별 해결

### RAG-001 ACL (문서/답변 접근 제어)

- **수정**: `documents.acl` 컬럼 + `source_scopes` 기반 ACL 절을 모든 검색/근거 재검증 SQL에 바인딩(`aclClause` 공유). API는 질문자의 OAuth guild 멤버십에서 `AclInput`을 도출하고, 프로젝트도 질문자 guild 스코프로 조회(`projectForAsker`). 저장 답변 재조회(`GET /answer/:id`)도 동일 ACL 재검증. 시드에 guild 스코프 반영.
- **파일**: `packages/knowledge-db/src/index.ts`, `packages/knowledge/src/retrieve.ts`, `packages/knowledge/src/answer.ts`, `apps/api/src/knowledge.ts`, `apps/discord-context/src/main.ts`, `scripts/seed-knowledge.ts`, `migrations/002_version_binding.sql`(ACL 백필 + 표현식 인덱스).
- **테스트**: `tests/integration/knowledge-db.test.ts` ACL backfill/필터, 단위 `knowledge-answer` ACL 게이팅.
- **남은 작업**: 운영 DB는 `002` 마이그레이션 적용 시 ACL 백필이 자동 실행 — 배포 시 포함.

### RAG-002 저장 답변 재검증

- **수정**: `GET /api/knowledge/answer/:id`가 저장 시점의 ACL/삭제를 다시 검증 — 공유 해제·삭제된 근거만으로 이루어진 답변은 403/404.
- **파일**: `apps/api/src/knowledge.ts`, `packages/knowledge/src/answer.ts`.
- **테스트**: 단위 + 통합(재조회 시 ACL 회수 시나리오).

### RAG-003 coverage/COMPLETE 판정

- **수정**: coverage를 실제 소스 상태에서 계산 — ACCESS_LOST/DISABLED → FAILED, 허용 스코프 0 → `scope_complete=false`, 대조 이력 없음/정체(출처별 stale 임계) → PARTIAL. 하나라도 실패/정체면 COMPLETE 불가.
- **파일**: `packages/knowledge/src/answer.ts`(coverage 루프, `sourceRows`, `lastReconciled`).
- **테스트**: 단위 — discord_context_disabled/source 실패 → PARTIAL, 정체 커서 → PARTIAL.

### RAG-004 근거 버전 고정·재검증

- **수정**: 검색 시점에 `revision`(현재 version의 `content_hash`)을 캡처 → 모델 호출 후 `revalidateEvidence`가 문서 상태(READY/비삭제/비dirty)·버전 결속·정규화 본문 내 청크 텍스트 존재·ACL을 재확인. 실패 근거는 제외하고 PARTIAL 처리.
- **파일**: `packages/knowledge/src/retrieve.ts`(`revision` 반환), `answer.ts`.
- **테스트**: 통합 — 버전 교체 후 재검증 실패 케이스.

### RAG-005~007 버전·청크·잡 일관성

- **수정**:
  - `documents.pending_revision` + `publishVersion(expectedRevision)` — 잘못된 revision으로의 게시는 거부.
  - `chunk_sets.version_id` NOT NULL + `createChunkSet(versionId)` + `swapChunkSet`이 `s.version_id = d.current_version_id` JOIN 조건을 강제 — 구버전 청크 세트는 활성화 불가.
  - `knowledge_jobs.owner` + `claimJobs`의 만료 lease 회수 + `finishJob/retryJob`을 generation+owner+`status='RUNNING'`으로 게이팅 — 늦게 깨어난 워커의 쓰기는 false 반환.
  - `markDocumentDirty`가 동일 content_hash면 `unchanged` 반환 + `unlessHash`/`revision`/`acl` 옵션 — 동일 내용 재수집이 READY 문서를 dirty로 밀지 않음. tombstoned 문서는 dirty 불가.
  - `recordSourceEventWithJob` — 이벤트 기록과 잡 생성을 단일 트랜잭션으로 (webhook → 잡 매핑 원자성, RAG-014).
- **파일**: `packages/knowledge-db/src/index.ts`, `migrations/002_version_binding.sql`, `packages/knowledge/src/indexer.ts`(expectedHash·버전 결속 swap).
- **테스트**: 통합 `knowledge-db.test.ts` 6개 중 4개가 이 범위(lease 회수, stale generation 거부, tombstone 게이팅, 버전 결속 swap, unchanged 재수집).

### RAG-008 Discord live read

- **수정**: `makeDiscordRead`가 `source_scopes`의 허용 `channel:` 스코프를 읽는다(connector_cursors 아님). 허용 채널 0 → `ok:false`(gap), ACCESS_LOST → 시도 없이 gap. 채널 병렬 3 + 호출자 예산. 읽은 뒤 extract 잡 큐가 빌 때까지 최대 3초 대기해 검색 반영.
- **파일**: `apps/api/src/knowledge.ts`.
- **테스트**: 단위 — 빈 스코프/비활성 소스/timeout 경로.

### RAG-009 백필 완료 판정

- **수정**: `backfillChannel`은 head 메시지 자체를 수집하고(`fetched++`), `done`은 첫 페이지까지 도달(`reachedStart`)할 때만 — 부분 페이지/한도 도달을 완료로 간주하지 않음. 403 → cursor에 `access_lost` 기록.
- **파일**: `packages/knowledge/src/discord.ts`.
- **테스트**: 단위 — head 수집, slice-limit≠done, 빈 페이지=done, 403 access_lost.

### RAG-010 스레드 수집·삭제·권한 회수

- **수정**: `source_scopes`에 `thread:<id>` 스코프 등록(`registerThreadScopes`), 스레드 문서는 `acl.scope='thread:<id>'`로 결속(`scopeKey`를 ingest/backfill/reconcile에 통으로 전달). `applyTombstonesByPrefix`로 채널/스레드 삭제 시 `discord:<guild>:<channel>:` 접두의 모든 문서를 일괄 tombstone. Gateway가 `MESSAGE_DELETE_BULK`, `CHANNEL_DELETE`, `THREAD_DELETE`, `CHANNEL_UPDATE`(접근 재확인 reconcile), `THREAD_CREATE/UPDATE/LIST_SYNC`를 처리.
- **파일**: `packages/knowledge/src/discord.ts`, `apps/discord-context/src/main.ts`, `packages/knowledge-db/src/index.ts`(`applyTombstonesByPrefix`).
- **테스트**: 단위 — 스레드 스코프 결속, bulk tombstone, 채널 권한 회수 시 tombstone.

### RAG-011 Gateway 내구 sequence/순서

- **수정**: `dispatchChain`으로 dispatch를 직렬화 — `seq`는 `onDispatch` 성공(await) 후에만 전진. `p.s !== seq+1`(역행 포함)이면 `resync`. dispatch 오류 → `closed` + resync(조용한 삼킴 제거). `resyncInFlight`로 재연결 중복 방지.
- **파일**: `packages/knowledge/src/discord-gateway.ts`.
- **테스트**: 단위 — seq가 durable dispatch 후에만 전진, 이벤트 순서 보장, 역행 seq resync.

### RAG-012 회의 공유 해제/final/상태

- **수정**: canonical segments에 `is_final` 필터; cursor가 `{transcript_version,status,ended_at}` 세 요소 비교(상태 전환도 재수집 유발). `reconcileUnshared` — 워크스페이스 공유 목록에서 사라진 회의 문서를 tombstone(`meeting_unshared_from_workspace`). `syncOnce`가 `{meetings, synced, unshared}` 반환.
- **파일**: `packages/knowledge/src/juncoy.ts`.
- **테스트**: 단위 — 공유 해제 tombstone, status 변화 재수집, final 필터.

### RAG-013 Notion pagination/속성/접근 회수

- **수정**: 댓글 `has_more/next_cursor` 페이지네이션, 페이지 본문에 비제목 속성 요약(`propertySummary`)을 포함해 속성 변경이 해시에 반영. 401/403 → `knowledge_sources.status='ACCESS_LOST'`(coverage가 FAILED로 보고). `reconcileStructure`가 검색 커서를 올바른 인자로 전달(기존엔 `editedAfter` 자리에 커서가 들어가 구조 대조가 항상 첫 페이지만 돔).
- **파일**: `packages/knowledge/src/notion.ts`.
- **테스트**: 단위 — 댓글 페이지네이션, 속성 포함 해시, 401 → ACCESS_LOST.

### RAG-014 webhook 소스 결속·원자 잡

- **수정**: GitHub/Notion webhook 페이로드에 `source_id`를 박고 워커의 `boundSource`가 `payload.source_id` 우선(기존 "첫 ACTIVE 소스" 폴백 유지). 이벤트 수신+잡 생성은 `recordSourceEventWithJob` 트랜잭션.
- **파일**: `apps/api/src/knowledge.ts`, `apps/knowledge-worker/src/main.ts`, `packages/knowledge-db/src/index.ts`.
- **테스트**: 단위 — source_id 바인딩 경로.

### RAG-015 기능 off/Compose 독립/마이그레이션 순서

- **수정**: knowledge 라우트를 캡슐화된 플러그인으로 등록 + 스코프 에러 핸들러(Zod→400, KNOWLEDGE_DISABLED→503, 미지 원인→503 TEMPORARY_FAILURE). `infra/compose.yml`에서 api의 knowledge-net 제거 → 회의 스택 단독 기동. 지식 스택은 `compose.knowledge.yml` + 선택 override(`compose.knowledge-attach.yml`=api↔knowledge-net, `compose.knowledge.meetingnet.yml`=knowledge-worker↔meeting-net). `knowledge-worker`는 `migrate: service_completed_successfully` 후 시작.
- **파일**: `apps/api/src/server.ts`, `infra/compose*.yml`.
- **테스트**: `docker compose config --quiet` 각 조합 검증 + 단위 — 지식 비활성 시 503.

### RAG-016 격리 테스트 DB + skip/fail 구분

- **수정**: `tests/integration/knowledge-db.test.ts`가 스키마 스코프 테스트 DB를 생성/폐기(운영 DB 불변). URL 없음 → skip(이유 표기), URL 있는데 연결/마이그레이션 실패 → **fail**. pgvector 확장은 `public` 스키마에 생성하고 search_path에 포함.
- **검증**: 로컬 pgvector DB에서 6/6 pass; URL 없는 실행은 명시적 skip.

### RAG-017 미지원 질의 옵션 명시

- **수정**: `/api/knowledge/ask`가 `temporal_mode!=='current'`, `as_of`, `branch`, `conversation_id`를 `400 UNSUPPORTED_OPTION`으로 거부 — 조용히 무시하지 않는다. `history`/`as_of`/`branch`/SSE는 **명시적 백로그**(미구현).
- **파일**: `apps/api/src/knowledge.ts`.
- **남은 작업(backlog)**: 과거 시점 버전 검색(as_of), 브랜치/대화 맥락, 비동기 실행+SSE.

### RAG-018 이미지 프롬프트 승인/근거

- **수정**: `activeStyle`이 `approved_by IS NOT NULL AND approved_at IS NOT NULL`인 프로필만 사용. 결과에 `evidence`(stable_key+revision), `retrieved_at`, `style_approved`, `mode:'prompt_only'`를 포함. 라우트도 질문자 프로젝트 스코프+guild ACL 바인딩. provider 미설정은 `X-Image-Generation: provider_unconfigured` 헤더로만 표시 — 생성 완료로 보이지 않는다.
- **파일**: `packages/knowledge/src/image-prompt.ts`, `apps/api/src/knowledge.ts`.
- **남은 작업**: 실제 이미지 provider 미연결(명세상 선택 사항) — prompt만 반환.

### RAG-019 검색 분배·계측·미구현 범위

- **수정**: `perSourceQuota` — 결과가 있는 출처끼리 limit 균등 배당 + 남는 자리 순위 채움(출처 독점 방지). Solar 래퍼가 실제 `usage`를 반환하고 `answer_runs`에 기록. 단계별 latency(discord_read/search/generate/revalidate/total)를 `knowledge_audit`의 `ANSWER_RUN` 레코드로 남긴다(Answer 스키마가 strict라 body에 못 넣음).
- **파일**: `packages/knowledge/src/retrieve.ts`, `packages/knowledge/src/answer.ts`, `apps/api/src/knowledge.ts`.
- **테스트**: 단위 `perSourceQuota` 3개(독점 방지/부족 시 전량/단일 출처).
- **백로그(미구현, 명시적)**: GitHub PR/issue/discussion 수집, PDF/OCR/이미지 이해, AST 청킹, 지속 claim 그래프, retrieval gold/Recall@20 하네스, 공용 rate-limiter.

### RAG-020 포맷·보고 증거 수준

- **수정**: 이번 작업의 수정 파일은 `prettier --check` 통과. 기존 미수정 파일의 기존 경고는 이번 범위 밖으로 보고한다. 이 문서가 P 단계별 상태를 **코드/테스트/실API/배포**로 구분한다.

## 상태 요약 (증거 수준)

| 범위 | 코드 | 단위 테스트 | 격리 DB | 실API/운영 |
|---|---|---|---|---|
| RAG-001~007 (스토어·ACL·버전) | ✅ | ✅ | ✅ 6/6 | 배포 시 `002` 마이그레이션 필요 |
| RAG-008~011 (Discord) | ✅ | ✅ | — | 실게이트웨이 장기 관측은 배포 후 |
| RAG-012 (회의) | ✅ | ✅ | — | 운영 연동 재검증은 배포 후 |
| RAG-013 (Notion) | ✅ | ✅ | — | 접근 회수는 실 권한 변경으로 재검증 |
| RAG-014 (webhook) | ✅ | ✅ | — | 실 webhook e2e는 배포 후 push로 |
| RAG-015 (off/compose) | ✅ | ✅ | — | 각 조합 `compose config` 검증 완료 |
| RAG-016 (테스트 DB) | ✅ | ✅ | ✅ | CI에 `KNOWLEDGE_DATABASE_URL` 설정 시 자동 활성 |
| RAG-017~019 | ✅ | ✅ | — | usage/latency는 실 호출에서 기록 확인 필요 |
| RAG-020 | ✅ | — | — | 본 문서 |

## 회귀 확인

- `pnpm test:integration`에 격리 meeting DB를 붙여 **기존 회의·인증·캡처 테스트 51개 전부 통과** — 음성 봇/회의 기록 회귀 없음.
- 운영 서비스 재기동·운영 DB 테스트 데이터 없음(감사 지시 준수).

## 배포 시 필요한 작업

1. 지식 DB에 `migrations/002_version_binding.sql` 적용 — `chunk_sets.version_id` 백필 + 문서 ACL 백필이 자동 실행.
2. `apps/knowledge-worker` 재빌드(신규 잡 경로), `api` 재빌드(스코프 에러 핸들러·UNSUPPORTED_OPTION·webhook source_id), `discord-context` 재빌드(스레드/삭제 이벤트).
3. `infra/compose.knowledge-attach.yml`, `compose.knowledge.meetingnet.yml` 선택 override를 운영 배포 명령에 포함해 네트워크 분리 유지.
