ALTER TABLE knowledge_upload_versions
  ADD COLUMN IF NOT EXISTS parser_kind text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS parser_version text,
  ADD COLUMN IF NOT EXISTS parse_status text NOT NULL DEFAULT 'NOT_REQUESTED',
  ADD COLUMN IF NOT EXISTS parse_request_id text,
  ADD COLUMN IF NOT EXISTS parse_latency_ms integer,
  ADD COLUMN IF NOT EXISTS parse_error_code text,
  ADD COLUMN IF NOT EXISTS source_sha256 text,
  ADD COLUMN IF NOT EXISTS normalized_hash text;

CREATE TABLE document_parse_blocks (
  id uuid PRIMARY KEY,
  upload_version_id uuid NOT NULL REFERENCES knowledge_upload_versions(id) ON DELETE CASCADE,
  block_id text NOT NULL,
  page_number integer,
  ordinal integer NOT NULL,
  block_type text NOT NULL,
  text text NOT NULL DEFAULT '',
  html text,
  metadata jsonb NOT NULL DEFAULT '{}',
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(upload_version_id, block_id)
);

CREATE TABLE document_parse_pages (
  id uuid PRIMARY KEY,
  upload_version_id uuid NOT NULL REFERENCES knowledge_upload_versions(id) ON DELETE CASCADE,
  page_number integer NOT NULL,
  text text NOT NULL DEFAULT '',
  block_ids jsonb NOT NULL DEFAULT '[]',
  page_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(upload_version_id, page_number)
);

CREATE INDEX document_parse_blocks_page ON document_parse_blocks(upload_version_id, page_number, ordinal);
CREATE INDEX document_parse_pages_version ON document_parse_pages(upload_version_id, page_number);
