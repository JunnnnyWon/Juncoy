# 웹 프로젝트 어시스턴트 구현 플랜

작성일: 2026-10-07 KST. 대상 저장소: `JunnnnyWon/Juncoy`.
명세: [WEB_PROJECT_ASSISTANT_DEVELOPMENT_SPEC.md](WEB_PROJECT_ASSISTANT_DEVELOPMENT_SPEC.md) v1.0.
선행: RAG 감사 결함 RAG-001~020 해결 완료 (`docs/RAG_AUDIT_RESOLUTIONS.md`, SHA `a8bc956` 이후) — 명세 Phase 0 충족.

## 사용자 결정 반영

- **이미지 provider = OpenRouter** (모델 `gpt-image-2.5-flare`). 명세의 OpenAI Image API 대신 OpenRouter 엔드포인트(`https://openrouter.ai/api/v1`)로 adapter를 구현한다. env는 `OPENROUTER_API_KEY` + `OPENROUTER_IMAGE_MODEL=openai/gpt-image-2.5-flare`(이름 확인 후 고정)로 둔다.
- 나머지 모델 계층은 명세대로: 대화/문답 Solar Pro4(기존 `UPSTAGE_MODEL`), 임베딩 Upstage 4096d(기존 profile).

## 전제 확인 결과

- ✅ RAG 파이프라인·ACL·coverage·근거 재검증·툼스톤: 구현·검증 완료(RAG 감사 해결).
- ✅ Notion integration token: 운영에 존재 (수집기 동작 중). schedule/task DB 접근은 integration이 두 DB에도 연결돼 있어야 함 — **사용자 확인 필요**(페이지 공유와 별개로 DB 단위 연결 필요).
- ✅ 일정 DB `collection://3d4ec741-…`, 작업 DB `collection://3d1ec741-…` — 명세에 스키마 확정.
- ❌ OpenRouter API key: 없음 — **사용자 제공 필요** (`OPENROUTER_API_KEY`).
- ⚠️ 파일 storage: 명세는 "private object storage". 서버 로컬 볼륨(`/home/junnnnyserver/services/discord-meeting-bot/.data/knowledge-uploads`, 웹 루트 밖, ACL 게이트된 GET만)을 1차로 채택 — S3 불필요. 변경이 필요하면 결정 포인트로 남김.
- ⚠️ `gpt-image-2.5-flare`의 OpenRouter 정확한 slug는 키 입수 후 `/v1/models`로 확인한다.

## 단계

### Phase 1 — 웹 read-only assistant (W1~W4)

**W1. 데이터 모델 + 계약** — `packages/knowledge-db/migrations/003_assistant.sql`: `assistant_conversations`, `assistant_messages`, `assistant_runs`, `assistant_run_events`(seq+payload_hash), `assistant_tool_calls`, `assistant_approvals`, `assistant_audit`. `packages/contracts/src/assistant.ts`: Conversation/Message/Run/RunEvent/ToolCall/Approval zod 스키마, run 상태 열거(idle~failed, 명세 §7), tool 실행 모드 열거(answer/search/propose/mutate/generate/ingest).

**W2. Tool registry 골격 + read 도구** — `packages/knowledge/src/tools/`: 공통 `ToolDef{schema, permission, idempotencyKey, auditKind, run}` + registry. 구현할 read 도구: `knowledge.search/ask/get_evidence`(기존 answer.ts 래핑), `discord.refresh_context`(기존 live read 재사용), `notion.search/fetch_page/query_schedule/query_tasks`(Notion REST adapter에 DB query + property 매핑 — 일정: 이름/날짜/담당자/상태, 작업: +우선순위/파트/진행률), `github.search_code/fetch_file`(App adapter 재사용), `meeting.search_transcript`, `file.get_ingestion_status`(스텁→W7에서 완성). 도구 입력은 서버 검증 스키마만 — 모델이 URL/토큰을 넣을 수 없다.

**W3. API `api/assistant/*`** — 대화 CRUD, `POST messages`(run 생성 → `run_id` 즉시 반환 → SSE `runs/:id/stream`으로 phase 이벤트·근거·결과 push, heartbeat 15s + tick마다 ownership 재검사), `runs/:id/cancel`, approvals/actions 조회. 실행기: 질문 → mode 분류(Solar 또는 규칙) → answer/search만 허용. 에러 핸들러는 기존 캡슐 패턴.

**W4. 웹 UI 뼈대** — `/assistant` 페이지: 대화 목록/새 대화, 메시지 스트림(SSE), coverage 칩(기존 Ask 재사용), 근거 패널, 우측 일정·작업 패널(read-only). 첫 화면을 assistant로 보낼지는 결정 포인트(기본: 기존 회의록 대시보드 유지 + 탭 추가).

### Phase 2 — 파일과 RAG (W5~W7)

**W5. 업로드 저장소 + 검사** — `knowledge_uploads`/`knowledge_upload_versions` 테이블, private 로컬 저장소 + sha256 계산, `files/init`→`files/:id/complete` 2단계 업로드, MIME/확장자/크기(50MB/10개/5GB)/실행·압축파일 거부 + 매직 바이트 검사.

