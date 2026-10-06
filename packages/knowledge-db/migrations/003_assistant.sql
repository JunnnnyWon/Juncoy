-- 웹 프로젝트 어시스턴트 데이터 모델 — docs/WEB_PROJECT_ASSISTANT_DEVELOPMENT_SPEC.md §14.
-- knowledge DB에 추가한다 (회의 DB 불변).

-- 대화/메시지/run
CREATE TABLE assistant_conversations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  title text NOT NULL DEFAULT '새 대화',
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_conversations_owner ON assistant_conversations(project_id, owner_id, archived, updated_at DESC);

CREATE TABLE assistant_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  run_id uuid, -- FK는 runs 생성 후 추가
  role text NOT NULL, -- user | assistant | tool | system
  content text NOT NULL DEFAULT '',
  attachments jsonb NOT NULL DEFAULT '[]',
  citations jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_messages_conv ON assistant_messages(conversation_id, created_at);

CREATE TABLE assistant_runs (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES assistant_messages(id) ON DELETE SET NULL,
  mode text NOT NULL, -- answer | search | propose | mutate | generate | ingest
  phase text NOT NULL DEFAULT 'idle', -- §7 상태 열거
  status text, -- COMPLETE | PARTIAL | NEEDS_CLARIFICATION | FAILED (종료 시)
  model text,
  corpus_generation text,
  error text,
  cancelled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_runs_conv ON assistant_runs(conversation_id, created_at DESC);
ALTER TABLE assistant_messages
  ADD CONSTRAINT assistant_messages_run_fk FOREIGN KEY (run_id) REFERENCES assistant_runs(id) ON DELETE SET NULL;

-- SSE 이벤트 — 대화 내 seq 단조 증가, payload_hash로 재검증.
CREATE TABLE assistant_run_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES assistant_runs(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  kind text NOT NULL, -- phase | evidence | coverage | tool_call | approval | result | error | heartbeat
  payload jsonb NOT NULL DEFAULT '{}',
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);
CREATE INDEX assistant_run_events_run ON assistant_run_events(run_id, seq);

-- 도구 호출 — 입력은 schema hash + redacted input만 (secret/URL 원문 금지).
CREATE TABLE assistant_tool_calls (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES assistant_runs(id) ON DELETE CASCADE,
  tool text NOT NULL,
  input_schema_hash text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PENDING', -- PENDING | RUNNING | DONE | FAILED | CANCELLED
  result jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX assistant_tool_calls_idem
  ON assistant_tool_calls(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 승인 — before_hash 재조회 비교, 만료/1회성.
CREATE TABLE assistant_approvals (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  conversation_id uuid REFERENCES assistant_conversations(id) ON DELETE SET NULL,
  run_id uuid REFERENCES assistant_runs(id) ON DELETE SET NULL,
  kind text NOT NULL, -- notion_page | notion_schedule | notion_task | file_delete | image_generate
  target jsonb NOT NULL, -- { connector, stable_id, revision, fetched_hash } — URL만 저장 금지
  before_hash text,
  after jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PENDING', -- PENDING | APPROVED | REJECTED | EXPIRED | CONSUMED | CANCELLED | CONFLICT
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX assistant_approvals_user ON assistant_approvals(project_id, user_id, status);

-- 외부 변경 감사 — actor/connector/target/action/before-after hash/결과만 (원문 금지).
CREATE TABLE assistant_audit (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  actor text NOT NULL,
  connector text NOT NULL, -- notion | file | image | github
  target jsonb NOT NULL,
  action text NOT NULL,
  before_hash text,
  after_hash text,
  status text NOT NULL, -- DONE | FAILED | CONFLICT | CANCELLED
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_audit_project ON assistant_audit(project_id, created_at DESC);

-- 파일 업로드 (§9) — private storage key만, 원본은 object storage.
CREATE TABLE knowledge_uploads (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  state text NOT NULL DEFAULT 'UPLOADED', -- UPLOADED | EXTRACTING | INDEXING | READY | FAILED
  error text,
  document_id uuid, -- ingest 완료 후 documents.id
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX knowledge_uploads_sha ON knowledge_uploads(project_id, sha256);
CREATE INDEX knowledge_uploads_state ON knowledge_uploads(project_id, state);

CREATE TABLE knowledge_upload_versions (
  id uuid PRIMARY KEY,
  upload_id uuid NOT NULL REFERENCES knowledge_uploads(id) ON DELETE CASCADE,
  extractor_version text NOT NULL,
  source_revision text NOT NULL,
  state text NOT NULL, -- extract/index 상태 추적
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 이미지 (§12) — prompt/evidence hash + 비용.
-- image_jobs/image_results는 001에서 이미 생성됨 — 어시스턴트 경로가 요구하는
-- 컬럼만 추가한다 (approval 연결/idempotency/prompt_hash/결과 치수·비용).
ALTER TABLE image_jobs
  ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS approval_id uuid REFERENCES assistant_approvals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'PENDING', -- PENDING|RUNNING|DONE|FAILED|REJECTED|CANCELLED
  ADD COLUMN IF NOT EXISTS negative_prompt text,
  ADD COLUMN IF NOT EXISTS prompt_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS error text,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz,
  ALTER COLUMN prompt TYPE text USING prompt::text,
  ALTER COLUMN model SET NOT NULL;
ALTER TABLE image_jobs ALTER COLUMN created_by DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS image_jobs_idem ON image_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE image_results
  ADD COLUMN IF NOT EXISTS bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS width int,
  ADD COLUMN IF NOT EXISTS height int,
  ADD COLUMN IF NOT EXISTS cost_usd numeric(10,4);
