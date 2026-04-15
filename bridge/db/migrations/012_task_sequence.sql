ALTER TABLE capability_tasks ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_capability_tasks_sequence
  ON capability_tasks (sequence ASC);
