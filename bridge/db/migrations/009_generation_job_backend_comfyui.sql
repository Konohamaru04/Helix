PRAGMA foreign_keys = OFF;

CREATE TABLE generation_artifacts_backup AS
SELECT
  id,
  job_id,
  kind,
  file_path,
  preview_path,
  mime_type,
  width,
  height,
  created_at
FROM generation_artifacts;

CREATE TABLE generation_reference_images_backup AS
SELECT
  id,
  job_id,
  file_name,
  file_path,
  mime_type,
  size_bytes,
  extracted_text,
  created_at,
  sort_order
FROM generation_reference_images;

CREATE TABLE generation_jobs_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations (id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  prompt TEXT NOT NULL,
  negative_prompt TEXT,
  model TEXT NOT NULL,
  backend TEXT NOT NULL CHECK (backend IN ('placeholder', 'diffusers', 'comfyui')),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  steps INTEGER NOT NULL,
  guidance_scale REAL NOT NULL,
  seed INTEGER,
  progress REAL NOT NULL DEFAULT 0,
  stage TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  mode TEXT NOT NULL DEFAULT 'text-to-image'
    CHECK (mode IN ('text-to-image', 'image-to-image')),
  workflow_profile TEXT NOT NULL DEFAULT 'default'
    CHECK (workflow_profile IN ('default', 'qwen-image-edit-2511'))
);

INSERT INTO generation_jobs_new (
  id,
  workspace_id,
  conversation_id,
  kind,
  status,
  prompt,
  negative_prompt,
  model,
  backend,
  width,
  height,
  steps,
  guidance_scale,
  seed,
  progress,
  stage,
  error_message,
  created_at,
  updated_at,
  started_at,
  completed_at,
  mode,
  workflow_profile
)
SELECT
  id,
  workspace_id,
  conversation_id,
  kind,
  status,
  prompt,
  negative_prompt,
  model,
  backend,
  width,
  height,
  steps,
  guidance_scale,
  seed,
  progress,
  stage,
  error_message,
  created_at,
  updated_at,
  started_at,
  completed_at,
  mode,
  workflow_profile
FROM generation_jobs;

DROP TABLE generation_artifacts;
DROP TABLE generation_reference_images;
DROP TABLE generation_jobs;

ALTER TABLE generation_jobs_new RENAME TO generation_jobs;

CREATE TABLE generation_artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image')),
  file_path TEXT NOT NULL,
  preview_path TEXT,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);

INSERT INTO generation_artifacts (
  id,
  job_id,
  kind,
  file_path,
  preview_path,
  mime_type,
  width,
  height,
  created_at
)
SELECT
  id,
  job_id,
  kind,
  file_path,
  preview_path,
  mime_type,
  width,
  height,
  created_at
FROM generation_artifacts_backup;

CREATE TABLE generation_reference_images (
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

INSERT INTO generation_reference_images (
  id,
  job_id,
  file_name,
  file_path,
  mime_type,
  size_bytes,
  extracted_text,
  created_at,
  sort_order
)
SELECT
  id,
  job_id,
  file_name,
  file_path,
  mime_type,
  size_bytes,
  extracted_text,
  created_at,
  sort_order
FROM generation_reference_images_backup;

DROP TABLE generation_artifacts_backup;
DROP TABLE generation_reference_images_backup;

CREATE INDEX idx_generation_jobs_workspace_updated
  ON generation_jobs (workspace_id, updated_at DESC);

CREATE INDEX idx_generation_jobs_conversation_updated
  ON generation_jobs (conversation_id, updated_at DESC);

CREATE INDEX idx_generation_jobs_status_updated
  ON generation_jobs (status, updated_at DESC);

CREATE INDEX idx_generation_artifacts_job_created
  ON generation_artifacts (job_id, created_at ASC);

CREATE INDEX idx_generation_reference_images_job_order
  ON generation_reference_images (job_id, sort_order ASC, created_at ASC);

PRAGMA foreign_keys = ON;
