import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CancelGenerationJobInput,
  GenerationJob,
  ImageGenerationModelCatalog,
  GenerationStreamEvent,
  ImageGenerationRequest,
  ListGenerationJobsInput,
  RetryGenerationJobInput
} from '@bridge/ipc/contracts';
import {
  generationArtifactSchema,
  messageAttachmentSchema
} from '@bridge/ipc/contracts';
import type { Logger } from 'pino';
import type { ChatRepository } from '@bridge/chat/repository';
import type { SettingsService } from '@bridge/settings/service';
import type {
  PythonGenerationJobSnapshot,
  PythonServerManager
} from '@bridge/python/lifecycle';
import { discoverImageGenerationModels } from './catalog';
import { GenerationRepository } from './repository';

const DEFAULT_IMAGE_WIDTH = 768;
const DEFAULT_IMAGE_HEIGHT = 768;
const DEFAULT_IMAGE_STEPS = 6;
const DEFAULT_IMAGE_GUIDANCE_SCALE = 4;
const QWEN_EDIT_IMAGE_WIDTH = 1664;
const QWEN_EDIT_IMAGE_HEIGHT = 1248;
const QWEN_EDIT_STEPS = 4;
const QWEN_EDIT_GUIDANCE_SCALE = 1;
const QWEN_EDIT_NEGATIVE_PROMPT =
  'blur, motion blur, soft focus, low resolution, distorted faces, identity change, bad anatomy, extra limbs, incorrect positioning, duplicate faces, unrealistic lighting, cartoon, illustration, CGI look, oversmooth skin, plastic skin, noise, grain, compression artifacts, perspective errors';
const POLL_INTERVAL_MS = 600;
const BASE_DIFFUSERS_HEADROOM_MB = 384;
const BASE_COMFYUI_HEADROOM_MB = 512;
const PER_MEGAPIXEL_HEADROOM_MB = 256;
const HIGH_STEP_THRESHOLD = 20;
const HIGH_STEP_EXTRA_HEADROOM_MB = 128;
const MAX_HEADROOM_MB = 2048;

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nowIso() {
  return new Date().toISOString();
}

function isTerminalJobStatus(status: GenerationJob['status']) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function resolveBackend(
  model: string,
  workflowProfile: GenerationJob['workflowProfile']
): GenerationJob['backend'] {
  if (model.trim().toLowerCase() === 'builtin:placeholder') {
    return 'placeholder';
  }

  if (workflowProfile === 'qwen-image-edit-2511') {
    return 'comfyui';
  }

  return 'diffusers';
}

export class GenerationService {
  private readonly listeners = new Set<(event: GenerationStreamEvent) => void>();
  private readonly pollingJobIds = new Set<string>();

  constructor(
    private readonly repository: GenerationRepository,
    private readonly chatRepository: ChatRepository,
    private readonly settingsService: SettingsService,
    private readonly pythonManager: PythonServerManager,
    private readonly logger: Logger,
    private readonly assetRootPath: string
  ) {}

  async initialize(): Promise<void> {
    mkdirSync(this.assetRootPath, { recursive: true });
    await this.reconcilePendingJobs();
  }

  listJobs(input?: ListGenerationJobsInput): GenerationJob[] {
    return this.repository.listJobs({
      ...(input?.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input?.conversationId ? { conversationId: input.conversationId } : {}),
      ...(typeof input?.limit === 'number' ? { limit: input.limit } : {})
    });
  }

  listImageModels(additionalModelsDirectory?: string | null): ImageGenerationModelCatalog {
    const catalog = discoverImageGenerationModels(additionalModelsDirectory);
    this.logger.info(
      {
        additionalModelsDirectory: catalog.additionalModelsDirectory,
        optionCount: catalog.options.length,
        warningCount: catalog.warnings.length
      },
      'Discovered image-generation models'
    );
    return catalog;
  }

