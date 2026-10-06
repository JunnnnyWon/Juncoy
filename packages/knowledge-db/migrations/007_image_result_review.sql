ALTER TABLE image_results
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_role text,
  ADD COLUMN IF NOT EXISTS review_note text;
CREATE INDEX IF NOT EXISTS image_results_review_status ON image_results(review_status);
