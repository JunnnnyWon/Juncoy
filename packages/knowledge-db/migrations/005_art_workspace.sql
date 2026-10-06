CREATE TABLE art_boards (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'DRAFT',
  current_revision integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX art_boards_project ON art_boards(project_id, archived_at, updated_at DESC);

CREATE TABLE art_board_revisions (
  id uuid PRIMARY KEY,
  board_id uuid NOT NULL REFERENCES art_boards(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  created_by text NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}',
  snapshot_hash text NOT NULL,
  analysis_state text NOT NULL DEFAULT 'NONE',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(board_id, revision)
);

CREATE TABLE art_board_assets (
  board_id uuid NOT NULL REFERENCES art_boards(id) ON DELETE CASCADE,
  asset_key text NOT NULL,
  source_upload_id uuid,
  role text NOT NULL,
  usage_strength text NOT NULL,
  note text NOT NULL DEFAULT '',
  selected boolean NOT NULL DEFAULT false,
  source_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(board_id, asset_key)
);
CREATE INDEX art_board_revisions_board ON art_board_revisions(board_id, revision DESC);
