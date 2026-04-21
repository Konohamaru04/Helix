// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsDrawer } from '@renderer/components/settings-drawer';

const settings = {
  textInferenceBackend: 'ollama' as const,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1',
  nvidiaApiKey: '',
  defaultModel: 'llama3.2:latest',
  codingModel: 'qwen2.5-coder:latest',
  visionModel: 'qwen3-vl:8b',
  imageGenerationModel: 'builtin:placeholder',
  additionalModelsDirectory: null,
  videoGenerationModel: '',
  pythonPort: 8765,
  streamingMascotEnabled: true,
  theme: 'system' as const
};

const builtinCatalog = {
  additionalModelsDirectory: null,
  options: [
    {
      id: 'builtin:placeholder',
      label: 'Built-in placeholder',
      description: 'Instant local placeholder image for queue, UI, and pipeline testing.',
      backend: 'placeholder' as const,
      source: 'builtin' as const,
      loadStrategy: 'placeholder' as const,
      family: 'placeholder' as const,
      supported: true,
      supportReason: null,
      baseModelId: null,
      path: null
    }
  ],
  warnings: []
};

function createCapabilityProps() {
  return {
    capabilities: [
      {
        id: 'bash',
        title: 'Bash',
        description: 'Execute a bash command with bounded runtime and captured output.',
        command: '/bash',
        kind: 'tool' as const,
        permissionClass: 'always_confirm' as const,
        availability: 'available' as const,
        autoRoutable: true
      }
    ],
    capabilityPermissions: [],
    capabilityTasks: [],
    capabilitySchedules: [],
    capabilityAgents: [],
    capabilityTeams: [],
    capabilityWorktrees: [],
    capabilityPlanState: {
      conversationId: null,
      workspaceId: null,
      status: 'inactive' as const,
      summary: null,
      createdAt: null,
      updatedAt: null
    },
    capabilityAuditEvents: [],
    onGrantCapabilityPermission: vi.fn().mockResolvedValue(undefined),
    onRevokeCapabilityPermission: vi.fn().mockResolvedValue(undefined)
  };
}

function chooseCombobox(index: number, optionName: string | RegExp) {
  const combo = screen.getAllByRole('combobox')[index];

  expect(combo).toBeDefined();
  fireEvent.click(combo!);
  fireEvent.click(screen.getByRole('option', { name: optionName }));
}

