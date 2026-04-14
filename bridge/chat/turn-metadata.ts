import { randomUUID } from 'node:crypto';
import type { DatabaseManager } from '@bridge/db/database';
import {
  type ContextSource,
  type MessageUsage,
  type RouteTrace,
  type StoredMessage,
  type ToolInvocation,
  contextSourceSchema,
  messageUsageSchema,
  routeTraceSchema,
  storedMessageSchema,
  toolInvocationSchema
} from '@bridge/ipc/contracts';

function nowIso() {
  return new Date().toISOString();
}

interface AssistantMetadataRow {
  message_id: string;
  route_strategy: RouteTrace['strategy'];
  route_reason: string;
  route_confidence: number;
  selected_model: string | null;
  fallback_model: string | null;
  active_skill_id: string | null;
  active_tool_id: string | null;
  used_workspace_prompt: number;
  used_pinned_messages: number;
  used_rag: number;
  used_tools: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

interface ToolInvocationRow {
  id: string;
  message_id: string;
  tool_id: string;
  display_name: string;
  status: ToolInvocation['status'];
  input_summary: string;
  output_summary: string | null;
  output_text: string | null;
  error_text: string | null;
  created_at: string;
  updated_at: string;
}

interface ContextSourceRow {
  id: string;
  message_id: string;
  source_kind: ContextSource['kind'];
  label: string;
  excerpt: string;
  source_path: string | null;
  document_id: string | null;
  score: number | null;
}

export class TurnMetadataService {
  constructor(private readonly database: DatabaseManager) {}

  decorateMessages(messages: StoredMessage[]): StoredMessage[] {
    const messageIds = messages.map((message) => message.id);

    if (messageIds.length === 0) {
      return messages;
    }

    const pinnedMessageIds = this.listPinnedMessageIdsForMessages(messageIds);
    const routeTraceByMessageId = this.getRouteTraceByMessageIds(messageIds);
    const usageByMessageId = this.getUsageByMessageIds(messageIds);
    const toolInvocationsByMessageId = this.getToolInvocationsByMessageIds(messageIds);
    const contextSourcesByMessageId = this.getContextSourcesByMessageIds(messageIds);

    return messages.map((message) =>
      storedMessageSchema.parse({
        ...message,
        pinned: pinnedMessageIds.has(message.id),
        routeTrace: routeTraceByMessageId.get(message.id) ?? null,
        usage: usageByMessageId.get(message.id) ?? null,
        toolInvocations: toolInvocationsByMessageId.get(message.id) ?? [],
        contextSources: contextSourcesByMessageId.get(message.id) ?? []
      })
    );
  }

  setMessagePinned(messageId: string, conversationId: string, pinned: boolean): void {
    if (pinned) {
      this.database.connection
        .prepare(`
          INSERT INTO pinned_messages (message_id, conversation_id, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(message_id) DO NOTHING
        `)
        .run(messageId, conversationId, nowIso());
      return;
    }

    this.database.connection
      .prepare('DELETE FROM pinned_messages WHERE message_id = ?')
      .run(messageId);
  }

  listPinnedMessageIds(conversationId: string): Set<string> {
    const rows = this.database.connection
      .prepare(`
        SELECT message_id
        FROM pinned_messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC
      `)
      .all(conversationId) as Array<{ message_id: string }>;

    return new Set(rows.map((row) => row.message_id));
  }

