// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationJobCard } from '@renderer/components/generation-job-card';

const completedJob = {
  id: '80000000-0000-4000-8000-000000000010',
  workspaceId: '50000000-0000-4000-8000-000000000001',
  conversationId: '20000000-0000-4000-8000-000000000001',
  kind: 'image' as const,
  mode: 'text-to-image' as const,
  workflowProfile: 'default' as const,
  status: 'completed' as const,
  prompt: 'Generate a city skyline',
  negativePrompt: null,
  model: 'builtin:placeholder',
  backend: 'placeholder' as const,
  width: 768,
  height: 768,
  steps: 6,
  guidanceScale: 4,
  seed: 1,
  progress: 1,
  stage: 'Completed',
  errorMessage: null,
  createdAt: '2026-04-09T00:00:00.000Z',
  updatedAt: '2026-04-09T00:00:01.000Z',
  startedAt: '2026-04-09T00:00:00.000Z',
  completedAt: '2026-04-09T00:00:01.000Z',
  referenceImages: [],
  artifacts: [
    {
      id: '81000000-0000-4000-8000-000000000010',
      jobId: '80000000-0000-4000-8000-000000000010',
      kind: 'image' as const,
      filePath: 'E:/generated/city.png',
      previewPath: 'E:/generated/city-preview.png',
      mimeType: 'image/png',
      width: 768,
      height: 768,
      createdAt: '2026-04-09T00:00:01.000Z'
    }
  ]
};

describe('GenerationJobCard', () => {
  beforeEach(() => {
    window.ollamaDesktop = {
      window: {
        minimize: vi.fn(),
        maximize: vi.fn(),
        close: vi.fn(),
        isMaximized: vi.fn().mockResolvedValue(false)
      },
      settings: {
        get: vi.fn(),
        update: vi.fn(),
        pickAdditionalModelsDirectory: vi.fn()
      },
      system: {
        getStatus: vi.fn()
      },
      generation: {
        startImage: vi.fn(),
        listImageModels: vi.fn(),
        listJobs: vi.fn(),
        cancelJob: vi.fn(),
        retryJob: vi.fn(),
        onJobEvent: vi.fn()
      },
      chat: {
        start: vi.fn(),
        pickAttachments: vi.fn(),
        editAndResend: vi.fn(),
        regenerateResponse: vi.fn(),
        cancelTurn: vi.fn(),
        deleteConversation: vi.fn(),
        pinMessage: vi.fn(),
        getAttachmentPreview: vi.fn().mockResolvedValue({
          dataUrl: 'data:image/png;base64,ZmFrZQ==',
          mimeType: 'image/png'
        }),
        openLocalPath: vi.fn().mockResolvedValue(undefined),
        listWorkspaces: vi.fn(),
        createWorkspace: vi.fn(),
        pickWorkspaceDirectory: vi.fn(),
        updateWorkspaceRoot: vi.fn(),
        deleteWorkspace: vi.fn(),
        listConversations: vi.fn(),
        searchConversations: vi.fn(),
        getConversationMessages: vi.fn(),
        listTools: vi.fn(),
        listSkills: vi.fn(),
        listKnowledgeDocuments: vi.fn(),
        importWorkspaceKnowledge: vi.fn(),
        importConversation: vi.fn(),
        exportConversation: vi.fn(),
        onStreamEvent: vi.fn()
      },
      capabilities: {
        listPermissions: vi.fn().mockResolvedValue([]),
        grantPermission: vi.fn(),
        revokePermission: vi.fn(),
        listTasks: vi.fn().mockResolvedValue([]),
        getTask: vi.fn().mockResolvedValue(null),
        deleteTask: vi.fn(),
        listSchedules: vi.fn().mockResolvedValue([]),
        listAgents: vi.fn().mockResolvedValue([]),
        listTeams: vi.fn().mockResolvedValue([]),
        listWorktrees: vi.fn().mockResolvedValue([]),
        getPlanState: vi.fn().mockResolvedValue({
          conversationId: null,
          status: 'inactive',
          summary: null,
          createdAt: null,
          updatedAt: null
        }),
        listAuditEvents: vi.fn().mockResolvedValue([])
      }
    };
  });

  it('loads a generated image preview and opens the image on click', async () => {
    render(<GenerationJobCard job={completedJob} showPrompt={false} />);

    await screen.findByRole('img', { name: completedJob.prompt });
    fireEvent.click(screen.getByRole('button', { name: 'Open generated image' }));

    await waitFor(() => {
      expect(window.ollamaDesktop.chat.openLocalPath).toHaveBeenCalledWith({
        filePath: 'E:/generated/city.png'
      });
    });
  });

  it('shows a stable unavailable state when preview loading fails', async () => {
    window.ollamaDesktop.chat.getAttachmentPreview = vi.fn().mockRejectedValue(
      new Error('Preview not permitted')
    );
    const failedPreviewJob: typeof completedJob = {
      ...completedJob,
      id: '80000000-0000-4000-8000-000000000011',
      artifacts: [
        {
          id: '81000000-0000-4000-8000-000000000011',
          jobId: '80000000-0000-4000-8000-000000000011',
          kind: 'image',
          filePath: 'E:/generated/city.png',
          previewPath: 'E:/generated/city-preview-missing.png',
          mimeType: 'image/png',
          width: 768,
          height: 768,
          createdAt: '2026-04-09T00:00:01.000Z'
        }
      ]
    };

    render(<GenerationJobCard job={failedPreviewJob} showPrompt={false} />);

    await waitFor(() => {
      expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
    });
  });

  it('renders a retry action for failed jobs', () => {
    const onRetry = vi.fn();

    render(
      <GenerationJobCard
        job={{
          ...completedJob,
          id: '80000000-0000-4000-8000-000000000012',
          status: 'failed',
          stage: 'Failed',
          errorMessage: 'Out of VRAM',
          artifacts: []
        }}
        onRetry={onRetry}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry job' }));

    expect(onRetry).toHaveBeenCalledWith('80000000-0000-4000-8000-000000000012');
  });
});
