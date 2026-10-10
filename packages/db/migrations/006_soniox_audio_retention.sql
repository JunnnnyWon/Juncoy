-- Opt-in conversion is done by the full migration deployment, not normal API CI.
ALTER TABLE meetings ADD COLUMN stt_provider text NOT NULL DEFAULT 'returnzero', ADD COLUMN transcription_mode text NOT NULL DEFAULT 'realtime';
CREATE TABLE stt_provider_jobs (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  file_id text,
  transcription_id text,
  submitted_audio_ms bigint NOT NULL DEFAULT 0,
  source_time_map jsonb NOT NULL DEFAULT '[]',
  cleanup_status text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now()
);
