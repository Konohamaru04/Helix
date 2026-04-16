import type { DatabaseManager } from '@bridge/db/database';
import {
  type GenerationArtifact,
  type GenerationJob,
  type MessageAttachment,
  generationArtifactSchema,
  generationJobSchema,
  messageAttachmentSchema
} from '@bridge/ipc/contracts';

function nowIso() {
  return new Date().toISOString();
}

interface GenerationJobRow {
  id: string;
  workspace_id: string | null;
  conversation_id: string | null;
  kind: 'image';
  mode: 'text-to-image' | 'image-to-image';
  workflow_profile: 'default' | 'qwen-image-edit-2511';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  prompt: string;
  negative_prompt: string | null;
  model: string;
  backend: 'placeholder' | 'diffusers' | 'comfyui';
  width: number;
  height: number;
  steps: number;
  guidance_scale: number;
  seed: number | null;
  progress: number;
  stage: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface GenerationReferenceImageRow {
  id: string;
  job_id: string;
  file_name: string;
  file_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  extracted_text: string | null;
  created_at: string;
}

interface GenerationArtifactRow {
  id: string;
  job_id: string;
  kind: 'image';
  file_path: string;
  preview_path: string | null;
  mime_type: string;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface UpsertGenerationJobInput {
  id: string;
  workspaceId: string | null;
  conversationId: string | null;
  kind: 'image';
  mode: 'text-to-image' | 'image-to-image';
  workflowProfile: 'default' | 'qwen-image-edit-2511';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  prompt: string;
  negativePrompt: string | null;
  model: string;
  backend: 'placeholder' | 'diffusers' | 'comfyui';
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
  seed: number | null;
  progress: number;
  stage: string | null;
  errorMessage: string | null;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  referenceImages: MessageAttachment[];
}

export class GenerationRepository {
  constructor(private readonly database: DatabaseManager) {}

  hasKnownFilePath(filePath: string): boolean {
    const row = this.database.connection
      .prepare(
        `
          SELECT 1 AS found
          FROM generation_reference_images
          WHERE file_path = ?
          UNION
          SELECT 1 AS found
          FROM generation_artifacts
          WHERE file_path = ? OR preview_path = ?
          LIMIT 1
        `
      )
      .get(filePath, filePath, filePath) as { found: number } | undefined;

    return Boolean(row);
  }

  listJobs(input?: {
    workspaceId?: string;
    conversationId?: string;
    limit?: number;
    statuses?: GenerationJob['status'][];
  }): GenerationJob[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (input?.workspaceId) {
      clauses.push('workspace_id = ?');
      params.push(input.workspaceId);
    }

    if (input?.conversationId) {
      clauses.push('conversation_id = ?');
      params.push(input.conversationId);
    }

    if (input?.statuses && input.statuses.length > 0) {
      clauses.push(`status IN (${input.statuses.map(() => '?').join(', ')})`);
      params.push(...input.statuses);
    }

    const limit = input?.limit ?? 40;
    params.push(limit);

    const rows = this.database.connection
      .prepare(`
        SELECT
          id,
          workspace_id,
          conversation_id,
          kind,
          mode,
          workflow_profile,
          status,
          prompt,
          negative_prompt,
          model,
          backend,
          width,
          height,
          steps,
          guidance_scale,
          seed,
          progress,
          stage,
          error_message,
          created_at,
          updated_at,
          started_at,
          completed_at
        FROM generation_jobs
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?
      `)
      .all(...params) as unknown as GenerationJobRow[];

    return this.hydrateJobs(rows);
  }

  getJob(jobId: string): GenerationJob | null {
    const row = this.database.connection
      .prepare(`
        SELECT
          id,
          workspace_id,
          conversation_id,
          kind,
          mode,
          workflow_profile,
          status,
          prompt,
          negative_prompt,
          model,
          backend,
          width,
          height,
          steps,
          guidance_scale,
          seed,
          progress,
          stage,
          error_message,
          created_at,
          updated_at,
          started_at,
          completed_at
        FROM generation_jobs
        WHERE id = ?
        LIMIT 1
      `)
      .get(jobId) as GenerationJobRow | undefined;

    if (!row) {
      return null;
    }

    return this.hydrateJobs([row])[0] ?? null;
  }

  upsertJob(input: UpsertGenerationJobInput): GenerationJob {
    const existing = this.getJob(input.id);
    const createdAt = existing?.createdAt ?? input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();

    this.database.connection
      .prepare(`
        INSERT INTO generation_jobs (
          id,
          workspace_id,
          conversation_id,
          kind,
          mode,
          workflow_profile,
          status,
          prompt,
          negative_prompt,
          model,
          backend,
          width,
          height,
          steps,
          guidance_scale,
          seed,
          progress,
          stage,
          error_message,
          created_at,
          updated_at,
          started_at,
          completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          conversation_id = excluded.conversation_id,
          kind = excluded.kind,
          mode = excluded.mode,
          workflow_profile = excluded.workflow_profile,
          status = excluded.status,
          prompt = excluded.prompt,
          negative_prompt = excluded.negative_prompt,
          model = excluded.model,
          backend = excluded.backend,
          width = excluded.width,
          height = excluded.height,
          steps = excluded.steps,
          guidance_scale = excluded.guidance_scale,
          seed = excluded.seed,
          progress = excluded.progress,
          stage = excluded.stage,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at
      `)
      .run(
        input.id,
        input.workspaceId,
        input.conversationId,
        input.kind,
        input.mode,
        input.workflowProfile,
        input.status,
        input.prompt,
        input.negativePrompt,
        input.model,
        input.backend,
        input.width,
        input.height,
        input.steps,
        input.guidanceScale,
        input.seed,
        input.progress,
        input.stage,
        input.errorMessage,
        createdAt,
        updatedAt,
        input.startedAt ?? null,
        input.completedAt ?? null
      );

    this.replaceReferenceImagesInternal(input.id, input.referenceImages);

    const job = this.getJob(input.id);

    if (!job) {
      throw new Error(`Generation job ${input.id} was not found after upsert.`);
    }

    return job;
  }

