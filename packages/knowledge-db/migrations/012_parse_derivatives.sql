ALTER TABLE knowledge_uploads ADD COLUMN original_verified_at timestamptz;
ALTER TABLE knowledge_upload_versions ADD COLUMN cache_hit boolean NOT NULL DEFAULT false;
ALTER TABLE knowledge_projects ADD COLUMN external_processing_allowed boolean NOT NULL DEFAULT true;
CREATE TABLE document_parse_derived_assets (
  id uuid PRIMARY KEY,
  upload_version_id uuid NOT NULL REFERENCES knowledge_upload_versions(id) ON DELETE CASCADE,
  page_number integer NOT NULL,
  block_id text,
  storage_key text NOT NULL,
  mime text NOT NULL,
  bytes bigint NOT NULL CHECK(bytes > 0),
  sha256 text NOT NULL,
  source_sha256 text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('page_preview','figure')),
  bbox jsonb,
  origin text NOT NULL DEFAULT 'local_pdf_render',
  created_at timestamptz NOT NULL DEFAULT now()
);
