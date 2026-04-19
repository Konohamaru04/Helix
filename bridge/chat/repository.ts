import { randomUUID } from 'node:crypto';
import type { DatabaseManager } from '@bridge/db/database';
import {
  type ConversationExportPayload,
  type ConversationSearchResult,
  type ConversationSummary,
  type MessageAttachment,
  type StoredMessage,
  type WorkspaceSummary,
  conversationSearchResultSchema,
  conversationSummarySchema,
  messageAttachmentSchema,
  storedMessageSchema,
  workspaceSummarySchema
} from '@bridge/ipc/contracts';

function nowIso() {
  return new Date().toISOString();
}

function deriveConversationTitle(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').slice(0, 72) || 'New conversation';
}

function buildFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.replaceAll('"', '""'))
    .filter(Boolean);

  if (tokens.length === 0) {
    return '""';
  }

  return tokens.map((token) => `"${token}"*`).join(' AND ');
}

interface ConversationRow {
  id: string;
  workspace_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  prompt: string | null;
  root_path: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  row_id?: number;
  id: string;
  conversation_id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed';
  model: string | null;
  correlation_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  file_name: string;
  file_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  extracted_text: string | null;
  created_at: string;
}

interface ConversationMemorySummaryRow {
  conversation_id: string;
  upto_message_id: string;
  message_count: number;
  summary_text: string;
  token_estimate: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationMemorySummaryRecord {
  conversationId: string;
  uptoMessageId: string;
  messageCount: number;
  summaryText: string;
  tokenEstimate: number;
  createdAt: string;
  updatedAt: string;
}

interface RepositoryCreateWorkspaceInput {
  name: string;
  prompt?: string | undefined;
  rootPath?: string | null | undefined;
}

export class ChatRepository {
  constructor(private readonly database: DatabaseManager) {}

  ensureDefaultWorkspace(): WorkspaceSummary {
    const existing = this.database.connection
      .prepare(`
        SELECT id, name, prompt, root_path, created_at, updated_at
        FROM workspaces
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .get() as WorkspaceRow | undefined;

    if (existing) {
      return this.parseWorkspaceRow(existing);
    }

    return this.createWorkspace({ name: 'General' });
  }

  listWorkspaces(): WorkspaceSummary[] {
    const rows = this.database.connection
      .prepare(`
        SELECT id, name, prompt, root_path, created_at, updated_at
        FROM workspaces
        ORDER BY lower(name) ASC, created_at ASC
      `)
      .all() as unknown as WorkspaceRow[];

    return rows.map((row) => this.parseWorkspaceRow(row));
  }

  getWorkspace(workspaceId: string): WorkspaceSummary | null {
    const row = this.database.connection
      .prepare(`
        SELECT id, name, prompt, root_path, created_at, updated_at
        FROM workspaces
        WHERE id = ?
        LIMIT 1
      `)
      .get(workspaceId) as WorkspaceRow | undefined;

    return row ? this.parseWorkspaceRow(row) : null;
  }

  findWorkspaceByName(name: string): WorkspaceSummary | null {
    const row = this.database.connection
      .prepare(`
        SELECT id, name, prompt, root_path, created_at, updated_at
        FROM workspaces
        WHERE lower(name) = lower(?)
        LIMIT 1
      `)
      .get(name.trim()) as WorkspaceRow | undefined;

    if (!row) {
      return null;
    }

    return this.parseWorkspaceRow(row);
  }

  findWorkspaceByRootPath(rootPath: string): WorkspaceSummary | null {
    const row = this.database.connection
      .prepare(`
        SELECT id, name, prompt, root_path, created_at, updated_at
        FROM workspaces
        WHERE lower(root_path) = lower(?)
        LIMIT 1
      `)
      .get(rootPath) as WorkspaceRow | undefined;

    return row ? this.parseWorkspaceRow(row) : null;
  }

  createWorkspace(input: RepositoryCreateWorkspaceInput): WorkspaceSummary {
    const createdAt = nowIso();
    const workspace = workspaceSummarySchema.parse({
      id: randomUUID(),
      name: input.name.trim(),
      prompt: input.prompt ?? null,
      rootPath: input.rootPath ?? null,
      createdAt,
      updatedAt: createdAt
    });

    this.database.connection
      .prepare(`
        INSERT INTO workspaces (id, name, prompt, root_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        workspace.id,
        workspace.name,
        workspace.prompt,
        workspace.rootPath,
        workspace.createdAt,
        workspace.updatedAt
      );

    return workspace;
  }

  deleteWorkspace(workspaceId: string): void {
    // Delete conversations first so messages cascade (conversations.workspace_id is ON DELETE SET NULL,
    // not CASCADE — explicitly deleting here triggers the messages FK cascade chain).
    this.database.connection
      .prepare('DELETE FROM conversations WHERE workspace_id = ?')
      .run(workspaceId);
    // Deleting the workspace cascades: knowledge_documents, knowledge_chunks,
    // capability_tasks, plan_state (all have ON DELETE CASCADE).
    this.database.connection
      .prepare('DELETE FROM workspaces WHERE id = ?')
      .run(workspaceId);
  }

  updateWorkspaceRoot(workspaceId: string, rootPath: string | null): WorkspaceSummary {
    const updatedAt = nowIso();
    this.database.connection
      .prepare(`
        UPDATE workspaces
        SET root_path = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(rootPath, updatedAt, workspaceId);

    const workspace = this.getWorkspace(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} was not found after update.`);
    }

    return workspace;
  }