  async startImageJob(input: ImageGenerationRequest): Promise<GenerationJob> {
    const workspaceId = this.resolveWorkspaceId(input);
    const settings = this.settingsService.get();
    const model =
      input.model?.trim() || settings.imageGenerationModel.trim() || 'builtin:placeholder';
    const jobId = randomUUID();
    const outputPath = this.buildOutputPath(jobId);
    const referenceImages = (input.referenceImages ?? []).map((attachment) =>
      messageAttachmentSchema.parse(attachment)
    );
    const workflowProfile = this.resolveWorkflowProfile(model, input.workflowProfile);
    const backend = resolveBackend(model, workflowProfile);
    const mode = input.mode ?? (referenceImages.length > 0 ? 'image-to-image' : 'text-to-image');
    const width = this.resolveWidth(input, workflowProfile);
    const height = this.resolveHeight(input, workflowProfile);
    const steps = this.resolveSteps(input, workflowProfile);
    const guidanceScale = this.resolveGuidanceScale(input, workflowProfile);

    this.validateWorkflowInput({
      model,
      mode,
      workflowProfile,
      referenceImages
    });
    await this.assertImageJobCanStart({
      model,
      backend,
      width,
      height,
      steps
    });

    const preparedJob = this.repository.upsertJob({
      id: jobId,
      workspaceId,
      conversationId: input.conversationId ?? null,
      kind: 'image',
      mode,
      workflowProfile,
      status: 'queued',
      prompt: input.prompt.trim(),
      negativePrompt: this.resolveNegativePrompt(input, workflowProfile),
      model,
      backend,
      width,
      height,
      steps,
      guidanceScale,
      seed: input.seed ?? null,
      progress: 0,
      stage: 'Queued',
      errorMessage: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      completedAt: null,
      referenceImages
    });
    if (preparedJob.conversationId) {
      this.chatRepository.touchConversation(preparedJob.conversationId);
    }
    this.emit(preparedJob);

    try {
      const snapshot = await this.pythonManager.startImageJob({
        id: preparedJob.id,
        prompt: preparedJob.prompt,
        negativePrompt: preparedJob.negativePrompt,
        model: preparedJob.model,
        backend: preparedJob.backend,
        mode: preparedJob.mode,
        workflowProfile: preparedJob.workflowProfile,
        width: preparedJob.width,
        height: preparedJob.height,
        steps: preparedJob.steps,
        guidanceScale: preparedJob.guidanceScale,
        seed: preparedJob.seed,
        outputPath,
        referenceImages: preparedJob.referenceImages
      });
      const job = this.applySnapshot(snapshot, preparedJob);
      this.ensurePolling(job.id);
      return job;
    } catch (error) {
      const failedJob = this.repository.upsertJob({
        ...preparedJob,
        status: 'failed',
        progress: preparedJob.progress,
        stage: 'Failed to start',
        errorMessage:
          error instanceof Error ? error.message : 'Unable to start image generation.',
        updatedAt: nowIso(),
        completedAt: nowIso()
      });
      this.emit(failedJob);
      throw error;
    }
  }

  async retryJob(input: RetryGenerationJobInput): Promise<GenerationJob> {
    const existingJob = this.repository.getJob(input.jobId);

    if (!existingJob) {
      throw new Error(`Generation job ${input.jobId} was not found.`);
    }

    if (existingJob.status !== 'failed' && existingJob.status !== 'cancelled') {
      throw new Error('Only failed or cancelled image jobs can be retried.');
    }

    return this.startImageJob({
      conversationId: existingJob.conversationId ?? undefined,
      workspaceId:
        existingJob.conversationId === null ? existingJob.workspaceId ?? undefined : undefined,
      prompt: existingJob.prompt,
      negativePrompt: existingJob.negativePrompt ?? undefined,
      model: existingJob.model,
      mode: existingJob.mode,
      workflowProfile: existingJob.workflowProfile,
      referenceImages: existingJob.referenceImages.map((attachment) => ({
        ...attachment,
        id: randomUUID()
      })),
      width: existingJob.width,
      height: existingJob.height,
      steps: existingJob.steps,
      guidanceScale: existingJob.guidanceScale,
      seed: existingJob.seed
    });
  }