  saveAssistantTurnArtifacts(input: {
    messageId: string;
    routeTrace: RouteTrace;
    usage: MessageUsage | null;
    toolInvocations: ToolInvocation[];
    contextSources: ContextSource[];
  }): void {
    const createdAt = nowIso();
    const updatedAt = createdAt;

    this.database.connection
      .prepare(`
        INSERT INTO assistant_message_metadata (
          message_id,
          route_strategy,
          route_reason,
          route_confidence,
          selected_model,
          fallback_model,
          active_skill_id,
          active_tool_id,
          used_workspace_prompt,
          used_pinned_messages,
          used_rag,
          used_tools,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          route_strategy = excluded.route_strategy,
          route_reason = excluded.route_reason,
          route_confidence = excluded.route_confidence,
          selected_model = excluded.selected_model,
          fallback_model = excluded.fallback_model,
          active_skill_id = excluded.active_skill_id,
          active_tool_id = excluded.active_tool_id,
          used_workspace_prompt = excluded.used_workspace_prompt,
          used_pinned_messages = excluded.used_pinned_messages,
          used_rag = excluded.used_rag,
          used_tools = excluded.used_tools,
          prompt_tokens = excluded.prompt_tokens,
          completion_tokens = excluded.completion_tokens,
          total_tokens = excluded.total_tokens,
          updated_at = excluded.updated_at
      `)
      .run(
        input.messageId,
        input.routeTrace.strategy,
        input.routeTrace.reason,
        input.routeTrace.confidence,
        input.routeTrace.selectedModel,
        input.routeTrace.fallbackModel,
        input.routeTrace.activeSkillId,
        input.routeTrace.activeToolId,
        input.routeTrace.usedWorkspacePrompt ? 1 : 0,
        input.routeTrace.usedPinnedMessages ? 1 : 0,
        input.routeTrace.usedRag ? 1 : 0,
        input.routeTrace.usedTools ? 1 : 0,
        input.usage?.promptTokens ?? null,
        input.usage?.completionTokens ?? null,
        input.usage?.totalTokens ?? null,
        createdAt,
        updatedAt
      );

    this.database.connection
      .prepare('DELETE FROM tool_invocations WHERE message_id = ?')
      .run(input.messageId);
    this.database.connection
      .prepare('DELETE FROM message_context_sources WHERE message_id = ?')
      .run(input.messageId);

    const toolInvocationStatement = this.database.connection.prepare(`
      INSERT INTO tool_invocations (
        id,
        message_id,
        tool_id,
        display_name,
        status,
        input_summary,
        output_summary,
        output_text,
        error_text,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    input.toolInvocations.forEach((invocation) => {
      const validated = toolInvocationSchema.parse(invocation);

      toolInvocationStatement.run(
        validated.id,
        input.messageId,
        validated.toolId,
        validated.displayName,
        validated.status,
        validated.inputSummary,
        validated.outputSummary,
        validated.outputText ?? null,
        validated.errorMessage,
        validated.createdAt,
        validated.updatedAt
      );
    });

    const contextSourceStatement = this.database.connection.prepare(`
      INSERT INTO message_context_sources (
        id,
        message_id,
        source_kind,
        source_id,
        label,
        excerpt,
        source_path,
        document_id,
        score,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    input.contextSources.forEach((source) => {
      const validated = contextSourceSchema.parse(source);

      contextSourceStatement.run(
        validated.id,
        input.messageId,
        validated.kind,
        validated.id,
        validated.label,
        validated.excerpt,
        validated.sourcePath,
        validated.documentId,
        validated.score,
        nowIso()
      );
    });
  }

  createToolInvocation(input: Omit<ToolInvocation, 'id' | 'createdAt' | 'updatedAt'>): ToolInvocation {
    const timestamp = nowIso();

    return toolInvocationSchema.parse({
      ...input,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  createContextSource(input: Omit<ContextSource, 'id'>): ContextSource {
    return contextSourceSchema.parse({
      ...input,
      id: randomUUID()
    });
  }

  getConversationUsageTotals(conversationId: string): MessageUsage {
    const row = this.database.connection
      .prepare(`
        SELECT
          COALESCE(SUM(assistant_message_metadata.prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(assistant_message_metadata.completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(assistant_message_metadata.total_tokens), 0) AS total_tokens
        FROM assistant_message_metadata
        INNER JOIN messages
          ON messages.id = assistant_message_metadata.message_id
        WHERE messages.conversation_id = ?
      `)
      .get(conversationId) as {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };

    return messageUsageSchema.parse({
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens
    });
  }

  private listPinnedMessageIdsForMessages(messageIds: string[]): Set<string> {
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.database.connection
      .prepare(`
        SELECT message_id
        FROM pinned_messages
        WHERE message_id IN (${placeholders})
      `)
      .all(...messageIds) as Array<{ message_id: string }>;

    return new Set(rows.map((row) => row.message_id));
  }

  private getRouteTraceByMessageIds(messageIds: string[]): Map<string, RouteTrace> {
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.database.connection
      .prepare(`
        SELECT
          message_id,
          route_strategy,
          route_reason,
          route_confidence,
          selected_model,
          fallback_model,
          active_skill_id,
          active_tool_id,
          used_workspace_prompt,
          used_pinned_messages,
          used_rag,
          used_tools,
          prompt_tokens,
          completion_tokens,
          total_tokens
        FROM assistant_message_metadata
        WHERE message_id IN (${placeholders})
      `)
      .all(...messageIds) as unknown as AssistantMetadataRow[];

    return rows.reduce<Map<string, RouteTrace>>((accumulator, row) => {
      accumulator.set(
        row.message_id,
        routeTraceSchema.parse({
          strategy: row.route_strategy,
          reason: row.route_reason,
          confidence: row.route_confidence,
          selectedModel: row.selected_model,
          fallbackModel: row.fallback_model,
          activeSkillId: row.active_skill_id,
          activeToolId: row.active_tool_id,
          usedWorkspacePrompt: Boolean(row.used_workspace_prompt),
          usedPinnedMessages: Boolean(row.used_pinned_messages),
          usedRag: Boolean(row.used_rag),
          usedTools: Boolean(row.used_tools)
        })
      );
      return accumulator;
    }, new Map());
  }

  private getUsageByMessageIds(messageIds: string[]): Map<string, MessageUsage> {
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.database.connection
      .prepare(`
        SELECT
          message_id,
          prompt_tokens,
          completion_tokens,
          total_tokens
        FROM assistant_message_metadata
        WHERE message_id IN (${placeholders})
          AND prompt_tokens IS NOT NULL
          AND completion_tokens IS NOT NULL
          AND total_tokens IS NOT NULL
      `)
      .all(...messageIds) as Array<{
      message_id: string;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    }>;

    return rows.reduce<Map<string, MessageUsage>>((accumulator, row) => {
      accumulator.set(
        row.message_id,
        messageUsageSchema.parse({
          promptTokens: row.prompt_tokens,
          completionTokens: row.completion_tokens,
          totalTokens: row.total_tokens
        })
      );
      return accumulator;
    }, new Map());
  }

  private getToolInvocationsByMessageIds(messageIds: string[]): Map<string, ToolInvocation[]> {
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.database.connection
      .prepare(`
        SELECT
          id,
          message_id,
          tool_id,
          display_name,
          status,
          input_summary,
          output_summary,
          output_text,
          error_text,
          created_at,
          updated_at
        FROM tool_invocations
        WHERE message_id IN (${placeholders})
        ORDER BY created_at ASC
      `)
      .all(...messageIds) as unknown as ToolInvocationRow[];

    return rows.reduce<Map<string, ToolInvocation[]>>((accumulator, row) => {
      const invocation = toolInvocationSchema.parse({
        id: row.id,
        toolId: row.tool_id,
        displayName: row.display_name,
        status: row.status,
        inputSummary: row.input_summary,
        outputSummary: row.output_summary,
        outputText: row.output_text,
        errorMessage: row.error_text,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });

      accumulator.set(row.message_id, [...(accumulator.get(row.message_id) ?? []), invocation]);
      return accumulator;
    }, new Map());
  }

  private getContextSourcesByMessageIds(messageIds: string[]): Map<string, ContextSource[]> {
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.database.connection
      .prepare(`
        SELECT
          id,
          message_id,
          source_kind,
          label,
          excerpt,
          source_path,
          document_id,
          score
        FROM message_context_sources
        WHERE message_id IN (${placeholders})
        ORDER BY created_at ASC
      `)
      .all(...messageIds) as unknown as ContextSourceRow[];

    return rows.reduce<Map<string, ContextSource[]>>((accumulator, row) => {
      const source = contextSourceSchema.parse({
        id: row.id,
        kind: row.source_kind,
        label: row.label,
        excerpt: row.excerpt,
        sourcePath: row.source_path,
        documentId: row.document_id,
        score: row.score
      });

      accumulator.set(row.message_id, [...(accumulator.get(row.message_id) ?? []), source]);
      return accumulator;
    }, new Map());
  }
}
