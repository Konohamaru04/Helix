CREATE TABLE IF NOT EXISTS pinned_messages (
  message_id TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pinned_messages_conversation
  ON pinned_messages (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assistant_message_metadata (
  message_id TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
  route_strategy TEXT NOT NULL,
  route_reason TEXT NOT NULL,
  route_confidence REAL NOT NULL,
  selected_model TEXT,
  fallback_model TEXT,
  active_skill_id TEXT,
  active_tool_id TEXT,
  used_workspace_prompt INTEGER NOT NULL DEFAULT 0,
  used_pinned_messages INTEGER NOT NULL DEFAULT 0,
  used_rag INTEGER NOT NULL DEFAULT 0,
  used_tools INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  input_summary TEXT NOT NULL,
  output_summary TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_message
  ON tool_invocations (message_id, created_at ASC);

CREATE TABLE IF NOT EXISTS message_context_sources (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('document_chunk', 'pinned_message')),
  source_id TEXT,
  label TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  source_path TEXT,
  document_id TEXT,
  score REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_context_sources_message
  ON message_context_sources (message_id, created_at ASC);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_path TEXT,
  mime_type TEXT,
  content_hash TEXT NOT NULL,
  token_estimate INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_documents_workspace_hash
  ON knowledge_documents (workspace_id, content_hash);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_workspace_updated
  ON knowledge_documents (workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  token_estimate INTEGER,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_chunks_document_index
  ON knowledge_chunks (document_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_workspace_document
  ON knowledge_chunks (workspace_id, document_id, chunk_index ASC);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5 (
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  workspace_id UNINDEXED,
  title,
  content,
  tokenize = 'porter unicode61'
);

INSERT INTO knowledge_chunks_fts (chunk_id, document_id, workspace_id, title, content)
SELECT
  knowledge_chunks.id,
  knowledge_chunks.document_id,
  knowledge_chunks.workspace_id,
  knowledge_documents.title,
  knowledge_chunks.content
FROM knowledge_chunks
JOIN knowledge_documents ON knowledge_documents.id = knowledge_chunks.document_id;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_chunks_ai_fts
AFTER INSERT ON knowledge_chunks
BEGIN
  INSERT INTO knowledge_chunks_fts (chunk_id, document_id, workspace_id, title, content)
  SELECT
    NEW.id,
    NEW.document_id,
    NEW.workspace_id,
    knowledge_documents.title,
    NEW.content
  FROM knowledge_documents
  WHERE knowledge_documents.id = NEW.document_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_chunks_au_fts
AFTER UPDATE ON knowledge_chunks
BEGIN
  DELETE FROM knowledge_chunks_fts WHERE chunk_id = OLD.id;

  INSERT INTO knowledge_chunks_fts (chunk_id, document_id, workspace_id, title, content)
  SELECT
    NEW.id,
    NEW.document_id,
    NEW.workspace_id,
    knowledge_documents.title,
    NEW.content
  FROM knowledge_documents
  WHERE knowledge_documents.id = NEW.document_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_chunks_ad_fts
AFTER DELETE ON knowledge_chunks
BEGIN
  DELETE FROM knowledge_chunks_fts WHERE chunk_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_documents_au_fts
AFTER UPDATE OF title ON knowledge_documents
BEGIN
  UPDATE knowledge_chunks_fts
  SET title = NEW.title
  WHERE document_id = NEW.id;
END;