describe('SettingsDrawer', () => {
  it('renders role-based model routing controls and only keeps video generation disabled', () => {
    const capabilityProps = createCapabilityProps();

    render(
      <SettingsDrawer
        {...capabilityProps}
        imageGenerationModelCatalog={builtinCatalog}
        onClose={() => undefined}
        onDiscoverImageModels={vi.fn().mockResolvedValue(builtinCatalog)}
        onPickAdditionalModelsDirectory={vi.fn().mockResolvedValue(null)}
        onSave={vi.fn().mockResolvedValue(undefined)}
        nvidiaModels={['meta/llama-3.1-8b-instruct']}
        ollamaModels={['llama3.2:latest', 'qwen2.5-coder:latest', 'qwen3-vl:8b']}
        open
        settings={settings}
      />
    );

    expect(screen.getByText('Model routing')).toBeInTheDocument();
    expect(screen.getByText('Text backend')).toBeInTheDocument();
    expect(screen.getByText('General (base)')).toBeInTheDocument();
    expect(screen.getByText('Coding')).toBeInTheDocument();
    expect(screen.getByText('Vision')).toBeInTheDocument();
    expect(screen.getByText('Additional models directory')).toBeInTheDocument();
    expect(screen.getByText('Text backend connections')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Image Gen/i })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: /Video Gen/i })).toBeDisabled();
  });

  it('discovers local image models from a selected directory', async () => {
    const capabilityProps = createCapabilityProps();
    const onDiscoverImageModels = vi.fn().mockResolvedValue({
      additionalModelsDirectory: 'E:\\ComfyUI_windows_portable\\ComfyUI\\models',
      options: [
        ...builtinCatalog.options,
        {
          id: 'E:\\ComfyUI_windows_portable\\ComfyUI\\models\\checkpoints\\model.safetensors',
          label: 'model.safetensors',
          description:
            'Local checkpoint file at E:\\ComfyUI_windows_portable\\ComfyUI\\models\\checkpoints\\model.safetensors. Loaded best-effort through diffusers single-file support.',
          backend: 'diffusers' as const,
          source: 'local-checkpoint' as const,
          loadStrategy: 'diffusers-single-file' as const,
          family: 'diffusers' as const,
          supported: true,
          supportReason: null,
          baseModelId: null,
          path: 'E:\\ComfyUI_windows_portable\\ComfyUI\\models\\checkpoints\\model.safetensors'
        }
      ],
      warnings: []
    });

    render(
      <SettingsDrawer
        {...capabilityProps}
        imageGenerationModelCatalog={builtinCatalog}
        onClose={() => undefined}
        onDiscoverImageModels={onDiscoverImageModels}
        onPickAdditionalModelsDirectory={vi
          .fn()
          .mockResolvedValue('E:\\ComfyUI_windows_portable\\ComfyUI\\models')}
        onSave={vi.fn().mockResolvedValue(undefined)}
        nvidiaModels={['meta/llama-3.1-8b-instruct']}
        ollamaModels={['llama3.2:latest', 'qwen2.5-coder:latest', 'qwen3-vl:8b']}
        open
        settings={settings}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));

    await waitFor(() => {
      expect(onDiscoverImageModels).toHaveBeenCalledWith(
        'E:\\ComfyUI_windows_portable\\ComfyUI\\models'
      );
    });

    expect(
      screen.getByText('E:\\ComfyUI_windows_portable\\ComfyUI\\models')
    ).toBeInTheDocument();
  });

  it('shows Qwen Image Edit GGUF models as selectable workflow-ready entries', () => {
    const capabilityProps = createCapabilityProps();

    render(
      <SettingsDrawer
        {...capabilityProps}
        imageGenerationModelCatalog={{
          additionalModelsDirectory: 'E:\\ComfyUI_windows_portable\\ComfyUI\\models',
          options: [
            ...builtinCatalog.options,
            {
              id: 'E:\\ComfyUI_windows_portable\\ComfyUI\\models\\diffusion_models\\zimageTurbo.gguf',
              label: 'zimageTurbo.gguf',
              description: 'Local GGUF Qwen Image checkpoint.',
              backend: 'diffusers',
              source: 'local-gguf',
              loadStrategy: 'diffusers-gguf',
              family: 'qwen-image',
              supported: true,
              supportReason: null,
              baseModelId: 'Qwen/Qwen-Image',
              path: 'E:\\ComfyUI_windows_portable\\ComfyUI\\models\\diffusion_models\\zimageTurbo.gguf'
            },
            {
              id: 'E:\\LocalModels\\diffusion_models\\Qwen-Image-Edit.gguf',
              label: 'Qwen-Image-Edit.gguf',
              description: 'Local GGUF Qwen Image Edit checkpoint.',
              backend: 'comfyui',
              source: 'local-gguf',
              loadStrategy: 'comfyui-workflow',
              family: 'qwen-image-edit',
              supported: true,
              supportReason: null,
              baseModelId: null,
              path: 'E:\\LocalModels\\diffusion_models\\Qwen-Image-Edit.gguf'
            }
          ],
          warnings: []
        }}
        onClose={() => undefined}
        onDiscoverImageModels={vi.fn().mockResolvedValue(builtinCatalog)}
        onPickAdditionalModelsDirectory={vi.fn().mockResolvedValue(null)}
        onSave={vi.fn().mockResolvedValue(undefined)}
        nvidiaModels={['meta/llama-3.1-8b-instruct']}
        ollamaModels={['llama3.2:latest', 'qwen2.5-coder:latest', 'qwen3-vl:8b']}
        open
        settings={settings}
      />
    );

    fireEvent.click(screen.getByRole('combobox', { name: /Image Gen/i }));

    expect(screen.getByRole('option', { name: 'zimageTurbo.gguf' })).toBeEnabled();
    expect(screen.getByRole('option', { name: 'Qwen-Image-Edit.gguf' })).toBeEnabled();
  });

  it('saves updated routing roles and the selected models directory', async () => {
    const capabilityProps = createCapabilityProps();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsDrawer
        {...capabilityProps}
        imageGenerationModelCatalog={builtinCatalog}
        onClose={() => undefined}
        onDiscoverImageModels={vi.fn().mockResolvedValue(builtinCatalog)}
        onPickAdditionalModelsDirectory={vi.fn().mockResolvedValue(null)}
        onSave={onSave}
        nvidiaModels={['meta/llama-3.1-8b-instruct']}
        ollamaModels={['llama3.2:latest', 'qwen2.5-coder:latest', 'qwen3-vl:8b']}
        open
        settings={settings}
      />
    );

    chooseCombobox(1, 'qwen2.5-coder:latest');
    chooseCombobox(2, 'llama3.2:latest');
    chooseCombobox(3, 'qwen3-vl:8b');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        textInferenceBackend: 'ollama',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1',
        nvidiaApiKey: '',
        defaultModel: 'qwen2.5-coder:latest',
        codingModel: 'llama3.2:latest',
        visionModel: 'qwen3-vl:8b',
        imageGenerationModel: 'builtin:placeholder',
        additionalModelsDirectory: null,
        videoGenerationModel: '',
        pythonPort: 8765,
        streamingMascotEnabled: true,
        theme: 'system'
      });
    });
  });

  it('saves the streaming mascot switch state', async () => {
    const capabilityProps = createCapabilityProps();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsDrawer
        {...capabilityProps}
        imageGenerationModelCatalog={builtinCatalog}
        onClose={() => undefined}
        onDiscoverImageModels={vi.fn().mockResolvedValue(builtinCatalog)}
        onPickAdditionalModelsDirectory={vi.fn().mockResolvedValue(null)}
        onSave={onSave}
        nvidiaModels={['meta/llama-3.1-8b-instruct']}
        ollamaModels={['llama3.2:latest', 'qwen2.5-coder:latest', 'qwen3-vl:8b']}
        open
        settings={settings}
      />
    );

    const mascotSwitch = screen.getByRole('switch', { name: /Streaming mascot/i });

    expect(mascotSwitch).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(mascotSwitch);
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        textInferenceBackend: 'ollama',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1',
        nvidiaApiKey: '',
        defaultModel: 'llama3.2:latest',
        codingModel: 'qwen2.5-coder:latest',
        visionModel: 'qwen3-vl:8b',
        imageGenerationModel: 'builtin:placeholder',
        additionalModelsDirectory: null,
        videoGenerationModel: '',
        pythonPort: 8765,
        streamingMascotEnabled: false,
        theme: 'system'
      });
    });
  });

  it('saves NVIDIA backend settings and disables vision routing in that mode', async () => {
    const capabilityProps = createCapabilityProps();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsDrawer
        {...capabilityProps}
        imageGenerationModelCatalog={builtinCatalog}
        onClose={() => undefined}
        onDiscoverImageModels={vi.fn().mockResolvedValue(builtinCatalog)}
        onPickAdditionalModelsDirectory={vi.fn().mockResolvedValue(null)}
        onSave={onSave}
        nvidiaModels={['meta/llama-3.1-8b-instruct']}
        ollamaModels={['llama3.2:latest', 'qwen2.5-coder:latest', 'qwen3-vl:8b']}
        open
        settings={settings}
      />
    );

    chooseCombobox(0, 'NVIDIA');
    chooseCombobox(1, 'meta/llama-3.1-8b-instruct');
    fireEvent.change(screen.getByPlaceholderText('nvapi-...'), {
      target: { value: 'nvapi-test-key' }
    });

    expect(screen.getAllByRole('combobox')[3]).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        textInferenceBackend: 'nvidia',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1',
        nvidiaApiKey: 'nvapi-test-key',
        defaultModel: 'meta/llama-3.1-8b-instruct',
        codingModel: 'qwen2.5-coder:latest',
        visionModel: 'qwen3-vl:8b',
        imageGenerationModel: 'builtin:placeholder',
        additionalModelsDirectory: null,
        videoGenerationModel: '',
        pythonPort: 8765,
        streamingMascotEnabled: true,
        theme: 'system'
      });
    });
  });

  it('shows permission-gated agentic tools and grants access from settings', async () => {
    const capabilityProps = createCapabilityProps();

    render(
      <SettingsDrawer
        {...capabilityProps}
        imageGenerationModelCatalog={builtinCatalog}
        onClose={() => undefined}
        onDiscoverImageModels={vi.fn().mockResolvedValue(builtinCatalog)}
        onPickAdditionalModelsDirectory={vi.fn().mockResolvedValue(null)}
        onSave={vi.fn().mockResolvedValue(undefined)}
        nvidiaModels={['meta/llama-3.1-8b-instruct']}
        ollamaModels={['llama3.2:latest', 'qwen2.5-coder:latest', 'qwen3-vl:8b']}
        open
        settings={settings}
      />
    );

    expect(screen.getByText('Agentic tools')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));

    await waitFor(() => {
      expect(capabilityProps.onGrantCapabilityPermission).toHaveBeenCalledWith('bash');
    });
  });
});
