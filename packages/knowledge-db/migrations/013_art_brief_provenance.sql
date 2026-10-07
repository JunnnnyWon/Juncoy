ALTER TABLE knowledge_upload_versions
  ADD COLUMN IF NOT EXISTS parser_profile text,
  ADD COLUMN IF NOT EXISTS options_hash text;
ALTER TABLE knowledge_uploads
  ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
ALTER TABLE image_jobs
  ADD COLUMN IF NOT EXISTS brief_hash text,
  ADD COLUMN IF NOT EXISTS board_id uuid REFERENCES art_boards(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS board_revision integer,
  ADD COLUMN IF NOT EXISTS art_bible_version integer,
  ADD COLUMN IF NOT EXISTS provider_request_id text,
  ADD COLUMN IF NOT EXISTS cost_status text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS execution_token uuid,
  ADD COLUMN IF NOT EXISTS execution_started_at timestamptz;
ALTER TABLE image_results
  ADD COLUMN IF NOT EXISTS mime text NOT NULL DEFAULT 'image/png',
  ADD COLUMN IF NOT EXISTS sha256 text,
  ADD COLUMN IF NOT EXISTS cost_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE image_job_references
  ADD COLUMN IF NOT EXISTS asset_revision text,
  ADD COLUMN IF NOT EXISTS source_sha256 text,
  ADD COLUMN IF NOT EXISTS crop jsonb;

CREATE TABLE IF NOT EXISTS art_board_shares (
  board_id uuid NOT NULL REFERENCES art_boards(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('reader', 'editor')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX IF NOT EXISTS art_board_shares_user ON art_board_shares(user_id, board_id);
CREATE INDEX IF NOT EXISTS image_jobs_brief ON image_jobs(project_id, brief_hash);
CREATE UNIQUE INDEX IF NOT EXISTS image_results_job_unique ON image_results(job_id);
ALTER TABLE art_board_assets
  ADD COLUMN IF NOT EXISTS roles jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS role_usage jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS crop jsonb,
  ADD COLUMN IF NOT EXISTS group_id text;