  async cancelJob(input: CancelGenerationJobInput): Promise<GenerationJob> {
    const snapshot = await this.pythonManager.cancelGenerationJob(input.jobId);
    const job = this.applySnapshot(snapshot);
    this.ensurePolling(job.id);
    return job;
  }

  subscribe(listener: (event: GenerationStreamEvent) => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(job: GenerationJob): void {
    const event: GenerationStreamEvent = {
      type: 'job-updated',
      job
    };

    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async reconcilePendingJobs(): Promise<void> {
    const localPendingJobs = this.repository.listJobs({
      statuses: ['queued', 'running'],
      limit: 100
    });

    if (localPendingJobs.length === 0) {
      return;
    }

    try {
      const remoteJobs = await this.pythonManager.listGenerationJobs();
      const remoteJobsById = new Map(remoteJobs.map((job) => [job.id, job]));

      for (const localJob of localPendingJobs) {
        const remoteJob = remoteJobsById.get(localJob.id);

        if (!remoteJob) {
          const failedJob = this.repository.upsertJob({
            ...localJob,
            status: 'failed',
            stage: 'Worker state lost',
            errorMessage: 'The Python generation worker restarted before this job finished.',
            updatedAt: nowIso(),
            completedAt: nowIso()
          });
          this.emit(failedJob);
          continue;
        }

        const syncedJob = this.applySnapshot(remoteJob, localJob);

        if (!isTerminalJobStatus(syncedJob.status)) {
          this.ensurePolling(syncedJob.id);
        }
      }
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : 'Unknown generation queue sync error'
        },
        'Unable to reconcile pending generation jobs with the Python worker'
      );
    }
  }

  private ensurePolling(jobId: string): void {
    if (this.pollingJobIds.has(jobId)) {
      return;
    }

    this.pollingJobIds.add(jobId);

    void (async () => {
      try {
        while (true) {
          await sleep(POLL_INTERVAL_MS);
          const snapshot = await this.pythonManager.getGenerationJob(jobId);
          const job = this.applySnapshot(snapshot);

          if (isTerminalJobStatus(job.status)) {
            return;
          }
        }
      } catch (error) {
        const currentJob = this.repository.getJob(jobId);

        if (currentJob && !isTerminalJobStatus(currentJob.status)) {
          const failedJob = this.repository.upsertJob({
            ...currentJob,
            status: 'failed',
            stage: 'Worker polling failed',
            errorMessage:
              error instanceof Error
                ? error.message
                : 'Unable to poll the Python generation worker.',
            updatedAt: nowIso(),
            completedAt: nowIso()
          });
          this.emit(failedJob);
        }

        this.logger.warn(
          {
            jobId,
            error: error instanceof Error ? error.message : 'Unknown polling error'
          },
          'Generation job polling stopped with an error'
        );
      } finally {
        this.pollingJobIds.delete(jobId);
      }
    })();
  }

