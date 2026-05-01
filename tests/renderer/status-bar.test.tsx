// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StatusBar } from '@renderer/components/status-bar';

describe('StatusBar', () => {
  it('shows Ollama and NVIDIA status while hiding Python and VRAM when Python is healthy', () => {
    render(
      <StatusBar
        onOpenAgents={vi.fn()}
        onOpenPlan={vi.fn()}
        onOpenQueue={vi.fn()}
        onOpenGallery={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenPersonas={vi.fn()}
        onOpenSettings={vi.fn()}
        activeTextBackend="ollama"
        onTextBackendChange={vi.fn()}
        selectedModel=""
        availableModels={[]}
        onSelectedModelChange={vi.fn()}
        selectedThinkMode=""
        onSelectedThinkModeChange={vi.fn()}
        systemStatus={{
          appVersion: '0.1.0',
          database: {
            ready: true,
            path: 'E:/tmp/ollama-desktop.sqlite'
          },
          activeTextBackend: 'ollama',
          ollama: {
            reachable: true,
            baseUrl: 'http://127.0.0.1:11434',
            checkedAt: '2026-04-12T00:00:00.000Z',
            error: null,
            models: [{ name: 'llama3.2:latest', size: null, digest: null }]
          },
          nvidia: {
            configured: false,
            baseUrl: 'https://integrate.api.nvidia.com/v1',
            checkedAt: '2026-04-12T00:00:00.000Z',
            error: 'Add an NVIDIA API key in Settings to use this backend.',
            models: [{ name: 'meta/llama-3.1-8b-instruct', size: null, digest: null }]
          },
          python: {
            reachable: true,
            url: 'http://127.0.0.1:8765',
            checkedAt: '2026-04-12T00:00:00.000Z',
            pid: 1234,
            error: null,
            runtime: 'E:/OllamaDesktop/python_embeded/python.exe',
            modelManager: {
              loadedModel: null,
              loadedBackend: null,
              device: 'cuda:0',
              lastError: null
            },
            vram: {
              device: 'cuda:0',
              cudaAvailable: true,
              totalMb: 16384,
              freeMb: 15360,
              reservedMb: 512,
              allocatedMb: 256
            }
          },
          pendingRequestCount: 0
        }}
      />
    );

    expect(screen.getByText('1 model(s)')).toBeInTheDocument();
    expect(screen.getByText('Add an NVIDIA API key in Settings to use this backend.')).toBeInTheDocument();
    expect(screen.queryByText('Python')).not.toBeInTheDocument();
    expect(screen.queryByText('VRAM')).not.toBeInTheDocument();
    expect(screen.queryByText(/MiB/)).not.toBeInTheDocument();
  });

  it('shows Python only when the Python server is unreachable', () => {
    render(
      <StatusBar
        onOpenAgents={vi.fn()}
        onOpenPlan={vi.fn()}
        onOpenQueue={vi.fn()}
        onOpenGallery={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenPersonas={vi.fn()}
        onOpenSettings={vi.fn()}
        activeTextBackend="ollama"
        onTextBackendChange={vi.fn()}
        selectedModel=""
        availableModels={[]}
        onSelectedModelChange={vi.fn()}
        selectedThinkMode=""
        onSelectedThinkModeChange={vi.fn()}
        systemStatus={{
          appVersion: '0.1.0',
          database: {
            ready: true,
            path: 'E:/tmp/ollama-desktop.sqlite'
          },
          activeTextBackend: 'ollama',
          ollama: {
            reachable: true,
            baseUrl: 'http://127.0.0.1:11434',
            checkedAt: '2026-04-12T00:00:00.000Z',
            error: null,
            models: [{ name: 'llama3.2:latest', size: null, digest: null }]
          },
          nvidia: {
            configured: true,
            baseUrl: 'https://integrate.api.nvidia.com/v1',
            checkedAt: '2026-04-12T00:00:00.000Z',
            error: null,
            models: [{ name: 'meta/llama-3.1-8b-instruct', size: null, digest: null }]
          },
          python: {
            reachable: false,
            url: 'http://127.0.0.1:8765',
            checkedAt: '2026-04-12T00:00:00.000Z',
            pid: null,
            error: 'Python worker offline',
            runtime: 'E:/OllamaDesktop/python_embeded/python.exe',
            modelManager: null,
            vram: null
          },
          pendingRequestCount: 0
        }}
      />
    );

    expect(screen.getByText('Python')).toBeInTheDocument();
    expect(screen.getByText('Python worker offline')).toBeInTheDocument();
    expect(screen.queryByText('VRAM')).not.toBeInTheDocument();
  });

  it('opens the agents drawer from the status bar', () => {
    const onOpenAgents = vi.fn();

    render(
      <StatusBar
        onOpenAgents={onOpenAgents}
        onOpenPlan={vi.fn()}
        onOpenQueue={vi.fn()}
        onOpenGallery={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenPersonas={vi.fn()}
        onOpenSettings={vi.fn()}
        activeTextBackend="ollama"
        onTextBackendChange={vi.fn()}
        selectedModel=""
        availableModels={[]}
        onSelectedModelChange={vi.fn()}
        selectedThinkMode=""
        onSelectedThinkModeChange={vi.fn()}
        systemStatus={null}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));

    expect(onOpenAgents).toHaveBeenCalledTimes(1);
  });

  it('opens the gallery from the status bar', () => {
    const onOpenGallery = vi.fn();

    render(
      <StatusBar
        onOpenAgents={vi.fn()}
        onOpenPlan={vi.fn()}
        onOpenQueue={vi.fn()}
        onOpenGallery={onOpenGallery}
        onOpenSkills={vi.fn()}
        onOpenPersonas={vi.fn()}
        onOpenSettings={vi.fn()}
        activeTextBackend="ollama"
        onTextBackendChange={vi.fn()}
        selectedModel=""
        availableModels={[]}
        onSelectedModelChange={vi.fn()}
        selectedThinkMode=""
        onSelectedThinkModeChange={vi.fn()}
        systemStatus={null}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Gallery' }));

    expect(onOpenGallery).toHaveBeenCalledTimes(1);
  });

  it('uses themed dropdowns for footer model controls', () => {
    const onTextBackendChange = vi.fn();
    const onSelectedModelChange = vi.fn();
    const onSelectedThinkModeChange = vi.fn();

    render(
      <StatusBar
        onOpenAgents={vi.fn()}
        onOpenPlan={vi.fn()}
        onOpenQueue={vi.fn()}
        onOpenGallery={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenPersonas={vi.fn()}
        onOpenSettings={vi.fn()}
        activeTextBackend="ollama"
        onTextBackendChange={onTextBackendChange}
        selectedModel=""
        availableModels={['qwen3:latest']}
        onSelectedModelChange={onSelectedModelChange}
        selectedThinkMode=""
        onSelectedThinkModeChange={onSelectedThinkModeChange}
        systemStatus={null}
      />
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Text backend' }));
    fireEvent.click(screen.getByRole('option', { name: 'NVIDIA' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    fireEvent.click(screen.getByRole('option', { name: 'qwen3:latest' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Think mode' }));
    fireEvent.click(screen.getByRole('option', { name: 'Think high' }));

    expect(onTextBackendChange).toHaveBeenCalledWith('nvidia');
    expect(onSelectedModelChange).toHaveBeenCalledWith('qwen3:latest');
    expect(onSelectedThinkModeChange).toHaveBeenCalledWith('high');
  });
});
