-- Change conversations.workspace_id from ON DELETE SET NULL to ON DELETE CASCADE
-- Ensures all conversations and their messages are deleted when a workspace is deleted.
--
-- Triggers that reference `conversations` from other tables must be dropped before
-- the table is dropped — otherwise SQLite leaves the triggers bound to the old
-- table identity and inserts into `messages` fail with `no such table: main.conversations`
-- after the rename.

DROP TRIGGER IF EXISTS trg_messages_ai_fts;
DROP TRIGGER IF EXISTS trg_messages_au_fts;
DROP TRIGGER IF EXISTS trg_messages_ad_fts;
DROP TRIGGER IF EXISTS trg_conversations_au_fts;

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

CREATE TRIGGER IF NOT EXISTS trg_messages_ai_fts
AFTER INSERT ON messages
BEGIN
  INSERT INTO conversation_fts (conversation_id, message_id, title, content)
  SELECT NEW.conversation_id, NEW.id, conversations.title, NEW.content
  FROM conversations
  WHERE conversations.id = NEW.conversation_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_au_fts
AFTER UPDATE OF content ON messages
BEGIN
  UPDATE conversation_fts
  SET content = NEW.content
  WHERE message_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_ad_fts
AFTER DELETE ON messages
BEGIN
  DELETE FROM conversation_fts WHERE message_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_conversations_au_fts
AFTER UPDATE OF title ON conversations
BEGIN
  UPDATE conversation_fts
  SET title = NEW.title
  WHERE conversation_id = NEW.id;
END;
