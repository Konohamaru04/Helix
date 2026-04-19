// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GenerationJob, StoredMessage } from '@bridge/ipc/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '@renderer/components/message-list';

const userMessage: StoredMessage = {
  id: '10000000-0000-4000-8000-000000000001',
  conversationId: '20000000-0000-4000-8000-000000000001',
  role: 'user',
  content: 'Show me the latest output',
  attachments: [],
  status: 'completed',
  model: 'llama3.2:latest',
  correlationId: null,
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z'
};

const assistantMessage: StoredMessage = {
  id: '10000000-0000-4000-8000-000000000002',
  conversationId: '20000000-0000-4000-8000-000000000001',
  role: 'assistant',
  content: 'Streaming reply',
  attachments: [],
  status: 'streaming',
  model: 'llama3.2:latest',
  correlationId: null,
  createdAt: '2026-04-08T00:00:01.000Z',
  updatedAt: '2026-04-08T00:00:01.000Z'
};

const generationJob: GenerationJob = {
  id: '30000000-0000-4000-8000-000000000001',
  workspaceId: '40000000-0000-4000-8000-000000000001',
  conversationId: null,
  kind: 'image',
  mode: 'text-to-image',
  workflowProfile: 'default',
  status: 'running',
  prompt: 'Generate a neon skyline',
  negativePrompt: null,
  model: 'builtin:placeholder',
  backend: 'placeholder',
  width: 768,
  height: 768,
  steps: 6,
  guidanceScale: 4,
  seed: null,
  progress: 0.4,
  stage: 'Rendering',
  errorMessage: null,
  createdAt: '2026-04-08T00:00:02.000Z',
  updatedAt: '2026-04-08T00:00:02.000Z',
  startedAt: '2026-04-08T00:00:02.000Z',
  completedAt: null,
  referenceImages: [],
  artifacts: []
};

describe('MessageList', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-scrolls when new content arrives and the user is near the bottom', () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo
    });

    const { rerender } = render(
      <MessageList
        conversationTitle="Auto-scroll test"
        generationJobs={[]}
        messages={[userMessage, assistantMessage]}
        streaming
      />
    );
    const transcript = screen.getByLabelText('Conversation transcript');
    Object.defineProperty(transcript, 'scrollHeight', {
      configurable: true,
      value: 2000
    });
    Object.defineProperty(transcript, 'clientHeight', {
      configurable: true,
      value: 500
    });
    Object.defineProperty(transcript, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 1405
    });

    fireEvent.scroll(transcript);
    scrollTo.mockClear();

    rerender(
      <MessageList
        conversationTitle="Auto-scroll test"
        generationJobs={[]}
        messages={[
          userMessage,
          {
            ...assistantMessage,
            content: 'Streaming reply with more visible output',
            updatedAt: '2026-04-08T00:00:02.000Z'
          }
        ]}
        streaming
      />
    );

    expect(scrollTo).toHaveBeenCalledWith({
      top: 2000,
      behavior: 'auto'
    });
  });

  it('does not force scroll when the user has intentionally scrolled away', () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo
    });

    const { rerender } = render(
      <MessageList
        conversationTitle="Manual scroll test"
        generationJobs={[]}
        messages={[userMessage, assistantMessage]}
        streaming
      />
    );
    const transcript = screen.getByLabelText('Conversation transcript');
    Object.defineProperty(transcript, 'scrollHeight', {
      configurable: true,
      value: 2000
    });
    Object.defineProperty(transcript, 'clientHeight', {
      configurable: true,
      value: 500
    });
    Object.defineProperty(transcript, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 900
    });

    fireEvent.scroll(transcript);
    scrollTo.mockClear();

    rerender(
      <MessageList
        conversationTitle="Manual scroll test"
        generationJobs={[]}
        messages={[
          userMessage,
          {
            ...assistantMessage,
            content: 'Streaming reply with more visible output',
            updatedAt: '2026-04-08T00:00:02.000Z'
          }
        ]}
        streaming
      />
    );

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('renders inline image-generation turns inside the transcript timeline', () => {
    render(
      <MessageList
        conversationTitle="Image timeline test"
        generationJobs={[generationJob]}
        messages={[userMessage]}
        streaming={false}
      />
    );

    expect(screen.getByText('Generate a neon skyline')).toBeInTheDocument();
    expect(screen.getAllByText('assistant')[0]).toBeInTheDocument();
    expect(screen.getByText('Image generation')).toBeInTheDocument();
    expect(screen.getByText('Rendering')).toBeInTheDocument();
  });

  it('renders a pending turn indicator before the assistant reply exists', () => {
    render(
      <MessageList
        conversationTitle="Pending request"
        generationJobs={[]}
        messages={[]}
        pendingHint="The router is choosing whether to stay in base chat or hand off."
        pendingLabel="Analyzing request"
        streaming={false}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('Analyzing request');
    expect(screen.getByRole('status')).toHaveTextContent(
      'The router is choosing whether to stay in base chat or hand off.'
    );
  });

  it('shows a rotating empty-state tip whenever the blank transcript reappears', async () => {
    const randomSpy = vi
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);

    try {
      const { rerender } = render(
        <MessageList
          conversationTitle="Empty tip test"
          generationJobs={[]}
          messages={[]}
          streaming={false}
        />
      );

      expect(await screen.findByText('Bind a folder to this workspace')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Link a local project folder from the composer actions so tools and imports stay scoped to the right files.'
        )
      ).toBeInTheDocument();

      rerender(
        <MessageList
          conversationTitle="Empty tip test"
          generationJobs={[]}
          messages={[userMessage]}
          streaming={false}
        />
      );

      rerender(
        <MessageList
          conversationTitle="Empty tip test"
          generationJobs={[]}
          messages={[]}
          streaming={false}
        />
      );

      expect(await screen.findByText('Import files for grounded answers')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Text-like attachments and workspace imports become searchable context that can show up later in Sources.'
        )
      ).toBeInTheDocument();
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('preserves the provided message order when timestamps are identical', () => {
    render(
      <MessageList
        conversationTitle="Stable ordering"
        generationJobs={[]}
        messages={[
          {
            ...userMessage,
            id: 'zzzz-user',
            content: 'User should stay first',
            createdAt: '2026-04-08T00:00:00.000Z',
            updatedAt: '2026-04-08T00:00:00.000Z'
          },
          {
            ...assistantMessage,
            id: 'aaaa-assistant',
            content: 'Assistant should stay second',
            status: 'completed',
            createdAt: '2026-04-08T00:00:00.000Z',
            updatedAt: '2026-04-08T00:00:00.000Z'
          }
        ]}
        streaming={false}
      />
    );

    const userContent = screen.getByText('User should stay first');
    const assistantContent = screen.getByText('Assistant should stay second');

    expect(
      userContent.compareDocumentPosition(assistantContent) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
