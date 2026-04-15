-- Change conversations.workspace_id from ON DELETE SET NULL to ON DELETE CASCADE
-- Ensures all conversations and their messages are deleted when a workspace is deleted

CREATE TABLE conversations_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO conversations_new (id, workspace_id, title, created_at, updated_at)
SELECT id, workspace_id, title, created_at, updated_at FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
  ON conversations (updated_at DESC);

-- Re-create the title FTS sync trigger (dropped with the old table)
CREATE TRIGGER IF NOT EXISTS trg_conversations_au_fts
AFTER UPDATE OF title ON conversations
BEGIN
  UPDATE conversation_fts
  SET title = NEW.title
  WHERE conversation_id = NEW.id;
END;
