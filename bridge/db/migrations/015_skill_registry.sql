CREATE TABLE IF NOT EXISTS skill_definitions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('builtin', 'user')),
  read_only INTEGER NOT NULL DEFAULT 0,
  origin_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_definitions_source
  ON skill_definitions (source, title);
