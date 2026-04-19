// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '@renderer/components/chat-composer';

describe('ChatComposer', () => {
  it('uses automatic routing copy instead of manual tool and skill picker buttons', () => {
    render(
      <ChatComposer
        activeWorkspaceName="General"
        attachments={[]}
        disabled={false}
        editing={false}
        generationMode={false}
        imageGenerationAvailable={true}
        imageGenerationModelLabel="Built-in placeholder"
        streaming={false}
        knowledgeDocumentCount={0}
        onAttach={vi.fn().mockResolvedValue(undefined)}
        onCancelEdit={vi.fn()}
        onEnterImageMode={vi.fn()}
        onExitImageMode={vi.fn()}
        onImportWorkspaceKnowledge={vi.fn().mockResolvedValue(undefined)}
        onPromptChange={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        prompt="Summarize the workspace docs"
        workspaceActionsEnabled
        workspaceRootPath={null}
      />
    );

    expect(screen.queryByRole('button', { name: 'Tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skills' })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Enter sends. Shift+Enter keeps writing. Models choose tools and skills automatically when needed.'
      )
    ).toBeInTheDocument();
  });

  it('opens the workspace menu with docs actions and no folder rebinding controls', () => {
    render(
      <ChatComposer
        activeWorkspaceName="General"
        attachments={[]}
        disabled={false}
        editing={false}
        generationMode={false}
        imageGenerationAvailable={true}
        imageGenerationModelLabel="Built-in placeholder"
        streaming={false}
        knowledgeDocumentCount={2}
        onAttach={vi.fn().mockResolvedValue(undefined)}
        onCancelEdit={vi.fn()}
        onEnterImageMode={vi.fn()}
        onExitImageMode={vi.fn()}
        onImportWorkspaceKnowledge={vi.fn().mockResolvedValue(undefined)}
        onPromptChange={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        prompt=""
        workspaceActionsEnabled
        workspaceRootPath="E:/Projects/demo-app"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open workspace settings' }));

    expect(screen.getByRole('menuitem', { name: 'Add docs' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /folder/i })).not.toBeInTheDocument();
  });

  it('shows a visible processing indicator while a submit is starting', () => {
    render(
      <ChatComposer
        activeWorkspaceName="General"
        attachments={[]}
        disabled={true}
        editing={false}
        generationMode={false}
        imageGenerationAvailable={true}
        imageGenerationModelLabel="Built-in placeholder"
        knowledgeDocumentCount={0}
        onAttach={vi.fn().mockResolvedValue(undefined)}
        onCancelEdit={vi.fn()}
        onEnterImageMode={vi.fn()}
        onExitImageMode={vi.fn()}
        onImportWorkspaceKnowledge={vi.fn().mockResolvedValue(undefined)}
        onPromptChange={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        prompt="Describe this scene"
        submitHint="The base model is choosing the best route."
        submitLabel="Analyzing..."
        submitting={true}
        streaming={false}
        workspaceActionsEnabled={false}
        workspaceRootPath={null}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('Analyzing...');
    expect(screen.getByRole('status')).toHaveTextContent(
      'The base model is choosing the best route.'
    );
    expect(screen.getByRole('button', { name: 'Analyzing...' })).toBeDisabled();
  });

  it('keeps the prompt area at a fixed height and scrolls long drafts internally', () => {
    render(
      <ChatComposer
        activeWorkspaceName="General"
        attachments={[]}
        disabled={false}
        editing={false}
        generationMode={false}
        imageGenerationAvailable={true}
        imageGenerationModelLabel="Built-in placeholder"
        knowledgeDocumentCount={0}
        onAttach={vi.fn().mockResolvedValue(undefined)}
        onCancelEdit={vi.fn()}
        onEnterImageMode={vi.fn()}
        onExitImageMode={vi.fn()}
        onImportWorkspaceKnowledge={vi.fn().mockResolvedValue(undefined)}
        onPromptChange={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        prompt={'Line 1\n'.repeat(12)}
        streaming={false}
        workspaceActionsEnabled={true}
        workspaceRootPath={null}
      />
    );

    expect(screen.getByLabelText('Message prompt')).toHaveClass('h-28', 'overflow-y-auto');
  });
});
