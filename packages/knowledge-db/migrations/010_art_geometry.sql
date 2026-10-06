CREATE TABLE art_board_nodes (
  board_id uuid NOT NULL,
  revision integer NOT NULL,
  id text NOT NULL,
  node_type text NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  width double precision NOT NULL CHECK (width > 0),
  height double precision NOT NULL CHECK (height > 0),
  data jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (board_id, revision, id),
  FOREIGN KEY (board_id, revision) REFERENCES art_board_revisions(board_id, revision) ON DELETE CASCADE
);
CREATE TABLE art_board_edges (
  board_id uuid NOT NULL,
  revision integer NOT NULL,
  id text NOT NULL,
  source_node_id text NOT NULL,
  target_node_id text NOT NULL,
  edge_type text NOT NULL,
  PRIMARY KEY (board_id, revision, id),
  UNIQUE (board_id, revision, source_node_id, target_node_id, edge_type),
  CHECK (source_node_id <> target_node_id),
  FOREIGN KEY (board_id, revision, source_node_id) REFERENCES art_board_nodes(board_id, revision, id) ON DELETE CASCADE,
  FOREIGN KEY (board_id, revision, target_node_id) REFERENCES art_board_nodes(board_id, revision, id) ON DELETE CASCADE
);
