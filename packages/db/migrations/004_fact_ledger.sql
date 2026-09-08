CREATE TABLE summary_runs (
  id uuid PRIMARY KEY, meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  transcript_version integer NOT NULL, run_key text NOT NULL UNIQUE, input_hash text NOT NULL,
  model text NOT NULL, prompt_hash text NOT NULL, observed_model text,
  status text NOT NULL CHECK(status IN ('RUNNING','VERIFIED','REJECTED')),
  owner_job_id uuid NOT NULL, owner_generation integer NOT NULL,
  output_hash text, result jsonb, report jsonb, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX summary_runs_meeting ON summary_runs(meeting_id,transcript_version);
CREATE TABLE summary_stages (
  run_id uuid NOT NULL REFERENCES summary_runs(id) ON DELETE CASCADE, stage_key text NOT NULL,
  input_hash text NOT NULL, status text NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  output jsonb, model text, error_code text, terminal boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,stage_key)
);
CREATE TABLE summary_stage_attempts (
  run_id uuid NOT NULL, stage_key text NOT NULL, attempt integer NOT NULL,
  job_id uuid NOT NULL, generation integer NOT NULL, status text NOT NULL,
  error_code text, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  PRIMARY KEY(run_id,stage_key,attempt),
  FOREIGN KEY(run_id,stage_key) REFERENCES summary_stages(run_id,stage_key) ON DELETE CASCADE
);
CREATE TABLE summary_facts (
  run_id uuid NOT NULL REFERENCES summary_runs(id) ON DELETE CASCADE, fact_id uuid NOT NULL,
  body jsonb NOT NULL, disposition jsonb NOT NULL, PRIMARY KEY(run_id,fact_id)
);
ALTER TABLE summaries ADD COLUMN input_hash text NOT NULL DEFAULT '';
ALTER TABLE summaries ADD COLUMN verification_run_id uuid REFERENCES summary_runs(id) ON DELETE SET NULL;
ALTER TABLE summaries DROP CONSTRAINT IF EXISTS summaries_meeting_id_transcript_version_prompt_hash_model_key;
CREATE UNIQUE INDEX summaries_input_unique ON summaries(meeting_id,transcript_version,prompt_hash,model,input_hash);
CREATE UNIQUE INDEX summaries_verified_run_unique ON summaries(verification_run_id) WHERE verification_run_id IS NOT NULL;
