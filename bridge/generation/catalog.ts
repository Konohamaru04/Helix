import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  statSync
} from 'node:fs';
import path from 'node:path';
import { APP_DISPLAY_NAME } from '@bridge/branding';
import {
  builtinImageGenerationModelOption,
  imageGenerationModelCatalogSchema,
  imageGenerationModelOptionSchema,
  type ImageGenerationModelCatalog,
  type ImageGenerationModelOption
} from '@bridge/ipc/contracts';

const CHECKPOINT_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth']);
const GGUF_EXTENSIONS = new Set(['.gguf']);
const GGUF_SCAN_DIRECTORIES = ['diffusion_models', 'unet', 'transformer'];
const GGUF_SNIFF_BYTES = 256 * 1024;
const UNSUPPORTED_PIPELINE_TOKENS = [
  'audio',
  'controlnet',
  'depth2img',
  'img2img',
  'image2image',
  'imagevariation',
  'inpaint',
  'instructpix2pix',
  'normals',
  'prior',
  'upscale',
  'video'
];

function normalizeDirectory(directory: string | null | undefined): string | null {
  const trimmed = directory?.trim();
  return trimmed ? path.normalize(trimmed) : null;
}

function isExistingDirectory(directory: string): boolean {
  if (!existsSync(directory)) {
    return false;
  }

  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function safeListDirectory(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readDiffusersClassName(directory: string): string | null {
  try {
    const raw = readFileSync(path.join(directory, 'model_index.json'), 'utf8');
    const parsed = JSON.parse(raw) as { _class_name?: string };
    return typeof parsed._class_name === 'string' ? parsed._class_name : null;
  } catch {
    return null;
  }
}

function isCompatibleDiffusersPipeline(className: string | null): boolean {
  if (!className || !className.endsWith('Pipeline')) {
    return false;
  }

  const normalized = className.toLowerCase();

  return !UNSUPPORTED_PIPELINE_TOKENS.some((token) => normalized.includes(token));
}

function pushOption(
  optionsById: Map<string, ImageGenerationModelOption>,
  option: ImageGenerationModelOption
) {
  if (!optionsById.has(option.id)) {
    optionsById.set(option.id, imageGenerationModelOptionSchema.parse(option));
  }
}

function findDiffusersDirectories(rootDirectory: string): string[] {
  const candidates = new Set<string>();
  const inspectRoots = [rootDirectory, path.join(rootDirectory, 'diffusers')];

  for (const inspectRoot of inspectRoots) {
    if (!isExistingDirectory(inspectRoot)) {
      continue;
    }

    if (existsSync(path.join(inspectRoot, 'model_index.json'))) {
      candidates.add(path.normalize(inspectRoot));
    }

    for (const entry of safeListDirectory(inspectRoot)) {
      if (!entry.isDirectory()) {
        continue;
      }

      const fullPath = path.join(inspectRoot, entry.name);

      if (existsSync(path.join(fullPath, 'model_index.json'))) {
        candidates.add(path.normalize(fullPath));
      }
    }
  }

  return Array.from(candidates).sort((left, right) => left.localeCompare(right));
}

function findCheckpointFiles(rootDirectory: string): string[] {
  const candidates = new Set<string>();
  const inspectRoots = [rootDirectory, path.join(rootDirectory, 'checkpoints')];

  for (const inspectRoot of inspectRoots) {
    if (!isExistingDirectory(inspectRoot)) {
      continue;
    }

    for (const entry of safeListDirectory(inspectRoot)) {
      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (!CHECKPOINT_EXTENSIONS.has(extension)) {
        continue;
      }

      candidates.add(path.normalize(path.join(inspectRoot, entry.name)));
    }
  }

  return Array.from(candidates).sort((left, right) => left.localeCompare(right));
}

function findGgufFiles(rootDirectory: string): string[] {
  const candidates = new Set<string>();
  const inspectRoots = [rootDirectory, ...GGUF_SCAN_DIRECTORIES.map((directory) => path.join(rootDirectory, directory))];

  for (const inspectRoot of inspectRoots) {
    if (!isExistingDirectory(inspectRoot)) {
      continue;
    }

    for (const entry of safeListDirectory(inspectRoot)) {
      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (!GGUF_EXTENSIONS.has(extension)) {
        continue;
      }

      candidates.add(path.normalize(path.join(inspectRoot, entry.name)));
    }
  }

  return Array.from(candidates).sort((left, right) => left.localeCompare(right));
}

function readFileHead(filePath: string, byteCount: number): Buffer | null {
  try {
    const descriptor = openSync(filePath, 'r');

    try {
      const buffer = Buffer.alloc(byteCount);
      const bytesRead = readSync(descriptor, buffer, 0, byteCount, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return null;
  }
}

function sniffGgufArchitecture(filePath: string): string | null {
  const buffer = readFileHead(filePath, GGUF_SNIFF_BYTES);

  if (!buffer) {
    return null;
  }

  const sample = buffer.toString('utf8').toLowerCase();

  if (sample.includes('qwen_image')) {
    return 'qwen_image';
  }

  if (sample.includes('wan')) {
    return 'wan';
  }

  if (sample.includes('flux')) {
    return 'flux';
  }

  return null;
}

function describeGgufModel(ggufPath: string): ImageGenerationModelOption {
  const fileName = path.basename(ggufPath);
  const normalizedName = fileName.toLowerCase();
  const architecture = sniffGgufArchitecture(ggufPath);

  if (architecture === 'qwen_image') {
    const isEditModel = normalizedName.includes('edit');

    if (isEditModel) {
      return {
        id: ggufPath,
        label: fileName,
        description:
          `Local GGUF Qwen Image Edit checkpoint at ${ggufPath}. ${APP_DISPLAY_NAME} runs this through the vendored ComfyUI backend shipped inside the repo, without requiring a separate ComfyUI install.`,
        backend: 'comfyui',
        source: 'local-gguf',
        loadStrategy: 'comfyui-workflow',
        family: 'qwen-image-edit',
        supported: true,
        supportReason: null,
        baseModelId: null,
        path: ggufPath
      };
    }

    return {
      id: ggufPath,
      label: fileName,
      description:
        `Local GGUF Qwen Image checkpoint at ${ggufPath}. Uses the Qwen/Qwen-Image base pipeline and may download missing base components the first time it loads.`,
      backend: 'diffusers',
      source: 'local-gguf',
      loadStrategy: 'diffusers-gguf',
      family: 'qwen-image',
      supported: true,
      supportReason: null,
      baseModelId: 'Qwen/Qwen-Image',
      path: ggufPath
    };
  }

  if (architecture === 'wan') {
    return {
      id: ggufPath,
      label: fileName,
      description:
        `Local GGUF Wan checkpoint at ${ggufPath}. Wan GGUF models are held for Video Gen, so they are shown here but cannot be selected for Image Gen yet.`,
      backend: 'diffusers',
      source: 'local-gguf',
      loadStrategy: 'diffusers-gguf',
      family: 'wan-video',
      supported: false,
      supportReason:
        'Wan GGUF models target video or image-to-video flows, which arrive in a later Milestone 6 slice.',
      baseModelId: null,
      path: ggufPath
    };
  }

  if (architecture === 'flux') {
    return {
      id: ggufPath,
      label: fileName,
      description:
        `Local GGUF FLUX-style checkpoint at ${ggufPath}. FLUX GGUF loading is not wired into the desktop worker yet.`,
      backend: 'diffusers',
      source: 'local-gguf',
      loadStrategy: 'diffusers-gguf',
      family: 'unknown',
      supported: false,
      supportReason: 'This GGUF family has not been wired into the desktop worker yet.',
      baseModelId: null,
      path: ggufPath
    };
  }

  return {
    id: ggufPath,
    label: fileName,
    description:
      `Local GGUF checkpoint at ${ggufPath}. ${APP_DISPLAY_NAME} could not determine a supported image pipeline family for this file.`,
    backend: 'diffusers',
    source: 'local-gguf',
    loadStrategy: 'diffusers-gguf',
    family: 'unknown',
    supported: false,
    supportReason:
      'Unknown GGUF architecture. The worker only enables image-ready GGUF families it can load safely.',
    baseModelId: null,
    path: ggufPath
  };
}

export function discoverImageGenerationModels(
  additionalModelsDirectory?: string | null
): ImageGenerationModelCatalog {
  const normalizedDirectory = normalizeDirectory(additionalModelsDirectory);
  const warnings: string[] = [];
  const optionsById = new Map<string, ImageGenerationModelOption>([
    [builtinImageGenerationModelOption.id, builtinImageGenerationModelOption]
  ]);

  if (!normalizedDirectory) {
    return imageGenerationModelCatalogSchema.parse({
      additionalModelsDirectory: null,
      options: Array.from(optionsById.values()),
      warnings
    });
  }

  if (!existsSync(normalizedDirectory)) {
    warnings.push(`The models directory "${normalizedDirectory}" does not exist.`);
    return imageGenerationModelCatalogSchema.parse({
      additionalModelsDirectory: normalizedDirectory,
      options: Array.from(optionsById.values()),
      warnings
    });
  }

  if (!isExistingDirectory(normalizedDirectory)) {
    warnings.push(`The models path "${normalizedDirectory}" is not a directory.`);
    return imageGenerationModelCatalogSchema.parse({
      additionalModelsDirectory: normalizedDirectory,
      options: Array.from(optionsById.values()),
      warnings
    });
  }

  let skippedIncompatibleDiffusersCount = 0;
  let supportedGgufCount = 0;
  let unsupportedGgufCount = 0;

  for (const modelDirectory of findDiffusersDirectories(normalizedDirectory)) {
    const className = readDiffusersClassName(modelDirectory);

    if (!isCompatibleDiffusersPipeline(className)) {
      skippedIncompatibleDiffusersCount += 1;
      continue;
    }

    pushOption(optionsById, {
      id: modelDirectory,
      label: path.basename(modelDirectory),
      description: `Local diffusers pipeline at ${modelDirectory}`,
      backend: 'diffusers',
      source: 'local-directory',
      loadStrategy: 'diffusers-directory',
      family: 'diffusers',
      supported: true,
      supportReason: null,
      baseModelId: null,
      path: modelDirectory
    });
  }

  for (const checkpointPath of findCheckpointFiles(normalizedDirectory)) {
    pushOption(optionsById, {
      id: checkpointPath,
      label: path.basename(checkpointPath),
      description:
        `Local checkpoint file at ${checkpointPath}. Loaded best-effort through diffusers single-file support.`,
      backend: 'diffusers',
      source: 'local-checkpoint',
      loadStrategy: 'diffusers-single-file',
      family: 'diffusers',
      supported: true,
      supportReason: null,
      baseModelId: null,
      path: checkpointPath
    });
  }

  for (const ggufPath of findGgufFiles(normalizedDirectory)) {
    const option = describeGgufModel(ggufPath);

    if (option.supported) {
      supportedGgufCount += 1;
    } else {
      unsupportedGgufCount += 1;
    }

    pushOption(optionsById, option);
  }

  if (skippedIncompatibleDiffusersCount > 0) {
    warnings.push(
      `Skipped ${skippedIncompatibleDiffusersCount} local diffusers model` +
        `${skippedIncompatibleDiffusersCount === 1 ? '' : 's'} that require non-text inputs or unsupported pipeline types.`
    );
  }

  if (supportedGgufCount > 0 || unsupportedGgufCount > 0) {
    warnings.push(
      `Discovered ${supportedGgufCount + unsupportedGgufCount} GGUF model` +
        `${supportedGgufCount + unsupportedGgufCount === 1 ? '' : 's'}: ${supportedGgufCount} ready to load now, ${unsupportedGgufCount} still gated behind unsupported families or later flows.`
    );
  }

  if (optionsById.size === 1) {
    warnings.push(
      'No compatible local image-generation models were found. Discovery currently checks diffusers model directories, checkpoint files, and GGUF transformer checkpoints.'
    );
  }

  return imageGenerationModelCatalogSchema.parse({
    additionalModelsDirectory: normalizedDirectory,
    options: Array.from(optionsById.values()),
    warnings
  });
}
