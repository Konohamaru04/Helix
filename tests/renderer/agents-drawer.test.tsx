// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentsDrawer } from '@renderer/components/agents-drawer';

describe('AgentsDrawer', () => {
  it('shows agent sessions and switches transcript focus when a session is selected', () => {
    render(
      <AgentsDrawer
        agents={[
          {
            id: '10000000-0000-4000-8000-000000000001',
            title: 'Research agent',
            status: 'running',
            systemPrompt: 'You are a research helper.',
            teamId: '20000000-0000-4000-8000-000000000001',
            parentConversationId: '30000000-0000-4000-8000-000000000001',
            createdAt: '2026-04-19T10:00:00.000Z',
            updatedAt: '2026-04-19T10:05:00.000Z',
            lastMessageAt: '2026-04-19T10:05:00.000Z',
            messages: [
              {
                id: '40000000-0000-4000-8000-000000000001',
                sessionId: '10000000-0000-4000-8000-000000000001',
                role: 'user',
                content: 'Find the regression cause.',
                createdAt: '2026-04-19T10:01:00.000Z'
              },
              {
                id: '40000000-0000-4000-8000-000000000002',
                sessionId: '10000000-0000-4000-8000-000000000001',
                role: 'assistant',
                content: 'Investigating the renderer freeze path.',
                createdAt: '2026-04-19T10:05:00.000Z'
              }
            ]
          },
          {
            id: '10000000-0000-4000-8000-000000000002',
            title: 'Reviewer agent',
            status: 'completed',
            systemPrompt: null,
            teamId: null,
            parentConversationId: null,
            createdAt: '2026-04-19T09:00:00.000Z',
            updatedAt: '2026-04-19T09:10:00.000Z',
            lastMessageAt: '2026-04-19T09:10:00.000Z',
            messages: [
              {
                id: '40000000-0000-4000-8000-000000000003',
                sessionId: '10000000-0000-4000-8000-000000000002',
                role: 'assistant',
                content: 'Review complete.',
                createdAt: '2026-04-19T09:10:00.000Z'
              }
            ]
          }
        ]}
        onClose={vi.fn()}
        open
        teams={[
          {
            id: '20000000-0000-4000-8000-000000000001',
            title: 'Incident team',
            status: 'active',
            memberIds: ['10000000-0000-4000-8000-000000000001'],
            createdAt: '2026-04-19T10:00:00.000Z',
            updatedAt: '2026-04-19T10:05:00.000Z'
          }
        ]}
      />
    );

    expect(
      screen.getByText('Agent ID: 10000000-0000-4000-8000-000000000001')
    ).toBeInTheDocument();
    expect(screen.getByText('Team Incident team')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open agent Reviewer agent' }));

    expect(
      screen.getByText('Agent ID: 10000000-0000-4000-8000-000000000002')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Parent chat:/)).not.toBeInTheDocument();
  });
});
