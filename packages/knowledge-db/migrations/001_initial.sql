-- Knowledge store schema — docs/RAG_DEVELOPMENT_SPEC.md §8~§10.
-- 회의 DB와 분리된 전용 데이터베이스에 적용한다. pgvector + pg_trgm 필요.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 프로젝트/공유 정책 ──────────────────────────────────────────────
CREATE TABLE knowledge_projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE project_memberships (
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  user_id text NOT NULL, -- Discord snowflake 문자열
  role text NOT NULL DEFAULT 'reader', -- reader | admin
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- ── 원본/스코프/이벤트 ──────────────────────────────────────────────
CREATE TABLE knowledge_sources (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  kind text NOT NULL, -- notion | github | discord | meeting
  auth_ref text NOT NULL, -- 시크릿 "이름" 참조. 값을 저장하지 않는다.
  acl_epoch bigint NOT NULL DEFAULT 0, -- source ACL 변경 시 증가 (§10)
  status text NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | ACCESS_LOST | DISABLED
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind, auth_ref)
);
CREATE TABLE source_scopes (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  scope_key text NOT NULL, -- e.g. 'channel:1547...', 'ref:main', 'root:<page_id>'
  metadata jsonb NOT NULL DEFAULT '{}',
  allowed boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, scope_key)
);
CREATE TABLE source_events (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  event_key text NOT NULL, -- provider delivery/event ID 또는 내부 key
  kind text NOT NULL,
  body jsonb NOT NULL,
  status text NOT NULL DEFAULT 'RECEIVED', -- RECEIVED | PROCESSED | FAILED | IGNORED
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (source_id, event_key) -- §8.1 event dedupe
);

-- ── 작업 큐 (지식 전용 — 회의 jobs와 분리) ──────────────────────────
CREATE TABLE knowledge_jobs (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE,
  kind text NOT NULL, -- fetch | extract | index | refresh | delete
  document_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PENDING', -- PENDING | RUNNING | DONE | RETRYABLE | DEAD_LETTER
  attempts integer NOT NULL DEFAULT 0,
  generation integer NOT NULL DEFAULT 0, -- lease fencing
  owner text,
  lease_until timestamptz,
  due_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_jobs_due ON knowledge_jobs(due_at) WHERE status IN ('PENDING','RETRYABLE');

-- ── 커넥터 커서/대조 ────────────────────────────────────────────────
CREATE TABLE connector_cursors (
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  cursor jsonb NOT NULL DEFAULT '{}', -- snowflake/ref/event_seq 등 원본별 위치
  covered_until timestamptz,
  last_reconciled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, scope_key)
);
CREATE TABLE sync_checks (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  kind text NOT NULL, -- head | incremental | structure | full
  checked_at timestamptz NOT NULL DEFAULT now(),
  result jsonb NOT NULL DEFAULT '{}'
);

-- ── 문서/버전/첨부 ──────────────────────────────────────────────────
CREATE TABLE documents (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  stable_key text NOT NULL, -- §9.1 영구 key (notion:<ws>:<page> 등)
  state text NOT NULL DEFAULT 'RECEIVED',
  current_version_id uuid,
  acl jsonb NOT NULL DEFAULT '{}', -- scope/role 조건
  acl_epoch bigint NOT NULL DEFAULT 0,
  dirty boolean NOT NULL DEFAULT true, -- 변경 인지 후 최신화 완료 전까지 true (§8.1)
  deleted boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, stable_key)
);
CREATE INDEX documents_state ON documents(state, dirty) WHERE NOT deleted;

CREATE TABLE document_versions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  extractor_version integer NOT NULL DEFAULT 1,
  source_revision text, -- blob SHA, transcript_version, edited_timestamp 등
  source_occurred_at timestamptz,
  source_modified_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  normalized jsonb NOT NULL DEFAULT '{}', -- text + typed attrs
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, content_hash, extractor_version) -- §10 멱등
);
ALTER TABLE documents ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id);

CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  stable_key text NOT NULL,
  sha256 text,
  storage_key text,
  mime text,
  bytes bigint,
  extract_state text NOT NULL DEFAULT 'PENDING', -- PENDING | METADATA_ONLY | EXTRACTED | OVERSIZE | UNSUPPORTED | FAILED
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, stable_key)
);