  listConversations(): ConversationSummary[] {
    const rows = this.database.connection
      .prepare(`
        SELECT id, workspace_id, title, created_at, updated_at
        FROM conversations
        ORDER BY updated_at DESC
      `)
      .all() as unknown as ConversationRow[];

    return rows.map((row) => this.parseConversationRow(row));
  }

  getConversation(conversationId: string): ConversationSummary | null {
    const row = this.database.connection
      .prepare(`
        SELECT id, workspace_id, title, created_at, updated_at
        FROM conversations
        WHERE id = ?
      `)
      .get(conversationId) as ConversationRow | undefined;

    return row ? this.parseConversationRow(row) : null;
  }

  deleteConversation(conversationId: string): void {
    this.database.connection
      .prepare(`
        DELETE FROM conversations
        WHERE id = ?
      `)
      .run(conversationId);
  }

  createConversation(input: {
    prompt: string;
    workspaceId?: string | null;
    title?: string;
    createdAt?: string;
    updatedAt?: string;
  }): ConversationSummary {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    const resolvedWorkspaceId = this.resolveWorkspaceId(input.workspaceId);
    const conversation = conversationSummarySchema.parse({
      id: randomUUID(),
      workspaceId: resolvedWorkspaceId,
      title: input.title ?? deriveConversationTitle(input.prompt),
      createdAt,
      updatedAt
    });

    this.database.connection
      .prepare(`
        INSERT INTO conversations (id, workspace_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        conversation.id,
        conversation.workspaceId,
        conversation.title,
        conversation.createdAt,
        conversation.updatedAt
      );

    return conversation;
  }

  searchConversations(query: string): ConversationSearchResult[] {
    const ftsQuery = buildFtsQuery(query);
    const rows = this.database.connection
      .prepare(`
        SELECT
          conversations.id,
          conversations.workspace_id,
          conversations.title,
          conversations.created_at,
          conversations.updated_at,
          workspaces.name AS workspace_name,
          (
            SELECT snippet(conversation_fts, 3, '', '', ' ... ', 16)
            FROM conversation_fts
            WHERE conversation_fts MATCH ?
              AND conversation_fts.conversation_id = conversations.id
            LIMIT 1
          ) AS snippet
        FROM (
          SELECT DISTINCT conversation_id
          FROM conversation_fts
          WHERE conversation_fts MATCH ?
        ) AS matches
        JOIN conversations ON conversations.id = matches.conversation_id
        LEFT JOIN workspaces ON workspaces.id = conversations.workspace_id
        ORDER BY conversations.updated_at DESC
        LIMIT 50
      `)
      .all(ftsQuery, ftsQuery) as Array<{
      id: string;
      workspace_id: string | null;
      title: string;
      created_at: string;
      updated_at: string;
      workspace_name: string | null;
      snippet: string | null;
    }>;

    return rows.map((row) =>
      conversationSearchResultSchema.parse({
        conversation: {
          id: row.id,
          workspaceId: row.workspace_id,
          title: row.title,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        },
        workspaceName: row.workspace_name,
        snippet: row.snippet
      })
    );
  }

  touchConversation(conversationId: string, updatedAt = nowIso()): ConversationSummary {
    this.database.connection
      .prepare(`
        UPDATE conversations
        SET updated_at = ?
        WHERE id = ?
      `)
      .run(updatedAt, conversationId);

    const conversation = this.getConversation(conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} was not found after update.`);
    }

