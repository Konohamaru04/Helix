ALTER TABLE generation_jobs
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'text-to-image'
  CHECK (mode IN ('text-to-image', 'image-to-image'));

ALTER TABLE generation_jobs
  ADD COLUMN workflow_profile TEXT NOT NULL DEFAULT 'default'
  CHECK (workflow_profile IN ('default', 'qwen-image-edit-2511'));

CREATE TABLE IF NOT EXISTS generation_reference_images (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs (id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_path TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  extracted_text TEXT,
  created_at TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_generation_reference_images_job_order
  ON generation_reference_images (job_id, sort_order ASC, created_at ASC);
