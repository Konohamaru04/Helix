CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5 (
  conversation_id UNINDEXED,
  message_id UNINDEXED,
  title,
  content,
  tokenize = 'porter unicode61'
);

INSERT INTO conversation_fts (conversation_id, message_id, title, content)
SELECT
  conversations.id,
  messages.id,
  conversations.title,
  messages.content
FROM messages
JOIN conversations ON conversations.id = messages.conversation_id;

CREATE TRIGGER IF NOT EXISTS trg_messages_ai_fts
AFTER INSERT ON messages
BEGIN
  INSERT INTO conversation_fts (conversation_id, message_id, title, content)
  SELECT NEW.conversation_id, NEW.id, conversations.title, NEW.content
  FROM conversations
  WHERE conversations.id = NEW.conversation_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_au_fts
AFTER UPDATE ON messages
BEGIN
  DELETE FROM conversation_fts WHERE message_id = OLD.id;

  INSERT INTO conversation_fts (conversation_id, message_id, title, content)
  SELECT NEW.conversation_id, NEW.id, conversations.title, NEW.content
  FROM conversations
  WHERE conversations.id = NEW.conversation_id;
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
