# 웹 프로젝트 어시스턴트 개발 명세서

작성일: 2026-10-07 KST
대상 저장소: JunnnnyWon/Juncoy
기준 코드: 4deda347b0433bf19c2c43cf3ab0fa820b0a3c1b
버전: v1.0

## 1. 확정 결정사항

| 항목        | 결정                                                                  |
| ----------- | --------------------------------------------------------------------- |
| 주 화면     | 웹 대시보드. 질문, 파일, 이미지, 일정, Notion 변경의 유일한 실행 창구 |
| Discord 봇  | 회의 녹음·전사와 Discord 대화 수집 전용. 웹 도구를 실행하지 않음      |
| Notion 변경 | 변경 미리보기 후 사용자가 승인하면 실행                               |
| 일정 원본   | Notion의 실제 데이터베이스 일정 관리                                  |
| 작업 원본   | Notion의 실제 데이터베이스 통합 작업 현황판                           |
| 이미지      | OpenAI Image API의 gpt-image-2.5-flare                                |
| 문답        | 기존 Upstage Solar Pro 계열                                           |
| 프로젝트    | 1차는 23시 정시퇴근 단일 프로젝트                                     |

Notion MCP 직접 조회로 확인한 일정 schema:

- database ID: 3d4ec741-b304-80bb-9176-c2f7084f0edc
- data source: collection://3d4ec741-b304-80e5-8b38-000b4d9db22b
- 속성: 이름 title, 날짜 date, 담당자 person, 상태 status
- 상태: 시작 전, 진행 중, 완료
- 캘린더 view: view://92016321-a2ef-4d17-bda6-a6d2e6f97dda

작업 현황판:

- database ID: 3d1ec741-b304-80c7-9a9b-e353f1b88e5d
- data source: collection://3d1ec741-b304-8086-ba3f-000bf2f7d110
- 속성: 작업명, 날짜, 담당자, 상태, 우선순위, 파트, 진행률, 관련 기획서, 관련 아트리소스

운영 백엔드는 notion-second MCP OAuth를 복사해 사용하지 않는다. 별도 Notion Integration token을 secret으로 주입한다.

## 2. 제품 목표

팀원이 웹 대시보드 하나에서 프로젝트에 대해 질문하고, 근거를 확인하고, 파일을 RAG에 추가하고, 이미지를 만들고, 일정을 조회·제안·승인·수정하고, Notion 작업 내용을 안전하게 갱신할 수 있어야 한다.

예시:

- 최근 회의와 Discord에서 레벨 디자인에 합의된 내용을 정리해 줘.
- 이번 주 마감인데 시작 전인 작업을 보여 줘.
- 김준 담당 작업 중 날짜가 비어 있는 항목을 찾아 일정 후보를 만들어 줘.
- 이 PDF를 프로젝트 자료에 추가하고 기존 기획과 충돌하는 내용을 알려 줘.
- 아트 방향과 회의 내용을 참고해 캐릭터 컨셉 이미지를 생성해 줘.
- 다음 주 화요일까지 캐릭터 모델링 일정을 추가해 줘.
- 이 작업을 진행 중으로 바꾸고 진행률을 60으로 바꿔 줘.

어시스턴트는 답변과 외부 변경을 구분한다. 모델의 문장만으로 승인된 것으로 판단하지 않는다.

## 3. 범위

### 3.1 1차 포함

- 웹 통합 채팅과 대화 이력
- Notion, Team_23 GitHub, Discord, Juncoy 회의록, 웹 업로드 파일 통합 RAG
- 답변별 근거, source coverage, 최신 확인 시각, 충돌과 경고
- 파일 업로드, 추출, chunk, embedding, READY 상태 표시
- 일정 DB 조회·생성·수정·상태 변경
- 작업 현황판 조회·생성·수정·상태·진행률 변경
- Notion page와 database row 수정
- preview, approval, commit, 재조회 결과
- RAG 근거 기반 이미지 prompt 및 실제 이미지 생성
- 이미지 결과 저장·갤러리·근거·비용 표시
- tool 실행 감사 로그, idempotency, 취소와 충돌 처리

### 3.2 1차 제외

- Discord에서 Notion·일정·이미지 도구를 실행하는 기능
- Discord 메시지 자동 게시·수정·삭제
- GitHub push, branch 생성, PR merge
- Notion schema 자동 변경
- HR·급여·개인정보 관리
- 승인 없는 외부 시스템 변경
- 이미지를 게임 저장소에 자동 커밋하거나 배포하는 기능

## 4. 시스템 경계

웹 대시보드가 assistant session, 파일 업로드, tool call, approval, image generation, Notion mutation을 모두 담당한다.

Discord 수집기는 두 역할만 수행한다.

1. 음성 회의 녹음·전사·회의 원장 생성
2. 허용된 텍스트 채널·스레드의 메시지 수집·편집·삭제·접근 상태 동기화