**W6. 추출기** — TXT/Markdown/CSV는 직접, PDF/DOCX는 라이브러리(`pdf-parse`/`mammoth` 계열, 전단 의존성 최소), 이미지는 metadata + 원본 reference(OCR/vision은 백로그 표기 — Solar 비전 경로 없음). 추출 → 기존 chunk/embed/index 파이프라인으로 document kind `upload` 수집. 상태 머신 UPLOADED→EXTRACTING→INDEXING→READY, READY 전 검색 차단(기존 `state` 게이트 그대로).

**W7. 삭제 preview/commit + UI** — `file.preview_delete_or_replace`/`file.commit_delete_or_replace`(approval 경유), tombstone+파생 차단은 기존 store 함수 재사용. 업로드 UI(드래그앤드롭, 진행 상태, READY 표시, 갤러리식 목록).

### Phase 3 — Notion approval mutation (W8~W10)

**W8. Approval 인프라** — `assistant_approvals`(before_hash/after_hash/expires_at 10분/1회성), audit 기록, 재사용·만료·사용자 불일치 거부. 승인 시 target 재조회 → before_hash 다르면 중단+새 preview.

**W9. Notion 쓰기 도구** — preview/commit 6종(page/schedule/task create·update). KST 날짜 계산, 구조화된 속성 매핑(실제 DB 스키마 고정 매핑 — 자동 스키마 변경 금지), 중복·일정 충돌 검사, idempotency key로 재시도 안전. 부분 성공 가능(두 DB 동시 변경 시) → 결과에 per-target 성공/실패 명시.

**W10. UI 승인 흐름** — preview card(작업 종류/대상/before→after/근거/만료 시각/승인·거부·수정·취소), run 상태 `awaiting_approval`/`executing_tool`, 실행 후 재조회 결과 표시. 역할: 길드 멤버=reader 기본, editor 명시 부여(단일 프로젝트라 서버측 role 테이블에 수동 등록 — 자동 승격 없음).

### Phase 4 — 이미지 (W11~W12)

**W11. OpenRouter adapter** — `packages/knowledge/src/image-openrouter.ts`: `POST https://openrouter.ai/api/v1/images/generations`(또는 chat completions + modalities, slug 확인 후 확정), 429/5xx 지수 재시도, 사용자·프로젝트 일일 quota + 동시 job 제한, moderation 응답 전달. env: `OPENROUTER_API_KEY`, `OPENROUTER_IMAGE_MODEL`, `IMAGE_GENERATION_ENABLED`(기본 false).

**W12. Preview → 명시적 generate → 저장** — `images/preview`(기존 `buildImagePrompt` 확장: 근거+negative+cost 추정), `images/generate`(approval과 동일 패턴의 명시 action — 최신 소스/ACL 재확인 후 호출), `image_jobs/results` 테이블 + private 저장소 + `images/:id`(ACL 게이트 GET) + 갤러리 UI(prompt·근거·model·size·cost·created_by 표시). provider off → prompt-only, 생성 완료로 표시 금지(기존 RAG-018 정책 유지).

### Phase 5 — 운영 품질 (W13)

- retrieval gold set + tool eval, approval race 테스트, freshness SLO 점검, 백업/복원/삭제 훈련, 실 credentials + Message Content Intent 최종 검증, 브라우저 인수 테스트(명세 §17 체크리스트).

## 의존 관계와 병행

- W1 → W2·W3 · W4(병행 가능, W3 스키마만 필요)
- W5 → W6 → W7
- W8 → W9 → W10
- W11 → W12 (OpenRouter 키 입수가 선행)
- W13은 마지막

## 검증 계획

- 각 W 단위: `pnpm check` + 단위 테스트(날짜 KST, 속성 매핑, approval 만료/재사용/불일치, idempotency, 파일 검사, image payload) + 격리 DB 통합(ACL 3역할, preview 불변, 승인 후 재조회, upload→extract→index→search, tombstone 차단).
- 실API: Notion DB read/write(실 DB 2개), OpenRouter 1장 생성, Solar tool plan — 서버 credentials ��용.
- 브라우저: §17 인수 기준 전체 — 기존 `juncoy-e2e-testing` 스킬의 OAuth 게이트 절차 재사용.
- 회귀: 음성 봇·회의 기록은 배포 전 `pnpm test:integration`(격리 meeting DB) 필수 — 이번 세션에서 검증된 방법 그대로.

## 사용자 액션 필요

1. **OpenRouter API key** — `OPENROUTER_API_KEY`로 제공(이미지는 키 없이 adapter만 구현 가능하지만 실호출 검증에 필요).
2. **Notion DB 연결** — 일정 DB·작업 DB를 `23시 정시퇴근` integration에 연결(읽기+쓰기). 페이지와 별개 DB 권한.
3. 확인 필요: 첫 화면을 assistant로 대체할지(기본 유지+탭), 업로드 저장소를 로컬 볼륨으로 할지.

## 명시적 제외 (명세 §3.2)

Discord에서 도구 실행, GitHub 쓰기, Notion 스키마 자동 변경, 승인 없는 외부 변경, 이미지의 게임 레포 자동 커밋 — 전부 하지 않는다.
