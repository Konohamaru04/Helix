import type {
  ImageGenerationModelCatalog,
  ImageGenerationModelOption
} from '@bridge/ipc/contracts';

export type WanNoiseVariant = 'high' | 'low' | 'unknown';

function getTrailingPathSegment(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function looksLikeLocalModelId(modelId: string): boolean {
  const normalized = modelId.trim();
  return (
    normalized.includes('\\') ||
    normalized.startsWith('.') ||
    normalized.startsWith('/') ||
    (normalized.length > 1 && normalized[1] === ':')
  );
}

function inferConfiguredOptionMetadata(modelId: string) {
  if (/\.gguf$/i.test(modelId)) {
    const label = getTrailingPathSegment(modelId);
    const isEditModel = /edit/i.test(label);
    const isWanVideoModel = /wan|high_noise|low_noise|q8high|q8low/i.test(label);

    if (isWanVideoModel) {
      return {
        backend: 'comfyui' as const,
        source: 'configured' as const,
        loadStrategy: 'comfyui-workflow' as const,
        family: 'wan-video' as const,
        supported: false,
        supportReason:
          'Wan GGUF checkpoints are reserved for image-to-video jobs, not Image Gen.',
        baseModelId: null
      };
    }

    return {
      backend: 'comfyui' as const,
      source: 'configured' as const,
      loadStrategy: 'comfyui-workflow' as const,
      family: isEditModel ? ('qwen-image-edit' as const) : ('unknown' as const),
      supported: true,
      supportReason: null,
      baseModelId: null
    };
  }

  const looksCheckpoint = /\.(safetensors|ckpt|pt|pth)$/i.test(modelId);

  return {
    backend: 'diffusers' as const,
    source: 'configured' as const,
    loadStrategy: looksCheckpoint
      ? ('diffusers-single-file' as const)
      : ('diffusers-directory' as const),
    family: 'diffusers' as const,
    supported: true,
    supportReason: null,
    baseModelId: null
  };
}

export function getWanNoiseVariant(modelId: string | null | undefined): WanNoiseVariant {
  if (!modelId) {
    return 'unknown';
  }

  const label = getTrailingPathSegment(modelId).toLowerCase();

  if (
    label.includes('high_noise') ||
    label.includes('high-noise') ||
    label.includes('highnoise') ||
    label.includes('q8high') ||
    label.includes('_high') ||
    label.includes('-high')
  ) {
    return 'high';
  }

  if (
    label.includes('low_noise') ||
    label.includes('low-noise') ||
    label.includes('lownoise') ||
    label.includes('q8low') ||
    label.includes('_low') ||
    label.includes('-low')
  ) {
    return 'low';
  }

  return 'unknown';
}

export function getConfiguredImageGenerationModelOption(
  modelId: string | null | undefined
): ImageGenerationModelOption | null {
  if (!modelId) {
    return null;
  }

  if (modelId === 'builtin:placeholder') {
    return {
      id: modelId,
      label: 'Built-in placeholder',
      description: 'Instant local placeholder image for queue, UI, and pipeline testing.',
      backend: 'placeholder',
      source: 'builtin',
      loadStrategy: 'placeholder',
      family: 'placeholder',
      supported: true,
      supportReason: null,
      baseModelId: null,
      path: null
    };
  }

  const looksLocalPath = looksLikeLocalModelId(modelId);
  const metadata = inferConfiguredOptionMetadata(modelId);

  return {
    id: modelId,
    label: getTrailingPathSegment(modelId),
    description: `Configured image model at ${modelId}`,
    backend: metadata.backend,
    source: metadata.source,
    loadStrategy: looksLocalPath ? metadata.loadStrategy : 'remote-repo',
    family: looksLocalPath ? metadata.family : 'diffusers',
    supported: looksLocalPath ? metadata.supported : true,
    supportReason: looksLocalPath ? metadata.supportReason : null,
    baseModelId: looksLocalPath ? metadata.baseModelId : null,
    path: looksLocalPath ? modelId : null
  };
}

export function getImageGenerationModelLabel(
  modelId: string | null | undefined,
  catalog: ImageGenerationModelCatalog | null
): string | null {
  if (!modelId) {
    return null;
  }

  return (
    catalog?.options.find((option) => option.id === modelId)?.label ??
    getConfiguredImageGenerationModelOption(modelId)?.label ??
    modelId
  );
}

export function getImageGenerationModelOptions(
  catalog: ImageGenerationModelCatalog | null,
  selectedModelId: string | null | undefined
): ImageGenerationModelOption[] {
  const options = [...(catalog?.options ?? [])];
  const selectedOption = getConfiguredImageGenerationModelOption(selectedModelId);

  if (selectedOption && !options.some((option) => option.id === selectedOption.id)) {
    options.push(selectedOption);
  }

  return options;
}

export function getVideoGenerationModelOptions(
  catalog: ImageGenerationModelCatalog | null,
  selectedModelId: string | null | undefined
): ImageGenerationModelOption[] {
  const options = (catalog?.options ?? []).filter((option) => option.family === 'wan-video');
  const selectedOption = getConfiguredImageGenerationModelOption(selectedModelId);

  if (
    selectedOption &&
    selectedOption.family === 'wan-video' &&
    !options.some((option) => option.id === selectedOption.id)
  ) {
    options.push(selectedOption);
  }

  return options;
}

export function getVideoGenerationHighNoiseModelOptions(
  catalog: ImageGenerationModelCatalog | null,
  selectedModelId: string | null | undefined
): ImageGenerationModelOption[] {
  return getVideoGenerationModelOptions(catalog, selectedModelId).filter(
    (option) =>
      option.id === selectedModelId || getWanNoiseVariant(option.id) !== 'low'
  );
}

export function getVideoGenerationLowNoiseModelOptions(
  catalog: ImageGenerationModelCatalog | null,
  selectedModelId: string | null | undefined
): ImageGenerationModelOption[] {
  return getVideoGenerationModelOptions(catalog, selectedModelId).filter(
    (option) =>
      option.id === selectedModelId || getWanNoiseVariant(option.id) !== 'high'
  );
}