수집된 내용은 Knowledge DB로 들어가고 웹 assistant가 검색한다. Discord 이벤트 처리기는 tool registry를 호출하거나 Notion을 변경하지 않는다.

## 5. 실행 모드

모든 assistant request는 answer, search, propose, mutate, generate, ingest 중 하나다.

- answer: 근거 기반 답변
- search: source·일정·작업 조회
- propose: 변경하지 않고 실행 계획과 preview 생성
- mutate: approval 후 외부 변경
- generate: 이미지 생성
- ingest: 파일 RAG 편입

답변 상태는 COMPLETE, PARTIAL, NEEDS_CLARIFICATION, FAILED다. 읽지 못한 source를 자료 없음으로 표시하지 않는다. 확인 실패와 관련 근거 없음을 구분한다.

## 6. Tool registry

읽기 도구:

- knowledge.search, knowledge.ask, knowledge.get_evidence
- discord.refresh_context
- notion.search, notion.fetch_page, notion.query_schedule, notion.query_tasks
- github.search_code, github.fetch_file
- meeting.search_transcript
- file.get_ingestion_status

preview 도구:

- notion.preview_create_page, notion.preview_update_page
- notion.preview_create_schedule, notion.preview_update_schedule
- notion.preview_create_task, notion.preview_update_task
- file.preview_delete_or_replace
- image.preview_generation

approval 이후 실행 도구:

- notion.commit_page_change
- notion.commit_schedule_change
- notion.commit_task_change
- file.commit_delete_or_replace
- image.generate

각 도구는 입력 schema, 권한 predicate, idempotency key, audit event type, 결과 schema를 가진다. 모델이 임의 URL이나 connector token을 tool input으로 만들 수 없다.

## 7. 웹 UX

첫 화면은 설명형 랜딩이 아니라 바로 사용하는 assistant다.

- 상단: 프로젝트, source 상태, 사용자
- 왼쪽: 대화 목록, 새 대화, 최근 작업
- 중앙: 메시지, 답변, preview, approval, 실행 결과
- 오른쪽: 근거 source, 일정, 작업 상태, 이미지 결과
- 입력: 텍스트, 파일 첨부, 이미지 모드, 일정·Notion 작업 모드

대화 run 상태는 idle, retrieving, checking_sources, planning_tool_call, awaiting_approval, executing_tool, generating_image, ingesting_file, completed, partial, failed다.

preview card는 작업 종류, 대상, 현재 값, 변경 후 값, 근거, 예상 비용, 만료 시각, 승인·거부·수정·취소를 표시한다.

## 8. 모델 계층

| 역할                | 모델/서비스                    |
| ------------------- | ------------------------------ |
| 대화·분류·계획·문답 | 기존 Upstage Solar Pro 설정    |
| 임베딩              | 기존 Upstage embedding profile |
| 이미지              | OpenAI gpt-image-2.5-flare     |
| 정책                | 서버 정책과 provider 응답      |

OpenAI 공식 문서 기준 GPT Image 2.5 Flare는 Image API 또는 Responses API image generation tool에서 사용할 수 있고 이미지 입력과 이미지 출력을 지원한다. 1차는 Image API adapter로 구현한다.

참조: https://developers.openai.com/api/docs/models/gpt-image-2.5-flare
참조: https://developers.openai.com/api/docs/guides/image-generation

모델은 connector를 직접 호출하지 않는다. 서버가 검증된 tool schema와 connector adapter를 통해서만 실행한다.

## 9. 파일 업로드와 RAG

웹 흐름:

1. 파일 선택 또는 drag-and-drop
2. 이름, MIME, 크기, sha256, 사용자, 프로젝트 기록
3. 프로젝트 지식에 추가 명시
4. MIME, 확장자, 크기, 위험 파일 검사
5. private object storage 원본 저장
6. 텍스트, PDF, DOCX, CSV, Markdown 추출·정규화·chunk·embedding
7. 이미지 metadata와 OCR 또는 vision description, 원본 reference 저장
8. UPLOADED, EXTRACTING, INDEXING, READY 상태 표시

READY 이전 파일은 검색·답변·이미지 근거에 사용하지 않는다. 삭제는 tombstone과 파생 청크·embedding 차단을 적용한다.

기본 제한: 파일당 50 MB, 요청당 10개, 프로젝트별 5 GB. 허용 형식은 PDF, DOCX, TXT, Markdown, CSV, PNG, JPEG, WEBP다. 실행 파일·스크립트·압축 파일은 기본 거부한다.

## 10. Notion 일정·작업

일정 패널은 collection://3d4ec741-b304-80e5-8b38-000b4d9db22b를 사용한다. 필터는 기간, 상태, 담당자, 키워드, 날짜 없음이다. 표시 항목은 이름, 날짜, 담당자, 상태, 원문 링크다.

