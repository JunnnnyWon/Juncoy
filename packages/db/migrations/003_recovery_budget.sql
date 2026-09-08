CREATE TABLE recovery_applications (job_key text PRIMARY KEY, meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, transcript_version integer NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX budget_alert_once ON audit_events(guild_id,kind,(data->>'month')) WHERE kind IN ('BUDGET_80','BUDGET_100');
