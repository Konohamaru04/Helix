CREATE TABLE IF NOT EXISTS knowledge_chunk_embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES knowledge_chunks (id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  embedding_model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_embeddings_workspace
  ON knowledge_chunk_embeddings (workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_memory_summaries (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  upto_message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  message_count INTEGER NOT NULL,
  summary_text TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_memory_summaries_updated
  ON conversation_memory_summaries (updated_at DESC);
