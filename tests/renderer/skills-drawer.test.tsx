// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsDrawer } from '@renderer/components/skills-drawer';

describe('SkillsDrawer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a new skill through the wizard flow', async () => {
    const onCreateSkill = vi.fn().mockResolvedValue(undefined);

    render(
      <SkillsDrawer
        onClose={vi.fn()}
        onCreateSkill={onCreateSkill}
        onDeleteSkill={vi.fn()}
        onUpdateSkill={vi.fn()}
        open
        skills={[]}
      />
    );

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Grounded Reviewer' }
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Review code with source-backed findings.' }
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Act like a grounded reviewer and cite evidence.' }
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create skill' }));

    await waitFor(() => {
      expect(onCreateSkill).toHaveBeenCalledWith({
        title: 'Grounded Reviewer',
        description: 'Review code with source-backed findings.',
        prompt: 'Act like a grounded reviewer and cite evidence.'
      });
    });
  });

  it('edits and deletes an existing user skill', async () => {
    const onUpdateSkill = vi.fn().mockResolvedValue(undefined);
    const onDeleteSkill = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <SkillsDrawer
        onClose={vi.fn()}
        onCreateSkill={vi.fn()}
        onDeleteSkill={onDeleteSkill}
        onUpdateSkill={onUpdateSkill}
        open
        skills={[
          {
            id: 'custom-reviewer',
            title: 'Custom Reviewer',
            description: 'Original description',
            prompt: 'Original prompt',
            source: 'user',
            readOnly: false,
            createdAt: '2026-04-19T00:00:00.000Z',
            updatedAt: '2026-04-19T00:00:00.000Z'
          }
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Updated description' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Updated prompt' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(onUpdateSkill).toHaveBeenCalledWith({
        skillId: 'custom-reviewer',
        title: 'Custom Reviewer',
        description: 'Updated description',
        prompt: 'Updated prompt'
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(onDeleteSkill).toHaveBeenCalledWith('custom-reviewer');
    });
  });
});
