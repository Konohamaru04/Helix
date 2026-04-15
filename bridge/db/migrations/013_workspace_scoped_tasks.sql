-- Add workspace_id to capability_tasks for workspace-scoped tasks
ALTER TABLE capability_tasks ADD COLUMN workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_capability_tasks_workspace
  ON capability_tasks (workspace_id);

-- Add workspace_id to plan_state for workspace-scoped plan mode
ALTER TABLE plan_state ADD COLUMN workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_plan_state_workspace
  ON plan_state (workspace_id);

-- Update the unique constraint on plan_state to be per-workspace
-- First, we need to handle the existing primary key on conversation_id
-- The plan_state table currently has conversation_id as PRIMARY KEY
-- We'll change it to support workspace-based plan state

-- Create a new table with the correct schema
CREATE TABLE plan_state_new (
  conversation_id TEXT REFERENCES conversations (id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('inactive', 'active')),
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, conversation_id)
);

-- Migrate existing data
INSERT INTO plan_state_new (conversation_id, workspace_id, status, summary, created_at, updated_at)
SELECT conversation_id, NULL, status, summary, created_at, updated_at FROM plan_state;

-- Drop old table and rename new one
DROP TABLE plan_state;
ALTER TABLE plan_state_new RENAME TO plan_state;

CREATE INDEX IF NOT EXISTS idx_plan_state_workspace_status
  ON plan_state (workspace_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_plan_state_conversation
  ON plan_state (conversation_id);
