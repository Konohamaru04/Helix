// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WireframePreviewPanel } from '@renderer/components/wireframe-preview-panel';
import { buildWireframePreviewDocument } from '@renderer/lib/wireframe';

const design = {
  type: 'design' as const,
  title: 'Music App',
  html: '<main><button>Play</button></main>',
  css: 'main { width: 390px; height: 844px; }',
  js: ''
};
const secondDesign = {
  ...design,
  title: 'Music App Revised',
  html: '<main><button>Play</button><button>Like</button></main>'
};
const iterations = [
  {
    id: 'message-1:0',
    design,
    createdAt: '2026-04-25T01:00:00.000Z',
    sourceMessageId: 'message-1'
  },
  {
    id: 'message-2:0',
    design: secondDesign,
    createdAt: '2026-04-25T02:00:00.000Z',
    sourceMessageId: 'message-2'
  }
];
const firstIteration = iterations[0]!;

describe('WireframePreviewPanel', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:wireframe-preview');
    URL.revokeObjectURL = vi.fn();
  });

  it('renders a no-scroll preview iframe with pointer and drag modes', () => {
    render(<WireframePreviewPanel iterations={[firstIteration]} />);

    const iframe = screen.getByTitle('Music App preview');
    expect(iframe).toHaveAttribute('scrolling', 'no');
    expect(screen.getByRole('button', { name: 'pointer' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(screen.getByRole('button', { name: 'drag' }));

    expect(screen.getByRole('button', { name: 'drag' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(iframe).toHaveClass('pointer-events-none');
  });

  it('exposes zoom controls and export', () => {
    render(<WireframePreviewPanel iterations={[firstIteration]} />);

    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Export HTML' })).toHaveAttribute(
      'download',
      'music-app.html'
    );
  });

  it('zooms from wheel messages emitted by the iframe preview', async () => {
    render(<WireframePreviewPanel iterations={[firstIteration]} />);

    const iframe = screen.getByTitle('Music App preview') as HTMLIFrameElement;
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            source: 'helix-wireframe-preview',
            type: 'wheel',
            deltaY: 100,
            clientX: 20,
            clientY: 20
          },
          source: iframe.contentWindow
        })
      );
    });

    expect(screen.getByRole('button', { name: '62%' })).toBeInTheDocument();
  });

  it('blocks wheel scrolling inside the generated preview document', () => {
    expect(buildWireframePreviewDocument(design)).toContain(
      "window.addEventListener('wheel'"
    );
    expect(buildWireframePreviewDocument(design)).toContain(
      "source: 'helix-wireframe-preview'"
    );
    expect(buildWireframePreviewDocument(design)).toContain(
      'overscroll-behavior: none'
    );
    expect(buildWireframePreviewDocument(design)).toContain(
      'background: transparent !important'
    );
  });

  it('lists design iterations and switches the selected preview', () => {
    const handleSelectIteration = vi.fn();
    render(
      <WireframePreviewPanel
        iterations={iterations}
        onSelectIteration={handleSelectIteration}
        selectedIterationId="message-1:0"
      />
    );

    expect(screen.getByRole('button', { name: /Version 1/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: /Version 2/ }));

    expect(handleSelectIteration).toHaveBeenCalledWith('message-2:0');
  });
});
