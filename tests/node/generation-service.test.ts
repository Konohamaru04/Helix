import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatRepository } from '@bridge/chat/repository';
import { DatabaseManager } from '@bridge/db/database';
import { GenerationRepository } from '@bridge/generation/repository';
import { GenerationService } from '@bridge/generation/service';
import { createLogger } from '@bridge/logging/logger';
import { SettingsService } from '@bridge/settings/service';

const tempDirectories: string[] = [];
const referenceImage = {
  id: '90000000-0000-4000-8000-000000000001',
  fileName: 'reference.png',
  filePath: 'E:/refs/reference.png',
  mimeType: 'image/png',
  sizeBytes: 1234,
  extractedText: null,
  createdAt: '2026-04-08T00:00:00.000Z'
};

interface RetryImageJobRequest {
  prompt: string;
  negativePrompt: string | null;
  model: string;
  backend: 'placeholder' | 'diffusers' | 'comfyui';
  mode: 'text-to-image' | 'image-to-image';
  workflowProfile: 'default' | 'qwen-image-edit-2511';
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
  seed: number | null;
  referenceImages: Array<{
    id: string;
    fileName: string;
    filePath: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    extractedText: string | null;
    createdAt: string;
  }>;
}

afterEach(() => {
  vi.useRealTimers();

  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createGenerationHarness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-generation-'));
  tempDirectories.push(directory);

  const database = new DatabaseManager(
    path.join(directory, 'ollama-desktop.sqlite'),
    createLogger('generation-service-test')
  );
  database.initialize();

  const settingsService = new SettingsService(database, createLogger('generation-settings-test'));
  settingsService.ensureDefaults();

  const repository = new ChatRepository(database);
  const defaultWorkspace = repository.ensureDefaultWorkspace();
  const conversation = repository.createConversation({
    prompt: 'Image generation test',
    workspaceId: defaultWorkspace.id
  });

  const generationRepository = new GenerationRepository(database);
  const pythonManager = {
    startImageJob: vi.fn(),
    getGenerationJob: vi.fn(),
    listGenerationJobs: vi.fn(),
    cancelGenerationJob: vi.fn(),
    getStatus: vi.fn().mockResolvedValue({
      reachable: true,
      url: 'http://127.0.0.1:8765',
      checkedAt: '2026-04-08T00:00:00.000Z',
      pid: 1234,
      error: null,
      runtime: 'E:/OllamaDesktop/python_embeded/python.exe',
      modelManager: {
        loadedModel: null,
        loadedBackend: null,
        device: 'cpu',
        lastError: null
      },
      vram: {
        device: 'cpu',
        cudaAvailable: false,
        totalMb: null,
        freeMb: null,
        reservedMb: null,
        allocatedMb: null
      }
    })
  };
  const assetRoot = path.join(directory, 'generated-images');
  mkdirSync(assetRoot, { recursive: true });

  const service = new GenerationService(
    generationRepository,
    repository,
    settingsService,
    pythonManager as never,
    createLogger('generation-test'),
    assetRoot
  );

  return {
    directory,
    database,
    repository,
    generationRepository,
    settingsService,
    defaultWorkspace,
    conversation,
    pythonManager,
    service
  };
}

describe('GenerationService', () => {
  it('starts image jobs, polls them to completion, and preserves workspace metadata', async () => {
    vi.useFakeTimers();
    const harness = createGenerationHarness();
    const startedAt = '2026-04-08T00:00:00.000Z';
    const completedAt = '2026-04-08T00:00:01.000Z';

    harness.pythonManager.startImageJob.mockImplementation(
      (input: { id: string; outputPath: string; model: string }) => Promise.resolve({
        id: input.id,
        kind: 'image',
        mode: 'text-to-image',
        workflow_profile: 'default',
        status: 'running',
        prompt: 'Generate a neon skyline',
        negative_prompt: null,
        model: input.model,
        backend: 'placeholder',
        width: 768,
        height: 768,
        steps: 6,
        guidance_scale: 4,
        seed: null,
        progress: 0.35,
        stage: 'Rendering',
        error_message: null,
        created_at: startedAt,
        updated_at: startedAt,
        started_at: startedAt,
        completed_at: null,
        reference_images: [],
        artifacts: []
      })
    );
    harness.pythonManager.getGenerationJob.mockImplementation(
      (jobId: string) => Promise.resolve({
        id: jobId,
        kind: 'image',
        mode: 'text-to-image',
        workflow_profile: 'default',
        status: 'completed',
        prompt: 'Generate a neon skyline',
        negative_prompt: null,
        model: 'builtin:placeholder',
        backend: 'placeholder',
        width: 768,
        height: 768,
        steps: 6,
        guidance_scale: 4,
        seed: null,
        progress: 1,
        stage: 'Completed',
        error_message: null,
        created_at: startedAt,
        updated_at: completedAt,
        started_at: startedAt,
        completed_at: completedAt,
        reference_images: [],
        artifacts: [
          {
            id: '80000000-0000-4000-8000-000000000001',
            job_id: jobId,
            kind: 'image',
            file_path: path.join(harness.directory, 'generated-images', `${jobId}.png`),
            preview_path: path.join(harness.directory, 'generated-images', `${jobId}.png`),
            mime_type: 'image/png',
            width: 768,
            height: 768,
            created_at: completedAt
          }
        ]
      })
    );
    harness.pythonManager.listGenerationJobs.mockResolvedValue([]);

    await harness.service.initialize();

    const startedJob = await harness.service.startImageJob({
      conversationId: harness.conversation.id,
      prompt: 'Generate a neon skyline'
    });

    expect(startedJob.status).toBe('running');
    expect(startedJob.workspaceId).toBe(harness.defaultWorkspace.id);
    expect(startedJob.conversationId).toBe(harness.conversation.id);
    expect(startedJob.model).toBe('builtin:placeholder');

    await vi.advanceTimersByTimeAsync(700);

    const completedJob = harness.generationRepository.getJob(startedJob.id);

    expect(completedJob?.status).toBe('completed');
    expect(completedJob?.workspaceId).toBe(harness.defaultWorkspace.id);
    expect(completedJob?.conversationId).toBe(harness.conversation.id);
    expect(completedJob?.artifacts).toHaveLength(1);
    expect(completedJob?.artifacts[0]?.mimeType).toBe('image/png');

    harness.database.close();
  });

  it('marks orphaned pending jobs as failed when the Python worker loses state', async () => {
    const harness = createGenerationHarness();
    const queuedJob = harness.generationRepository.upsertJob({
      id: '70000000-0000-4000-8000-000000000001',
      workspaceId: harness.defaultWorkspace.id,
      conversationId: harness.conversation.id,
      kind: 'image',
      mode: 'text-to-image',
      workflowProfile: 'default',
      status: 'queued',
      prompt: 'Generate a city skyline',
      negativePrompt: null,
      model: 'builtin:placeholder',
      backend: 'placeholder',
      width: 768,
      height: 768,
      steps: 6,
      guidanceScale: 4,
      seed: null,
      progress: 0,
      stage: 'Queued',
      errorMessage: null,
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
      referenceImages: []
    });
    harness.pythonManager.listGenerationJobs.mockResolvedValue([]);

    await harness.service.initialize();

    const failedJob = harness.generationRepository.getJob(queuedJob.id);

    expect(failedJob?.status).toBe('failed');
    expect(failedJob?.workspaceId).toBe(harness.defaultWorkspace.id);
    expect(failedJob?.conversationId).toBe(harness.conversation.id);
    expect(failedJob?.errorMessage).toContain('worker restarted');

    harness.database.close();
  });

  it('preserves workspace and conversation metadata when cancellation snapshots arrive', async () => {
    const harness = createGenerationHarness();
    const persistedJob = harness.generationRepository.upsertJob({
      id: '70000000-0000-4000-8000-000000000002',
      workspaceId: harness.defaultWorkspace.id,
      conversationId: harness.conversation.id,
      kind: 'image',
      mode: 'text-to-image',
      workflowProfile: 'default',
      status: 'running',
      prompt: 'Generate a portrait',
      negativePrompt: null,
      model: 'builtin:placeholder',
      backend: 'placeholder',
      width: 768,
      height: 768,
      steps: 6,
      guidanceScale: 4,
      seed: null,
      progress: 0.45,
      stage: 'Rendering',
      errorMessage: null,
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
      startedAt: '2026-04-08T00:00:00.000Z',
      completedAt: null,
      referenceImages: []
    });
    harness.pythonManager.cancelGenerationJob.mockResolvedValue({
      id: persistedJob.id,
      kind: 'image',
      mode: 'text-to-image',
      workflow_profile: 'default',
      status: 'cancelled',
      prompt: persistedJob.prompt,
      negative_prompt: null,
      model: persistedJob.model,
      backend: persistedJob.backend,
      width: persistedJob.width,
      height: persistedJob.height,
      steps: persistedJob.steps,
      guidance_scale: persistedJob.guidanceScale,
      seed: persistedJob.seed,
      progress: persistedJob.progress,
      stage: 'Cancelled',
      error_message: null,
      created_at: persistedJob.createdAt,
      updated_at: '2026-04-08T00:00:01.000Z',
      started_at: persistedJob.startedAt,
      completed_at: '2026-04-08T00:00:01.000Z',
      reference_images: [],
      artifacts: []
    });
    harness.pythonManager.getGenerationJob.mockResolvedValue({
      id: persistedJob.id,
      kind: 'image',
      mode: 'text-to-image',
      workflow_profile: 'default',
      status: 'cancelled',
      prompt: persistedJob.prompt,
      negative_prompt: null,
      model: persistedJob.model,
      backend: persistedJob.backend,
      width: persistedJob.width,
      height: persistedJob.height,
      steps: persistedJob.steps,
      guidance_scale: persistedJob.guidanceScale,
      seed: persistedJob.seed,
      progress: persistedJob.progress,
      stage: 'Cancelled',
      error_message: null,
      created_at: persistedJob.createdAt,
      updated_at: '2026-04-08T00:00:01.000Z',
      started_at: persistedJob.startedAt,
      completed_at: '2026-04-08T00:00:01.000Z',
      reference_images: [],
      artifacts: []
    });

    const cancelledJob = await harness.service.cancelJob({ jobId: persistedJob.id });

    expect(cancelledJob.status).toBe('cancelled');
    expect(cancelledJob.workspaceId).toBe(harness.defaultWorkspace.id);
    expect(cancelledJob.conversationId).toBe(harness.conversation.id);

    const storedJob = harness.generationRepository.getJob(persistedJob.id);
    expect(storedJob?.status).toBe('cancelled');
    expect(storedJob?.workspaceId).toBe(harness.defaultWorkspace.id);
    expect(storedJob?.conversationId).toBe(harness.conversation.id);

    harness.database.close();
  });

  it('routes Qwen Image Edit 2511 jobs with reference images through workflow-aware payloads', async () => {
    const harness = createGenerationHarness();
    harness.settingsService.update({
      imageGenerationModel:
        'E:\\LocalModels\\diffusion_models\\Qwen-Image-Edit-2511-Q8_0.gguf',
      additionalModelsDirectory: 'E:\\LocalModels'
    });

    harness.pythonManager.startImageJob.mockImplementation(
      (input: {
        id: string;
        model: string;
        mode: string;
        workflowProfile: string;
        referenceImages: unknown[];
      }) =>
        Promise.resolve({
          id: input.id,
          kind: 'image',
          mode: input.mode,
          workflow_profile: input.workflowProfile,
          status: 'running',
          prompt: 'Blend these references',
          negative_prompt: 'blur',
          model: input.model,
          backend: 'comfyui',
          width: 1664,
          height: 1248,
          steps: 4,
          guidance_scale: 1,
          seed: 7,
          progress: 0.15,
          stage: 'Loading image model',
          error_message: null,
          created_at: '2026-04-08T00:00:00.000Z',
          updated_at: '2026-04-08T00:00:00.000Z',
          started_at: '2026-04-08T00:00:00.000Z',
          completed_at: null,
          reference_images: (input.referenceImages as typeof referenceImage[]).map((attachment) => ({
            id: attachment.id,
            file_name: attachment.fileName,
            file_path: attachment.filePath,
            mime_type: attachment.mimeType,
            size_bytes: attachment.sizeBytes,
            extracted_text: attachment.extractedText,
            created_at: attachment.createdAt
          })),
          artifacts: []
        })
    );
    harness.pythonManager.getGenerationJob.mockResolvedValue({
      id: '80000000-0000-4000-8000-000000000001',
      kind: 'image',
      mode: 'image-to-image',
      workflow_profile: 'qwen-image-edit-2511',
      status: 'completed',
      prompt: 'Blend these references',
      negative_prompt: 'blur',
      model:
        'E:\\LocalModels\\diffusion_models\\Qwen-Image-Edit-2511-Q8_0.gguf',
      backend: 'comfyui',
      width: 1664,
      height: 1248,
      steps: 4,
      guidance_scale: 1,
      seed: 7,
      progress: 1,
      stage: 'Completed',
      error_message: null,
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:01.000Z',
      started_at: '2026-04-08T00:00:00.000Z',
      completed_at: '2026-04-08T00:00:01.000Z',
      reference_images: [
        {
          id: referenceImage.id,
          file_name: referenceImage.fileName,
          file_path: referenceImage.filePath,
          mime_type: referenceImage.mimeType,
          size_bytes: referenceImage.sizeBytes,
          extracted_text: referenceImage.extractedText,
          created_at: referenceImage.createdAt
        }
      ],
      artifacts: []
    });
    harness.pythonManager.listGenerationJobs.mockResolvedValue([]);

    const job = await harness.service.startImageJob({
      conversationId: harness.conversation.id,
      prompt: 'Blend these references',
      referenceImages: [referenceImage]
    });

    expect(job.mode).toBe('image-to-image');
    expect(job.workflowProfile).toBe('qwen-image-edit-2511');
    expect(job.referenceImages).toEqual([referenceImage]);
    expect(harness.pythonManager.startImageJob).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'image-to-image',
        workflowProfile: 'qwen-image-edit-2511',
        referenceImages: [referenceImage],
        width: 1664,
        height: 1248,
        steps: 4,
        guidanceScale: 1
      })
    );

    harness.database.close();
  });

  it('rejects unsupported discovered models before persisting or enqueueing a job', async () => {
    const harness = createGenerationHarness();
    const unsupportedModelsDirectory = path.join(harness.directory, 'unsupported-models');
    const unsupportedModelPath = path.join(
      unsupportedModelsDirectory,
      'diffusion_models',
      'wan-video-q8_0.gguf'
    );

    mkdirSync(path.dirname(unsupportedModelPath), { recursive: true });
    writeFileSync(unsupportedModelPath, 'wan');
    harness.settingsService.update({
      imageGenerationModel: unsupportedModelPath,
      additionalModelsDirectory: unsupportedModelsDirectory
    });

    await expect(
      harness.service.startImageJob({
        conversationId: harness.conversation.id,
        prompt: 'Turn this into a short video clip'
      })
    ).rejects.toThrow(/later milestone 6 slice/i);

    expect(harness.pythonManager.startImageJob).not.toHaveBeenCalled();
    expect(harness.generationRepository.listJobs().length).toBe(0);

    harness.database.close();
  });

  it('retries failed jobs by cloning the original request into a new queued job', async () => {
    const harness = createGenerationHarness();
    const failedJob = harness.generationRepository.upsertJob({
      id: '70000000-0000-4000-8000-000000000020',
      workspaceId: harness.defaultWorkspace.id,
      conversationId: harness.conversation.id,
      kind: 'image',
      mode: 'image-to-image',
      workflowProfile: 'qwen-image-edit-2511',
      status: 'failed',
      prompt: 'Retry the clothing swap',
      negativePrompt: 'blur',
      model: 'E:/LocalModels/Qwen-Image-Edit-2511-Q8_0.gguf',
      backend: 'comfyui',
      width: 1664,
      height: 1248,
      steps: 4,
      guidanceScale: 1,
      seed: 9,
      progress: 0.3,
      stage: 'Failed',
      errorMessage: 'Out of VRAM',
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:01.000Z',
      startedAt: '2026-04-08T00:00:00.000Z',
      completedAt: '2026-04-08T00:00:01.000Z',
      referenceImages: [referenceImage]
    });

    harness.pythonManager.startImageJob.mockImplementation(
      (input: { id: string; referenceImages: unknown[] }) =>
        Promise.resolve({
          id: input.id,
          kind: 'image',
          mode: failedJob.mode,
          workflow_profile: failedJob.workflowProfile,
          status: 'queued',
          prompt: failedJob.prompt,
          negative_prompt: failedJob.negativePrompt,
          model: failedJob.model,
          backend: failedJob.backend,
          width: failedJob.width,
          height: failedJob.height,
          steps: failedJob.steps,
          guidance_scale: failedJob.guidanceScale,
          seed: failedJob.seed,
          progress: 0,
          stage: 'Queued',
          error_message: null,
          created_at: '2026-04-08T00:00:02.000Z',
          updated_at: '2026-04-08T00:00:02.000Z',
          started_at: null,
          completed_at: null,
          reference_images: (input.referenceImages as typeof referenceImage[]).map((attachment) => ({
            id: attachment.id,
            file_name: attachment.fileName,
            file_path: attachment.filePath,
            mime_type: attachment.mimeType,
            size_bytes: attachment.sizeBytes,
            extracted_text: attachment.extractedText,
            created_at: attachment.createdAt
          })),
          artifacts: []
        })
    );

    const retriedJob = await harness.service.retryJob({ jobId: failedJob.id });
    const retryRequest = harness.pythonManager.startImageJob.mock.calls[0]?.[0] as
      | RetryImageJobRequest
      | undefined;

    expect(retriedJob.id).not.toBe(failedJob.id);
    expect(retriedJob.status).toBe('queued');
    expect(retryRequest).toEqual(
      expect.objectContaining({
        prompt: failedJob.prompt,
        negativePrompt: failedJob.negativePrompt,
        model: failedJob.model,
        backend: failedJob.backend,
        mode: failedJob.mode,
        workflowProfile: failedJob.workflowProfile,
        width: failedJob.width,
        height: failedJob.height,
        steps: failedJob.steps,
        guidanceScale: failedJob.guidanceScale,
        seed: failedJob.seed,
        referenceImages: [
          expect.objectContaining({
            fileName: referenceImage.fileName,
            filePath: referenceImage.filePath,
            mimeType: referenceImage.mimeType,
            sizeBytes: referenceImage.sizeBytes,
            extractedText: referenceImage.extractedText,
            createdAt: referenceImage.createdAt
          })
        ]
      })
    );
    expect(retryRequest?.referenceImages[0]?.id).not.toBe(referenceImage.id);

    harness.database.close();
  });
});
