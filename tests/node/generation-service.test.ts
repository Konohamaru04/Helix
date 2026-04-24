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
    startVideoJob: vi.fn(),
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

    expect(startedJob.job.status).toBe('running');
    expect(startedJob.job.workspaceId).toBe(harness.defaultWorkspace.id);
    expect(startedJob.job.conversationId).toBe(harness.conversation.id);
    expect(startedJob.job.model).toBe('builtin:placeholder');
    expect(startedJob.conversation).toBeUndefined();

    await vi.advanceTimersByTimeAsync(700);

    const completedJob = harness.generationRepository.getJob(startedJob.job.id);

    expect(completedJob?.status).toBe('completed');
    expect(completedJob?.workspaceId).toBe(harness.defaultWorkspace.id);
    expect(completedJob?.conversationId).toBe(harness.conversation.id);
    expect(completedJob?.artifacts).toHaveLength(1);
    expect(completedJob?.artifacts[0]?.mimeType).toBe('image/png');

    harness.database.close();
  });

  it('lists generated gallery media without duplicate preview companion images', async () => {
    const harness = createGenerationHarness();
    const completedAt = '2026-04-08T00:00:01.000Z';
    const trackedJobId = '930f3926-8321-4e54-9620-46933f5360bd';
    const orphanJobId = '45000000-0000-4000-8000-000000000001';
    const imagesDirectory = path.join(harness.directory, 'generated-images', 'images');
    mkdirSync(imagesDirectory, { recursive: true });

    const trackedImagePath = path.join(imagesDirectory, `${trackedJobId}.png`);
    const trackedPreviewPath = path.join(imagesDirectory, `${trackedJobId}-preview.png`);
    const orphanImagePath = path.join(imagesDirectory, `${orphanJobId}.png`);
    const orphanPreviewPath = path.join(imagesDirectory, `${orphanJobId}-preview.png`);

    writeFileSync(trackedImagePath, 'image');
    writeFileSync(trackedPreviewPath, 'preview');
    writeFileSync(orphanImagePath, 'orphan-image');
    writeFileSync(orphanPreviewPath, 'orphan-preview');

    harness.generationRepository.upsertJob({
      id: trackedJobId,
      workspaceId: harness.defaultWorkspace.id,
      conversationId: harness.conversation.id,
      kind: 'image',
      mode: 'text-to-image',
      workflowProfile: 'default',
      status: 'completed',
      prompt: 'Generate a gallery image',
      negativePrompt: null,
      model: 'builtin:placeholder',
      backend: 'placeholder',
      width: 768,
      height: 768,
      steps: 6,
      guidanceScale: 4,
      seed: null,
      progress: 1,
      stage: 'Completed',
      errorMessage: null,
      createdAt: completedAt,
      updatedAt: completedAt,
      startedAt: completedAt,
      completedAt,
      referenceImages: []
    });
    harness.generationRepository.replaceArtifacts(trackedJobId, [
      {
        id: '80000000-0000-4000-8000-000000000002',
        jobId: trackedJobId,
        kind: 'image',
        filePath: trackedImagePath,
        previewPath: trackedPreviewPath,
        mimeType: 'image/png',
        width: 768,
        height: 768,
        createdAt: completedAt
      }
    ]);

    const items = await harness.service.listGalleryItems();
    const fileNames = items.map((item) => path.basename(item.filePath));

    expect(fileNames).toContain(`${trackedJobId}.png`);
    expect(fileNames).toContain(`${orphanJobId}.png`);
    expect(fileNames).not.toContain(`${trackedJobId}-preview.png`);
    expect(fileNames).not.toContain(`${orphanJobId}-preview.png`);

    harness.database.close();
  });

  it('deletes filesystem gallery media with preview companion files', async () => {
    const harness = createGenerationHarness();
    const orphanJobId = '45000000-0000-4000-8000-000000000002';
    const imagesDirectory = path.join(harness.directory, 'generated-images', 'images');
    mkdirSync(imagesDirectory, { recursive: true });

    const orphanImagePath = path.join(imagesDirectory, `${orphanJobId}.png`);
    const orphanPreviewPath = path.join(imagesDirectory, `${orphanJobId}-preview.png`);

    writeFileSync(orphanImagePath, 'orphan-image');
    writeFileSync(orphanPreviewPath, 'orphan-preview');

    await harness.service.deleteArtifact({ filePath: orphanImagePath });

    const items = await harness.service.listGalleryItems();
    const fileNames = items.map((item) => path.basename(item.filePath));

    expect(fileNames).not.toContain(`${orphanJobId}.png`);
    expect(fileNames).not.toContain(`${orphanJobId}-preview.png`);

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

    expect(job.job.mode).toBe('image-to-image');
    expect(job.job.workflowProfile).toBe('qwen-image-edit-2511');
    expect(job.job.referenceImages).toEqual([referenceImage]);
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

  it('starts Wan image-to-video jobs with derived high-noise and low-noise checkpoints', async () => {
    const harness = createGenerationHarness();
    const localModelsDirectory = path.join(harness.directory, 'local-models');
    const highNoiseModelPath = path.join(
      localModelsDirectory,
      'diffusion_models',
      'DasiwaWAN22I2V14BSynthseduction_q8High.gguf'
    );
    const lowNoiseModelPath = path.join(
      localModelsDirectory,
      'diffusion_models',
      'DasiwaWAN22I2V14BSynthseduction_q8Low.gguf'
    );

    mkdirSync(path.dirname(highNoiseModelPath), { recursive: true });
    writeFileSync(highNoiseModelPath, 'wan-high');
    writeFileSync(lowNoiseModelPath, 'wan-low');
    harness.settingsService.update({
      additionalModelsDirectory: localModelsDirectory,
      videoGenerationModel: highNoiseModelPath,
      videoGenerationHighNoiseModel: highNoiseModelPath,
      videoGenerationLowNoiseModel: lowNoiseModelPath
    });

    harness.pythonManager.startVideoJob.mockImplementation(
      (input: {
        id: string;
        model: string;
        highNoiseModel: string;
        lowNoiseModel: string;
        frameCount: number;
        frameRate: number;
        referenceImages: typeof referenceImage[];
      }) =>
        Promise.resolve({
          id: input.id,
          kind: 'video',
          mode: 'image-to-video',
          workflow_profile: 'wan-image-to-video',
          status: 'running',
          prompt: 'Add a gentle camera orbit',
          negative_prompt: 'static frame',
          model: input.model,
          backend: 'comfyui',
          width: 528,
          height: 704,
          steps: 8,
          guidance_scale: 1,
          seed: 11,
          frame_count: input.frameCount,
          frame_rate: input.frameRate,
          progress: 0.12,
          stage: 'Preparing embedded Wan 2.2 workflow',
          error_message: null,
          created_at: '2026-04-23T00:00:00.000Z',
          updated_at: '2026-04-23T00:00:00.000Z',
          started_at: '2026-04-23T00:00:00.000Z',
          completed_at: null,
          reference_images: input.referenceImages.map((attachment) => ({
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
    harness.pythonManager.listGenerationJobs.mockResolvedValue([]);

    const result = await harness.service.startVideoJob({
      conversationId: harness.conversation.id,
      prompt: 'Add a gentle camera orbit',
      referenceImages: [referenceImage]
    });

    expect(result.job.kind).toBe('video');
    expect(result.job.mode).toBe('image-to-video');
    expect(result.job.workflowProfile).toBe('wan-image-to-video');
    expect(result.job.frameCount).toBe(81);
    expect(result.job.frameRate).toBe(16);
    expect(harness.pythonManager.startVideoJob).toHaveBeenCalledWith(
      expect.objectContaining({
        model: highNoiseModelPath,
        highNoiseModel: highNoiseModelPath,
        lowNoiseModel: lowNoiseModelPath,
        frameCount: 81,
        frameRate: 16,
        referenceImages: [referenceImage],
        backend: 'comfyui',
        mode: 'image-to-video',
        workflowProfile: 'wan-image-to-video'
      })
    );

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

    const retriedResult = await harness.service.retryJob({ jobId: failedJob.id });
    const retryRequest = harness.pythonManager.startImageJob.mock.calls[0]?.[0] as
      | RetryImageJobRequest
      | undefined;

    expect(retriedResult.job.id).not.toBe(failedJob.id);
    expect(retriedResult.job.status).toBe('queued');
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

  it('retries failed video jobs by cloning the original Wan request into a new queued job', async () => {
    const harness = createGenerationHarness();
    const localModelsDirectory = path.join(harness.directory, 'local-models');
    const highNoiseModelPath = path.join(
      localModelsDirectory,
      'diffusion_models',
      'DasiwaWAN22I2V14BSynthseduction_q8High.gguf'
    );
    const lowNoiseModelPath = path.join(
      localModelsDirectory,
      'diffusion_models',
      'DasiwaWAN22I2V14BSynthseduction_q8Low.gguf'
    );

    mkdirSync(path.dirname(highNoiseModelPath), { recursive: true });
    writeFileSync(highNoiseModelPath, 'wan-high');
    writeFileSync(lowNoiseModelPath, 'wan-low');
    harness.settingsService.update({
      additionalModelsDirectory: localModelsDirectory,
      videoGenerationModel: highNoiseModelPath,
      videoGenerationHighNoiseModel: highNoiseModelPath,
      videoGenerationLowNoiseModel: lowNoiseModelPath
    });

    const failedJob = harness.generationRepository.upsertJob({
      id: '70000000-0000-4000-8000-000000000030',
      workspaceId: harness.defaultWorkspace.id,
      conversationId: harness.conversation.id,
      kind: 'video',
      mode: 'image-to-video',
      workflowProfile: 'wan-image-to-video',
      status: 'failed',
      prompt: 'Animate this portrait',
      negativePrompt: 'static frame',
      model: highNoiseModelPath,
      backend: 'comfyui',
      width: 528,
      height: 704,
      steps: 8,
      guidanceScale: 1,
      seed: 19,
      frameCount: 81,
      frameRate: 16,
      progress: 0.25,
      stage: 'Failed',
      errorMessage: 'Worker offline',
      createdAt: '2026-04-23T00:00:00.000Z',
      updatedAt: '2026-04-23T00:00:01.000Z',
      startedAt: '2026-04-23T00:00:00.000Z',
      completedAt: '2026-04-23T00:00:01.000Z',
      referenceImages: [referenceImage]
    });

    harness.pythonManager.startVideoJob.mockImplementation(
      (input: { id: string; referenceImages: typeof referenceImage[] }) =>
        Promise.resolve({
          id: input.id,
          kind: 'video',
          mode: 'image-to-video',
          workflow_profile: 'wan-image-to-video',
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
          frame_count: failedJob.frameCount,
          frame_rate: failedJob.frameRate,
          progress: 0,
          stage: 'Queued',
          error_message: null,
          created_at: '2026-04-23T00:00:02.000Z',
          updated_at: '2026-04-23T00:00:02.000Z',
          started_at: null,
          completed_at: null,
          reference_images: input.referenceImages.map((attachment) => ({
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

    const retriedResult = await harness.service.retryJob({ jobId: failedJob.id });
    const retryRequest = harness.pythonManager.startVideoJob.mock.calls[0]?.[0] as
      | {
          prompt: string;
          negativePrompt: string | null;
          model: string;
          highNoiseModel: string;
          lowNoiseModel: string;
          frameCount: number;
          frameRate: number;
          referenceImages: typeof referenceImage[];
        }
      | undefined;

    expect(retriedResult.job.id).not.toBe(failedJob.id);
    expect(retriedResult.job.kind).toBe('video');
    expect(retriedResult.job.status).toBe('queued');
    expect(retryRequest).toEqual(
      expect.objectContaining({
        prompt: failedJob.prompt,
        negativePrompt: failedJob.negativePrompt,
        model: highNoiseModelPath,
        highNoiseModel: highNoiseModelPath,
        lowNoiseModel: lowNoiseModelPath,
        frameCount: 81,
        frameRate: 16,
        referenceImages: [
          expect.objectContaining({
            fileName: referenceImage.fileName,
            filePath: referenceImage.filePath
          })
        ]
      })
    );
    expect(retryRequest?.referenceImages[0]?.id).not.toBe(referenceImage.id);

    harness.database.close();
  });

  it('creates a new conversation when conversationId is not provided', async () => {
    const harness = createGenerationHarness();
    harness.pythonManager.startImageJob.mockImplementation(
      (input: { id: string }) =>
        Promise.resolve({
          id: input.id,
          kind: 'image',
          mode: 'text-to-image',
          workflow_profile: 'default',
          status: 'running',
          prompt: 'Generate a sunset',
          negative_prompt: null,
          model: 'builtin:placeholder',
          backend: 'placeholder',
          width: 768,
          height: 768,
          steps: 6,
          guidance_scale: 4,
          seed: null,
          progress: 0,
          stage: 'Running',
          error_message: null,
          created_at: '2026-04-08T00:00:00.000Z',
          updated_at: '2026-04-08T00:00:00.000Z',
          started_at: '2026-04-08T00:00:00.000Z',
          completed_at: null,
          reference_images: [],
          artifacts: []
        })
    );
    harness.pythonManager.listGenerationJobs.mockResolvedValue([]);

    const result = await harness.service.startImageJob({
      prompt: 'Generate a sunset'
    });

    expect(result.conversation).toBeDefined();
    expect(result.conversation!.title).toBe('Generate a sunset');
    expect(result.job.conversationId).toBe(result.conversation!.id);
    expect(result.job.workspaceId).toBe(harness.defaultWorkspace.id);

    harness.database.close();
  });

  it('does not create a conversation when conversationId is provided', async () => {
    const harness = createGenerationHarness();
    harness.pythonManager.startImageJob.mockImplementation(
      (input: { id: string }) =>
        Promise.resolve({
          id: input.id,
          kind: 'image',
          mode: 'text-to-image',
          workflow_profile: 'default',
          status: 'running',
          prompt: 'Generate a neon skyline',
          negative_prompt: null,
          model: 'builtin:placeholder',
          backend: 'placeholder',
          width: 768,
          height: 768,
          steps: 6,
          guidance_scale: 4,
          seed: null,
          progress: 0,
          stage: 'Running',
          error_message: null,
          created_at: '2026-04-08T00:00:00.000Z',
          updated_at: '2026-04-08T00:00:00.000Z',
          started_at: '2026-04-08T00:00:00.000Z',
          completed_at: null,
          reference_images: [],
          artifacts: []
        })
    );
    harness.pythonManager.listGenerationJobs.mockResolvedValue([]);

    const result = await harness.service.startImageJob({
      conversationId: harness.conversation.id,
      prompt: 'Generate a neon skyline'
    });

    expect(result.conversation).toBeUndefined();
    expect(result.job.conversationId).toBe(harness.conversation.id);

    harness.database.close();
  });
});

describe('GenerationRepository', () => {
  it('deletes all jobs for a given conversation ID', () => {
    const harness = createGenerationHarness();
    const otherConversation = harness.repository.createConversation({
      prompt: 'Other chat',
      workspaceId: harness.defaultWorkspace.id
    });

    harness.generationRepository.upsertJob({
      id: '71000000-0000-4000-8000-000000000001',
      workspaceId: harness.defaultWorkspace.id,
      conversationId: harness.conversation.id,
      kind: 'image',
      mode: 'text-to-image',
      workflowProfile: 'default',
      status: 'completed',
      prompt: 'Sunset',
      negativePrompt: null,
      model: 'builtin:placeholder',
      backend: 'placeholder',
      width: 768,
      height: 768,
      steps: 6,
      guidanceScale: 4,
      seed: null,
      progress: 1,
      stage: 'Completed',
      errorMessage: null,
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
      startedAt: null,
      completedAt: '2026-04-08T00:00:00.000Z',
      referenceImages: []
    });
    harness.generationRepository.upsertJob({
      id: '71000000-0000-4000-8000-000000000002',
      workspaceId: harness.defaultWorkspace.id,
      conversationId: otherConversation.id,
      kind: 'image',
      mode: 'text-to-image',
      workflowProfile: 'default',
      status: 'completed',
      prompt: 'Mountain',
      negativePrompt: null,
      model: 'builtin:placeholder',
      backend: 'placeholder',
      width: 768,
      height: 768,
      steps: 6,
      guidanceScale: 4,
      seed: null,
      progress: 1,
      stage: 'Completed',
      errorMessage: null,
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
      startedAt: null,
      completedAt: '2026-04-08T00:00:00.000Z',
      referenceImages: []
    });

    const deleted = harness.generationRepository.deleteJobsByConversationId(harness.conversation.id);

    expect(deleted).toBe(1);
    expect(harness.generationRepository.getJob('71000000-0000-4000-8000-000000000001')).toBeNull();
    expect(harness.generationRepository.getJob('71000000-0000-4000-8000-000000000002')).not.toBeNull();

    harness.database.close();
  });

  it('deletes all jobs for a given workspace ID', () => {
    const harness = createGenerationHarness();
    const otherWorkspace = harness.repository.createWorkspace({ name: 'Other workspace' });
    const otherConversation = harness.repository.createConversation({
      prompt: 'Other workspace chat',
      workspaceId: otherWorkspace.id
    });

    harness.generationRepository.upsertJob({
      id: '71000000-0000-4000-8000-000000000010',
      workspaceId: harness.defaultWorkspace.id,
      conversationId: harness.conversation.id,
      kind: 'image',
      mode: 'text-to-image',
      workflowProfile: 'default',
      status: 'completed',
      prompt: 'Workspace job',
      negativePrompt: null,
      model: 'builtin:placeholder',
      backend: 'placeholder',
      width: 768,
      height: 768,
      steps: 6,
      guidanceScale: 4,
      seed: null,
      progress: 1,
      stage: 'Completed',
      errorMessage: null,
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
      startedAt: null,
      completedAt: '2026-04-08T00:00:00.000Z',
      referenceImages: []
    });
    harness.generationRepository.upsertJob({
      id: '71000000-0000-4000-8000-000000000011',
      workspaceId: otherWorkspace.id,
      conversationId: otherConversation.id,
      kind: 'image',
      mode: 'text-to-image',
      workflowProfile: 'default',
      status: 'completed',
      prompt: 'Other workspace job',
      negativePrompt: null,
      model: 'builtin:placeholder',
      backend: 'placeholder',
      width: 768,
      height: 768,
      steps: 6,
      guidanceScale: 4,
      seed: null,
      progress: 1,
      stage: 'Completed',
      errorMessage: null,
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
      startedAt: null,
      completedAt: '2026-04-08T00:00:00.000Z',
      referenceImages: []
    });

    const deleted = harness.generationRepository.deleteJobsByWorkspaceId(harness.defaultWorkspace.id);

    expect(deleted).toBe(1);
    expect(harness.generationRepository.getJob('71000000-0000-4000-8000-000000000010')).toBeNull();
    expect(harness.generationRepository.getJob('71000000-0000-4000-8000-000000000011')).not.toBeNull();

    harness.database.close();
  });
});
