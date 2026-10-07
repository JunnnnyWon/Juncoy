CREATE TABLE document_parse_cache (
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL REFERENCES knowledge_uploads(id) ON DELETE CASCADE,
  source_sha256 text NOT NULL,
  parser_profile text NOT NULL,
  options_hash text NOT NULL,
  owner uuid,
  lease_until timestamptz,
  result jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, upload_id, source_sha256, parser_profile, options_hash)
);
