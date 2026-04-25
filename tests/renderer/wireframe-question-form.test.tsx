// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WireframeQuestionForm } from '@renderer/components/wireframe-question-form';

const questions = [
  {
    id: 'accent',
    label: 'What accent color direction fits the brand?',
    selection: 'single' as const,
    options: [
      { id: 'A', label: 'Vibrant purple/violet' },
      { id: 'B', label: 'Electric blue' }
    ]
  },
  {
    id: 'mini_player',
    label: 'How should the mini-player behave across screens?',
    selection: 'single' as const,
    options: [
      { id: 'A', label: 'Persistent mini-player bar' },
      { id: 'B', label: 'Swipe-up mini-player' }
    ]
  }
];

describe('WireframeQuestionForm', () => {
  it('hides submit answers after a successful submit and keeps answers read-only', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <WireframeQuestionForm
        onSubmit={onSubmit}
        questions={questions}
      />
    );

    fireEvent.click(screen.getByLabelText(/Electric blue/));
    fireEvent.click(screen.getByLabelText(/Persistent mini-player bar/));
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    expect(
      screen.queryByRole('button', { name: 'Submit answers' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('Answers submitted')).toBeInTheDocument();
    expect(screen.getByLabelText(/Electric blue/)).toBeDisabled();
    expect(screen.getByLabelText(/Persistent mini-player bar/)).toBeDisabled();
  });
});
