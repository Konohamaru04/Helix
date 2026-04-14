CREATE TABLE IF NOT EXISTS permission_grants (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'workspace', 'session')),
  scope_id TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_grants_scope
  ON permission_grants (capability_id, scope_kind, COALESCE(scope_id, ''));

CREATE TABLE IF NOT EXISTS capability_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled', 'failed')),
  details TEXT,
  output_path TEXT,
  process_id INTEGER,
  parent_task_id TEXT REFERENCES capability_tasks (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_capability_tasks_updated
  ON capability_tasks (updated_at DESC);

CREATE TABLE IF NOT EXISTS scheduled_prompts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once', 'interval')),
  interval_seconds INTEGER,
  run_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_prompts_next_run
  ON scheduled_prompts (enabled, next_run_at);

CREATE TABLE IF NOT EXISTS agent_teams (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'completed', 'stopped', 'failed')),
  system_prompt TEXT,
  team_id TEXT REFERENCES agent_teams (id) ON DELETE SET NULL,
  parent_conversation_id TEXT REFERENCES conversations (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated
  ON agent_sessions (updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_session_created
  ON agent_messages (session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS worktree_sessions (
  id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_worktree_sessions_status
  ON worktree_sessions (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS plan_state (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('inactive', 'active')),
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
