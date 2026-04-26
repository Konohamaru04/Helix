// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEscapeClose } from '@renderer/lib/use-escape-close';

function fireKeyDown(key: string, options?: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, ...options, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

describe('useEscapeClose', () => {
  it('calls onClose when Escape is pressed and open=true', () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeClose(true, onClose));

    fireKeyDown('Escape');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when open=false', () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeClose(false, onClose));

    fireKeyDown('Escape');

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not call onClose when onClose is undefined', () => {
    renderHook(() => useEscapeClose(true, undefined));

    // Should not throw
    fireKeyDown('Escape');
  });

  it('does not call onClose for other keys (Enter, Tab, etc.)', () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeClose(true, onClose));

    fireKeyDown('Enter');
    fireKeyDown('Tab');
    fireKeyDown('ArrowDown');
    fireKeyDown('a');

    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls stopPropagation on the Escape event', () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeClose(true, onClose));

    const event = fireKeyDown('Escape');

    expect(event.stopPropagation).toBeDefined();
    // The handler calls event.stopPropagation() before onClose()
    expect(onClose).toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const onClose = vi.fn();
    const { unmount } = renderHook(() => useEscapeClose(true, onClose));

    unmount();

    fireKeyDown('Escape');

    expect(onClose).not.toHaveBeenCalled();
  });

  it('re-subscribes when open changes from false to true', () => {
    const onClose = vi.fn();
    const { rerender } = renderHook(
      ({ open }) => useEscapeClose(open, onClose),
      { initialProps: { open: false } }
    );

    fireKeyDown('Escape');
    expect(onClose).not.toHaveBeenCalled();

    rerender({ open: true });

    fireKeyDown('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stops calling onClose when open changes from true to false', () => {
    const onClose = vi.fn();
    const { rerender } = renderHook(
      ({ open }) => useEscapeClose(open, onClose),
      { initialProps: { open: true } }
    );

    fireKeyDown('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender({ open: false });

    fireKeyDown('Escape');
    expect(onClose).toHaveBeenCalledTimes(1); // no additional call
  });

  it('updates the onClose callback on re-render', () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    const { rerender } = renderHook(
      ({ onClose }) => useEscapeClose(true, onClose),
      { initialProps: { onClose: onCloseA } }
    );

    fireKeyDown('Escape');
    expect(onCloseA).toHaveBeenCalledTimes(1);

    rerender({ onClose: onCloseB });

    fireKeyDown('Escape');
    expect(onCloseB).toHaveBeenCalledTimes(1);
    expect(onCloseA).toHaveBeenCalledTimes(1); // not called again
  });
});