-- Each analysis attempt is immutable; approved rows must not be overwritten.
ALTER TABLE art_board_analyses DROP CONSTRAINT art_board_analyses_board_id_revision_key;
ALTER TABLE art_board_analyses ADD COLUMN approved_style_version integer;
CREATE INDEX art_board_analyses_latest ON art_board_analyses(board_id, revision, created_at DESC);