    return conversation;
  }

  listMessages(conversationId: string): StoredMessage[] {
    const rows = this.database.connection
      .prepare(`
        SELECT
          rowid AS row_id,
          id,
          conversation_id,
          role,
          content,
          status,
          model,
          correlation_id,
          created_at,
          updated_at
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, row_id ASC
      `)
      .all(conversationId) as unknown as MessageRow[];

    return this.hydrateMessages(rows);
  }

  getMessage(messageId: string): StoredMessage | null {
    const row = this.database.connection
      .prepare(`
        SELECT
          rowid AS row_id,
          id,
          conversation_id,
          role,
          content,
          status,
          model,
          correlation_id,
          created_at,
          updated_at
        FROM messages
        WHERE id = ?
      `)
      .get(messageId) as MessageRow | undefined;

    if (!row) {
      return null;
    }

    return this.hydrateMessages([row])[0] ?? null;
  }

  hasAttachmentPath(filePath: string): boolean {
    const row = this.database.connection
      .prepare(`
        SELECT 1
        FROM message_attachments
        WHERE file_path = ?
        LIMIT 1
      `)
      .get(filePath) as { 1: number } | undefined;

    return Boolean(row);
  }

  createMessage(input: {
    conversationId: string;
    role: StoredMessage['role'];
    content: string;
    attachments?: MessageAttachment[];
    status: StoredMessage['status'];
    model?: string | null;
    correlationId?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }): StoredMessage {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    const persistedAttachments = this.cloneAttachmentsForStorage(input.attachments ?? []);
    const message = storedMessageSchema.parse({
      id: randomUUID(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      attachments: persistedAttachments,
      status: input.status,
      model: input.model ?? null,
      correlationId: input.correlationId ?? null,
      createdAt,
      updatedAt
    });

    this.database.connection
      .prepare(`
        INSERT INTO messages (
          id,
          conversation_id,
          role,
          content,
          status,
          model,
          correlation_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.conversationId,
        message.role,
        message.content,
        message.status,
        message.model,
        message.correlationId,
        message.createdAt,
        message.updatedAt
      );

    this.insertAttachments(message.id, message.attachments);
    this.touchConversation(input.conversationId, updatedAt);

    return message;
  }

  updateMessage(
    messageId: string,
    patch: Pick<StoredMessage, 'content' | 'status' | 'model'> & {
      attachments?: MessageAttachment[];
    }
  ): StoredMessage {
    const updatedAt = nowIso();
    this.database.connection
      .prepare(`
        UPDATE messages
        SET content = ?, status = ?, model = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(patch.content, patch.status, patch.model, updatedAt, messageId);

    if (patch.attachments) {
      this.replaceAttachments(messageId, patch.attachments);
    }

    const message = this.getMessage(messageId);

    if (!message) {
      throw new Error(`Message ${messageId} was not found after update.`);
    }

    this.touchConversation(message.conversationId, updatedAt);
    return message;
  }

  deleteMessagesAfter(messageId: string, options?: { includeTarget?: boolean }): void {
    const target = this.database.connection
      .prepare(`
        SELECT conversation_id, rowid AS row_id
        FROM messages
        WHERE id = ?
      `)
      .get(messageId) as { conversation_id: string; row_id: number } | undefined;

    if (!target) {
      throw new Error(`Message ${messageId} was not found.`);
    }

    this.database.connection
      .prepare(`
        DELETE FROM messages
        WHERE conversation_id = ?
          AND rowid ${options?.includeTarget ? '>=' : '>'} ?
      `)
      .run(target.conversation_id, target.row_id);

    this.touchConversation(target.conversation_id);
  }

  importConversation(payload: ConversationExportPayload): {
    conversation: ConversationSummary;
    workspace: WorkspaceSummary | null;
  } {
    const workspace =
      payload.workspace === null
        ? this.ensureDefaultWorkspace()
        : this.findWorkspaceByName(payload.workspace.name) ??
          this.createWorkspace({
            name: payload.workspace.name,
            prompt: payload.workspace.prompt ?? undefined,
            rootPath: undefined
          });

    const conversation = this.createConversation({
      prompt: payload.messages[0]?.content ?? payload.conversation.title,
      workspaceId: workspace.id,
      title: payload.conversation.title,
      createdAt: payload.conversation.createdAt,
      updatedAt: payload.conversation.updatedAt
    });

    for (const message of payload.messages) {
      this.createMessage({
        conversationId: conversation.id,
        role: message.role,
        content: message.content,
        attachments: message.attachments.map((attachment) => ({
          ...attachment,
          id: randomUUID()
        })),
        status: message.status,
        model: message.model,
        correlationId: message.correlationId,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt
      });
    }

    this.touchConversation(conversation.id, payload.conversation.updatedAt);

    return {
      conversation: this.getConversation(conversation.id) ?? conversation,
      workspace
    };
  }

  getConversationExport(conversationId: string): ConversationExportPayload {
    const conversation = this.getConversation(conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} was not found.`);
    }

    const workspace =
      conversation.workspaceId === null
        ? null
        : this.listWorkspaces().find((item) => item.id === conversation.workspaceId) ?? null;

    return {
      conversation,
      workspace,
      messages: this.listMessages(conversationId)
    };
  }

  getConversationMemorySummary(
    conversationId: string
  ): ConversationMemorySummaryRecord | null {
    const row = this.database.connection
      .prepare(`
        SELECT
          conversation_id,
          upto_message_id,
          message_count,
          summary_text,
          token_estimate,
          created_at,
          updated_at
        FROM conversation_memory_summaries
        WHERE conversation_id = ?
        LIMIT 1
      `)
      .get(conversationId) as ConversationMemorySummaryRow | undefined;

    if (!row) {
      return null;
    }

    return {
      conversationId: row.conversation_id,
      uptoMessageId: row.upto_message_id,
      messageCount: row.message_count,
      summaryText: row.summary_text,
      tokenEstimate: row.token_estimate,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  upsertConversationMemorySummary(input: {
    conversationId: string;
    uptoMessageId: string;
    messageCount: number;
    summaryText: string;
    tokenEstimate: number;
  }): ConversationMemorySummaryRecord {
    const existing = this.getConversationMemorySummary(input.conversationId);
    const createdAt = existing?.createdAt ?? nowIso();
    const updatedAt = nowIso();

    this.database.connection
      .prepare(`
        INSERT INTO conversation_memory_summaries (
          conversation_id,
          upto_message_id,
          message_count,
          summary_text,
          token_estimate,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          upto_message_id = excluded.upto_message_id,
          message_count = excluded.message_count,
          summary_text = excluded.summary_text,
          token_estimate = excluded.token_estimate,
          updated_at = excluded.updated_at
      `)
      .run(
        input.conversationId,
        input.uptoMessageId,
        input.messageCount,
        input.summaryText,
        input.tokenEstimate,
        createdAt,
        updatedAt
      );

    const summary = this.getConversationMemorySummary(input.conversationId);

    if (!summary) {
      throw new Error(
        `Conversation memory summary for ${input.conversationId} was not found after upsert.`
      );
    }

    return summary;
  }

  clearConversationMemorySummary(conversationId: string): void {
    this.database.connection
      .prepare('DELETE FROM conversation_memory_summaries WHERE conversation_id = ?')
      .run(conversationId);
  }

  private resolveWorkspaceId(workspaceId?: string | null): string {
    if (!workspaceId) {
      return this.ensureDefaultWorkspace().id;
    }

    const workspace = this.database.connection
      .prepare(`
        SELECT id
        FROM workspaces
        WHERE id = ?
      `)
      .get(workspaceId) as { id: string } | undefined;

    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} was not found.`);
    }

    return workspace.id;
  }

  private parseConversationRow(row: ConversationRow): ConversationSummary {
    return conversationSummarySchema.parse({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private parseWorkspaceRow(row: WorkspaceRow): WorkspaceSummary {
    return workspaceSummarySchema.parse({
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      rootPath: row.root_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private hydrateMessages(rows: MessageRow[]): StoredMessage[] {
    const attachmentsByMessageId = this.listAttachmentsByMessageIds(rows.map((row) => row.id));

    return rows.map((row) =>
      storedMessageSchema.parse({
        id: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        content: row.content,
        attachments: attachmentsByMessageId[row.id] ?? [],
        status: row.status,
        model: row.model,
        correlationId: row.correlation_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })
    );
  }

  private listAttachmentsByMessageIds(
    messageIds: string[]
  ): Record<string, MessageAttachment[]> {
    if (messageIds.length === 0) {
      return {};
    }

    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.database.connection
      .prepare(`
        SELECT
          id,
          message_id,
          file_name,
          file_path,
          mime_type,
          size_bytes,
          extracted_text,
          created_at
        FROM message_attachments
        WHERE message_id IN (${placeholders})
        ORDER BY display_order ASC, created_at ASC
      `)
      .all(...messageIds) as unknown as AttachmentRow[];

    return rows.reduce<Record<string, MessageAttachment[]>>((accumulator, row) => {
      const attachment = messageAttachmentSchema.parse({
        id: row.id,
        fileName: row.file_name,
        filePath: row.file_path,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        extractedText: row.extracted_text,
        createdAt: row.created_at
      });

      accumulator[row.message_id] ??= [];
      accumulator[row.message_id]?.push(attachment);
      return accumulator;
    }, {});
  }

  private insertAttachments(messageId: string, attachments: MessageAttachment[]): void {
    if (attachments.length === 0) {
      return;
    }

    const statement = this.database.connection.prepare(`
      INSERT INTO message_attachments (
        id,
        message_id,
        display_order,
        file_name,
        file_path,
        mime_type,
        size_bytes,
        extracted_text,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    attachments.forEach((attachment, index) => {
      statement.run(
        attachment.id,
        messageId,
        index,
        attachment.fileName,
        attachment.filePath,
        attachment.mimeType,
        attachment.sizeBytes,
        attachment.extractedText,
        attachment.createdAt
      );
    });
  }

  private replaceAttachments(messageId: string, attachments: MessageAttachment[]): void {
    this.database.connection
      .prepare('DELETE FROM message_attachments WHERE message_id = ?')
      .run(messageId);
    this.insertAttachments(messageId, this.cloneAttachmentsForStorage(attachments));
  }

  private cloneAttachmentsForStorage(attachments: MessageAttachment[]): MessageAttachment[] {
    return attachments.map((attachment) =>
      messageAttachmentSchema.parse({
        ...attachment,
        // Attachment picker ids identify transient client-side selections; the
        // persistence layer needs a fresh row id each time an attachment is
        // stored against a message.
        id: randomUUID()
      })
    );
  }
}