작업 패널은 collection://3d1ec741-b304-8086-ba3f-000bf2f7d110을 사용한다.

- 일정 DB: 단순 일정·마감·담당자·상태
- 작업 DB: 파트·우선순위·진행률·관련 기획서·아트 리소스

사용자가 “일정에 추가”라고 하면 일정 DB, “작업을 진행 중으로 변경”이라고 하면 작업 DB를 대상으로 한다. 둘 다 바꾸는 경우 하나의 preview에 두 변경을 명시한다. 외부 Notion API에 원자적 transaction이 없으므로 부분 성공 가능성을 표시한다.

변경 흐름:

1. KST 기준 날짜 계산
2. 이름·날짜·담당자·상태 구조화
3. 모호한 대상 질문
4. 기존 row 중복·일정 충돌 검사
5. before/after preview
6. 사용자 승인
7. approval token과 before hash 검증
8. Notion create/update를 idempotency key로 실행
9. target 재조회 후 실제 결과 표시

## 11. 승인·권한·감사

approval에는 approval_id, user_id, project_id, target_id, before_hash, after_hash, expires_at, status를 저장한다.

- 기본 승인 만료 10분
- 승인 시 target 재조회
- before_hash가 달라지면 실행 중단 후 새 preview
- approval token은 1회 사용
- 동일 idempotency key는 같은 결과 반환
- 성공 후 target 재조회 필수
- 실패·취소·충돌도 audit 기록

역할은 reader, editor, admin이다. 기존 Discord 길드 멤버는 기본 reader이며, Discord 역할명을 자동으로 Notion write 권한으로 승격하지 않는다.

## 12. 이미지 생성

1. 웹 요청
2. RAG에서 문서·회의·Discord·아트 resource 검색
3. Solar가 근거 기반 prompt와 negative prompt 생성
4. prompt·근거·style·설정·예상 비용 preview
5. 사용자가 생성 버튼 클릭
6. 최신 source와 ACL 재확인
7. OpenAI Image API로 gpt-image-2.5-flare 호출
8. private storage 저장
9. 이미지와 prompt·근거·model·quality·size·cost·created_by 표시

기본 환경:

- OPENAI_IMAGE_MODEL=gpt-image-2.5-flare
- OPENAI_IMAGE_QUALITY=auto
- OPENAI_IMAGE_SIZE=auto
- OPENAI_IMAGE_OUTPUT_FORMAT=png
- IMAGE_GENERATION_ENABLED=false

provider가 꺼져 있으면 prompt-only로 반환하고 생성 완료로 표시하지 않는다. reference image를 provider에 보낼 때 source ACL과 signed fetch를 다시 확인한다. 사용자·프로젝트별 일일 quota, 동시 job 제한, 429/5xx 재시도, 중복 생성 방지, moderation, 비용 기록을 구현한다.

## 13. API

기존 knowledge API는 유지하고 웹 facade를 api/assistant 아래에 추가한다.

대화:

- POST api/assistant/conversations
- GET api/assistant/conversations
- GET api/assistant/conversations/:id
- DELETE api/assistant/conversations/:id
- POST api/assistant/conversations/:id/messages
- GET api/assistant/runs/:id
- GET api/assistant/runs/:id/stream
- POST api/assistant/runs/:id/cancel

승인·action:

- GET api/assistant/approvals
- POST api/assistant/approvals/:id/approve
- POST api/assistant/approvals/:id/reject
- GET api/assistant/actions
- GET api/assistant/actions/:id

파일·일정·이미지:

- POST api/assistant/files/init
- POST api/assistant/files/:id/complete
- GET api/assistant/files/:id
- POST api/assistant/files/:id/ingest
- POST api/assistant/files/:id/delete-preview
- GET api/assistant/schedule
- POST api/assistant/schedule/preview
- POST api/assistant/tasks/preview
- POST api/assistant/images/preview
- POST api/assistant/images/generate
- GET api/assistant/images/:id

POST messages는 run_id를 먼저 반환하고 답변·tool plan·approval·근거·결과를 SSE로 보낸다. 실제 mutation은 approval 또는 명시적 image generate action을 거친다.

## 14. 데이터 모델

- assistant_conversations: project, owner, title, archived, timestamps
- assistant_messages: role, content, attachments, citations, tool refs
- assistant_runs: phase, status, model, corpus generation, timestamps, error
- assistant_run_events: ordered SSE event, sequence, payload hash
- assistant_tool_calls: run, tool, input schema hash, redacted input, status, result, idempotency
- assistant_approvals: user, target, before/after hash, expiry, status
- assistant_audit: actor, connector, target, action, before/after hash, status, error
- knowledge_uploads: project, owner, filename, MIME, bytes, sha256, storage key, ACL
- knowledge_upload_versions: extractor version, source revision, state
- image_jobs/results: provider, model, prompt/evidence hash, approval, cost, storage metadata

