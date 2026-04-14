CREATE TABLE IF NOT EXISTS generation_jobs (
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
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_workspace_updated
  ON generation_jobs (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_conversation_updated
  ON generation_jobs (conversation_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_status_updated
  ON generation_jobs (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS generation_artifacts (
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

CREATE INDEX IF NOT EXISTS idx_generation_artifacts_job_created
  ON generation_artifacts (job_id, created_at ASC);
