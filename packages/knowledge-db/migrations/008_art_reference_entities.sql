CREATE TABLE art_reference_assets (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL REFERENCES knowledge_uploads(id) ON DELETE CASCADE,
  source_label text NOT NULL DEFAULT '',
  rights_note text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'READY',
  canonical_state text NOT NULL DEFAULT 'NONE',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, upload_id)
);
CREATE TABLE art_extractions (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES art_reference_assets(id) ON DELETE CASCADE,
  asset_revision text NOT NULL,
  extractor_version text NOT NULL,
  observations jsonb NOT NULL DEFAULT '{}',
  ocr jsonb NOT NULL DEFAULT '{}',
  machine_confidence text,
  human_corrections jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  approved_at timestamptz
);
CREATE TABLE style_profile_rules (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  style_version integer NOT NULL,
  category text NOT NULL,
  statement text NOT NULL,
  strength text NOT NULL DEFAULT 'SUGGESTION',
  provenance jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'DRAFT',
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE image_job_references (
  id uuid PRIMARY KEY,
  image_job_id uuid NOT NULL REFERENCES image_jobs(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES art_reference_assets(id) ON DELETE SET NULL,
  upload_id uuid REFERENCES knowledge_uploads(id) ON DELETE SET NULL,
  role_json jsonb NOT NULL DEFAULT '{}',
  usage_strength text NOT NULL,
  instruction text NOT NULL DEFAULT '',
  content_hash text NOT NULL,
  acl_snapshot jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX image_job_references_job ON image_job_references(image_job_id);
