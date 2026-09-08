CREATE TABLE workspace_meetings (
  workspace_guild_id text NOT NULL,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  PRIMARY KEY(workspace_guild_id, meeting_id)
);
INSERT INTO workspace_meetings(workspace_guild_id, meeting_id)
SELECT guild_id,id FROM meetings WHERE deleted_at IS NULL;
INSERT INTO workspace_meetings(workspace_guild_id, meeting_id)
SELECT '1545264536158740590',id FROM meetings
WHERE guild_id='754664613462802452' AND runtime->>'mode'='real'
AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM deletion_tombstones d WHERE d.meeting_id=meetings.id)
ON CONFLICT DO NOTHING;
