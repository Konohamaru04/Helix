import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from 'pino';
import { pythonStatusSchema, type PythonStatus } from '@bridge/ipc/contracts';

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface PythonGenerationArtifactSnapshot {
  id: string;
  job_id: string;
  kind: 'image' | 'video';
  file_path: string;
  preview_path: string | null;
  mime_type: string;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface PythonGenerationReferenceImageSnapshot {
  id: string;
  file_name: string;
  file_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  extracted_text: string | null;
  created_at: string;
}

export interface PythonGenerationJobSnapshot {
  id: string;
  kind: 'image' | 'video';
  mode: 'text-to-image' | 'image-to-image' | 'image-to-video';
  workflow_profile: 'default' | 'qwen-image-edit-2511' | 'wan-image-to-video';
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
  frame_count: number | null;
  frame_rate: number | null;
  progress: number;
  stage: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  reference_images: PythonGenerationReferenceImageSnapshot[];
  artifacts: PythonGenerationArtifactSnapshot[];
}

export interface StartPythonImageJobInput {
  id: string;
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
  outputPath: string;
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

export interface StartPythonVideoJobInput {
  id: string;
  prompt: string;
  negativePrompt: string | null;
  model: string;
  backend: 'comfyui';
  mode: 'image-to-video';
  workflowProfile: 'wan-image-to-video';
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
  seed: number | null;
  frameCount: number;
  frameRate: number;
  outputPath: string;
  highNoiseModel: string;
  lowNoiseModel: string;
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

export class PythonServerManager {
  #child: ChildProcessWithoutNullStreams | null = null;
  #runtime: string | null = null;
  #lastError: string | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly logger: Logger,
    private port: number,
    private readonly stateDirectory?: string,
    private readonly extraPythonPaths: string[] = []
  ) {}

  async start(): Promise<void> {
    if (this.#child) {
      return;
    }

    const runtime = this.resolvePythonRuntime();
    const existingStatus = await this.getStatus();

    if (existingStatus.reachable) {
      this.#runtime = runtime;
      this.logger.info(
        { port: this.port, url: existingStatus.url },
        'Reusing existing Python server already bound to configured port'
      );
      return;
    }

    this.#runtime = runtime;
    this.#lastError = null;
    const bootstrap = this.createServerBootstrap();
    this.#child = spawn(
      runtime,
      [
        '-c',
        bootstrap,
        this.projectRoot,
        String(this.port),
      ],
      {
        cwd: this.projectRoot,
        env: {
          ...this.getPythonEnvironment(),
          OLLAMA_DESKTOP_PARENT_PID: String(process.pid),
          ...(this.stateDirectory
            ? { OLLAMA_DESKTOP_PYTHON_STATE_DIR: this.stateDirectory }
            : {})
        },
        windowsHide: true
      }
    );

    this.#child.stdout.on('data', (chunk: Buffer | string) => {
      const output = Buffer.from(chunk).toString('utf8').trim();
      this.logger.info({ output }, 'Python server output');
    });

    this.#child.stderr.on('data', (chunk: Buffer | string) => {
      const output = Buffer.from(chunk).toString('utf8').trim();
      this.logger.warn({ output }, 'Python server stderr');
    });

    this.#child.on('exit', (code, signal) => {
      this.logger.warn({ code, signal }, 'Python server exited');
      this.#child = null;
    });

    this.#child.on('error', (error) => {
      this.#lastError = error.message;
      this.logger.error({ error: error.message }, 'Python server failed to launch');
    });

    this.logger.info({ runtime, port: this.port }, 'Started Python server process');
    await this.waitUntilHealthy();
  }

  async restart(port: number): Promise<void> {
    this.port = port;
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    const child = this.#child;
    const reachable = await this.isReachable();

    if (reachable) {
      await this.requestGracefulShutdown();
    }

    if (child) {
      const exitedGracefully = await this.waitForChildExit(child, 5000);

      if (!exitedGracefully) {
        this.logger.warn(
          { pid: child.pid },
          'Python server did not stop gracefully; forcing process tree termination'
        );
        this.forceKillProcessTree(child.pid ?? null);
        await this.waitForChildExit(child, 3000);
      }
    } else if (reachable) {
      await this.waitUntilUnavailable(5000);
    }

    this.#child = null;
    this.#runtime = null;
    this.#lastError = null;
  }

  forceStopSync(): void {
    this.forceKillProcessTree(this.#child?.pid ?? null);
    this.#child = null;
  }

  async getStatus(): Promise<PythonStatus> {
    const checkedAt = new Date().toISOString();
    const url = this.getBaseUrl();

    try {
      const health = await this.requestJson<{
        model_manager?: {
          loaded_model?: string | null;
          loaded_backend?: 'placeholder' | 'diffusers' | 'comfyui' | null;
          device?: string;
          last_error?: string | null;
        };
        vram?: {
          device?: string;
          cuda_available?: boolean;
          total_mb?: number | null;
          free_mb?: number | null;
          reserved_mb?: number | null;
          allocated_mb?: number | null;
        };
      }>('/health');

      return pythonStatusSchema.parse({
        reachable: true,
        url,
        checkedAt,
        pid: this.#child?.pid ?? null,
        error: null,
        runtime: this.#runtime,
        modelManager: health.model_manager
          ? {
              loadedModel: health.model_manager.loaded_model ?? null,
              loadedBackend: health.model_manager.loaded_backend ?? null,
              device: health.model_manager.device ?? 'unknown',
              lastError: health.model_manager.last_error ?? null
            }
          : null,
        vram: health.vram
          ? {
              device: health.vram.device ?? 'unknown',
              cudaAvailable: health.vram.cuda_available ?? false,
              totalMb: health.vram.total_mb ?? null,
              freeMb: health.vram.free_mb ?? null,
              reservedMb: health.vram.reserved_mb ?? null,
              allocatedMb: health.vram.allocated_mb ?? null
            }
          : null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Python server error';
      this.#lastError = message;

      return pythonStatusSchema.parse({
        reachable: false,
        url,
        checkedAt,
        pid: this.#child?.pid ?? null,
        error: message,
        runtime: this.#runtime,
        modelManager: null,
        vram: null
      });
    }
  }

  private getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async listGenerationJobs(): Promise<PythonGenerationJobSnapshot[]> {
    return this.requestJson<PythonGenerationJobSnapshot[]>('/jobs');
  }

  async getGenerationJob(jobId: string): Promise<PythonGenerationJobSnapshot> {
    return this.requestJson<PythonGenerationJobSnapshot>(`/jobs/${jobId}`);
  }

  async startImageJob(
    input: StartPythonImageJobInput
  ): Promise<PythonGenerationJobSnapshot> {
    return this.requestJson<PythonGenerationJobSnapshot>('/jobs/images', {
      method: 'POST',
      body: JSON.stringify({
        id: input.id,
        prompt: input.prompt,
        negative_prompt: input.negativePrompt,
        model: input.model,
        backend: input.backend,
        mode: input.mode,
        workflow_profile: input.workflowProfile,
        width: input.width,
        height: input.height,
        steps: input.steps,
        guidance_scale: input.guidanceScale,
        seed: input.seed,
        output_path: input.outputPath,
        reference_images: input.referenceImages.map((attachment) => ({
          id: attachment.id,
          file_name: attachment.fileName,
          file_path: attachment.filePath,
          mime_type: attachment.mimeType,
          size_bytes: attachment.sizeBytes,
          extracted_text: attachment.extractedText,
          created_at: attachment.createdAt
        }))
      })
    });
  }

  async startVideoJob(
    input: StartPythonVideoJobInput
  ): Promise<PythonGenerationJobSnapshot> {
    return this.requestJson<PythonGenerationJobSnapshot>('/jobs/videos', {
      method: 'POST',
      body: JSON.stringify({
        id: input.id,
        prompt: input.prompt,
        negative_prompt: input.negativePrompt,
        model: input.model,
        backend: input.backend,
        mode: input.mode,
        workflow_profile: input.workflowProfile,
        width: input.width,
        height: input.height,
        steps: input.steps,
        guidance_scale: input.guidanceScale,
        seed: input.seed,
        frame_count: input.frameCount,
        frame_rate: input.frameRate,
        output_path: input.outputPath,
        high_noise_model: input.highNoiseModel,
        low_noise_model: input.lowNoiseModel,
        reference_images: input.referenceImages.map((attachment) => ({
          id: attachment.id,
          file_name: attachment.fileName,
          file_path: attachment.filePath,
          mime_type: attachment.mimeType,
          size_bytes: attachment.sizeBytes,
          extracted_text: attachment.extractedText,
          created_at: attachment.createdAt
        }))
      })
    });
  }

  async cancelGenerationJob(jobId: string): Promise<PythonGenerationJobSnapshot> {
    return this.requestJson<PythonGenerationJobSnapshot>(`/jobs/${jobId}/cancel`, {
      method: 'POST'
    });
  }

  private async waitUntilHealthy(): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = await this.getStatus();

      if (status.reachable) {
        return;
      }

      await sleep(250);
    }

    throw new Error(
      this.#lastError ??
        'Python server did not become healthy before the startup timeout.'
    );
  }

  private async isReachable(): Promise<boolean> {
    try {
      await this.requestJson('/health');
      return true;
    } catch {
      return false;
    }
  }

  private async requestGracefulShutdown(): Promise<void> {
    try {
      await fetch(new URL('/shutdown', this.getBaseUrl()), {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: '{}'
      });
    } catch (error) {
      this.logger.debug(
        { error: error instanceof Error ? error.message : 'Unknown shutdown error' },
        'Python shutdown request ended without a clean response'
      );
    }
  }

  private async waitUntilUnavailable(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!(await this.isReachable())) {
        return true;
      }

      await sleep(150);
    }

    return !(await this.isReachable());
  }

  private waitForChildExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number
  ): Promise<boolean> {
    if (child.exitCode !== null || child.killed) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let finished = false;
      const timeout = setTimeout(() => {
        if (finished) {
          return;
        }

        finished = true;
        cleanup();
        resolve(false);
      }, timeoutMs);

      const handleExit = () => {
        if (finished) {
          return;
        }

        finished = true;
        cleanup();
        resolve(true);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        child.off('exit', handleExit);
      };

      child.once('exit', handleExit);
    });
  }

  private forceKillProcessTree(pid: number | null): void {
    if (!pid) {
      return;
    }

    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true
        });
        return;
      }

      process.kill(pid, 'SIGKILL');
    } catch (error) {
      this.logger.warn(
        { pid, error: error instanceof Error ? error.message : 'Unknown kill error' },
        'Unable to force-stop the Python server process tree'
      );
    }
  }

  private async requestJson<T>(
    pathname: string,
    options?: RequestInit
  ): Promise<T> {
    const response = await fetch(new URL(pathname, this.getBaseUrl()), {
      method: options?.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(options?.headers ?? {})
      },
      ...options
    });

    if (!response.ok) {
      let message = `Python request to ${pathname} failed with status ${response.status}.`;

      try {
        const payload = (await response.json()) as { detail?: string };

        if (typeof payload.detail === 'string' && payload.detail.trim()) {
          message = payload.detail.trim();
        }
      } catch {
        // Ignore invalid JSON error bodies and keep the generic message.
      }

      throw new Error(message);
    }

    return (await response.json()) as T;
  }

  private resolvePythonRuntime(): string {
    const embeddedRuntime = path.join(this.projectRoot, 'python_embeded', 'python.exe');

    if (!existsSync(embeddedRuntime)) {
      throw new Error(
        'Expected bundled runtime at python_embeded\\python.exe, but it was not found.'
      );
    }

    if (!this.supportsApiDependencies(embeddedRuntime)) {
      throw new Error(
        'The bundled python_embeded runtime is missing FastAPI or Uvicorn. Install required packages into python_embeded before launching the app.'
      );
    }

    return embeddedRuntime;
  }

  private supportsApiDependencies(command: string): boolean {
    const probe = spawnSync(command, ['-c', this.createDependencyProbeBootstrap()], {
      cwd: this.projectRoot,
      timeout: 4000,
      stdio: 'ignore',
      windowsHide: true,
      env: this.getPythonEnvironment()
    });

    return probe.status === 0;
  }

  private getPythonEnvironment() {
    const extraPythonPath = this.extraPythonPaths
      .filter((entry): entry is string => Boolean(entry))
      .join(path.delimiter);
    const pythonPath = [this.projectRoot, extraPythonPath, process.env.PYTHONPATH]
      .filter((entry): entry is string => Boolean(entry))
      .join(path.delimiter);

    return {
      ...process.env,
      PYTHONPATH: pythonPath,
      OLLAMA_DESKTOP_EXTRA_PYTHONPATH: extraPythonPath
    };
  }

  private createDependencyProbeBootstrap() {
    return [
      ...this.getBootstrapPrelude(),
      'import fastapi, uvicorn'
    ].join('\n');
  }

  private createServerBootstrap() {
    return [
      ...this.getBootstrapPrelude(),
      'project_root = sys.argv[1]',
      'if project_root and project_root not in sys.path:',
      '    sys.path.insert(0, project_root)',
      'import uvicorn',
      "uvicorn.run('inference_server.main:app', host='127.0.0.1', port=int(sys.argv[2]), log_level='warning')"
    ].join('\n');
  }

  private getBootstrapPrelude() {
    return [
      'import os',
      'import sys',
      "extra_paths = [entry for entry in os.environ.get('OLLAMA_DESKTOP_EXTRA_PYTHONPATH', '').split(os.pathsep) if entry]",
      'for entry in reversed(extra_paths):',
      '    if entry not in sys.path:',
      '        sys.path.insert(0, entry)'
    ];
  }
}
