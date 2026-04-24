// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryDrawer } from '@renderer/components/gallery-drawer';
import type { GenerationGalleryItem } from '@bridge/ipc/contracts';

const imageItem: GenerationGalleryItem = {
  id: '81000000-0000-4000-8000-000000000010',
  artifactId: '81000000-0000-4000-8000-000000000010',
  jobId: '80000000-0000-4000-8000-000000000010',
  kind: 'image',
  filePath: 'E:/generated/city.png',
  previewPath: 'E:/generated/city-preview.png',
  mimeType: 'image/png',
  width: 768,
  height: 768,
  frameCount: null,
  frameRate: null,
  prompt: 'Generated city',
  model: 'builtin:placeholder',
  createdAt: '2026-04-09T00:00:01.000Z',
  completedAt: '2026-04-09T00:00:01.000Z'
};

describe('GalleryDrawer', () => {
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
        startVideo: vi.fn(),
        listImageModels: vi.fn(),
        listJobs: vi.fn(),
        listGallery: vi.fn(),
        cancelJob: vi.fn(),
        retryJob: vi.fn(),
        deleteArtifact: vi.fn(),
        onJobEvent: vi.fn()
      },
      chat: {
        start: vi.fn(),
        confirmGenerationIntent: vi.fn(),
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
        getMessage: vi.fn().mockResolvedValue(null),
        listTools: vi.fn(),
        listSkills: vi.fn(),
        createSkill: vi.fn(),
        updateSkill: vi.fn(),
        deleteSkill: vi.fn(),
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

  it('opens generated images in an in-app preview instead of the OS shell', async () => {
    render(<GalleryDrawer galleryItems={[imageItem]} open />);

    await screen.findByRole('img', { name: imageItem.prompt ?? '' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Open generated image' })[0]!);

    expect(await screen.findByRole('dialog', { name: 'Preview city.png' })).toBeInTheDocument();

    await waitFor(() => {
      expect(window.ollamaDesktop.chat.getAttachmentPreview).toHaveBeenCalledWith({
        filePath: 'E:/generated/city.png'
      });
    });
    expect(window.ollamaDesktop.chat.openLocalPath).not.toHaveBeenCalled();
  });
});
