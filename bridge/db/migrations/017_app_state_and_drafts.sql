CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_drafts (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
