// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StatusBar } from '@renderer/components/status-bar';

describe('StatusBar', () => {
  it('renders GPU usage as used VRAM instead of free VRAM', () => {
    render(
      <StatusBar
        onOpenQueue={vi.fn()}
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

    expect(screen.getByText('1.0 / 16.0 GB used')).toBeInTheDocument();
  });
});
