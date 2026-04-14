CREATE TABLE IF NOT EXISTS message_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL DEFAULT 0,
  file_name TEXT NOT NULL,
  file_path TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  extracted_text TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_attachments_message_order
  ON message_attachments (message_id, display_order ASC, created_at ASC);