  private applySnapshot(
    snapshot: PythonGenerationJobSnapshot,
    existingJob?: GenerationJob
  ): GenerationJob {
    const persistedJob = existingJob ?? this.repository.getJob(snapshot.id) ?? undefined;
    const job = this.repository.upsertJob({
      id: snapshot.id,
      workspaceId: persistedJob?.workspaceId ?? null,
      conversationId: persistedJob?.conversationId ?? null,
      kind: 'image',
      mode: snapshot.mode,
      workflowProfile: snapshot.workflow_profile,
      status: snapshot.status,
      prompt: snapshot.prompt,
      negativePrompt: snapshot.negative_prompt,
      model: snapshot.model,
      backend: snapshot.backend,
      width: snapshot.width,
      height: snapshot.height,
      steps: snapshot.steps,
      guidanceScale: snapshot.guidance_scale,
      seed: snapshot.seed,
      progress: snapshot.progress,
      stage: snapshot.stage,
      errorMessage: snapshot.error_message,
      createdAt: snapshot.created_at,
      updatedAt: snapshot.updated_at,
      startedAt: snapshot.started_at,
      completedAt: snapshot.completed_at,
      referenceImages:
        snapshot.reference_images.map((attachment) =>
          messageAttachmentSchema.parse({
            id: attachment.id,
            fileName: attachment.file_name,
            filePath: attachment.file_path,
            mimeType: attachment.mime_type,
            sizeBytes: attachment.size_bytes,
            extractedText: attachment.extracted_text,
            createdAt: attachment.created_at
          })
        ) ?? persistedJob?.referenceImages ?? []
    });
    const artifacts = snapshot.artifacts.map((artifact) =>
      generationArtifactSchema.parse({
        id: artifact.id,
        jobId: snapshot.id,
        kind: artifact.kind,
        filePath: artifact.file_path,
        previewPath: artifact.preview_path,
        mimeType: artifact.mime_type,
        width: artifact.width,
        height: artifact.height,
        createdAt: artifact.created_at
      })
    );
    const hydratedJob = this.repository.replaceArtifacts(job.id, artifacts);
    this.emit(hydratedJob);
    return hydratedJob;
  }

  private resolveWorkspaceId(input: ImageGenerationRequest): string | null {
    if (input.workspaceId) {
      return input.workspaceId;
    }

    if (input.conversationId) {
      return this.chatRepository.getConversation(input.conversationId)?.workspaceId ?? null;
    }

    return this.chatRepository.ensureDefaultWorkspace().id;
  }

  private resolveWorkflowProfile(
    model: string,
    requestedWorkflowProfile?: GenerationJob['workflowProfile']
  ): GenerationJob['workflowProfile'] {
    const settings = this.settingsService.get();
    const option = discoverImageGenerationModels(settings.additionalModelsDirectory).options.find(
      (candidate) => candidate.id === model
    );

    if (option?.family === 'qwen-image-edit') {
      return 'qwen-image-edit-2511';
    }

    if (/qwen-image-edit/i.test(model)) {
      return 'qwen-image-edit-2511';
    }

    if (requestedWorkflowProfile) {
      return requestedWorkflowProfile;
    }

    return 'default';
  }

  private validateWorkflowInput(input: {
    model: string;
    mode: GenerationJob['mode'];
    workflowProfile: GenerationJob['workflowProfile'];
    referenceImages: GenerationJob['referenceImages'];
  }): void {
    if (input.workflowProfile !== 'qwen-image-edit-2511') {
      return;
    }

    if (input.referenceImages.length > 3) {
      throw new Error('Qwen Image Edit 2511 supports up to 3 reference images per job.');
    }

    if (input.mode === 'image-to-image' && input.referenceImages.length === 0) {
      throw new Error('Attach at least one reference image for Qwen Image Edit 2511 jobs.');
    }

    for (const attachment of input.referenceImages) {
      if (!attachment.filePath) {
        throw new Error(
          `Reference image "${attachment.fileName}" is missing a local file path and cannot be used for generation.`
        );
      }
    }
  }

  private resolveNegativePrompt(
    input: ImageGenerationRequest,
    workflowProfile: GenerationJob['workflowProfile']
  ): string | null {
    const explicitNegativePrompt = input.negativePrompt?.trim();

    if (explicitNegativePrompt) {
      return explicitNegativePrompt;
    }

    if (workflowProfile === 'qwen-image-edit-2511') {
      return QWEN_EDIT_NEGATIVE_PROMPT;
    }

    return null;
  }

  private resolveWidth(
    input: ImageGenerationRequest,
    workflowProfile: GenerationJob['workflowProfile']
  ) {
    if (typeof input.width === 'number') {
      return input.width;
    }

    if (workflowProfile === 'qwen-image-edit-2511') {
      return QWEN_EDIT_IMAGE_WIDTH;
    }

    return DEFAULT_IMAGE_WIDTH;
  }

