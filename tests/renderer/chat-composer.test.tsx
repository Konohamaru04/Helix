// @vitest-environment jsdom

import type { ComponentProps } from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '@renderer/components/chat-composer';

function renderComposer(
  overrides: Partial<ComponentProps<typeof ChatComposer>> = {}
) {
  const props: ComponentProps<typeof ChatComposer> = {
    activeWorkspaceName: 'General',
    attachments: [],
    availableSkills: [],
    disabled: false,
    editing: false,
    generationMode: 'chat',
    imageGenerationAvailable: true,
    imageGenerationModelLabel: 'Built-in placeholder',
    videoGenerationAvailable: false,
    videoGenerationModelLabel: null,
    streaming: false,
    knowledgeDocumentCount: 0,
    onAttach: vi.fn().mockResolvedValue(undefined),
    onCancelEdit: vi.fn(),
    onEnterImageMode: vi.fn(),
    onEnterVideoMode: vi.fn(),
    onExitImageMode: vi.fn(),
    onExitVideoMode: vi.fn(),
    onToggleWireframeMode: vi.fn(),
    onImportWorkspaceKnowledge: vi.fn().mockResolvedValue(undefined),
    onPromptChange: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    prompt: '',
    workspaceActionsEnabled: true,
    workspaceRootPath: null,
    ...overrides
  };

  render(<ChatComposer {...props} />);
}

describe('ChatComposer', () => {
  it('uses automatic routing copy instead of manual tool and skill picker buttons', () => {
    renderComposer({
      prompt: 'Summarize the workspace docs'
    });

    expect(screen.queryByRole('button', { name: 'Tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skills' })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Enter sends. Shift+Enter keeps writing. Models choose tools and skills automatically when needed.'
      )
    ).toBeInTheDocument();
  });

  it('opens the workspace menu with docs actions and no folder rebinding controls', () => {
    renderComposer({
      knowledgeDocumentCount: 2,
      workspaceRootPath: 'E:/Projects/demo-app'
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open workspace settings' }));

    expect(screen.getByRole('menuitem', { name: 'Add docs' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /folder/i })).not.toBeInTheDocument();
  });

  it('shows a visible processing indicator while a submit is starting', () => {
    renderComposer({
      disabled: true,
      prompt: 'Describe this scene',
      submitHint: 'The base model is choosing the best route.',
      submitLabel: 'Analyzing...',
      submitting: true,
      workspaceActionsEnabled: false
    });

    expect(screen.getByRole('status')).toHaveTextContent('Analyzing...');
    expect(screen.getByRole('status')).toHaveTextContent(
      'The base model is choosing the best route.'
    );
    expect(screen.getByRole('button', { name: 'Analyzing...' })).toBeDisabled();
  });

  it('keeps the prompt area at a fixed height and scrolls long drafts internally', () => {
    renderComposer({
      prompt: 'Line 1\n'.repeat(12)
    });

    expect(screen.getByLabelText('Message prompt')).toHaveClass('h-28', 'overflow-y-auto');
  });

  it('shows Wan image-to-video guidance when video mode is active', () => {
    renderComposer({
      generationMode: 'video',
      videoGenerationAvailable: true,
      videoGenerationModelLabel: 'DasiwaWAN22I2V14BSynthseduction_q8High.gguf',
      prompt: 'Animate this portrait with a slow dolly-in.',
      attachments: [
        {
          id: '70000000-0000-4000-8000-000000000099',
          fileName: 'start-frame.png',
          filePath: 'E:/images/start-frame.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          extractedText: null,
          createdAt: '2026-04-08T00:00:00.000Z'
        }
      ]
    });

    expect(screen.getByText('Image to video')).toBeInTheDocument();
    expect(screen.getByText(/Attach exactly one start image/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Render video' })).toBeInTheDocument();
  });

  it('toggles wireframe mode from the composer action row', () => {
    const onToggleWireframeMode = vi.fn();
    renderComposer({
      onToggleWireframeMode,
      prompt: 'A CRM for field sales teams'
    });

    fireEvent.click(screen.getByRole('button', { name: 'Enable wireframe mode' }));

    expect(onToggleWireframeMode).toHaveBeenCalledTimes(1);
  });

  it('shows wireframe guidance when wireframe mode is active', () => {
    renderComposer({
      generationMode: 'wireframe',
      prompt: 'A planning app for architects'
    });

    expect(screen.getByText('Wireframe mode')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wireframe' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Enter sends the wireframe brief. Shift+Enter keeps writing. Follow-up answers stay in this flow.'
      )
    ).toBeInTheDocument();
  });
});