  deleteJobsByConversationId(conversationId: string): number {
    const result = this.database.connection
      .prepare('DELETE FROM generation_jobs WHERE conversation_id = ?')
      .run(conversationId);
    return result.changes;
  }

  deleteJobsByWorkspaceId(workspaceId: string): number {
    const result = this.database.connection
      .prepare('DELETE FROM generation_jobs WHERE workspace_id = ?')
      .run(workspaceId);
    return result.changes;
  }

  replaceArtifacts(jobId: string, artifacts: GenerationArtifact[]): GenerationJob {
    this.database.connection
      .prepare('DELETE FROM generation_artifacts WHERE job_id = ?')
      .run(jobId);

    if (artifacts.length > 0) {
      const statement = this.database.connection.prepare(`
        INSERT INTO generation_artifacts (
          id,
          job_id,
          kind,
          file_path,
          preview_path,
          mime_type,
          width,
          height,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const artifact of artifacts) {
        statement.run(
          artifact.id,
          jobId,
          artifact.kind,
          artifact.filePath,
          artifact.previewPath,
          artifact.mimeType,
          artifact.width,
          artifact.height,
          artifact.createdAt
        );
      }
    }

    const job = this.getJob(jobId);

    if (!job) {
      throw new Error(`Generation job ${jobId} was not found after artifact update.`);
    }

    return job;
  }

  private hydrateJobs(rows: GenerationJobRow[]): GenerationJob[] {
    const jobIds = rows.map((row) => row.id);
    const referenceImagesByJobId = this.listReferenceImagesByJobIds(jobIds);
    const artifactsByJobId = this.listArtifactsByJobIds(jobIds);

    return rows.map((row) =>
      generationJobSchema.parse({
        id: row.id,
        workspaceId: row.workspace_id,
        conversationId: row.conversation_id,
        kind: row.kind,
        mode: row.mode,
        workflowProfile: row.workflow_profile,
        status: row.status,
        prompt: row.prompt,
        negativePrompt: row.negative_prompt,
        model: row.model,
        backend: row.backend,
        width: row.width,
        height: row.height,
        steps: row.steps,
        guidanceScale: row.guidance_scale,
        seed: row.seed,
        progress: row.progress,
        stage: row.stage,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        referenceImages: referenceImagesByJobId[row.id] ?? [],
        artifacts: artifactsByJobId[row.id] ?? []
      })
    );
  }

  private replaceReferenceImagesInternal(
    jobId: string,
    referenceImages: MessageAttachment[]
  ): void {
    this.database.connection
      .prepare('DELETE FROM generation_reference_images WHERE job_id = ?')
      .run(jobId);

    if (referenceImages.length === 0) {
      return;
    }

    const statement = this.database.connection.prepare(`
      INSERT INTO generation_reference_images (
        id,
        job_id,
        file_name,
        file_path,
        mime_type,
        size_bytes,
        extracted_text,
        created_at,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    referenceImages.forEach((attachment, index) => {
      statement.run(
        attachment.id,
        jobId,
        attachment.fileName,
        attachment.filePath,
        attachment.mimeType,
        attachment.sizeBytes,
        attachment.extractedText,
        attachment.createdAt,
        index
      );
    });
  }

  private listReferenceImagesByJobIds(jobIds: string[]): Record<string, MessageAttachment[]> {
    if (jobIds.length === 0) {
      return {};
    }

    const rows = this.database.connection
      .prepare(`
        SELECT
          id,
          job_id,
          file_name,
          file_path,
          mime_type,
          size_bytes,
          extracted_text,
          created_at
        FROM generation_reference_images
        WHERE job_id IN (${jobIds.map(() => '?').join(', ')})
        ORDER BY sort_order ASC, created_at ASC
      `)
      .all(...jobIds) as unknown as GenerationReferenceImageRow[];

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

      accumulator[row.job_id] ??= [];
      accumulator[row.job_id]?.push(attachment);
      return accumulator;
    }, {});
  }

  private listArtifactsByJobIds(jobIds: string[]): Record<string, GenerationArtifact[]> {
    if (jobIds.length === 0) {
      return {};
    }

    const rows = this.database.connection
      .prepare(`
        SELECT
          id,
          job_id,
          kind,
          file_path,
          preview_path,
          mime_type,
          width,
          height,
          created_at
        FROM generation_artifacts
        WHERE job_id IN (${jobIds.map(() => '?').join(', ')})
        ORDER BY created_at ASC
      `)
      .all(...jobIds) as unknown as GenerationArtifactRow[];

    return rows.reduce<Record<string, GenerationArtifact[]>>((accumulator, row) => {
      const artifact = generationArtifactSchema.parse({
        id: row.id,
        jobId: row.job_id,
        kind: row.kind,
        filePath: row.file_path,
        previewPath: row.preview_path,
        mimeType: row.mime_type,
        width: row.width,
        height: row.height,
        createdAt: row.created_at
      });

      accumulator[row.job_id] ??= [];
      accumulator[row.job_id]?.push(artifact);
      return accumulator;
    }, {});
  }
}
