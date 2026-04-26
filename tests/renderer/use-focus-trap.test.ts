// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from '@renderer/lib/use-focus-trap';

/**
 * The hook uses useEffect which only fires when `open` changes.
 * We need to:
 *   1. renderHook with open=false initially (no listener attached)
 *   2. Set up a DOM container and assign it to the ref
 *   3. Re-render with open=true to trigger the effect
 *
 * This pattern ensures the ref has a DOM node before the effect runs.
 */

function createContainer(): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = `
    <button id="first">First</button>
    <input id="middle" type="text" />
    <button id="last">Last</button>
  `;
  document.body.appendChild(container);
  return container;
}

describe('useFocusTrap', () => {
  it('returns a ref object', () => {
    const { result } = renderHook(() => useFocusTrap(false));
    expect(result.current).toBeDefined();
    expect(result.current).toHaveProperty('current');
  });

  it('moves focus to the first focusable element when open becomes true', () => {
    const container = createContainer();

    const { result, rerender } = renderHook(
      ({ open }) => useFocusTrap(open),
      { initialProps: { open: false } }
    );

    // Assign the ref before opening
    result.current.current = container;

    // Now open the trap — effect runs and focuses first focusable element
    rerender({ open: true });

    const firstButton = container.querySelector('#first') as HTMLElement;
    expect(document.activeElement).toBe(firstButton);

    container.remove();
  });

  it('traps Tab key — cycles from last to first focusable element', () => {
    const container = createContainer();

    const { result, rerender } = renderHook(
      ({ open }) => useFocusTrap(open),
      { initialProps: { open: false } }
    );

    result.current.current = container;
    rerender({ open: true });

    const firstButton = container.querySelector('#first') as HTMLElement;
    const lastButton = container.querySelector('#last') as HTMLElement;

    // Focus the last element
    act(() => {
      lastButton.focus();
    });
    expect(document.activeElement).toBe(lastButton);

    // Press Tab while focus is on the last element
    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true
    });
    act(() => {
      container.dispatchEvent(tabEvent);
    });

    expect(document.activeElement).toBe(firstButton);

    container.remove();
  });

  it('traps Shift+Tab key — cycles from first to last focusable element', () => {
    const container = createContainer();

    const { result, rerender } = renderHook(
      ({ open }) => useFocusTrap(open),
      { initialProps: { open: false } }
    );

    result.current.current = container;
    rerender({ open: true });

    const firstButton = container.querySelector('#first') as HTMLElement;
    const lastButton = container.querySelector('#last') as HTMLElement;

    act(() => {
      firstButton.focus();
    });
    expect(document.activeElement).toBe(firstButton);

    const shiftTabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    act(() => {
      container.dispatchEvent(shiftTabEvent);
    });

    expect(document.activeElement).toBe(lastButton);

    container.remove();
  });

  it('does not cycle focus when Tab is pressed on a middle element', () => {
    const container = createContainer();

    const { result, rerender } = renderHook(
      ({ open }) => useFocusTrap(open),
      { initialProps: { open: false } }
    );

    result.current.current = container;
    rerender({ open: true });

    const middleInput = container.querySelector('#middle') as HTMLElement;

    act(() => {
      middleInput.focus();
    });
    expect(document.activeElement).toBe(middleInput);

    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true
    });
    act(() => {
      container.dispatchEvent(tabEvent);
    });

    // Focus should not jump — we're on a middle element, not last
    expect(document.activeElement).toBe(middleInput);

    container.remove();
  });

  it('restores focus to the previously active element on unmount', () => {
    // Create an outside button that receives focus before the trap opens
    const outsideButton = document.createElement('button');
    outsideButton.id = 'outside';
    document.body.appendChild(outsideButton);
    act(() => {
      outsideButton.focus();
    });
    expect(document.activeElement).toBe(outsideButton);

    const container = createContainer();

    const { result, rerender, unmount } = renderHook(
      ({ open }) => useFocusTrap(open),
      { initialProps: { open: false } }
    );

    result.current.current = container;
    // Open the trap — effect saves document.activeElement (outsideButton) and focuses first
    rerender({ open: true });

    // Now close the trap by unmounting — cleanup should restore focus to outsideButton
    unmount();

    expect(document.activeElement).toBe(outsideButton);

    outsideButton.remove();
    container.remove();
  });

  it('does not add a keydown listener when open=false', () => {
    const container = createContainer();

    const { result } = renderHook(() => useFocusTrap(false));
    result.current.current = container;

    const firstButton = container.querySelector('#first') as HTMLElement;
    act(() => {
      firstButton.focus();
    });

    const shiftTabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    act(() => {
      container.dispatchEvent(shiftTabEvent);
    });

    // Focus should not have been cycled — no listener attached
    expect(document.activeElement).toBe(firstButton);

    container.remove();
  });

  it('ignores non-Tab keys', () => {
    const container = createContainer();

    const { result, rerender } = renderHook(
      ({ open }) => useFocusTrap(open),
      { initialProps: { open: false } }
    );

    result.current.current = container;
    rerender({ open: true });

    const firstButton = container.querySelector('#first') as HTMLElement;
    act(() => {
      firstButton.focus();
    });

    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true
    });
    act(() => {
      container.dispatchEvent(enterEvent);
    });

    expect(document.activeElement).toBe(firstButton);

    container.remove();
  });
});