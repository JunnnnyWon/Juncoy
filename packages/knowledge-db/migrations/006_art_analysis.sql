CREATE TABLE art_board_analyses (
  id uuid PRIMARY KEY,
  board_id uuid NOT NULL REFERENCES art_boards(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  model text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}',
  result_hash text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(board_id, revision)
);
CREATE INDEX art_board_analyses_board ON art_board_analyses(board_id, revision DESC);
