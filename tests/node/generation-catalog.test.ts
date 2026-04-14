import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverImageGenerationModels } from '@bridge/generation/catalog';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTempDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ollama-desktop-model-catalog-'));
  tempDirectories.push(directory);
  return directory;
}

describe('discoverImageGenerationModels', () => {
  it('returns the built-in placeholder when no additional directory is configured', () => {
    const catalog = discoverImageGenerationModels(null);

    expect(catalog.additionalModelsDirectory).toBeNull();
    expect(catalog.options.map((option) => option.id)).toEqual(['builtin:placeholder']);
    expect(catalog.warnings).toEqual([]);
  });

  it('discovers compatible diffusers directories and checkpoint files from a ComfyUI-style models root', () => {
    const modelsRoot = createTempDirectory();
    const diffusersRoot = path.join(modelsRoot, 'diffusers');
    const checkpointsRoot = path.join(modelsRoot, 'checkpoints');
    const compatibleDiffusersModel = path.join(diffusersRoot, 'sdxl-local');
    const unsupportedDiffusersModel = path.join(diffusersRoot, 'pix2pix-local');
    const checkpointPath = path.join(checkpointsRoot, 'dreamshaper.safetensors');

    mkdirSync(compatibleDiffusersModel, { recursive: true });
    mkdirSync(unsupportedDiffusersModel, { recursive: true });
    mkdirSync(checkpointsRoot, { recursive: true });
    writeFileSync(
      path.join(compatibleDiffusersModel, 'model_index.json'),
      JSON.stringify({ _class_name: 'StableDiffusionXLPipeline' }),
      'utf8'
    );
    writeFileSync(
      path.join(unsupportedDiffusersModel, 'model_index.json'),
      JSON.stringify({ _class_name: 'StableDiffusionInstructPix2PixPipeline' }),
      'utf8'
    );
    writeFileSync(checkpointPath, '', 'utf8');

    const catalog = discoverImageGenerationModels(modelsRoot);

    expect(catalog.additionalModelsDirectory).toBe(modelsRoot);
    expect(catalog.options.map((option) => option.id)).toEqual([
      'builtin:placeholder',
      compatibleDiffusersModel,
      checkpointPath
    ]);
    expect(catalog.options[1]?.loadStrategy).toBe('diffusers-directory');
    expect(catalog.options[2]?.loadStrategy).toBe('diffusers-single-file');
    expect(catalog.warnings).toContain(
      'Skipped 1 local diffusers model that require non-text inputs or unsupported pipeline types.'
    );
  });

  it('discovers GGUF checkpoints and routes Qwen Image Edit 2511 through the embedded ComfyUI workflow', () => {
    const modelsRoot = createTempDirectory();
    const diffusionModelsRoot = path.join(modelsRoot, 'diffusion_models');
    const supportedQwenGguf = path.join(diffusionModelsRoot, 'zimageTurbo.gguf');
    const unsupportedEditGguf = path.join(diffusionModelsRoot, 'Qwen-Image-Edit.gguf');
    const unsupportedWanGguf = path.join(diffusionModelsRoot, 'WanVideo.gguf');

    mkdirSync(diffusionModelsRoot, { recursive: true });
    writeFileSync(supportedQwenGguf, 'general.architecture qwen_image', 'utf8');
    writeFileSync(unsupportedEditGguf, 'general.architecture qwen_image', 'utf8');
    writeFileSync(unsupportedWanGguf, 'general.architecture wan', 'utf8');

    const catalog = discoverImageGenerationModels(modelsRoot);
    const qwenOption = catalog.options.find((option) => option.id === supportedQwenGguf);
    const editOption = catalog.options.find((option) => option.id === unsupportedEditGguf);
    const wanOption = catalog.options.find((option) => option.id === unsupportedWanGguf);

    expect(qwenOption).toMatchObject({
      loadStrategy: 'diffusers-gguf',
      source: 'local-gguf',
      family: 'qwen-image',
      supported: true,
      baseModelId: 'Qwen/Qwen-Image'
    });
    expect(editOption).toMatchObject({
      backend: 'comfyui',
      loadStrategy: 'comfyui-workflow',
      source: 'local-gguf',
      family: 'qwen-image-edit',
      supported: true,
      baseModelId: null
    });
    expect(editOption?.supportReason).toBeNull();
    expect(wanOption).toMatchObject({
      loadStrategy: 'diffusers-gguf',
      source: 'local-gguf',
      family: 'wan-video',
      supported: false
    });
    expect(catalog.warnings).toContain(
      'Discovered 3 GGUF models: 2 ready to load now, 1 still gated behind unsupported families or later flows.'
    );
  });

  it('warns when the configured models directory does not exist', () => {
    const missingDirectory = path.join(tmpdir(), 'ollama-desktop-missing-models');
    const catalog = discoverImageGenerationModels(missingDirectory);

    expect(catalog.options.map((option) => option.id)).toEqual(['builtin:placeholder']);
    expect(catalog.warnings[0]).toContain('does not exist');
  });
});
