import { randomUUID } from 'node:crypto';
import type { DatabaseManager } from '@bridge/db/database';
import {
  type AgentMessage,
  type AgentSession,
  type AgentSessionStatus,
  type AuditEventRecord,
  type CapabilityPermission,
  type CapabilityPermissionInput,
  type CapabilityTask,
  type CapabilityTaskStatus,
  type CreateAgentSessionInput,
  type CreateCapabilityTaskInput,
  type CreateScheduledPromptInput,
  type CreateTeamSessionInput,
  type PlanState,
  type ScheduledPrompt,
  type TeamSession,
  type WorktreeSession,
  agentMessageSchema,
  agentSessionSchema,
  auditEventRecordSchema,
  capabilityPermissionSchema,
  capabilityTaskSchema,
  planStateSchema,
  scheduledPromptSchema,
  teamSessionSchema,
  worktreeSessionSchema
} from '@bridge/ipc/contracts';

function nowIso(): string {
  return new Date().toISOString();
}

interface PermissionGrantRow {
  id: string;
  capability_id: string;
  scope_kind: CapabilityPermission['scopeKind'];
  scope_id: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CapabilityTaskRow {
  id: string;
  sequence: number;
  workspace_id: string | null;
  title: string;
  status: CapabilityTask['status'];
  details: string | null;
  output_path: string | null;
  parent_task_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface ScheduledPromptRow {
  id: string;
  title: string;
  prompt: string;
  schedule_kind: ScheduledPrompt['kind'];
  interval_seconds: number | null;
  run_at: string | null;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentSessionRow {
  id: string;
  title: string;
  status: AgentSession['status'];
  system_prompt: string | null;
  team_id: string | null;
  parent_conversation_id: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
}

interface AgentMessageRow {
  id: string;
  session_id: string;
  role: AgentMessage['role'];
  content: string;
  created_at: string;
}

interface TeamSessionRow {
  id: string;
  title: string;
  status: TeamSession['status'];
  created_at: string;
  updated_at: string;
}

interface WorktreeSessionRow {
  id: string;
  repo_root: string;
  worktree_path: string;
  branch: string;
  status: WorktreeSession['status'];
  created_at: string;
  updated_at: string;
}

interface PlanStateRow {
  conversation_id: string;
  workspace_id: string | null;
  status: PlanState['status'];
  summary: string | null;
  created_at: string;
  updated_at: string;
}

interface AuditEventRow {
  id: string;
  category: string;
  action: string;
  payload_json: string;
  created_at: string;
}

export class CapabilityRepository {
  constructor(private readonly database: DatabaseManager) {}

  listPermissionGrants(): CapabilityPermission[] {
    const rows = this.database.connection
      .prepare(
        `
          SELECT id, capability_id, scope_kind, scope_id, expires_at, created_at, updated_at
          FROM permission_grants
          ORDER BY capability_id ASC, scope_kind ASC, updated_at DESC
        `
      )
      .all() as unknown as PermissionGrantRow[];

    return rows.map((row) => this.parsePermissionGrantRow(row));
  }

  getPermissionGrant(
    capabilityId: string,
    scopeKind: CapabilityPermission['scopeKind'],
    scopeId: string | null
  ): CapabilityPermission | null {
    const row = this.database.connection
      .prepare(
        `
          SELECT id, capability_id, scope_kind, scope_id, expires_at, created_at, updated_at
          FROM permission_grants
          WHERE capability_id = ?
            AND scope_kind = ?
            AND COALESCE(scope_id, '') = COALESCE(?, '')
          LIMIT 1
        `
      )
      .get(capabilityId, scopeKind, scopeId) as PermissionGrantRow | undefined;

    return row ? this.parsePermissionGrantRow(row) : null;
  }

  upsertPermissionGrant(input: CapabilityPermissionInput): CapabilityPermission {
    const existing = this.getPermissionGrant(
      input.capabilityId,
      input.scopeKind,
      input.scopeId ?? null
    );
    const createdAt = existing?.createdAt ?? nowIso();
    const updatedAt = nowIso();
    const permission = capabilityPermissionSchema.parse({
      id: existing?.id ?? randomUUID(),
      capabilityId: input.capabilityId,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt,
      updatedAt
    });

    if (existing) {
      this.database.connection
        .prepare(
          `
            UPDATE permission_grants
            SET expires_at = ?, updated_at = ?
            WHERE id = ?
          `
        )
        .run(permission.expiresAt, permission.updatedAt, existing.id);
    } else {
      this.database.connection
        .prepare(
          `
            INSERT INTO permission_grants (
              id,
              capability_id,
              scope_kind,
              scope_id,
              expires_at,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          permission.id,
          permission.capabilityId,
          permission.scopeKind,
          permission.scopeId,
          permission.expiresAt,
          permission.createdAt,
          permission.updatedAt
        );
    }

    return this.getPermissionGrant(
      permission.capabilityId,
      permission.scopeKind,
      permission.scopeId
    ) ?? permission;
  }

  revokePermissionGrant(input: CapabilityPermissionInput): void {
    this.database.connection
      .prepare(
        `
          DELETE FROM permission_grants
          WHERE capability_id = ?
            AND scope_kind = ?
            AND COALESCE(scope_id, '') = COALESCE(?, '')
        `
      )
      .run(input.capabilityId, input.scopeKind, input.scopeId ?? null);
  }

  createTask(input: CreateCapabilityTaskInput): CapabilityTask {
    const timestamp = nowIso();
    const nextSequence = (
      (this.database.connection
        .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM capability_tasks')
        .get() as { next_seq: number }).next_seq
    );
    const task = capabilityTaskSchema.parse({
      id: randomUUID(),
      sequence: nextSequence,
      workspaceId: input.workspaceId ?? null,
      title: input.title,
      status: 'pending',
      details: input.details ?? null,
      outputPath: null,
      parentTaskId: input.parentTaskId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null
    });

    this.database.connection
      .prepare(
        `
          INSERT INTO capability_tasks (
            id,
            sequence,
            workspace_id,
            title,
            status,
            details,
            output_path,
            process_id,
            parent_task_id,
            created_at,
            updated_at,
            started_at,
            completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
        `
      )
      .run(
        task.id,
        task.sequence,
        task.workspaceId,
        task.title,
        task.status,
        task.details,
        task.outputPath,
        task.parentTaskId,
        task.createdAt,
        task.updatedAt,
        task.startedAt,
        task.completedAt
      );

    return task;
  }

  listTasks(workspaceId?: string): CapabilityTask[] {
    const sql = workspaceId
      ? `
          SELECT
            id,
            sequence,
            workspace_id,
            title,
            status,
            details,
            output_path,
            parent_task_id,
            created_at,
            updated_at,
            started_at,
            completed_at
          FROM capability_tasks
          WHERE workspace_id = ? OR workspace_id IS NULL
          ORDER BY sequence ASC, created_at ASC
        `
      : `
          SELECT
            id,
            sequence,
            workspace_id,
            title,
            status,
            details,
            output_path,
            parent_task_id,
            created_at,
            updated_at,
            started_at,
            completed_at
          FROM capability_tasks
          ORDER BY sequence ASC, created_at ASC
        `;
    const params = workspaceId ? [workspaceId] : [];
    const rows = this.database.connection
      .prepare(sql)
      .all(...params) as unknown as CapabilityTaskRow[];

    return rows.map((row) => this.parseTaskRow(row));
  }

  getTask(taskId: string): CapabilityTask | null {
    const row = this.database.connection
      .prepare(
        `
          SELECT
            id,
            sequence,
            workspace_id,
            title,
            status,
            details,
            output_path,
            parent_task_id,
            created_at,
            updated_at,
            started_at,
            completed_at
          FROM capability_tasks
          WHERE id = ?
          LIMIT 1
        `
      )
      .get(taskId) as CapabilityTaskRow | undefined;

    return row ? this.parseTaskRow(row) : null;
  }

  updateTask(input: {
    taskId: string;
    title?: string | undefined;
    details?: string | null | undefined;
    status?: CapabilityTaskStatus | undefined;
    outputPath?: string | null | undefined;
    processId?: number | null | undefined;
  }): CapabilityTask {
    const current = this.getTask(input.taskId);

    if (!current) {
      throw new Error(`Task ${input.taskId} was not found.`);
    }

    const status = input.status ?? current.status;
    const startedAt =
      status === 'in_progress'
        ? current.startedAt ?? nowIso()
        : current.startedAt;
    const completedAt =
      status === 'completed' || status === 'cancelled' || status === 'failed'
        ? nowIso()
        : null;
    const updatedAt = nowIso();

    this.database.connection
      .prepare(
        `
          UPDATE capability_tasks
          SET
            title = ?,
            status = ?,
            details = ?,
            output_path = ?,
            process_id = ?,
            updated_at = ?,
            started_at = ?,
            completed_at = ?
          WHERE id = ?
        `
      )
      .run(
        input.title ?? current.title,
        status,
        input.details === undefined ? current.details : input.details,
        input.outputPath === undefined ? current.outputPath : input.outputPath,
        input.processId === undefined ? null : input.processId,
        updatedAt,
        startedAt,
        completedAt,
        current.id
      );

    const next = this.getTask(current.id);

    if (!next) {
      throw new Error(`Task ${current.id} was not found after update.`);
    }

    return next;
  }

  deleteTask(taskId: string): void {
    this.database.connection
      .prepare('DELETE FROM capability_tasks WHERE id = ?')
      .run(taskId);
  }

  createSchedule(input: CreateScheduledPromptInput, nextRunAt: string | null): ScheduledPrompt {
    const timestamp = nowIso();
    const schedule = scheduledPromptSchema.parse({
      id: randomUUID(),
      title: input.title,
      prompt: input.prompt,
      kind: input.kind,
      intervalSeconds: input.intervalSeconds ?? null,
      runAt: input.runAt ?? null,
      enabled: true,
      lastRunAt: null,
      nextRunAt,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    this.database.connection
      .prepare(
        `
          INSERT INTO scheduled_prompts (
            id,
            title,
            prompt,
            schedule_kind,
            interval_seconds,
            run_at,
            enabled,
            last_run_at,
            next_run_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        schedule.id,
        schedule.title,
        schedule.prompt,
        schedule.kind,
        schedule.intervalSeconds,
        schedule.runAt,
        schedule.enabled ? 1 : 0,
        schedule.lastRunAt,
        schedule.nextRunAt,
        schedule.createdAt,
        schedule.updatedAt
      );

    return schedule;
  }

  listSchedules(): ScheduledPrompt[] {
    const rows = this.database.connection
      .prepare(
        `
          SELECT
            id,
            title,
            prompt,
            schedule_kind,
            interval_seconds,
            run_at,
            enabled,
            last_run_at,
            next_run_at,
            created_at,
            updated_at
          FROM scheduled_prompts
          ORDER BY created_at DESC
        `
      )
      .all() as unknown as ScheduledPromptRow[];

    return rows.map((row) => this.parseScheduleRow(row));
  }

  updateSchedule(input: {
    scheduleId: string;
    enabled?: boolean | undefined;
    lastRunAt?: string | null | undefined;
    nextRunAt?: string | null | undefined;
  }): ScheduledPrompt {
    const current = this.listSchedules().find((item) => item.id === input.scheduleId);

    if (!current) {
      throw new Error(`Schedule ${input.scheduleId} was not found.`);
    }

    this.database.connection
      .prepare(
        `
          UPDATE scheduled_prompts
          SET
            enabled = ?,
            last_run_at = ?,
            next_run_at = ?,
            updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        input.enabled === undefined ? (current.enabled ? 1 : 0) : input.enabled ? 1 : 0,
        input.lastRunAt === undefined ? current.lastRunAt : input.lastRunAt,
        input.nextRunAt === undefined ? current.nextRunAt : input.nextRunAt,
        nowIso(),
        current.id
      );

    return this.listSchedules().find((item) => item.id === current.id) ?? current;
  }

  deleteSchedule(scheduleId: string): void {
    this.database.connection
      .prepare('DELETE FROM scheduled_prompts WHERE id = ?')
      .run(scheduleId);
  }

  createAgentTeam(input: CreateTeamSessionInput): TeamSession {
    const timestamp = nowIso();
    const team = teamSessionSchema.parse({
      id: randomUUID(),
      title: input.title,
      status: 'active',
      memberIds: [],
      createdAt: timestamp,
      updatedAt: timestamp
    });

    this.database.connection
      .prepare(
        `
          INSERT INTO agent_teams (id, title, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(team.id, team.title, team.status, team.createdAt, team.updatedAt);

    return team;
  }

  listAgentTeams(): TeamSession[] {
    const rows = this.database.connection
      .prepare(
        `
          SELECT id, title, status, created_at, updated_at
          FROM agent_teams
          ORDER BY updated_at DESC
        `
      )
      .all() as unknown as TeamSessionRow[];
    const membersByTeamId = this.listAgentSessions().reduce<Record<string, string[]>>(
      (accumulator, session) => {
        if (!session.teamId) {
          return accumulator;
        }

        accumulator[session.teamId] ??= [];
        accumulator[session.teamId]?.push(session.id);
        return accumulator;
      },
      {}
    );

    return rows.map((row) =>
      teamSessionSchema.parse({
        id: row.id,
        title: row.title,
        status: row.status,
        memberIds: membersByTeamId[row.id] ?? [],
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })
    );
  }

  archiveTeam(teamId: string): TeamSession {
    this.database.connection
      .prepare('UPDATE agent_teams SET status = ?, updated_at = ? WHERE id = ?')
      .run('archived', nowIso(), teamId);

    const team = this.listAgentTeams().find((item) => item.id === teamId);

    if (!team) {
      throw new Error(`Team ${teamId} was not found after archive.`);
    }

    return team;
  }

  createAgentSession(input: CreateAgentSessionInput): AgentSession {
    const timestamp = nowIso();
    const session = agentSessionSchema.parse({
      id: randomUUID(),
      title: input.title ?? input.prompt.slice(0, 80),
      status: 'idle',
      systemPrompt: null,
      teamId: input.teamId ?? null,
      parentConversationId: input.parentConversationId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastMessageAt: null,
      messages: []
    });

    this.database.connection
      .prepare(
        `
          INSERT INTO agent_sessions (
            id,
            title,
            status,
            system_prompt,
            team_id,
            parent_conversation_id,
            created_at,
            updated_at,
            last_message_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        session.id,
        session.title,
        session.status,
        session.systemPrompt,
        session.teamId,
        session.parentConversationId,
        session.createdAt,
        session.updatedAt,
        session.lastMessageAt
      );

    return session;
  }

  listAgentSessions(): AgentSession[] {
    const rows = this.database.connection
      .prepare(
        `
          SELECT
            id,
            title,
            status,
            system_prompt,
            team_id,
            parent_conversation_id,
            created_at,
            updated_at,
            last_message_at
          FROM agent_sessions
          ORDER BY updated_at DESC, created_at DESC
        `
      )
      .all() as unknown as AgentSessionRow[];
    const messagesBySessionId = this.listAgentMessagesBySessionIds(rows.map((row) => row.id));

    return rows.map((row) =>
      agentSessionSchema.parse({
        id: row.id,
        title: row.title,
        status: row.status,
        systemPrompt: row.system_prompt,
        teamId: row.team_id,
        parentConversationId: row.parent_conversation_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastMessageAt: row.last_message_at,
        messages: messagesBySessionId[row.id] ?? []
      })
    );
  }

  getAgentSession(sessionId: string): AgentSession | null {
    return this.listAgentSessions().find((item) => item.id === sessionId) ?? null;
  }

  appendAgentMessage(input: {
    sessionId: string;
    role: AgentMessage['role'];
    content: string;
  }): AgentMessage {
    const message = agentMessageSchema.parse({
      id: randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: nowIso()
    });

    this.database.connection
      .prepare(
        `
          INSERT INTO agent_messages (id, session_id, role, content, created_at)
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.createdAt
      );

    this.database.connection
      .prepare(
        `
          UPDATE agent_sessions
          SET last_message_at = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(message.createdAt, message.createdAt, message.sessionId);

    return message;
  }

  updateAgentSessionStatus(sessionId: string, status: AgentSessionStatus): AgentSession {
    this.database.connection
      .prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), sessionId);

    const session = this.getAgentSession(sessionId);

    if (!session) {
      throw new Error(`Agent session ${sessionId} was not found after update.`);
    }

    return session;
  }

  listWorktreeSessions(): WorktreeSession[] {
    const rows = this.database.connection
      .prepare(
        `
          SELECT id, repo_root, worktree_path, branch, status, created_at, updated_at
          FROM worktree_sessions
          ORDER BY updated_at DESC
        `
      )
      .all() as unknown as WorktreeSessionRow[];

    return rows.map((row) => this.parseWorktreeRow(row));
  }

  createWorktreeSession(input: {
    repoRoot: string;
    worktreePath: string;
    branch: string;
  }): WorktreeSession {
    const timestamp = nowIso();
    const session = worktreeSessionSchema.parse({
      id: randomUUID(),
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branch: input.branch,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp
    });

    this.database.connection
      .prepare(
        `
          INSERT INTO worktree_sessions (
            id,
            repo_root,
            worktree_path,
            branch,
            status,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        session.id,
        session.repoRoot,
        session.worktreePath,
        session.branch,
        session.status,
        session.createdAt,
        session.updatedAt
      );

    return session;
  }

  closeWorktreeSession(sessionId: string): WorktreeSession {
    this.database.connection
      .prepare(
        `
          UPDATE worktree_sessions
          SET status = 'closed', updated_at = ?
          WHERE id = ?
        `
      )
      .run(nowIso(), sessionId);

    const session = this.listWorktreeSessions().find((item) => item.id === sessionId);

    if (!session) {
      throw new Error(`Worktree session ${sessionId} was not found after close.`);
    }

    return session;
  }

  getPlanState(workspaceId?: string): PlanState {
    const sql = workspaceId
      ? `
          SELECT conversation_id, workspace_id, status, summary, created_at, updated_at
          FROM plan_state
          WHERE workspace_id = ? AND status = 'active'
          ORDER BY updated_at DESC
          LIMIT 1
        `
      : `
          SELECT conversation_id, workspace_id, status, summary, created_at, updated_at
          FROM plan_state
          WHERE status = 'active'
          ORDER BY updated_at DESC
          LIMIT 1
        `;
    const params = workspaceId ? [workspaceId] : [];
    const row = this.database.connection
      .prepare(sql)
      .get(...params) as PlanStateRow | undefined;

    if (!row) {
      return planStateSchema.parse({
        conversationId: null,
        workspaceId: workspaceId ?? null,
        status: 'inactive',
        summary: null,
        createdAt: null,
        updatedAt: null
      });
    }

    return this.parsePlanStateRow(row);
  }

  upsertPlanState(input: {
    conversationId: string;
    workspaceId?: string | null;
    status: PlanState['status'];
    summary?: string | null | undefined;
  }): PlanState {
    const current = this.database.connection
      .prepare(
        `
          SELECT conversation_id, workspace_id, status, summary, created_at, updated_at
          FROM plan_state
          WHERE conversation_id = ?
          LIMIT 1
        `
      )
      .get(input.conversationId) as PlanStateRow | undefined;
    const createdAt = current?.created_at ?? nowIso();
    const updatedAt = nowIso();

    this.database.connection
      .prepare(
        `
          INSERT INTO plan_state (conversation_id, workspace_id, status, summary, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, conversation_id) DO UPDATE SET
            status = excluded.status,
            summary = excluded.summary,
            updated_at = excluded.updated_at
        `
      )
      .run(
        input.conversationId,
        input.workspaceId ?? null,
        input.status,
        input.summary ?? null,
        createdAt,
        updatedAt
      );

    return this.getPlanState(input.workspaceId ?? undefined);
  }

  writeAuditEvent(input: {
    category: string;
    action: string;
    outcome: string;
    summary: string;
    payload?: Record<string, unknown> | undefined;
  }): AuditEventRecord {
    const createdAt = nowIso();
    const record = auditEventRecordSchema.parse({
      id: randomUUID(),
      category: input.category,
      action: input.action,
      outcome: input.outcome,
      summary: input.summary,
      createdAt
    });

    this.database.connection
      .prepare(
        `
          INSERT INTO audit_events (id, category, action, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(
        record.id,
        record.category,
        record.action,
        JSON.stringify({
          outcome: record.outcome,
          summary: record.summary,
          ...(input.payload ? { payload: input.payload } : {})
        }),
        record.createdAt
      );

    return record;
  }

  listAuditEvents(limit = 100): AuditEventRecord[] {
    const rows = this.database.connection
      .prepare(
        `
          SELECT id, category, action, payload_json, created_at
          FROM audit_events
          ORDER BY created_at DESC
          LIMIT ?
        `
      )
      .all(limit) as unknown as AuditEventRow[];

    return rows.map((row) => {
      const parsedPayload = JSON.parse(row.payload_json) as {
        outcome?: string;
        summary?: string;
      };

      return auditEventRecordSchema.parse({
        id: row.id,
        category: row.category,
        action: row.action,
        outcome: parsedPayload.outcome ?? 'completed',
        summary: parsedPayload.summary ?? `${row.category}:${row.action}`,
        createdAt: row.created_at
      });
    });
  }

  private listAgentMessagesBySessionIds(
    sessionIds: string[]
  ): Record<string, AgentMessage[]> {
    if (sessionIds.length === 0) {
      return {};
    }

    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = this.database.connection
      .prepare(
        `
          SELECT id, session_id, role, content, created_at
          FROM agent_messages
          WHERE session_id IN (${placeholders})
          ORDER BY created_at ASC
        `
      )
      .all(...sessionIds) as unknown as AgentMessageRow[];

    return rows.reduce<Record<string, AgentMessage[]>>((accumulator, row) => {
      const message = agentMessageSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at
      });

      accumulator[row.session_id] ??= [];
      accumulator[row.session_id]?.push(message);
      return accumulator;
    }, {});
  }

  private parsePermissionGrantRow(row: PermissionGrantRow): CapabilityPermission {
    return capabilityPermissionSchema.parse({
      id: row.id,
      capabilityId: row.capability_id,
      scopeKind: row.scope_kind,
      scopeId: row.scope_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private parseTaskRow(row: CapabilityTaskRow): CapabilityTask {
    return capabilityTaskSchema.parse({
      id: row.id,
      sequence: row.sequence,
      workspaceId: row.workspace_id,
      title: row.title,
      status: row.status,
      details: row.details,
      outputPath: row.output_path,
      parentTaskId: row.parent_task_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at
    });
  }

  private parseScheduleRow(row: ScheduledPromptRow): ScheduledPrompt {
    return scheduledPromptSchema.parse({
      id: row.id,
      title: row.title,
      prompt: row.prompt,
      kind: row.schedule_kind,
      intervalSeconds: row.interval_seconds,
      runAt: row.run_at,
      enabled: Boolean(row.enabled),
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private parseWorktreeRow(row: WorktreeSessionRow): WorktreeSession {
    return worktreeSessionSchema.parse({
      id: row.id,
      repoRoot: row.repo_root,
      worktreePath: row.worktree_path,
      branch: row.branch,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private parsePlanStateRow(row: PlanStateRow): PlanState {
    return planStateSchema.parse({
      conversationId: row.conversation_id,
      workspaceId: row.workspace_id,
      status: row.status,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }
}