외부 target에는 URL만 저장하지 않고 connector kind, stable ID, source revision, fetched hash를 저장한다.

## 15. 보안

- 웹 mutation은 same-origin, CSRF, session, project ACL 검사
- SSE 매 tick ownership 검증
- LLM에 Notion, OpenAI, Discord secret 전달 금지
- prompt injection은 source data로 취급하고 tool policy를 override하지 못함
- 파일 MIME, 확장자, 압축 폭탄, 실행 파일, path traversal 차단
- 외부 URL은 allowlist 또는 object storage만 fetch
- Notion update는 target 재조회와 before hash 필요
- mutation은 idempotency key와 audit 필수
- 삭제·접근 회수 source의 citation·저장 답변 재검증/마스킹
- 이미지 private storage 기본값

## 16. 개발 단계

### Phase 0: RAG 기반 안전성

기존 RAG 점검표 RAG-001~016의 ACL, version, coverage, Discord 수집, Compose, DB integration 문제를 해결한다.

### Phase 1: 웹 read-only assistant

conversation/message/run, SSE, source coverage UI, Notion 일정·작업 조회 도구를 만든다.

### Phase 2: 파일과 RAG

private upload storage, PDF/DOCX/TXT/Markdown/CSV/image extractor, ingestion UI, file ACL과 tombstone을 만든다.

### Phase 3: Notion approval mutation

tool registry, diff preview, approval token, 일정·작업·page create/update, conflict·재조회·audit을 만든다.

### Phase 4: 이미지

OpenAI adapter, gpt-image-2.5-flare, prompt/evidence preview, explicit generate, storage/gallery/cost/quota를 만든다.

### Phase 5: 운영 품질

retrieval gold set, tool eval, approval race test, freshness SLO, backup/restore/deletion exercise, 실제 credentials와 Discord Message Content Intent 검증을 한다.

## 17. 테스트와 인수 기준

단위: 날짜 KST 변환, Notion 속성 변환, approval 만료·재사용·사용자 불일치, idempotency, image payload, file 검사.

통합: reader/editor/admin ACL, preview의 외부 변경 금지, 승인 전 row 불변, 승인 후 재조회 일치, 충돌, upload→extract→index→search, 삭제 source 차단, Discord failure PARTIAL, OpenAI 재시도와 중복 방지.

브라우저: 새 대화·후속 질문, 파일 ingestion 상태, 일정 필터, Notion 승인·거부, 충돌 preview, 이미지 생성·gallery, 새로고침 후 run/approval 복구.

인수 기준:

- 웹이 질문·파일·이미지·일정·Notion의 유일한 실행 창구다.
- Discord 봇이 tool registry를 호출하지 않는다.
- source별 최신성·권한·근거가 답변에 표시된다.
- preview 없는 Notion 직접 실행이 불가능하다.
- 실제 일정 schema에 맞춰 생성·수정된다.
- 작업 변경은 일정 DB와 분리된다.
- READY 전 파일이 검색·이미지 근거에 사용되지 않는다.
- gpt-image-2.5-flare는 명시적 생성 action과 quota를 통과한다.
- 이미지 결과·prompt·근거·model·cost·사용자를 재조회할 수 있다.
- 삭제·접근 회수 후 기존 citation이 노출되지 않는다.
- 기존 회의 녹음·전사·Discord 수집 회귀가 없다.

## 18. 환경 변수

    ASSISTANT_ENABLED=false
    ASSISTANT_APPROVAL_TTL_MS=600000
    ASSISTANT_SSE_HEARTBEAT_MS=15000
    NOTION_TOKEN=
    NOTION_SCHEDULE_DATABASE_ID=3d4ec741-b304-80bb-9176-c2f7084f0edc
    NOTION_SCHEDULE_DATA_SOURCE_URL=collection://3d4ec741-b304-80e5-8b38-000b4d9db22b
    NOTION_TASK_DATA_SOURCE_URL=collection://3d1ec741-b304-8086-ba3f-000bf2f7d110
    OPENAI_API_KEY=
    OPENAI_IMAGE_MODEL=gpt-image-2.5-flare
    OPENAI_IMAGE_QUALITY=auto
    OPENAI_IMAGE_SIZE=auto
    OPENAI_IMAGE_OUTPUT_FORMAT=png
    IMAGE_GENERATION_ENABLED=false
    KNOWLEDGE_UPLOAD_MAX_BYTES=52428800
    KNOWLEDGE_UPLOAD_PROJECT_QUOTA_BYTES=5368709120

실제 secret은 Git에 저장하지 않는다. 구현 전 UI와 API는 기능이 꺼진 상태를 성공처럼 숨기지 않는다.
