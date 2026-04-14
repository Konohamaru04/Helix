ALTER TABLE workspaces ADD COLUMN root_path TEXT;

CREATE INDEX IF NOT EXISTS idx_workspaces_root_path
  ON workspaces (root_path);