-- ── 청크/임베딩 ─────────────────────────────────────────────────────
CREATE TABLE chunk_sets (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  extractor_version integer NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- active chunk_set 전환은 한 트랜잭션이며 문서당 정확히 하나만 active (§8.1)
CREATE UNIQUE INDEX chunk_sets_one_active ON chunk_sets(document_id) WHERE active;

CREATE TABLE chunks (
  id uuid PRIMARY KEY,
  chunk_set_id uuid NOT NULL REFERENCES chunk_sets(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  content text NOT NULL,
  token_count integer,
  span jsonb NOT NULL DEFAULT '{}', -- message ids / line range / segment ids·ms
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (chunk_set_id, ordinal)
);
CREATE INDEX chunks_trgm ON chunks USING gin (content gin_trgm_ops);

CREATE TABLE embedding_profiles (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  query_model text NOT NULL,
  document_model text NOT NULL,
  dimensions integer NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 구/신 모델 vector를 섞어 검색하지 않는다 — provider당 활성 profile 하나 (§10)
CREATE UNIQUE INDEX embedding_profiles_one_active ON embedding_profiles(provider) WHERE active;

CREATE TABLE chunk_embeddings (
  chunk_id uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES embedding_profiles(id) ON DELETE CASCADE,
  embedding vector(4096) NOT NULL, -- Upstage embedding-* 실측 4096 (C05)
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, profile_id)
);

-- ── 관계/중복 매핑 ──────────────────────────────────────────────────
CREATE TABLE source_relations (
  id uuid PRIMARY KEY,
  src_document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  dst_document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind text NOT NULL, -- notion_relation | discord_reply | github_pr_commit | meeting_minutes ...
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (src_document_id, dst_document_id, kind)
);
CREATE TABLE meeting_mappings (
  id uuid PRIMARY KEY,
  meeting_a text NOT NULL,
  meeting_b text NOT NULL,
  confidence numeric,
  evidence jsonb NOT NULL DEFAULT '{}',
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── claim 그래프 ────────────────────────────────────────────────────
CREATE TABLE claims (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  text text NOT NULL,
  state text NOT NULL DEFAULT 'UNKNOWN',
  supersedes_id uuid REFERENCES claims(id),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE claim_evidence (
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id uuid REFERENCES chunks(id) ON DELETE SET NULL,
  quote text NOT NULL DEFAULT '',
  span jsonb NOT NULL DEFAULT '{}',
  valid_from timestamptz,
  valid_to timestamptz,
  PRIMARY KEY (claim_id, document_id)
);
CREATE TABLE claim_relations (
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  other_claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  kind text NOT NULL, -- SUPERSEDES | CONFLICTS | SUPPORTS
  PRIMARY KEY (claim_id, other_claim_id, kind)
);

-- ── 답변 실행 ───────────────────────────────────────────────────────
CREATE TABLE answer_runs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  question text NOT NULL,
  temporal_mode text NOT NULL DEFAULT 'current',
  as_of timestamptz,
  status text NOT NULL DEFAULT 'PENDING',
  phase text NOT NULL DEFAULT 'checking_sources',
  body jsonb, -- Answer DTO (검증 완료 후에만 기록)
  model text,
  usage jsonb NOT NULL DEFAULT '{}',
  corpus_generation text,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE answer_evidence (
  answer_run_id uuid NOT NULL REFERENCES answer_runs(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  version_id uuid REFERENCES document_versions(id) ON DELETE SET NULL,
  source text NOT NULL,
  url text NOT NULL DEFAULT '',
  quote text NOT NULL DEFAULT '',
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (answer_run_id, url, quote)
);

-- ── 이미지 스타일/생성 ──────────────────────────────────────────────
CREATE TABLE style_profiles (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  version integer NOT NULL,
  body jsonb NOT NULL DEFAULT '{}',
  approved_by text, -- 사람 승인만 유효 (§15.2)
  approved_at timestamptz,
  epoch bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);
CREATE TABLE image_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  prompt jsonb NOT NULL,
  style_version integer,
  evidence jsonb NOT NULL DEFAULT '[]',
  state text NOT NULL DEFAULT 'DRAFT', -- DRAFT | REVIEWED | GENERATING | DONE | FAILED
  provider text,
  model text,
  config jsonb NOT NULL DEFAULT '{}',
  cost jsonb NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE image_results (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES image_jobs(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── 삭제/감사 ───────────────────────────────────────────────────────
-- 삭제/권한 회수는 authoritative tombstone. 늦은 create/update가 원문 확인 없이
-- 복원할 수 없고, audit에는 ID/hash/시각/이유만 남긴다 (§8.1~§8.2).
CREATE TABLE deletion_tombstones (
  stable_key text PRIMARY KEY,
  source_id uuid REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  document_id uuid,
  reason text NOT NULL,
  content_hash text,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  cleaned_at timestamptz
);
CREATE TABLE knowledge_audit (
  id uuid PRIMARY KEY,
  project_id uuid,
  actor text,
  kind text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}', -- 원문 텍스트 보존 금지 — ID/hash/시각/이유만
  created_at timestamptz NOT NULL DEFAULT now()
);