  private resolveHeight(
    input: ImageGenerationRequest,
    workflowProfile: GenerationJob['workflowProfile']
  ) {
    if (typeof input.height === 'number') {
      return input.height;
    }

    if (workflowProfile === 'qwen-image-edit-2511') {
      return QWEN_EDIT_IMAGE_HEIGHT;
    }

    return DEFAULT_IMAGE_HEIGHT;
  }

  private resolveSteps(
    input: ImageGenerationRequest,
    workflowProfile: GenerationJob['workflowProfile']
  ) {
    if (typeof input.steps === 'number') {
      return input.steps;
    }

    if (workflowProfile === 'qwen-image-edit-2511') {
      return QWEN_EDIT_STEPS;
    }

    return DEFAULT_IMAGE_STEPS;
  }

  private resolveGuidanceScale(
    input: ImageGenerationRequest,
    workflowProfile: GenerationJob['workflowProfile']
  ) {
    if (typeof input.guidanceScale === 'number') {
      return input.guidanceScale;
    }

    if (workflowProfile === 'qwen-image-edit-2511') {
      return QWEN_EDIT_GUIDANCE_SCALE;
    }

    return DEFAULT_IMAGE_GUIDANCE_SCALE;
  }

  private buildOutputPath(jobId: string): string {
    return path.join(this.assetRootPath, `${jobId}.png`);
  }

  private async assertImageJobCanStart(input: {
    model: string;
    backend: GenerationJob['backend'];
    width: number;
    height: number;
    steps: number;
  }): Promise<void> {
    const settings = this.settingsService.get();
    const modelOption = discoverImageGenerationModels(settings.additionalModelsDirectory).options.find(
      (candidate) => candidate.id === input.model
    );

    if (modelOption && !modelOption.supported) {
      throw new Error(
        modelOption.supportReason ??
          `The selected image model "${modelOption.label}" is not supported in this generation flow yet.`
      );
    }

    const pythonStatus = await this.pythonManager.getStatus();

    if (!pythonStatus.reachable) {
      throw new Error(
        pythonStatus.error
          ? `The local Python image worker is unavailable: ${pythonStatus.error}`
          : 'The local Python image worker is unavailable, so this image job cannot be started yet.'
      );
    }

    const totalVramMb = pythonStatus.vram?.totalMb ?? null;

    if (!pythonStatus.vram?.cudaAvailable || totalVramMb === null) {
      return;
    }

    const requiredHeadroomMb = this.requiredVramHeadroomMb({
      backend: input.backend,
      width: input.width,
      height: input.height,
      steps: input.steps
    });

    if (totalVramMb >= requiredHeadroomMb) {
      return;
    }

    throw new Error(
      `This ${input.backend} image request needs about ${requiredHeadroomMb} MB of free GPU headroom, but the worker only reports ${Math.round(
        totalVramMb
      )} MB total VRAM on this machine. Lower the resolution or steps, or switch to a lighter image model before queuing it.`
    );
  }

  private requiredVramHeadroomMb(input: {
    backend: GenerationJob['backend'];
    width: number;
    height: number;
    steps: number;
  }): number {
    if (input.backend === 'placeholder') {
      return 0;
    }

    const baseHeadroom =
      input.backend === 'comfyui' ? BASE_COMFYUI_HEADROOM_MB : BASE_DIFFUSERS_HEADROOM_MB;
    const megapixels = Math.max(1, Math.ceil((input.width * input.height) / (1024 * 1024)));
    let headroom = baseHeadroom + megapixels * PER_MEGAPIXEL_HEADROOM_MB;

    if (input.steps >= HIGH_STEP_THRESHOLD) {
      headroom += HIGH_STEP_EXTRA_HEADROOM_MB;
    }

    return Math.min(MAX_HEADROOM_MB, headroom);
  }
}
